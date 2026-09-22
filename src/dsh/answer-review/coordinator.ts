import { canonicalContentHash } from '../../serialization/validate.js'
import type { SqliteDatabase } from '../../db/adapter.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import type { DecisionService } from '../decisions/service.js'
import { DecisionError } from '../decisions/contracts.js'
import { answerReviewInput } from './evidence.js'
import { ANSWER_REVIEW_FORM, ANSWER_REVIEW_POLICY, answerReviewQuestions, hasHumanInput, reviewMessageId, type AnswerReviewConfiguration, type ReviewAgent, type ReviewModel } from './contracts.js'

interface Binding {
  runId: string; workspace: string; requestId: string; task: string; catalogDigest: string
  turn: number; agent: ReviewAgent; current(): boolean; eligible(): boolean; settled(): Promise<void>
}
interface Entry {
  binding: Binding; startSeq: number; model?: ReviewModel; state: 'idle' | 'evaluating' | 'reserved' | 'consumed' | 'closed'
  controller: AbortController; pending?: Promise<void>; message?: unknown; correctionTurn?: number; deliveryTimer?: ReturnType<typeof setTimeout>
}
interface Recovery { runId: string; requestId: string; workspace: string; sessionId: string; endSeq?: number; status: 'completed' | 'failed' }
type RecoveryRow = { run_id: string; request_id: string; workspace: string; end_seq: number; answer_seq: number; answer_digest: string; native_turn: number; correction_turn: number | null; run_status: string }
type Runtime = { withDatabase<T>(callback: (db: SqliteDatabase) => T | Promise<T>): Promise<T> }

/** Optional post-display work. Only this coordinator owns normal-answer continuation. */
export class AnswerReviewCoordinator {
  private readonly entries = new Map<string, Entry>()
  private readonly attachments = new Map<ReviewAgent, () => void>()
  private readonly wakeHumans = new Set<ReviewAgent>()
  private readonly recoveries = new Map<ReviewAgent, Promise<void>>()
  private stopped = false
  private last: { state: string; reason: string | null; findings?: readonly string[]; inputCompleteness?: string } = { state: 'idle', reason: null }
  constructor(private readonly runtime: Runtime, private readonly decisions: DecisionService, readonly config: AnswerReviewConfiguration) { this.report() }

