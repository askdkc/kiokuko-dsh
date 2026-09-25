import type { SqliteDatabase } from '../../db/adapter.js'
import { ModelBindingSchema, type ModelBinding } from '../model-configuration.js'
import type { ModelAutoConfiguration, ModelAutoReason } from './contracts.js'

export interface AutoSession {
  readonly mode: ModelAutoConfiguration['mode']
  readonly revision: number
  readonly manualSeq: number | null
  readonly pin: ModelBinding | null
  readonly last: unknown
}
export interface AutoRoute {
  readonly runId: string
  readonly sessionId: string
  readonly requestId: string
  readonly turn: number
  readonly inputDigest: string
  readonly status: 'deciding' | 'selected' | 'retained' | 'cancelled'
  readonly sessionRevision: number
  readonly binding: ModelBinding | null
  readonly baseline: ModelBinding | null
  readonly reason: ModelAutoReason
}
type Runtime = { withDatabase<T>(operation: (db: SqliteDatabase) => T): Promise<T> }
const binding = (json: unknown): ModelBinding | null => json == null ? null : ModelBindingSchema.parse(JSON.parse(String(json)))
const now = () => new Date().toISOString()

/** Session changes and route completion are compare-and-set writes in one project database. */
export class ModelAutoStore {
  constructor(private readonly runtime: Runtime, private readonly defaultMode: ModelAutoConfiguration['mode'],
    private readonly configDigest: string) {}
  async session(sessionId: string): Promise<AutoSession> {
    return this.runtime.withDatabase(db => {
      db.prepare('INSERT OR IGNORE INTO dsh_model_auto_sessions (session_id,mode,config_digest,updated_at) VALUES (?,?,?,?)')
        .run(sessionId, this.defaultMode, this.configDigest, now())
      db.prepare('UPDATE dsh_model_auto_sessions SET mode=?,config_digest=?,revision=revision+1,pin_json=NULL,manual_seq=NULL,updated_at=? WHERE session_id=? AND config_digest<>?')
        .run(this.defaultMode, this.configDigest, now(), sessionId, this.configDigest)
      if (db.prepare('SELECT changes() AS count').get<{ count: number }>()?.count === 1)
        db.prepare("UPDATE dsh_model_auto_routes SET status='cancelled',reason='session_changed',updated_at=? WHERE session_id=? AND status='deciding'").run(now(), sessionId)
      const row = db.prepare('SELECT mode,revision,manual_seq,pin_json,last_json FROM dsh_model_auto_sessions WHERE session_id=?').get<any>(sessionId)!
      return { mode: row.mode, revision: row.revision, manualSeq: row.manual_seq,
        pin: binding(row.pin_json), last: row.last_json == null ? null : JSON.parse(String(row.last_json)) }
    })
  }
  async setMode(sessionId: string, mode: ModelAutoConfiguration['mode']): Promise<AutoSession> {
    await this.session(sessionId)
    await this.runtime.withDatabase(db => {
      db.prepare("UPDATE dsh_model_auto_sessions SET mode=?,revision=revision+1,pin_json=CASE WHEN ?='auto' THEN NULL ELSE pin_json END,manual_seq=CASE WHEN ?='auto' THEN NULL ELSE manual_seq END,updated_at=? WHERE session_id=?")
        .run(mode, mode, mode, now(), sessionId)
      db.prepare("UPDATE dsh_model_auto_routes SET status='cancelled',reason='session_changed',updated_at=? WHERE session_id=? AND status='deciding'").run(now(), sessionId)
    })
    return this.session(sessionId)
  }
  async manual(sessionId: string, seq: number, selected: ModelBinding): Promise<void> {
    await this.session(sessionId)
    await this.runtime.withDatabase(db => {
      db.prepare('UPDATE dsh_model_auto_sessions SET revision=revision+1,manual_seq=?,pin_json=?,updated_at=? WHERE session_id=? AND (manual_seq IS NULL OR manual_seq<?)')
        .run(seq, JSON.stringify(ModelBindingSchema.parse(selected)), now(), sessionId, seq)
      if (db.prepare('SELECT changes() AS count').get<{ count: number }>()?.count !== 1) return
      db.prepare("UPDATE dsh_model_auto_routes SET status='cancelled',reason='manual_pin',updated_at=? WHERE session_id=? AND status='deciding'").run(now(), sessionId)
    })
  }
  async route(runId: string): Promise<AutoRoute | undefined> {
    return this.runtime.withDatabase(db => {
      const row = db.prepare('SELECT * FROM dsh_model_auto_routes WHERE run_id=?').get<any>(runId)
      return row && { runId: row.run_id, sessionId: row.session_id, requestId: row.request_id, turn: row.native_turn,
        inputDigest: row.input_digest, status: row.status, sessionRevision: row.session_revision,
        binding: binding(row.binding_json), baseline: binding(row.baseline_json), reason: row.reason }
    })
  }
  async claim(input: { runId: string; sessionId: string; requestId: string; turn: number; inputDigest: string;
    configDigest: string; catalogDigest: string; sessionRevision: number; policy: string }): Promise<AutoRoute> {
    await this.runtime.withDatabase(db => db.prepare(`INSERT OR IGNORE INTO dsh_model_auto_routes
      (run_id,session_id,request_id,native_turn,input_digest,policy_version,config_digest,catalog_digest,session_revision,status,reason,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'deciding','decision_unavailable',?)`).run(input.runId, input.sessionId, input.requestId,
        input.turn, input.inputDigest, input.policy, input.configDigest, input.catalogDigest, input.sessionRevision, now()))
    const route = await this.route(input.runId)
    if (!route || route.sessionId !== input.sessionId || route.requestId !== input.requestId || route.turn !== input.turn
      || route.inputDigest !== input.inputDigest) throw new Error('Model-auto run identity or input changed')
    return route
  }
  async complete(runId: string, revision: number, status: 'selected' | 'retained', reason: ModelAutoReason,
    selected: ModelBinding | null, elapsedMs: number): Promise<boolean> {
    return this.runtime.withDatabase(db => {
      db.prepare(`UPDATE dsh_model_auto_routes SET status=?,reason=?,binding_json=?,elapsed_ms=?,updated_at=?
        WHERE run_id=? AND status='deciding' AND session_revision=?
        AND session_revision=(SELECT revision FROM dsh_model_auto_sessions WHERE session_id=dsh_model_auto_routes.session_id)`)
        .run(status, reason, selected ? JSON.stringify(selected) : null, elapsedMs, now(), runId, revision)
      return db.prepare('SELECT changes() AS count').get<{ count: number }>()?.count === 1
    })
  }
  async recover(runId: string): Promise<AutoRoute | undefined> {
    await this.runtime.withDatabase(db => db.prepare("UPDATE dsh_model_auto_routes SET status='retained',reason='restart_no_retry',updated_at=? WHERE run_id=? AND status='deciding'").run(now(), runId))
    return this.route(runId)
  }
  async baseline(runId: string, native: ModelBinding): Promise<void> {
    await this.runtime.withDatabase(db => db.prepare('UPDATE dsh_model_auto_routes SET baseline_json=? WHERE run_id=? AND baseline_json IS NULL')
      .run(JSON.stringify(ModelBindingSchema.parse(native)), runId))
  }
  async observed(sessionId: string, value: unknown): Promise<void> {
    await this.session(sessionId)
    await this.runtime.withDatabase(db => db.prepare('UPDATE dsh_model_auto_sessions SET last_json=?,updated_at=? WHERE session_id=?')
      .run(JSON.stringify(value), now(), sessionId))
  }
}
