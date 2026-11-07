import type { SqliteDatabase } from '../../db/adapter.js'
import type { DshLogEvent } from '../session-memory-finalizer.js'
import type { CodingIdentity } from './contracts.js'

interface CodingObservation {
  ref: string
  tool?: string
  outcome: string
  exitCode?: number
}

interface ObservationSource extends CodingIdentity {
  turn?: number | undefined
  agent: { session?: { id: string; snapshotEvents?(): readonly DshLogEvent[] } }
}

/** Project existing receipts and the current turn's native log, without copying tool payloads. */
export function codingObservations(db: SqliteDatabase, source: ObservationSource,
  refs?: readonly string[]): CodingObservation[] {
  const owned = refs === undefined
    ? db.prepare('SELECT operation_id, receipt_json FROM dsh_owned_operations WHERE run_id=? ORDER BY rowid DESC LIMIT 32')
        .all<{operation_id: string; receipt_json: string}>(source.runId)
    : refs.flatMap(ref => {
        if (!ref.startsWith('owned:')) return []
        const row = db.prepare('SELECT operation_id, receipt_json FROM dsh_owned_operations WHERE run_id=? AND operation_id=?')
          .get<{operation_id: string; receipt_json: string}>(source.runId, ref.slice(6))
        return row ? [row] : []
      })
  const results: CodingObservation[] = owned.map(row => {
    const receipt = JSON.parse(row.receipt_json) as { kind: string; state: string; exitCode?: number }
    return { ref: `owned:${row.operation_id}`, tool: receipt.kind, outcome: receipt.state,
      ...(typeof receipt.exitCode === 'number' ? { exitCode: receipt.exitCode } : {}) }
  })
  const checks = refs === undefined
    ? db.prepare('SELECT call_id,outcome FROM dsh_completion_executions WHERE run_id=? ORDER BY rowid DESC LIMIT 32')
        .all<{call_id: string; outcome: string}>(source.runId)
    : refs.flatMap(ref => {
        const row = db.prepare('SELECT call_id,outcome FROM dsh_completion_executions WHERE run_id=? AND call_id=?')
          .get<{call_id: string; outcome: string}>(source.runId, ref)
        return row ? [row] : []
      })
  results.push(...checks.map(row => ({ ref: row.call_id, outcome: row.outcome })))

  const session = source.agent.session
  if (source.turn === undefined || session?.id !== source.sessionId) return results
  const events = session.snapshotEvents?.() ?? []
  const start = events.filter(event => event.type === 'turn/start').at(-1)
  if (!start || (start.data as { turn?: number } | undefined)?.turn !== source.turn) return results
  const calls = new Map<string, { tool: string; seq: number }>()
  const native: CodingObservation[] = []
  const requested = refs && new Set(refs)
  for (const event of events) {
    if (event.seq <= start.seq) continue
    const data = event.data as { turn?: number; callId?: string; name?: string; isError?: boolean;
      message?: { toolCallId?: string; isError?: boolean } } | undefined
    if (data?.turn !== source.turn) continue
    if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
      calls.set(data.callId, { tool: data.name, seq: event.seq })
      continue
    }
    if (event.type !== 'tool/result') continue
    const id = data?.message?.toolCallId ?? data?.callId
    const call = typeof id === 'string' ? calls.get(id) : undefined
    if (!call || call.seq >= event.seq) continue
    const ref = `native:${source.sessionId}:${event.seq}`
    if (!requested || requested.has(ref)) native.push({ ref, tool: call.tool,
      outcome: data?.message?.isError || data?.isError ? 'error' : 'returned' })
  }
  return [...results, ...native.slice(-32)]
}
