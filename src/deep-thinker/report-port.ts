import type { DshLogEvent } from '../dsh/session-memory-finalizer.js'
import type { DeepNativeAgent } from './native-executor.js'
import type { DeepStore } from './store.js'

export interface DeepReportSession { id: string; header?: { cwd?: string }; snapshotEvents(): readonly DshLogEvent[]; append(type: string, data: unknown, options?: { ignorable: true }): { seq: number } }
export interface DeepSessions { get(id: string): unknown; flush?(session: object): PromiseLike<unknown> }
export class DeepReportPort {
  readonly #active = new Map<string, Promise<void>>()
  constructor(readonly store: DeepStore, readonly sessions: DeepSessions | undefined) {}
  async snapshot(sessionId: string): Promise<{ id: string; kind: 'report' | 'status'; text: string; delivered: boolean }[]> {
    return this.store.database(db => {
      const reports = db.prepare("SELECT * FROM dsh_deep_outbox WHERE dsh_session_id=? AND kind='report' ORDER BY rowid DESC LIMIT 8").all<any>(sessionId)
      const status = db.prepare("SELECT * FROM dsh_deep_outbox WHERE dsh_session_id=? AND kind='status' ORDER BY rowid DESC LIMIT 1").get<any>(sessionId)
      return [...reports, ...(status ? [status] : [])].map(row => ({ id: row.event_id, kind: row.kind, text: JSON.parse(row.payload_json).text, delivered: row.status === 'delivered' }))
    })
  }
  async acknowledge(sessionId: string, ids: readonly string[]): Promise<void> {
    await this.store.transaction(db => {
      for (const id of ids) {
        const item = db.prepare("SELECT rowid,kind FROM dsh_deep_outbox WHERE event_id=? AND dsh_session_id=? AND kind<>'input'").get<{rowid:number;kind:string}>(id, sessionId)
        if (!item) throw new Error('Deep report identity mismatch')
        if (item.kind === 'status') db.prepare("UPDATE dsh_deep_outbox SET status='delivered' WHERE dsh_session_id=? AND kind='status' AND rowid<=?").run(sessionId, item.rowid)
        else db.prepare("UPDATE dsh_deep_outbox SET status='delivered' WHERE event_id=?").run(id)
      }
    })
  }
  session(agent: DeepNativeAgent): DeepReportSession {
    const session = agent.session as unknown as DeepReportSession | undefined
    if (!session || this.sessions?.get(session.id) !== session || typeof session.append !== 'function' || typeof session.snapshotEvents !== 'function' || !this.sessions.flush) throw new Error('Deep requires the exact durable Session event source and flush capability')
    return session
  }
  deliver(agent: DeepNativeAgent): Promise<void> {
    const session = this.session(agent), active = this.#active.get(session.id)
    if (active) return active
    const done = this.#deliver(agent, session).finally(() => this.#active.delete(session.id))
    this.#active.set(session.id, done); return done
  }
  async #deliver(agent: DeepNativeAgent, session: DeepReportSession): Promise<void> {
    for (const item of await this.store.pending(session.id)) {
      const payload = JSON.parse(item.payload_json)
      if (item.kind === 'input') {
        const present = session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && (event.data as any)?.inserted?.some((message: any) => message.id === payload.message.id)
          || event.type === 'user/message' && (event.data as any)?.message?.id === payload.message.id)
        if (!present && item.status === 'sending') continue // Crash before/after send is not an automatic resend.
        if (!present) {
          const claimed = await this.store.transaction(db => {
            db.prepare("UPDATE dsh_deep_outbox SET status='sending' WHERE event_id=? AND status='pending'").run(item.event_id)
            return db.prepare('SELECT changes() AS count').get<{count:number}>()?.count === 1
          })
          if (!claimed) continue
          if (!agent.followup) throw new Error('Deep input delivery requires native followup')
          agent.followup(payload.message)
        }
        await this.sessions!.flush!(session)
        await this.store.database(db => db.prepare("UPDATE dsh_deep_outbox SET status='delivered' WHERE event_id=?").run(item.event_id))
      }
    }
  }
}
