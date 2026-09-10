import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SqliteDatabase } from '../db/adapter.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { KiokukoError } from '../errors.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { LedgerStore } from '../ledger/store.js'
import type { DshRuntime } from '../dsh/runtime.js'
import { claimExecutionOwner, readExecutionOwner } from '../dsh/orchestration/execution-owner.js'
import { DeepArtifactSchema, DeepConfigurationSchema, DeepStateSchema, GoalNodeSchema, terminal, type DeepState, type DeepArtifact, type DeepRole } from './core/contracts.js'
import { budgetProblem, stopClock } from './core/budget.js'

export const IntentSchema = z.object({
  revision: z.number().int().nonnegative().default(0),
  startId: z.string(), workspace: z.string(), sessionId: z.string(), rootPath: z.string(), commandId: z.string(), messageId: z.string(),
  task: z.string().max(32_768), status: z.enum(['armed','pending','accepted','paused','cancelled','completed']),
  runId: z.string().nullable(), configuration: DeepConfigurationSchema.nullable(),
  messages: z.array(z.unknown()).max(64), problem: z.string().max(4_096),
})
export type DeepIntent = z.infer<typeof IntentSchema>
export type DeepAttempt = { attempt_id: string; run_id: string; node_id: string; node_revision: number; requirement_revision: number; owner_epoch: number; role: DeepRole; input_digest: string; prompt: string; child_session_id: string | null; status: string; result_json: string | null }
export type DeepOutbox = { event_id: string; start_id: string; run_id: string | null; dsh_session_id: string; kind: 'input' | 'status' | 'report'; payload_json: string; status: string; event_seq: number | null }
export interface DeepAuthority { runId: string; nodeId: string; nodeRevision: number; requirementRevision: number; ownerEpoch: number; ownerId: string; attemptId: string; inputDigest: string }

export function readDeepState(db: SqliteDatabase, runId: string): DeepState {
  const row = db.prepare('SELECT state_json,revision FROM dsh_deep_runs WHERE run_id=?').get<{ state_json: string; revision: number }>(runId)
  if (!row) throw new KiokukoError('NOT_FOUND', 'Deep runが見つかりません')
  const nodes = db.prepare('SELECT state_json FROM dsh_deep_nodes WHERE run_id=? ORDER BY rowid').all<{ state_json: string }>(runId).map(row => GoalNodeSchema.parse(JSON.parse(row.state_json)))
  return DeepStateSchema.parse({ ...JSON.parse(row.state_json), revision: row.revision, nodes })
}
function persistState(db: SqliteDatabase, state: DeepState, expectedRevision: number): void {
  const parsed = DeepStateSchema.parse(state)
  const { nodes, ...header } = parsed
  db.prepare('UPDATE dsh_deep_runs SET state_json=?,phase=?,revision=revision+1 WHERE run_id=? AND revision=?')
    .run(JSON.stringify({ ...header, revision: expectedRevision + 1 }), state.phase, state.runId, expectedRevision)
  if (db.prepare('SELECT changes() AS count').get<{ count: number }>()?.count !== 1) throw new KiokukoError('CONFLICT', 'Deep runの版が変わりました')
  for (const node of nodes) db.prepare(`INSERT INTO dsh_deep_nodes(run_id,node_id,revision,state_json) VALUES(?,?,?,?)
    ON CONFLICT(run_id,node_id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json WHERE state_json<>excluded.state_json`)
    .run(state.runId, node.id, node.revision, JSON.stringify(node))
  db.prepare('DELETE FROM dsh_deep_edges WHERE run_id=?').run(state.runId)
  for (const node of nodes) {
    if (node.parentId) db.prepare("INSERT INTO dsh_deep_edges VALUES(?,?,?,'child')").run(state.runId, node.parentId, node.id)
    for (const id of node.dependencies) db.prepare("INSERT INTO dsh_deep_edges VALUES(?,?,?,'dependency')").run(state.runId, node.id, id)
    if (node.receipt) db.prepare('INSERT OR IGNORE INTO dsh_deep_evidence VALUES(?,?,?,?)').run(state.runId, node.id, node.revision, JSON.stringify(node.receipt))
  }
  state.revision = expectedRevision + 1
}
export function assertDeepAuthority(db: SqliteDatabase, state: DeepState, authority: DeepAuthority, now: number): DeepAttempt {
  assertSessionOwnership(db, state)
  const node = state.nodes.find(node => node.id === authority.nodeId)
  if (state.phase !== 'running' || state.ownerEpoch !== authority.ownerEpoch || state.ownerId !== authority.ownerId || state.leaseUntil <= now || state.requirementRevision !== authority.requirementRevision || node?.revision !== authority.nodeRevision || node.activeAttemptId !== authority.attemptId) {
    throw new KiokukoError('CONFLICT', 'Deep試行の権限または版が失効しています')
  }
  const attempt = db.prepare('SELECT * FROM dsh_deep_attempts WHERE attempt_id=? AND run_id=?').get<DeepAttempt>(authority.attemptId, state.runId)
  if (!attempt || !['reserved','started'].includes(attempt.status) || attempt.input_digest !== authority.inputDigest) throw new KiokukoError('CONFLICT', 'Deep試行は実行可能ではありません')
  return attempt
}
function assertSessionOwnership(db: SqliteDatabase, state: DeepState): void {
  const owner = readExecutionOwner(db, state.sessionId)
  if (owner?.mode !== 'deep-thinker' || owner.run_id !== state.runId || owner.start_id !== state.startId || owner.workspace !== state.workspace) throw new KiokukoError('CONFLICT', 'Deep Session所有権が失効しています')
}

