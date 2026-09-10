import { recordRepeatedStage } from './repeated-memory-report.js'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { deepNativeFixture } from './deep-native-fixture.js'
import { deadline } from './repeated-memory-native.js'
import type { nativeMock } from './native-mock.js'

export function deepRoundScript(mock: ReturnType<typeof nativeMock>, round: number): any[] {
  return [
    { kind: 'leaf', reason: 'One read-only question' },
    { kind: 'candidate', answer: `Read-only plan ${round}: inspect the fixture schema.`, evidence: [], assumptions: [], unresolved: [] },
    { kind: 'supported', requirementIds: ['request'], reason: 'The answer addresses the requested read-only plan.', evidence: [] },
    { schemaVersion: 1, memories: [{ kind: 'fact', title: `Read-only Deep observation ${round}`, body: `Plan ${round} inspects only the fixture schema.`, summary: null, confidence: 0.5, tags: [] }] },
  ].map(value => mock.textResponse(JSON.stringify(value)))
}

export async function repeatedDeepHost(root: string, rounds: readonly number[], sessionId: string) {
  return deepNativeFixture(mock => rounds.flatMap(round => deepRoundScript(mock, round)), { root, dataRoot: join(root, '.git', 'deep-state'), keepFiles: true, sessionId })
}

export async function completeDeepRound(f: Awaited<ReturnType<typeof deepNativeFixture>>, round: number) {
  const before = f.provider.requests.length
  const result = await f.command(`/deep-planning Design read-only plan ${round} to inspect the fixture schema.`)
  assert.equal(result?.result?.kind, 'success')
  const intent = await deadline(f.complete(), `Deep round ${round}`)
  assert.ok(intent?.runId)
  const state = await f.deep.store.read(intent.runId)
  assert.equal(state.phase, 'answered', state.reason ?? '')
  assert.equal(state.usage.requests, 4)
  assert.equal(f.provider.requests.length - before, 4)
  const requests = f.provider.requests.slice(before)
  assert.equal(requests.filter(request => request.sessionId === f.parent.session.id && request.purpose !== 'compaction').length, 0)
  const job = await f.deep.store.database(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_episodes').get<{n:number}>()!.n, 0, 'Deep must not fabricate native episodes')
    assert.equal(db.prepare('SELECT count(*) AS n FROM enno_contracts').get<{n:number}>()!.n, 0)
    assert.equal(db.prepare("SELECT count(*) AS n FROM dsh_deep_finalizations WHERE status IN ('pending','processing')").get<{n:number}>()!.n, 0)
    return db.prepare('SELECT status,entry_id,error FROM dsh_deep_finalizations WHERE run_id=?').get<{status:string;entry_id:string|null;error:string|null}>(state.runId)
  })
  assert.equal(job?.status, 'completed', job?.error ?? '')
  assert.ok(job.entry_id)
  assert.ok((await f.deep.reports.snapshot(f.parent.session.id)).some(event => event.kind === 'report' && event.text.includes(`plan ${round}`)))
  const report = { round, runId: state.runId, session: f.parent.session.id, finalization: job.status, memory: job.entry_id, modelCalls: 4, stages: ['admission','planning','execution','verification','report','memory-finalization','durable-state'] }
  recordRepeatedStage(report)
  return report
}
