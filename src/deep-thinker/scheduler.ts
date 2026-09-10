import { randomUUID } from 'node:crypto'
import { findSecretInValue } from '../memory/secrets.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { budgetProblem, stopClock, activeMilliseconds } from './core/budget.js'
import { applyReply, advanceGraph, invalidateNodes, nextRole, runnableNodes } from './core/graph.js'
import { terminal, type DeepJob, type DeepModel, type DeepState } from './core/contracts.js'
import { DeepStore, assertDeepAuthority, type DeepAuthority } from './store.js'
import { changedSources, currentArtifacts, evidenceReceipt, inputArtifacts } from './evidence.js'
import { jobFor, parseDeepReply } from './prompts.js'
import { deepReport } from './report.js'
import { processDeepSlots } from './slots.js'
import type { DeepRole } from './core/contracts.js'
import { DeepModelUnavailable } from './failures.js'

export interface DeepExecution {
  execute(authority: DeepAuthority, job: DeepJob, state: DeepState, signal: AbortSignal): Promise<unknown>
}
interface Running { abort: AbortController; done: Promise<void> }
const errorText = (error: unknown): string => findSecretInValue(error instanceof Error ? error.message : error) ? 'Deep処理が安全に停止しました' : String(error instanceof Error ? error.message : error).slice(0, 2_048)

