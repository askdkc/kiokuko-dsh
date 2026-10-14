import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, seed, evidence, NOW } from './fixture.js'
import { withImmediateTransaction } from '../../../../src/db/transaction.js'
import { rotateTaskSourceInTransaction } from '../../../../src/dsh/task-source-history.js'
import { recordEntry, readEntry } from '../../../../src/memory/entries.js'
import { forgetMemory } from '../../../../src/memory/forget.js'
import { configureEvolution, episodeCurrent, evolutionEntryState, saveEpisode, scheduleEvolution } from '../../../../src/memory/evolution/store.js'
import { digest, evidenceReferences, episodeSignals, supportingEvidenceDigest, independentEpisodes, EVOLUTION_VERSION, MemoryEvolutionConfig, type Episode } from '../../../../src/memory/evolution/contracts.js'
import { EvolutionWorker } from '../../../../src/memory/evolution/worker.js'
import { canonicalJson } from '../../../../src/serialization/validate.js'

function rotate(f: ReturnType<typeof fixture>, episode: Episode, nextSessionId: string) {
  const run = f.db.prepare('SELECT task_revision,task_generation FROM ledger_runs WHERE run_id=?').get<{task_revision:number;task_generation:number}>(episode.runId)!
  withImmediateTransaction(f.db, () => rotateTaskSourceInTransaction(f.db, { runId: episode.runId, sessionId: episode.sessionId, nextSessionId,
    expectedRevision: run.task_revision, expectedGeneration: run.task_generation, operationId: `rotate-${episode.sourceEpoch ?? 1}`, reason: 'Explicit task continuation' }, NOW))
  f.db.prepare("UPDATE ledger_runs SET status='active',task_owner_session_id=? WHERE run_id=?").run(nextSessionId, episode.runId)
}

function nextSource(f: ReturnType<typeof fixture>, old: Episode, outcome: 'completed' | 'failed' = 'completed'): Episode {
  const epoch = (old.sourceEpoch ?? 1) + 1, sessionId = `session-${old.runId}-epoch-${epoch}`
  rotate(f, old, sessionId)
  f.db.prepare('INSERT INTO dsh_run_log_boundaries(run_id,workspace,dsh_session_id,source_start_seq,source_start_turn,created_at,updated_at) VALUES(?,?,?,1,1,?,?)')
    .run(old.runId, old.workspace, sessionId, NOW, NOW)
  f.db.prepare('UPDATE ledger_runs SET status=? WHERE run_id=?').run(outcome, old.runId)
  f.db.prepare(`INSERT INTO dsh_memory_finalizations(run_id,source_epoch,workspace,dsh_session_id,source_start_seq,source_end_seq,status,attempt_count,scheduled_at,updated_at,extraction_version)
    VALUES(?,?,?,?,1,5,'completed',1,?,?,2)`).run(old.runId, epoch, old.workspace, sessionId, NOW, NOW)
  const source = recordEntry(f.db, { workspace: old.workspace, kind: 'lesson', title: `New source ${epoch}`, body: `A source from epoch ${epoch}`, createdBy: 'fixture', scope: { visibility: 'project' } }, { now: NOW })
  f.db.prepare('INSERT INTO dsh_memory_finalization_entries(run_id,entry_id,ordinal,created_at) VALUES(?,?,0,?)').run(old.runId, source.id, NOW)
  const observations = evidence(`${old.runId}-epoch-${epoch}`)
  const episode: Episode = { ...old, sourceEpoch: epoch, sessionId, outcome, logDigest: digest(observations),
    evidence: evidenceReferences(observations), evidenceDigest: supportingEvidenceDigest(old.draft, observations),
    sources: [{ entryId: source.id, revision: source.revision, hash: source.contentHash }], ...episodeSignals(old.draft, observations) }
  withImmediateTransaction(f.db, () => saveEpisode(f.db, episode, NOW, observations))
  return episode
}