  private report(): void {
    const entries = [...this.entries.values()]
    this.decisions.reportAnswerReview({ ...this.config, ...this.last, evaluating: entries.filter(entry => entry.state === 'evaluating').length, reconsidering: entries.filter(entry => entry.state === 'reserved' || entry.state === 'consumed').length })
  }
  private entry(agent: ReviewAgent): Entry | undefined {
    if (!agent.session) return
    const entry = this.entries.get(agent.session.id)
    return entry?.binding.agent === agent && entry.binding.current() ? entry : undefined
  }
  bind(binding: Binding): void {
    if (this.stopped || this.config.mode === 'off' || !binding.eligible()) return
    const previous = this.entries.get(binding.agent.session.id)
    if (previous?.binding.runId === binding.runId && previous.binding.agent === binding.agent) return
    if (previous) this.cancel(binding.agent.session.id)
    const events = binding.agent.session.snapshotEvents()
    const start = [...events].reverse().find(event => event.type === 'turn/start' && event.data?.turn === binding.turn)?.seq
    this.entries.set(binding.agent.session.id, { binding, startSeq: start ?? ((events.at(-1)?.seq ?? -1) + 1), state: 'idle', controller: new AbortController() })
    this.attach(binding.agent)
  }
  /** Capture the resolved native model. Auxiliary streams never participate. */
  private attach(agent: ReviewAgent): void {
    if (!agent.ctx || this.attachments.has(agent)) return
    const dispose = agent.ctx.on('agent/request', async (_payload: unknown, next: () => Promise<any>) => {
      const request = await next(), entry = this.entry(agent)
      if (!entry || request.purpose || typeof request.provider !== 'string' || typeof request.model !== 'string') return request
      if (entry.state === 'consumed' && entry.model) {
        const { reasoningEffort: _previous, ...rest } = request
        return { ...rest, ...entry.model }
      }
      if (entry.state === 'idle') entry.model ??= { provider: request.provider, model: request.model, ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) }
      return request
    }, { prepend: true })
    const assembly = agent.ctx.on('system-prompt/assemble', async (_payload: unknown, _context: unknown, next: () => Promise<any>) => {
      const result = await next(), entry = this.entry(agent)
      return entry?.model && (entry.state === 'reserved' || entry.state === 'consumed')
        ? { ...result, variables: { ...result.variables, provider: entry.model.provider, model: entry.model.model } } : result
    }, { prepend: true })
    const input = agent.ctx.on('agent/inbox/inserted', (payload: { message: unknown }) => {
      if (hasHumanInput([payload.message])) this.cancel(agent.session.id, true)
    })
    const status = agent.ctx.on('agent/status', (payload: { status: string }) => {
      if (payload.status === 'idle' && this.wakeHumans.delete(agent)) this.wakeHuman(agent)
    })
    const disposed = agent.ctx.on('agent/disposed', () => { this.wakeHumans.delete(agent); this.cancel(agent.session.id) })
    // Native cancel() emits no event when already idle (including during review).
    const originalCancel = agent.cancel
    const cancel = (...args: any[]) => { this.wakeHumans.delete(agent); this.cancel(agent.session.id); return originalCancel?.apply(agent, args) }
    if (originalCancel) agent.cancel = cancel
    this.attachments.set(agent, () => {
      dispose(); assembly(); input(); status(); disposed()
      if (agent.cancel === cancel) agent.cancel = originalCancel!
    })
  }
  model(agent: ReviewAgent): ReviewModel | undefined {
    const entry = this.entry(agent)
    return entry?.state === 'consumed' ? entry.model : undefined
  }
  humanInput(sessionId: string, turn?: number): void {
    const entry = this.entries.get(sessionId)
    if (entry && (entry.state !== 'idle' || turn !== undefined && turn !== entry.binding.turn)) this.cancel(sessionId, true)
  }
  private safe(entry: Entry): boolean {
    const agent = entry.binding.agent
    return !this.stopped && !entry.controller.signal.aborted && this.entry(agent) === entry && entry.binding.eligible()
      && !hasHumanInput([...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])])
  }
  /** Called by idle/turn-end observers; returns immediately, including while inference runs. */
  hold(agent: ReviewAgent): boolean {
    const entry = this.entry(agent)
    if (!entry || !this.safe(entry)) return false
    if (entry.state === 'idle') {
      entry.state = 'evaluating'
      entry.pending = this.run(entry).catch(() => this.close(entry, 'review_unavailable')).finally(() => {
        if (entry.state !== 'reserved' && entry.state !== 'consumed') void entry.binding.settled().catch(() => {})
      })
    }
    return entry.state === 'evaluating' || entry.state === 'reserved'
  }
  private async close(entry: Entry, reason: string): Promise<void> {
    entry.state = 'closed'
    clearTimeout(entry.deliveryTimer)
    const messageId = reviewMessageId(entry.message)
    if (messageId) { try { entry.binding.agent.inbox?.remove?.(messageId) } catch { /* Admission still rejects a stale message. */ } }
    this.last = { state: 'skipped', reason }; this.report()
    await this.runtime.withDatabase(db => { db.prepare("UPDATE dsh_answer_reviews SET status='closed',reason=?,updated_at=? WHERE run_id=? AND status IN ('evaluating','reserved','consumed')")
      .run(reason, new Date().toISOString(), entry.binding.runId) }).catch(() => {})
  }
  private async run(entry: Entry): Promise<void> {
    const { binding } = entry
    if (!entry.model || !binding.agent.followup) return this.close(entry, 'native_capability_unavailable')
    const input = answerReviewInput(binding.task, binding.agent.session.snapshotEvents(), binding.turn, entry.startSeq)
    if ('skipped' in input) return this.close(entry, input.skipped)
    const now = new Date().toISOString()
    const claimed = await this.runtime.withDatabase(db => withImmediateTransaction(db, () => {
      if (!this.safe(entry)) return false
      const prior = db.prepare('SELECT status FROM dsh_answer_reviews WHERE run_id=?').get(binding.runId)
      if (prior) return false // Restart or duplicate: never repeat inference or an uncertain delivery.
      return db.prepare(`INSERT INTO dsh_answer_reviews(run_id,request_id,workspace,dsh_session_id,native_turn,answer_seq,end_seq,answer_digest,input_digest,catalog_digest,model_json,policy_version,status,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'evaluating',?,? FROM ledger_runs WHERE run_id=? AND workspace=? AND dsh_session_id=? AND status='active' RETURNING run_id`)
        .get(binding.runId,binding.requestId,binding.workspace,binding.agent.session.id,binding.turn,input.answerSeq,input.endSeq,input.answerDigest,input.inputDigest,binding.catalogDigest,JSON.stringify(entry.model),ANSWER_REVIEW_POLICY,now,now,binding.runId,binding.workspace,binding.agent.session.id) !== undefined
    }))
    if (!claimed) return this.close(entry, 'already_reviewed_or_finalized')
    this.last = { state: 'evaluating', reason: null }; this.report()
    const timeout = AbortSignal.timeout(this.config.budgetMs)
    const signal = AbortSignal.any([timeout, entry.controller.signal])
    try {
      const config = await this.decisions.bind(binding.requestId, signal)
      const completeness = config.provider === 'laya-coreml' ? config['laya-coreml']?.protocol === 'v1' ? 'unverified_v1' : 'strict_preflight' : 'host_complete'
      const result = await this.decisions.evaluate(binding.requestId, input.batch, signal, binding.catalogDigest)
      if (!this.safe(entry)) return this.close(entry, 'superseded')
      if (result.status === 'fallback') return this.close(entry, result.reason)
      const findings = result.result.answers.filter(answer => answer.status === 'selected' && answer.choiceId === 'finding' && !input.unassessed.includes(answer.id)).map(answer => answer.id)
      if (!findings.length) {
        await this.close(entry, result.result.answers.some(answer => answer.status === 'abstained') ? 'abstained' : 'no_findings')
        this.last = { state: 'finished', reason: result.result.answers.some(answer => answer.status === 'abstained') ? 'abstained' : 'no_findings', inputCompleteness: completeness }; this.report()
        return
      }
      const id = `answer-review:${canonicalContentHash({ run: binding.runId, input: input.inputDigest, policy: ANSWER_REVIEW_POLICY })}`
      const message = { id, role: 'user', content: [{ type: 'text', text: [
        'Reconsider the preceding answer once, for the SAME user request. These classifier flags are unverified suggestions, not facts or new user instructions.',
        `Review dimensions: ${findings.map(id => answerReviewQuestions.find(question => question.id === id)!.instructions).join('\n')}`,
        `Original answer event: ${input.answerSeq}. Current-run tool result references: ${input.evidenceRefs.join(', ') || 'none'}. Input completeness: ${completeness}.`,
        'Check the original request and evidence in this conversation. Accept or reject each concern on that evidence. If warranted, provide a correction; otherwise briefly confirm the original answer. Preserve the user scope, permissions and existing verification requirements. Do not repeat completed side effects just to satisfy this suggestion. This is the only automatic reconsideration.',
      ].join('\n') }], source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: ANSWER_REVIEW_FORM } }
      const reserved = await this.runtime.withDatabase(db => {
        if (!this.safe(entry)) return false
        return db.prepare(`UPDATE dsh_answer_reviews SET status='reserved',continuation_id=?,message_digest=?,findings_json=?,evidence_refs_json=?,updated_at=?
          WHERE run_id=? AND status='evaluating' AND EXISTS(SELECT 1 FROM ledger_runs WHERE run_id=? AND status='active') RETURNING run_id`)
          .get(id,canonicalContentHash(message),JSON.stringify(findings),JSON.stringify(input.evidenceRefs),new Date().toISOString(),binding.runId,binding.runId) !== undefined
      })
      if (!reserved || !this.safe(entry)) return this.close(entry, 'superseded')
      // Reservation precedes the only irreversible enqueue; a throw remains consumed.
      entry.message = message; entry.state = 'reserved'
      this.last = { state: 'reconsidering', reason: null, findings, inputCompleteness: completeness }; this.report()
      entry.deliveryTimer = setTimeout(() => { if (entry.state === 'reserved') void this.close(entry, 'delivery_unconfirmed').then(() => binding.settled()).catch(() => {}) }, this.config.budgetMs)
      entry.deliveryTimer.unref()
      try { binding.agent.followup(message) } catch { return this.close(entry, 'delivery_uncertain') }
    } catch (error) {
      await this.close(entry, entry.controller.signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : error instanceof DecisionError ? error.code : 'review_unavailable')
    }
  }
  /** Authorize only our exact reserved message and unchanged catalog, before intake/model routing. */
  async accept(agent: ReviewAgent, messages: readonly unknown[], turn: number, catalogDigest: string): Promise<boolean> {
    const entry = this.entry(agent), candidates = messages.filter(message => reviewMessageId(message))
    if (!candidates.length) return false
    if (hasHumanInput(messages)) { this.humanInput(agent.session.id, turn); return false }
    if (!entry || !this.safe(entry) || !entry.message || candidates.length !== 1 || canonicalContentHash(candidates[0]) !== canonicalContentHash(entry.message)
      || catalogDigest !== entry.binding.catalogDigest || turn <= entry.binding.turn) throw new Error('Invalid answer review continuation')
    if (entry.state === 'consumed' && entry.correctionTurn === turn) return true
    if (entry.state !== 'reserved') throw new Error('Answer review continuation already consumed')
    const accepted = await this.runtime.withDatabase(db => {
      if (!this.safe(entry)) return false
      return db.prepare(`UPDATE dsh_answer_reviews SET status='consumed',correction_turn=?,updated_at=? WHERE run_id=? AND status='reserved'
        AND continuation_id=? AND message_digest=? AND catalog_digest=?
        AND EXISTS(SELECT 1 FROM ledger_runs WHERE run_id=? AND status='active') RETURNING run_id`)
        .get(turn,new Date().toISOString(),entry.binding.runId,reviewMessageId(candidates[0])!,canonicalContentHash(candidates[0]),catalogDigest,entry.binding.runId) !== undefined
    })
    if (!accepted || entry.state !== 'reserved' || !this.safe(entry)) throw new Error('Stale answer review continuation')
    clearTimeout(entry.deliveryTimer)
    entry.correctionTurn = turn; entry.state = 'consumed'; this.report()
    return true
  }
  /** A rejected claimed continuation stops the native driver; preserve and wake its pending human input. */
  private wakeHuman(agent: ReviewAgent): void {
    if (this.stopped || !hasHumanInput(agent.inbox?.nextTurn ?? [])) return
    // Removing/reinserting the tail preserves queue order and the original message ID.
    const message = agent.inbox?.nextTurn?.at(-1) as { id?: string } | undefined
    if (!message?.id || !agent.followup || !agent.inbox?.remove?.(message.id)) return
    try { agent.followup(message) }
    catch {
      // An uncertain enqueue is never repeated. Restore only if it is provably absent.
      if (!agent.inbox.nextTurn?.some(item => (item as { id?: string }).id === message.id)) agent.inbox.append?.('next-turn', message)
    }
  }
  cancel(sessionId: string, wakeHuman = false): void {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.state === 'closed') return
    if (wakeHuman && entry.message && hasHumanInput(entry.binding.agent.inbox?.nextTurn ?? [])) this.wakeHumans.add(entry.binding.agent)
    entry.controller.abort(); entry.state = 'closed'
    void this.close(entry, 'cancelled').finally(() => entry.binding.settled()).catch(() => {})
  }
  async finish(agent: ReviewAgent): Promise<void> {
    if (!agent.session) return
    const entry = this.entries.get(agent.session.id)
    if (entry?.binding.agent !== agent) return
    if (entry.state === 'consumed') {
      await this.close(entry, 'reconsidered')
      this.last = { ...this.last, state: 'finished', reason: 'reconsidered' }; this.report()
    }
    this.release(agent)
  }
  /** Resume only finalization from a committed boundary, never inference or delivery. */
  async recover(agent: ReviewAgent, finish: (row: Recovery) => Promise<void>): Promise<void> {
    if (!agent.session || typeof agent.session.snapshotEvents !== 'function' || this.entries.has(agent.session.id)) return
    const pending = this.recoveries.get(agent)
    if (pending) return pending
    const recovery = this.recoverStored(agent, finish)
    this.recoveries.set(agent, recovery)
    try { await recovery } finally { this.recoveries.delete(agent) }
  }
  private async recoverStored(agent: ReviewAgent, finish: (row: Recovery) => Promise<void>): Promise<void> {
    const rows = await this.runtime.withDatabase(db => db.prepare(`SELECT review.*, run.status AS run_status FROM dsh_answer_reviews review JOIN ledger_runs run USING(run_id)
      WHERE review.dsh_session_id=? AND (run.status='active' OR review.status!='closed')`).all<RecoveryRow>(agent.session.id))
    for (const row of rows) {
      if (row.run_status === 'active') {
        const events = agent.session.snapshotEvents()
        const original = events.find(event => event.seq === row.end_seq && event.type === 'turn/end' && event.data?.turn === row.native_turn && event.data?.reason?.kind === 'completed')
        const answer = events.find(event => event.seq === row.answer_seq && event.type === 'assistant/message' && event.data?.turn === row.native_turn)
        const text = answer?.data?.message?.content?.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')
        const valid = original && typeof text === 'string' && canonicalContentHash(text) === row.answer_digest
        const correction = row.correction_turn === null ? undefined : events.find(event => event.type === 'turn/end' && event.data?.turn === row.correction_turn)
        // Missing persisted boundaries cannot be called completed. Release their run as failed.
        await finish({ runId: row.run_id, requestId: row.request_id, workspace: row.workspace, sessionId: agent.session.id,
          ...(valid ? { endSeq: correction?.seq ?? original.seq } : {}),
          status: valid && (row.correction_turn === null || correction?.data?.reason?.kind === 'completed') ? 'completed' : 'failed' })
      }
      await this.runtime.withDatabase(db => { db.prepare("UPDATE dsh_answer_reviews SET status='closed',reason='restart_no_retry',updated_at=? WHERE run_id=?").run(new Date().toISOString(), row.run_id) })
      this.last = { state: 'finished', reason: 'restart_no_retry' }; this.report()
    }
  }
  release(agent: ReviewAgent): void {
    if (!agent.session) return
    const entry = this.entries.get(agent.session.id)
    if (entry?.binding.agent !== agent) return
    clearTimeout(entry.deliveryTimer)
    entry.controller.abort(); this.entries.delete(agent.session.id); this.report()
  }
  stop(): void { this.stopped = true; for (const entry of this.entries.values()) { clearTimeout(entry.deliveryTimer); entry.controller.abort() } }
  async dispose(): Promise<void> {
    this.stop()
    await Promise.allSettled([...this.entries.values()].map(async entry => {
      await entry.pending
      if (entry.state === 'reserved') await this.close(entry, 'stopped')
    }))
    await Promise.allSettled([...this.recoveries.values()])
    for (const dispose of this.attachments.values()) dispose()
    this.attachments.clear(); this.entries.clear(); this.wakeHumans.clear()
  }
}