/** Effects run outside the DB queue. Only bounded synchronous state transitions hold a transaction. */
export class DeepScheduler {
  readonly ownerId = randomUUID()
  readonly #runs = new Map<string, Running>()
  #closed = false
  constructor(readonly store: DeepStore, readonly executor: DeepExecution, readonly notify: (state: DeepState) => Promise<void>, readonly maxTotal = 6) {}
  running(runId: string): boolean { return this.#runs.has(runId) }
  async start(runId: string): Promise<void> {
    if (this.#closed) throw new Error('Deep is shutting down')
    if (this.#runs.has(runId)) return
    // A placeholder prevents concurrent callers on this process entering claim twice.
    const abort = new AbortController()
    let ready!: () => void, failed!: (error: unknown) => void, epoch: number | undefined
    const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject })
    const done = (async () => {
      const state = await this.store.claim(runId, this.ownerId)
      epoch = state.ownerEpoch; ready(); await this.#drive(state, abort)
    })().catch(async error => {
      failed(error)
      if (epoch !== undefined) { await this.#pauseState(runId, errorText(error), epoch); await this.notify(await this.store.read(runId)).catch(() => {}) }
    }).finally(() => this.#runs.delete(runId))
    this.#runs.set(runId, { abort, done })
    await started
  }
  async idle(runId: string): Promise<void> { await this.#runs.get(runId)?.done }
  async reconcile(attemptId: string, output: unknown): Promise<void> {
    const attempt = await this.store.database(db => db.prepare('SELECT * FROM dsh_deep_attempts WHERE attempt_id=?').get<{
      run_id: string; node_id: string; node_revision: number; requirement_revision: number; role: DeepRole; input_digest: string; input_artifact_ids_json: string; status: string
    }>(attemptId))
    if (!attempt || !['reserved','started','uncertain'].includes(attempt.status)) return
    const state = await this.store.read(attempt.run_id)
    if (this.running(state.runId) || terminal(state.phase) || state.ownerId && state.leaseUntil > this.store.now()) throw new Error('Deep recovery requires an unowned nonterminal run')
    const reply = parseDeepReply(attempt.role, output)
    const ids: string[] = JSON.parse(attempt.input_artifact_ids_json)
    const artifacts = currentArtifacts(state, await this.store.artifacts(state.runId)).filter(a => ids.includes(a.id) || a.nodeId === attempt.node_id)
    if ((await changedSources(state.rootPath, artifacts)).length) throw new Error('資料が変更されたため、古い試行結果は再利用できません')
    const node = state.nodes.find(n => n.id === attempt.node_id)!
    const receipt = evidenceReceipt(reply, node.candidate, artifacts, attempt.input_digest)
    await this.store.mutate(state.runId, (current, db) => {
      const target = current.nodes.find(n => n.id === attempt.node_id)
      if (terminal(current.phase) || current.ownerId && current.leaseUntil > this.store.now() || current.requirementRevision !== attempt.requirement_revision || target?.revision !== attempt.node_revision) throw new Error('Deep recovery identity changed')
      const row = db.prepare('SELECT status FROM dsh_deep_attempts WHERE attempt_id=?').get<{status:string}>(attemptId)
      if (!row || !['reserved','started','uncertain'].includes(row.status)) return
      applyReply(current, target, attempt.role, reply, target.proposal?.kind === 'decompose' ? target.proposal.children.map(() => randomUUID()) : [])
      target.activeAttemptId = null; if (target.status === 'accepted') target.receipt = receipt
      current.phase = 'paused'; current.ownerId = null; current.ownerEpoch++; current.leaseUntil = 0; stopClock(current, this.store.now())
      current.reason = '子Sessionの完了記録から結果を復旧しました。--resume で継続できます。'
      db.prepare("UPDATE dsh_deep_attempts SET status='completed',result_json=? WHERE attempt_id=?").run(JSON.stringify(reply), attemptId)
      const reservations = db.prepare("SELECT reservation_id,tokens FROM dsh_deep_budget_reservations WHERE attempt_id=? AND status IN ('reserved','uncertain')").all<{reservation_id:string;tokens:number}>(attemptId)
      for (const reservation of reservations) {
        current.usage.reservedTokens -= reservation.tokens; current.usage.tokens += reservation.tokens
        db.prepare("UPDATE dsh_deep_budget_reservations SET status='settled' WHERE reservation_id=?").run(reservation.reservation_id)
      }
    })
    await this.notify(await this.store.read(state.runId)).catch(() => {})
  }
  async #pauseState(runId: string, reason: string, expectedEpoch?: number): Promise<number | undefined> {
    return this.store.mutate(runId, (state, db) => {
      if (terminal(state.phase) || expectedEpoch !== undefined && state.ownerEpoch !== expectedEpoch) return undefined
      if (state.ownerId && state.ownerId !== this.ownerId && state.leaseUntil > this.store.now()) throw new Error('別の実行プロセスが所有しています。そのプロセスから停止するか、所有期限後に再確認してください。')
      state.phase = 'paused'; state.reason = reason; state.ownerEpoch++; state.ownerId = null; state.leaseUntil = 0; stopClock(state, this.store.now())
      db.prepare("UPDATE dsh_deep_attempts SET status=CASE WHEN child_session_id IS NULL AND NOT EXISTS (SELECT 1 FROM dsh_deep_budget_reservations b WHERE b.attempt_id=dsh_deep_attempts.attempt_id) THEN 'cancelled' ELSE 'uncertain' END WHERE run_id=? AND status IN ('reserved','started')").run(runId)
      for (const node of state.nodes) node.activeAttemptId = null
      return state.ownerEpoch
    })
  }
  async pause(runId: string, reason: string): Promise<void> {
    await this.#pauseState(runId, reason) // Revoke authority before aborting child execution.
    const running = this.#runs.get(runId); running?.abort.abort(new Error(reason))
    await this.notify(await this.store.read(runId)).catch(() => {})
    if (running) await running.done
  }
  async cancel(runId: string): Promise<void> {
    await this.pause(runId, '取消し処理中')
    const state = await this.store.read(runId)
    if (state.phase === 'paused' && state.ownerId === null) await this.#finish(state, 'cancelled', '利用者が取り消しました。')
  }
  async completePartial(runId: string, reason: string): Promise<void> {
    await this.pause(runId, reason)
    const state = await this.store.read(runId)
    if (state.phase === 'paused' && state.ownerId === null) await this.#finish(state, 'partial', reason)
  }
  async dispose(): Promise<void> {
    this.#closed = true
    await Promise.all([...this.#runs.keys()].map(id => this.pause(id, 'ホスト終了のため一時停止。保存済みの結果を保持しています。')))
  }
  async #finish(expected: DeepState, phase: 'answered' | 'partial' | 'cancelled', reason: string): Promise<void> {
    const runId = expected.runId
    const artifacts = await this.store.artifacts(runId)
    const changed = await changedSources(expected.rootPath, currentArtifacts(expected, artifacts))
    await this.store.mutate(runId, (state, db) => {
      if (terminal(state.phase)) return
      if (state.ownerEpoch !== expected.ownerEpoch || state.ownerId !== expected.ownerId || state.phase !== expected.phase || state.requirementRevision !== expected.requirementRevision || state.ownerId && state.leaseUntil <= this.store.now()) throw new Error('Deep completion authority changed')
      if (changed.length) { invalidateNodes(state, changed, '最終確定時に参照資料の変更を検出しました'); if (phase === 'answered') { phase = 'partial'; reason = '参照資料が変更されたため、未検証の部分を残して停止しました。' } }
      state.phase = phase; state.reason = reason
      this.store.finishInTransaction(db, state, phase, reason, deepReport(state, currentArtifacts(state, artifacts)))
    })
    await this.notify(await this.store.read(runId)).catch(() => {})
  }
  async #drive(initial: DeepState, abort: AbortController): Promise<void> {
    const runId = initial.runId, active = new Set<Promise<void>>(), scheduled = new Set<string>()
    const remaining = Math.max(1, initial.configuration.budget.maxActiveSeconds * 1000 - activeMilliseconds(initial, this.store.now()))
    let timedOut = false, stoppedEpoch: number | undefined
    const deadline = setTimeout(() => { timedOut = true; abort.abort(new Error('稼働時間の上限に達しました')) }, remaining)
    const heartbeat = setInterval(() => { void this.store.renew(runId, this.ownerId, initial.ownerEpoch).catch(error => abort.abort(error)) }, 10_000)
    try {
      while (!abort.signal.aborted) {
        const state = await this.store.read(runId)
        if (state.phase !== 'running' || state.ownerEpoch !== initial.ownerEpoch) break
        await this.store.mutate(runId, state => {
          if (state.phase !== 'running' || state.ownerId !== this.ownerId || state.ownerEpoch !== initial.ownerEpoch || state.leaseUntil <= this.store.now()) throw new Error('Deep scheduling authority changed')
          advanceGraph(state)
        })
        const current = await this.store.read(runId)
        const problem = budgetProblem(current, this.store.now(), 'job')
        const nodes = runnableNodes(current).filter(node => !scheduled.has(node.id))
        if ((!nodes.length || problem) && !active.size) {
          const changed = await changedSources(current.rootPath, currentArtifacts(current, await this.store.artifacts(runId)))
          if (changed.length) {
            await this.store.mutate(runId, state => invalidateNodes(state, changed, '参照資料が変更されました。再検証が必要です。'))
            if (!problem) continue
          }
          const latest = await this.store.read(runId)
          if (latest.phase !== 'running' || latest.ownerEpoch !== initial.ownerEpoch) break
          await this.#finish(latest, latest.nodes[0]?.status === 'accepted' ? 'answered' : 'partial', latest.nodes[0]?.status === 'accepted' ? '要求と出典の検査を完了しました。' : problem ?? '実行可能な依存先が残っていません。未解決事項を表示します。')
          return
        }
        const count = problem ? 0 : Math.max(0, current.configuration.budget.maxConcurrentAgents - active.size)
        for (const node of nodes.slice(0, count)) {
          scheduled.add(node.id)
          const task = this.#runJob(current, node.id, abort.signal).finally(() => { active.delete(task); scheduled.delete(node.id) })
          active.add(task)
        }
        if (active.size) await Promise.race(active)
      }
      stoppedEpoch = await this.#pauseState(runId, abort.signal.aborted ? errorText(abort.signal.reason) : (await this.store.read(runId)).reason || '実行権限が変更されました', initial.ownerEpoch)
    } finally {
      clearTimeout(deadline); clearInterval(heartbeat)
      abort.abort(new Error('Deep scheduler stopped'))
      await Promise.allSettled(active)
    }
    if (timedOut && stoppedEpoch !== undefined) {
      const state = await this.store.read(runId)
      if (state.ownerEpoch === stoppedEpoch) await this.#finish(state, 'partial', '稼働時間の上限に達しました。保存済みの結果と未解決事項を表示します。')
    }
  }
  async #reserve(state: DeepState, job: DeepJob, repairOf?: string): Promise<DeepAuthority> {
    return this.store.mutate(state.runId, (current, db) => {
      const node = current.nodes.find(n => n.id === job.nodeId)
      if (current.phase !== 'running' || current.ownerId !== this.ownerId || current.ownerEpoch !== state.ownerEpoch || current.leaseUntil <= this.store.now() || current.requirementRevision !== state.requirementRevision || !node || node.revision !== job.nodeRevision || node.activeAttemptId) throw new Error('Deep job claim is stale')
      const problem = budgetProblem(current, this.store.now(), 'job'); if (problem) throw new Error(problem)
      if (repairOf && db.prepare('SELECT 1 FROM dsh_deep_attempts WHERE repair_of=?').get(repairOf)) throw new Error('JSON repair already attempted')
      const attemptId = randomUUID(); node.activeAttemptId = attemptId; current.usage.jobs++
      db.prepare(`INSERT INTO dsh_deep_attempts(attempt_id,run_id,node_id,node_revision,requirement_revision,owner_epoch,role,input_digest,prompt,input_artifact_ids_json,repair_of,model_json,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?)`).run(attemptId, current.runId, node.id, node.revision, current.requirementRevision, current.ownerEpoch, job.role, job.inputDigest, job.prompt, JSON.stringify(job.inputArtifactIds), repairOf ?? null, JSON.stringify(current.configuration.roles[job.role]), this.store.now())
      return { runId: current.runId, nodeId: node.id, nodeRevision: node.revision, requirementRevision: current.requirementRevision, ownerEpoch: current.ownerEpoch, ownerId: this.ownerId, attemptId, inputDigest: job.inputDigest }
    })
  }
  async #runJob(state: DeepState, nodeId: string, signal: AbortSignal): Promise<void> {
    const node = state.nodes.find(n => n.id === nodeId)!, role = nextRole(node)!
    const model: DeepModel = state.configuration.roles[role]
    const release = await processDeepSlots.acquire(state.runId, model.provider, state.configuration.localProviders.includes(model.provider), this.maxTotal, signal)
    let authority: DeepAuthority | undefined
    try {
      let job = jobFor(state, node, role, inputArtifacts(state, node, await this.store.artifacts(state.runId)))
      for (let repair = 0; repair <= 1; repair++) {
        authority = await this.#reserve(state, job, authority?.attemptId)
        const output = await this.executor.execute(authority, job, state, signal)
        let reply: ReturnType<typeof parseDeepReply>
        try { reply = parseDeepReply(role, output) }
        catch (error) {
          if (findSecretInValue(output) || repair === 1) throw error
          await this.store.mutate(state.runId, (current, db) => {
            assertDeepAuthority(db, current, authority!, this.store.now())
            db.prepare("UPDATE dsh_deep_attempts SET status='failed' WHERE attempt_id=?").run(authority!.attemptId)
            current.nodes.find(n => n.id === nodeId)!.activeAttemptId = null
          })
          // A fresh job, never a hidden retry inside the executor. Do not forward unbounded malformed output.
          job = { ...job, prompt: `${job.prompt}\nYour preceding response did not match the JSON schema. Return exactly one valid object.`, inputDigest: canonicalContentHash({ original: job.inputDigest, repair: 1 }) }
          continue
        }
        const latest = await this.store.read(state.runId), artifacts = await this.store.artifacts(state.runId)
        const available = currentArtifacts(latest, artifacts).filter(a => job.inputArtifactIds.includes(a.id) || a.nodeId === nodeId && a.nodeRevision === job.nodeRevision)
        const changed = await changedSources(state.rootPath, available)
        if (changed.length) {
          await this.store.mutate(state.runId, (current, db) => {
            assertDeepAuthority(db, current, authority!, this.store.now())
            db.prepare("UPDATE dsh_deep_attempts SET status='failed' WHERE attempt_id=?").run(authority!.attemptId)
            invalidateNodes(current, changed, '参照資料が変更されました。結果の受理を取り消しました。')
          })
          return
        }
        const receipt = evidenceReceipt(reply, latest.nodes.find(n => n.id === nodeId)!.candidate, available, job.inputDigest)
        await this.store.mutate(state.runId, (current, db) => {
          assertDeepAuthority(db, current, authority!, this.store.now())
          const target = current.nodes.find(n => n.id === nodeId)!
          applyReply(current, target, role, reply, target.proposal?.kind === 'decompose' ? target.proposal.children.map(() => randomUUID()) : [])
          target.activeAttemptId = null
          if (target.status === 'accepted') target.receipt = receipt
          db.prepare("UPDATE dsh_deep_attempts SET status='completed',result_json=? WHERE attempt_id=?").run(JSON.stringify(reply), authority!.attemptId)
        })
        await this.notify(await this.store.read(state.runId)).catch(() => {})
        return
      }
    } catch (error) {
      if (authority) await this.store.mutate(state.runId, (current, db) => {
        if (current.phase !== 'running' || current.ownerEpoch !== authority!.ownerEpoch || current.ownerId !== this.ownerId || current.leaseUntil <= this.store.now()) return
        const target = current.nodes.find(n => n.id === nodeId)!
        if (target.activeAttemptId !== authority!.attemptId) return
        const unknown = !!db.prepare("SELECT 1 FROM dsh_deep_budget_reservations WHERE attempt_id=? AND status IN ('reserved','uncertain')").get(authority!.attemptId)
        db.prepare('UPDATE dsh_deep_attempts SET status=? WHERE attempt_id=?').run(unknown ? 'uncertain' : 'failed', authority!.attemptId)
        target.activeAttemptId = null
        if (unknown || error instanceof DeepModelUnavailable) { current.phase = 'paused'; current.reason = error instanceof DeepModelUnavailable ? errorText(error) : '結果が不明な要求があります。記録の再確認が必要です。'; stopClock(current, this.store.now()) }
        else { target.status = 'unresolved'; target.reason = errorText(error) }
      }).catch(() => {})
      else if (!signal.aborted) throw error
    } finally { release() }
  }
}