test('resume and model-switch sources coexist without rewriting old episodes or their manifests', () => {
  const f = fixture()
  try {
    configureEvolution(f.db, 'active')
    const first = seed(f.db, 'resume'), oldJson = f.db.prepare('SELECT episode_json FROM memory_episodes WHERE run_id=?').get<{episode_json:string}>(first.runId)!.episode_json
    const second = nextSource(f, first, 'failed')
    assert.equal(episodeCurrent(f.db, first), true, 'old completed source remains current evidence after a later failed source')
    assert.equal(episodeCurrent(f.db, second), true)
    const rows = f.db.prepare('SELECT source_epoch,episode_json,overview_entry_id FROM memory_episodes WHERE run_id=? ORDER BY source_epoch')
      .all<{source_epoch:number;episode_json:string;overview_entry_id:string}>(first.runId)
    assert.deepEqual(rows.map(row => row.source_epoch), [1, 2]); assert.equal(rows[0]!.episode_json, oldJson)
    for (const row of rows) assert.equal(evolutionEntryState(f.db, readEntry(f.db, { workspace: first.workspace, entryId: row.overview_entry_id })).eligible, true)
    withImmediateTransaction(f.db, () => saveEpisode(f.db, { ...first, sourceEpoch: 1 }, NOW))
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_episodes WHERE run_id=?').get<{n:number}>(first.runId)!.n, 2)
    assert.throws(() => withImmediateTransaction(f.db, () => saveEpisode(f.db, { ...second, logDigest: 'changed' }, NOW)), /replay_conflict/)
    for (const changed of [{ ...second, sourceEpoch: 3 }, { ...second, sessionId: first.sessionId }, { ...second, outcome: 'completed' as const }, { ...second, end: 6 }])
      assert.throws(() => withImmediateTransaction(f.db, () => saveEpisode(f.db, changed, NOW)), /identity_mismatch/)
    rotate(f, second, 'session-third-model')
    assert.equal(episodeCurrent(f.db, first), true); assert.equal(episodeCurrent(f.db, second), true)
    assert.equal(independentEpisodes([first, second]).length, 1, 'a task resume never manufactures independent support')
    assert.equal(independentEpisodes([first, second])[0]!.sourceEpoch, 2, 'latest source wins deterministically within a logical task')
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { f.db.close() }
})

test('each source epoch can schedule and finish evolution while old pending jobs retain their original evidence', async () => {
  const f = fixture(), worker = new EvolutionWorker({ runtime: f.runtime, config: MemoryEvolutionConfig.parse({}), now: () => NOW })
  try {
    const first = seed(f.db, 'a'); seed(f.db, 'b'); seed(f.db, 'c')
    withImmediateTransaction(f.db, () => scheduleEvolution(f.db, first.runId, { provider: 'original', model: 'old-model' }, NOW))
    const second = nextSource(f, first)
    withImmediateTransaction(f.db, () => scheduleEvolution(f.db, second.runId, { provider: 'next', model: 'new-model' }, NOW, 2))
    assert.equal(f.db.prepare('SELECT reason FROM memory_evolution_skips WHERE run_id=? AND source_epoch=2').get<{reason:string}>(first.runId)!.reason, 'waiting_for_three_new_episodes')
    seed(f.db, 'd'); seed(f.db, 'e')
    withImmediateTransaction(f.db, () => scheduleEvolution(f.db, second.runId, { provider: 'next', model: 'new-model' }, NOW, 2))
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_evolution_jobs').get<{n:number}>()!.n, 1,
      'a resumed source plus only two new tasks cannot satisfy three new independent sources')
    seed(f.db, 'f')
    withImmediateTransaction(f.db, () => scheduleEvolution(f.db, second.runId, { provider: 'next', model: 'new-model' }, NOW, 2))
    assert.deepEqual(f.db.prepare('SELECT source_epoch FROM memory_evolution_jobs WHERE trigger_run=? ORDER BY source_epoch').all<{source_epoch:number}>(first.runId).map(row => row.source_epoch), [1, 2])
    worker.kick(); await worker.whenIdle()
    assert.deepEqual(f.db.prepare('SELECT state FROM memory_evolution_jobs WHERE trigger_run=? ORDER BY source_epoch').all<{state:string}>(first.runId).map(row => row.state), ['completed', 'completed'])
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_evolution_calls').get<{n:number}>()!.n, 0, 'v2 deterministic evolution does not invent LLM calls')
  } finally { await worker.dispose(); f.db.close() }
})