export class DeepStore {
  constructor(readonly runtime: Pick<DshRuntime, 'withDatabase'>, readonly now: () => number = Date.now) {}
  database<T>(fn: (db: SqliteDatabase) => T): Promise<T> { return this.runtime.withDatabase(db => fn(db)) }
  transaction<T>(fn: (db: SqliteDatabase) => T): Promise<T> { return this.database(db => withImmediateTransaction(db, () => fn(db))) }
  read(runId: string): Promise<DeepState> { return this.database(db => readDeepState(db, runId)) }
  mutate<T>(runId: string, fn: (state: DeepState, db: SqliteDatabase) => T): Promise<T> {
    return this.transaction(db => { const state = readDeepState(db, runId); const revision = state.revision; const result = fn(state, db); persistState(db, state, revision); return result })
  }
  intent(sessionId: string, activeOnly = false): Promise<DeepIntent | undefined> {
    return this.database(db => {
      const rows = db.prepare(`SELECT state_json FROM dsh_deep_intents WHERE dsh_session_id=? ${activeOnly ? "AND status IN ('armed','pending','accepted','paused')" : ''} ORDER BY created_at DESC,rowid DESC LIMIT 1`).all<{ state_json: string }>(sessionId)
      return rows[0] ? IntentSchema.parse(JSON.parse(rows[0].state_json)) : undefined
    })
  }
  replayedCommand(sessionId: string, commandId: string, task: string, armed: boolean): Promise<DeepIntent | undefined> {
    return this.database(db => this.#replayedCommand(db, sessionId, commandId, task, armed))
  }
  #replayedCommand(db: SqliteDatabase, sessionId: string, commandId: string, task: string, armed: boolean): DeepIntent | undefined {
    const row = db.prepare('SELECT state_json,command_digest FROM dsh_deep_intents WHERE dsh_session_id=? AND command_id=?').get<{state_json:string;command_digest:string}>(sessionId, commandId)
    if (!row) return undefined
    if (row.command_digest !== canonicalContentHash({task,armed})) throw new KiokukoError('CONFLICT', '同じcommand IDに異なる入力は指定できません')
    return IntentSchema.parse(JSON.parse(row.state_json))
  }
  saveIntentInTransaction(db: SqliteDatabase, intent: DeepIntent): void {
    const next = IntentSchema.parse({ ...intent, revision: intent.revision + 1 })
    db.prepare('UPDATE dsh_deep_intents SET state_json=?,status=?,run_id=?,message_id=?,input_digest=?,revision=revision+1 WHERE start_id=? AND revision=?')
      .run(JSON.stringify(next), intent.status, intent.runId, intent.messageId, canonicalContentHash({ task: intent.task }), intent.startId, intent.revision)
    if (db.prepare('SELECT changes() AS count').get<{count:number}>()?.count !== 1) throw new KiokukoError('CONFLICT', 'Deep入力が別の処理で更新されました。再取得してください。')
    intent.revision = next.revision
  }
  async createIntent(input: Omit<DeepIntent, 'startId' | 'runId' | 'messageId' | 'messages' | 'problem' | 'revision'> & { messages?: unknown[] }): Promise<DeepIntent> {
    return this.transaction(db => {
      const repeated = this.#replayedCommand(db, input.sessionId, input.commandId, input.task, input.status === 'armed')
      if (repeated) return repeated
      const previous = db.prepare("SELECT state_json FROM dsh_deep_intents WHERE dsh_session_id=? AND status IN ('armed','pending','accepted','paused')").get<{ state_json: string }>(input.sessionId)
      if (previous) {
        const existing = IntentSchema.parse(JSON.parse(previous.state_json))
        if (existing.task === input.task || existing.runId) return existing
        throw new KiokukoError('CONFLICT', '別のDeep要求を保持しています。取消し後に開始してください。')
      }
      const intent = IntentSchema.parse({ ...input, startId: randomUUID(), messageId: randomUUID(), runId: null, messages: input.messages ?? [], problem: '' })
      claimExecutionOwner(db, { workspace: input.workspace, sessionId: input.sessionId, mode: 'deep-thinker', startId: intent.startId })
      db.prepare('INSERT INTO dsh_deep_intents(start_id,workspace,dsh_session_id,command_id,command_digest,message_id,input_digest,state_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(intent.startId, intent.workspace, intent.sessionId, intent.commandId, canonicalContentHash({task: input.task, armed: input.status === 'armed'}), intent.messageId, canonicalContentHash({ task: intent.task }), JSON.stringify(intent), intent.status, this.now())
      this.enqueue(db, { id: `deep-intent:${intent.startId}`, startId: intent.startId, runId: null, sessionId: intent.sessionId, kind: 'status', payload: { phase: intent.status, text: intent.status === 'armed' ? 'Deep予約中：次の人間による通常入力を待っています。' : 'Deepへの入力を保存しました。' } })
      if (intent.status === 'pending' && !intent.messages.length) this.enqueue(db, { id: `deep-input:${intent.startId}`, startId: intent.startId, runId: null, sessionId: intent.sessionId, kind: 'input', payload: { message: { id: intent.messageId, role: 'user', content: [{ type: 'text', text: intent.task }], source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions' } } } })
      return intent
    })
  }
  async createRun(state: DeepState): Promise<void> {
    await this.transaction(db => {
      if (db.prepare('SELECT 1 FROM dsh_deep_runs WHERE run_id=?').get(state.runId)) return
      const row = db.prepare('SELECT state_json FROM dsh_deep_intents WHERE start_id=?').get<{state_json:string}>(state.startId)
      const intent = row && IntentSchema.parse(JSON.parse(row.state_json))
      if (!intent || intent.status !== 'pending' || intent.task !== state.task || canonicalContentHash(intent.configuration) !== canonicalContentHash(state.configuration)) throw new KiokukoError('CONFLICT', 'Deep開始入力が変更または取り消されました')
      const run = db.prepare("SELECT status FROM ledger_runs WHERE run_id=? AND workspace=? AND dsh_session_id=?").get<{status:string}>(state.runId, state.workspace, state.sessionId)
      if (!run || !['intake','active'].includes(run.status)) throw new KiokukoError('CONFLICT', 'Deep受付runが失効しています')
      const { nodes, ...header } = DeepStateSchema.parse(state)
      db.prepare('INSERT INTO dsh_deep_runs VALUES(?,?,?,?,?,0,?)').run(state.runId, state.startId, state.workspace, state.sessionId, state.phase, JSON.stringify(header))
      persistState(db, { ...state, nodes }, 0)
      this.saveIntentInTransaction(db, { ...intent, runId: state.runId, status: 'accepted' })
    })
  }
  enqueue(db: SqliteDatabase, input: { id: string; startId: string; runId: string | null; sessionId: string; kind: DeepOutbox['kind']; payload: unknown }): void {
    db.prepare("INSERT OR IGNORE INTO dsh_deep_outbox VALUES(?,?,?,?,?,?,'pending',NULL,?)")
      .run(input.id, input.startId, input.runId, input.sessionId, input.kind, JSON.stringify(input.payload), this.now())
  }
  pending(sessionId: string): Promise<DeepOutbox[]> { return this.database(db => db.prepare("SELECT * FROM dsh_deep_outbox WHERE dsh_session_id=? AND status<>'delivered' ORDER BY created_at,rowid").all<DeepOutbox>(sessionId)) }
  artifacts(runId: string): Promise<DeepArtifact[]> { return this.database(db => db.prepare('SELECT state_json FROM dsh_deep_artifacts WHERE run_id=?').all<{state_json:string}>(runId).map(row => DeepArtifactSchema.parse(JSON.parse(row.state_json)))) }
  async claim(runId: string, ownerId: string): Promise<DeepState> {
    await this.mutate(runId, (state, db) => {
      if (terminal(state.phase)) throw new KiokukoError('CONFLICT', '終了済みのDeep runは再開できません')
      assertSessionOwnership(db, state)
      if (state.ownerId && state.ownerId !== ownerId && state.leaseUntil > this.now()) throw new KiokukoError('CONFLICT', '別の実行プロセスがこのDeep runを所有しています')
      const pending = db.prepare("SELECT 1 FROM dsh_deep_attempts WHERE run_id=? AND status IN ('reserved','started','uncertain') LIMIT 1").get(runId)
      if (pending) throw new KiokukoError('CONFLICT', '結果が不明な試行があります。記録を再確認してください。')
      stopClock(state, this.now())
      state.ownerEpoch++; state.ownerId = ownerId; state.leaseUntil = this.now() + 45_000
      state.phase = 'running'; state.reason = ''; state.usage.activeSince = this.now()
    })
    return this.read(runId)
  }
  async renew(runId: string, ownerId: string, epoch: number): Promise<void> {
    await this.mutate(runId, state => {
      if (state.ownerId !== ownerId || state.ownerEpoch !== epoch || state.leaseUntil <= this.now() || state.phase !== 'running') throw new KiokukoError('CONFLICT', 'Deep所有権が失効しました')
      state.leaseUntil = this.now() + 45_000
    })
  }
  async reserveRequest(authority: DeepAuthority, estimatedTokens: number): Promise<string> {
    return this.mutate(authority.runId, (state, db) => {
      assertDeepAuthority(db, state, authority, this.now())
      const problem = budgetProblem(state, this.now(), 'request', estimatedTokens)
      if (problem) throw new KiokukoError('CONFLICT', problem)
      const id = randomUUID()
      state.usage.requests++; state.usage.reservedTokens += estimatedTokens; state.usage.estimated = true
      db.prepare("INSERT INTO dsh_deep_budget_reservations VALUES(?,?,?,?,'reserved',NULL,?,'agent')").run(id, state.runId, authority.attemptId, estimatedTokens, this.now())
      return id
    })
  }
  async settleRequest(runId: string, id: string, actual: number | undefined, finished: boolean): Promise<void> {
    await this.mutate(runId, (state, db) => {
      const reservation = db.prepare("SELECT tokens,status FROM dsh_deep_budget_reservations WHERE reservation_id=? AND run_id=?").get<{tokens:number;status:string}>(id, runId)
      if (!reservation || reservation.status !== 'reserved') return
      const measured = actual !== undefined && Number.isFinite(actual) && actual >= 0
      if (finished || measured) { state.usage.reservedTokens -= reservation.tokens; state.usage.tokens += measured ? actual! : reservation.tokens }
      db.prepare('UPDATE dsh_deep_budget_reservations SET status=?,actual_tokens=? WHERE reservation_id=?').run(finished || measured ? 'settled' : 'uncertain', measured ? actual! : null, id)
    })
  }
  async reserveMemoryRequest(runId: string, processId: string, tokens: number): Promise<string> {
    return this.mutate(runId, (state, db) => {
      const job = db.prepare('SELECT status,process_id,lease_until,reservation_id FROM dsh_deep_finalizations WHERE run_id=?').get<{status:string;process_id:string|null;lease_until:number|null;reservation_id:string|null}>(runId)
      if (job?.status !== 'processing' || job.process_id !== processId || !job.lease_until || job.lease_until <= this.now() || job.reservation_id) throw new Error('Deep memory request is stale or has already been sent')
      const problem = budgetProblem(state, this.now(), 'request', tokens); if (problem) throw new Error(problem)
      const id = randomUUID(); state.usage.requests++; state.usage.reservedTokens += tokens
      db.prepare("INSERT INTO dsh_deep_budget_reservations VALUES(?,?,NULL,?,'reserved',NULL,?,'memory')").run(id, runId, tokens, this.now())
      db.prepare('UPDATE dsh_deep_finalizations SET reservation_id=? WHERE run_id=?').run(id, runId)
      return id
    })
  }
  finishInTransaction(db: SqliteDatabase, state: DeepState, phase: 'answered' | 'partial' | 'blocked' | 'failed' | 'cancelled', reason: string, report: unknown): void {
    state.phase = phase; state.reason = reason; stopClock(state, this.now()); state.ownerEpoch++; state.ownerId = null; state.leaseUntil = 0
    new LedgerStore(db).updateRunStatusInTransaction(state.runId, phase === 'answered' ? 'completed' : phase === 'cancelled' ? 'cancelled' : 'failed')
    const row = db.prepare('SELECT state_json FROM dsh_deep_intents WHERE start_id=?').get<{state_json:string}>(state.startId)!
    this.saveIntentInTransaction(db, { ...IntentSchema.parse(JSON.parse(row.state_json)), status: phase === 'cancelled' ? 'cancelled' : 'completed' })
    this.enqueue(db, { id: `deep-report:${state.runId}`, startId: state.startId, runId: state.runId, sessionId: state.sessionId, kind: 'report', payload: report })
    this.enqueue(db, { id: `deep-terminal:${state.runId}`, startId: state.startId, runId: state.runId, sessionId: state.sessionId, kind: 'status', payload: {text: `Deep: ${phase === 'answered' ? '完了' : phase === 'partial' ? '部分回答' : phase === 'cancelled' ? '取消済み' : '停止'}${reason ? ` — ${reason}` : ''}`} })
    db.prepare("INSERT OR IGNORE INTO dsh_deep_finalizations(run_id,source_json,status) VALUES(?,?,'pending')").run(state.runId, JSON.stringify({ kind: 'deep-report', report, configuration: state.configuration, workspace: state.workspace, sessionId: state.sessionId,
      accepted: state.nodes.filter(n => n.status === 'accepted' && n.receipt).map(n => ({ nodeId: n.id, revision: n.revision, candidate: n.candidate, receipt: n.receipt })) }))
  }
}
