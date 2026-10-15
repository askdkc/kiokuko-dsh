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
  assert.equal(state.usage.requests, 3)
  assert.equal(f.provider.requests.length - before, 3)
  const requests = f.provider.requests.slice(before)
  assert.equal(requests.filter(request => request.sessionId === f.parent.session.id && request.purpose !== 'compaction').length, 0)
  const job = await f.deep.store.database(db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM memory_episodes').get<{n:number}>()!.n, 0, 'Deep must not fabricate native episodes')
    assert.equal(db.prepare('SELECT count(*) AS n FROM enno_contracts').get<{n:number}>()!.n, 0)
    assert.equal(db.prepare("SELECT count(*) AS n FROM dsh_deep_finalizations WHERE status IN ('pending','processing')").get<{n:number}>()!.n, 0)
    assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_deep_finalizations WHERE run_id=?').get<{n:number}>(state.runId)!.n,0,'Deep completion cannot queue automatic extraction')
    return db.prepare("SELECT 1 FROM sqlite_master WHERE name='replay_memories'").get()
      ? db.prepare('SELECT count(*) AS n FROM replay_memories').get<{n:number}>()!.n : 0
  })
  assert.equal(job,0,'the read-only Deep result was not offered for human approval')
  assert.ok((await f.deep.reports.snapshot(f.parent.session.id)).some(event => event.kind === 'report' && event.text.includes(`plan ${round}`)))
  const report = { round, runId: state.runId, session: f.parent.session.id, finalization: 'not-scheduled', memory: 'not-approved', modelCalls: 3, stages: ['admission','planning','execution','verification','report','no-automatic-memory','durable-state'] }
  recordRepeatedStage(report)
  return report
}