test('forget retires only referencing episode payloads and revokes archived finalization staging', () => {
  const f = fixture()
  try {
    const first = seed(f.db, 'forget-generation')
    f.db.prepare("UPDATE dsh_memory_finalizations SET staged_capsule_json=?,staged_binding_hash='archived-binding' WHERE run_id=?").run(JSON.stringify({ private: 'archived draft' }), first.runId)
    const second = nextSource(f, first)
    f.db.prepare(`UPDATE dsh_task_source_finalizations SET job_json=json_set(job_json,'$.staged_capsule_json','private old draft','$.staged_binding_hash','old-binding','$.claim_nonce','old-claim')
      WHERE run_id=? AND source_epoch=1`).run(first.runId)
    forgetMemory(f.db, { workspace: first.workspace, entryId: first.sources[0]!.entryId, expectedRevision: first.sources[0]!.revision, operationId: 'forget-epoch-one' })
    assert.deepEqual(f.db.prepare('SELECT source_epoch FROM memory_episodes WHERE run_id=?').all<{source_epoch:number}>(first.runId).map(row => row.source_epoch), [2])
    const job = JSON.parse(f.db.prepare('SELECT job_json FROM dsh_task_source_finalizations WHERE run_id=? AND source_epoch=1').get<{job_json:string}>(first.runId)!.job_json)
    assert.equal(job.last_error_code, 'MEMORY_FORGOTTEN'); assert.equal(job.claim_nonce, null); assert.equal(job.staged_capsule_json, null)
    const history = JSON.parse(f.db.prepare('SELECT finalization_json FROM dsh_task_source_history WHERE run_id=? AND source_epoch=1').get<{finalization_json:string}>(first.runId)!.finalization_json)
    assert.equal(history.staged_capsule_json, null); assert.equal(history.staged_binding_hash, null)
    assert.equal(episodeCurrent(f.db, second), true)
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { f.db.close() }
})

test('legacy model dispatch is once per source epoch and shares one daily budget across epochs', async () => {
  for (const dailyCalls of [1, 2]) {
    const f = fixture(), sessions: string[] = []
    const first = seed(f.db, `legacy-${dailyCalls}`), b = seed(f.db, 'legacy-b'), c = seed(f.db, 'legacy-c')
    const second = nextSource(f, first)
    for (const source of [first, second]) {
      const episodes = [source, b, c], kind = 'positive', inputDigest = digest({ version: EVOLUTION_VERSION, kind, episodes })
      f.db.prepare(`INSERT INTO memory_evolution_jobs(id,workspace,trigger_run,source_epoch,signature,kind,input_json,seen_json,input_digest,model_json,algorithm,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(inputDigest, source.workspace, source.runId, source.sourceEpoch ?? 1, source.signature, kind,
        canonicalJson(episodes), canonicalJson(episodes.map(e => e.evidenceDigest)), inputDigest,
        canonicalJson({ provider: 'fixture', model: 'original-model', contextWindow: 100000 }), EVOLUTION_VERSION, NOW, NOW)
    }
    const worker = new EvolutionWorker({ runtime: f.runtime, config: MemoryEvolutionConfig.parse({ dailyCalls }), now: () => NOW,
      llm: { async *stream(request) { sessions.push(request.sessionId!); throw new Error('provider failure still consumes this source dispatch'); } } })
    try {
      worker.kick(); await worker.whenIdle(); worker.kick(); await worker.whenIdle()
      const calls = f.db.prepare('SELECT source_epoch FROM memory_evolution_calls WHERE trigger_run=? ORDER BY source_epoch').all<{source_epoch:number}>(first.runId)
      assert.equal(calls.length, dailyCalls); assert.equal(sessions.length, dailyCalls)
      assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_evolution_jobs WHERE reason='call_budget'").get<{n:number}>()!.n, 2 - dailyCalls)
      if (dailyCalls === 2) {
        assert.deepEqual(calls.map(call => call.source_epoch), [1, 2])
        assert.deepEqual(sessions.sort(), [first.sessionId, second.sessionId].sort(), 'fallback model session belongs to its source epoch')
      }
    } finally { await worker.dispose(); f.db.close() }
  }
})
