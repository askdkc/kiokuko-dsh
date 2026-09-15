import type { SqliteDatabase } from '../db/adapter.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { KiokukoError } from '../errors.js'
import { canonicalContentHash } from '../serialization/validate.js'
import type { ScopedContextResult } from '../context/scoped-broker.js'

export interface RefreshMetadata extends Record<string, unknown> { revision: number; generation: number; fullCount: number; focus: string | null; config: string }
export function readRefreshMetadata(db: SqliteDatabase, runId: string): RefreshMetadata | undefined {
  const row = db.prepare(`SELECT state_revision AS revision, request_generation AS generation, full_search_count AS fullCount,
    latest_focus_digest AS focus, config_digest AS config FROM dsh_enno_memory_refresh WHERE run_id=?`).get<RefreshMetadata>(runId)
  if (row && ([row.revision, row.generation, row.fullCount].some(value => !Number.isSafeInteger(value) || value < 0)
    || typeof row.config !== 'string' || !/^[a-f0-9]{64}$/u.test(row.config)
    || row.focus !== null && (typeof row.focus !== 'string' || !/^[a-f0-9]{64}$/u.test(row.focus)))) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored memory refresh metadata is invalid')
  }
  return row
}

/** Reservations are never refunded. The existing run remains the authority. */
export function reserveMemoryRefresh(db: SqliteDatabase, input: { runId: string; config: string; full: boolean;
  maxFull: number; assertCurrent: () => void }): RefreshMetadata | undefined {
  return withImmediateTransaction(db, () => {
    input.assertCurrent()
    if (db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get(input.runId)?.status !== 'active') {
      throw new KiokukoError('CONFLICT', 'Memory refresh run is not active')
    }
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO dsh_enno_memory_refresh(run_id,config_digest,updated_at) VALUES(?,?,?) ON CONFLICT DO NOTHING`)
      .run(input.runId, input.config, now)
    const row = readRefreshMetadata(db, input.runId)!
    if (input.full && row.fullCount >= input.maxFull) return undefined
    const updated = db.prepare(`UPDATE dsh_enno_memory_refresh SET state_revision=state_revision+1,
      request_generation=request_generation+1, full_search_count=full_search_count+?, config_digest=?, updated_at=?
      WHERE run_id=? AND state_revision=? RETURNING run_id`).get(input.full ? 1 : 0, input.config, now, input.runId, row.revision)
    if (!updated) throw new KiokukoError('CONFLICT', 'Memory refresh reservation changed')
    return readRefreshMetadata(db, input.runId)!
  })
}

/** Called only inside the broker's delivery transaction, after its final authority checks. */
export function commitMemoryRefresh(db: SqliteDatabase, input: { runId: string; ticket: RefreshMetadata; focus: string;
  context: ScopedContextResult | null }): void {
  const { context, ticket } = input
  const updated = db.prepare(`UPDATE dsh_enno_memory_refresh SET state_revision=state_revision+1, latest_focus_digest=?,
    last_applied_query_digest=?,last_selected_set_digest=?,last_delivery_id=?,updated_at=?
    WHERE run_id=? AND state_revision=? AND request_generation=? AND config_digest=? RETURNING run_id`)
    .get(input.focus, context?.queryHash ?? null,
      canonicalContentHash((context?.items ?? []).map(item => [item.entryId, item.revision, item.projection ?? null])),
      context?.deliveryId ?? null, new Date().toISOString(), input.runId, ticket.revision, ticket.generation, ticket.config)
  if (!updated) throw new KiokukoError('CONFLICT', 'Memory refresh generation is stale')
}
