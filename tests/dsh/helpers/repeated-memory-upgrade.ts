import assert from 'node:assert/strict'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareRepeatedWorkspace, deadline } from './repeated-memory-native.js'
import { initializeDatabase } from '../../../src/dsh/database.js'
import { openConnection } from '../../../src/db/connection.js'
import { DshRunIntakeService } from '../../../src/dsh/run-intake-service.js'
import { readContextRunProfileBinding } from '../../../src/context/run-state.js'
import { scopedDeliveryId, readContextDelivery, type ContextDeliveryInput } from '../../../src/context/delivery.js'
import { recordEntry } from '../../../src/memory/entries.js'
import { canonicalJson } from '../../../src/serialization/validate.js'
import { CONTEXT_RANKING_COMPONENTS_V2 } from '../../../src/context/ranking.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import { DshMemoryFinalizer } from '../../../src/dsh/session-memory-finalizer.js'
import type { FinalizationInputMode } from '../../../src/dsh/efficiency.js'
import { recordRepeatedStage } from './repeated-memory-report.js'

/** Historical delivery/pending job only; the three measured episodes are native executions. */
export async function upgradeRepeatedWorkspace(root: string, mode: FinalizationInputMode) {
  const legacy = join(root, 'legacy-migrations')
  await mkdir(legacy)
  for (const file of await readdir('migrations')) if (/^0(?:0\d|1[0-3])_/u.test(file)) await copyFile(join('migrations', file), join(legacy, file))
  await prepareRepeatedWorkspace(root, legacy)
  const databasePath = join(root, '.git', 'state.sqlite3'), db = openConnection(databasePath)
  let delivery: ContextDeliveryInput
  const now = new Date().toISOString()
  try {
    const opened = new DshRunIntakeService(db).openRun({ idempotencyKey: 'legacy-intake', dshSessionId: 'legacy-session', request: {
      apiVersion: '1', workspace: 'repeated-memory', task: { title: 'Inspect archived design', query: 'Inspect archived design', profileHints: { taskType: 'chat', target: null, expected: null, constraints: null } },
      captureProfile: 'minimal', coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' }, metadata: {}, capabilities: [] } })
    const run = new LedgerStore(db).readRun(opened.runId)!, binding = readContextRunProfileBinding(db, run.runId, run.lastSequence)
    const entry = recordEntry(db, { workspace: run.workspace, kind: 'reference', title: 'Archived design', body: 'Keep the historical delivery text.', summary: null, scope: { visibility: 'project' }, createdBy: 'legacy-fixture' })
    const body = { workspace: run.workspace, runId: run.runId, throughSequence: run.lastSequence, intakeSessionId: binding.intakeSessionId, taskProfileHash: binding.profileHash,
      queryHash: 'a'.repeat(64), policyVersion: 'context-ranking-v6', charBudget: 4000, charCount: entry.title.length + entry.body.length, truncated: false, createdAt: now,
      items: [{ entryId: entry.id, entryRevision: entry.revision, rank: 1, scoreComponents: Object.fromEntries(CONTEXT_RANKING_COMPONENTS_V2.map(key => [key, 0])) as ContextDeliveryInput['items'][number]['scoreComponents'], selectionReasons: ['candidate'] }] }
    delivery = { ...body, deliveryId: scopedDeliveryId(body) }
    // Write precisely the historical v6 columns, before migration 014 exists.
    db.prepare(`INSERT INTO context_deliveries (delivery_id,run_id,through_sequence,intake_session_id,task_profile_hash,query_hash,policy_version,external_sync_summary_json,char_budget,char_count,truncated,created_at,score_schema_version)
      VALUES(?,?,?,?,?,?,?,'{}',?,?,0,?,2)`).run(delivery.deliveryId,run.runId,run.lastSequence,binding.intakeSessionId,binding.profileHash,delivery.queryHash,delivery.policyVersion,delivery.charBudget,delivery.charCount,now)
    const item = body.items[0]!
    db.prepare('INSERT INTO context_delivery_entries (delivery_id,entry_id,entry_revision,rank,score_components_json,selection_reason_json,origin_scope) VALUES(?,?,?,1,?,?,?)')
      .run(delivery.deliveryId,entry.id,entry.revision,canonicalJson(item.scoreComponents),canonicalJson(item.selectionReasons),'project')
    db.prepare('INSERT INTO dsh_run_log_boundaries VALUES(?,?,?,0,1,?,?)').run(run.runId,run.workspace,'legacy-session',now,now)
    new LedgerStore(db).updateRunStatusInTransaction(run.runId, 'completed')
    db.prepare(`INSERT INTO dsh_memory_finalizations(run_id,workspace,dsh_session_id,source_start_seq,source_end_seq,status,attempt_count,scheduled_at,updated_at,input_mode,extraction_version)
      VALUES(?,?,?,0,4,'pending',0,?,?,?,1)`).run(run.runId,run.workspace,'legacy-session',now,now,mode)
  } finally { db.close() }
  const migrated = await initializeDatabase({ databasePath })
  assert.deepEqual(migrated.applied, [14]); assert.ok(migrated.backupPath)
  const current = openConnection(databasePath)
  const finalizer = new DshMemoryFinalizer({ runtime: { withDatabase: async operation => operation(current, undefined as never) }, inputMode: mode === 'prefix_reuse' ? 'bounded_evidence' : 'prefix_reuse',
    sessionQuery: { async readSession() { return { session: { id: 'legacy-session' }, inheritedEventCount: 0, events: [
      { seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, time: 1, type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'legacy' } } } },
      { seq: 2, time: 2, type: 'request/context', data: { contextWindow: 100000 } },
      { seq: 3, time: 3, type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect archived design' }] } },
      { seq: 4, time: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ] } } }, llm: { async *stream() { yield { type: 'text-delta', text: '{"schemaVersion":1,"memories":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } } } } })
  try {
    const historical = readContextDelivery(current, { workspace: delivery!.workspace, deliveryId: delivery!.deliveryId })
    assert.equal(historical.policyVersion,'context-ranking-v6'); assert.equal(historical.items[0]!.projection,undefined)
    assert.equal(historical.charCount, delivery!.charCount); assert.equal(historical.deliveryId, delivery!.deliveryId)
    await finalizer.start(); await deadline(finalizer.whenIdle(), 'upgraded legacy pending job')
    const job = current.prepare('SELECT status,input_mode,evidence_selection_version,last_error_message FROM dsh_memory_finalizations').get<any>()
    assert.equal(job.status,'completed',job.last_error_message); assert.equal(job.input_mode,mode); assert.equal(job.evidence_selection_version,1)
    assert.throws(() => current.prepare('UPDATE dsh_memory_finalizations SET evidence_selection_version=2').run(), /immutable/u)
    assert.equal(current.prepare('SELECT count(*) AS n FROM memory_episodes').get<{n:number}>()!.n,0)
    recordRepeatedStage({ stage: 'legacy-upgrade', expected: { policy: 'context-ranking-v6', selectionVersion: 1, inputMode: mode }, actual: { policy: historical.policyVersion, selectionVersion: job.evidence_selection_version, inputMode: job.input_mode, job: job.status }, migration: 14 })
    return delivery!.deliveryId
  } finally { await finalizer.dispose(); current.close() }
}
