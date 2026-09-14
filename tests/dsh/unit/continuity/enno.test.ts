import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptContinuity } from '../../../../src/dsh/continuity-adapter.js'
import { updateExecutionFrame } from '../../../../src/dsh/execution-frame.js'
import { stateForSnapshot } from '../../../../src/enno-oduno/service.js'
import type { EnnoRunSnapshot, StoredWorkUnit } from '../../../../src/enno-oduno/types.js'

function unit(id: string, dependencies: string[] = [], completed = false): StoredWorkUnit {
  return { workUnit: { id, objective: id, scope: ['src'], dependencies, skillNames: [], expertRefs: [],
    acceptanceCriteria: ['meaningful validation'], focusedVerifiers: [], routes: ['code'] },
    status: completed ? 'completed' : 'in_progress', attemptCount: 1,
    result: completed ? { outcome: 'completed', summary: `${id}: I report success`, mutated: true, changedPaths: ['src/file'] } : null }
}
function snapshot(): EnnoRunSnapshot {
  const units = [unit('dependency', [], true), unit('current', ['dependency']), unit('unrelated', [], true)]
  const discovery = { attempted: false, mode: 'off' as const, requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] }
  return { runId: 'run', workspace: 'project:fixture', orchestrationId: 'orchestration', dshSessionId: 'session', repositoryRoot: '/project',
    taskType: 'build', userFacingLanguage: 'en', status: 'goki_executing', revision: 1, confirmationState: 'approved', attempts: 0,
    mutationRevision: 2, routeEpoch: 1, ideal: null, meditation: null,
    contract: { revision: 1, scope: ['src'], exclusions: [], acceptanceCriteria: [{ id: 'validation', description: 'validate' }],
      workPlan: { objective: 'fixture', units: units.map(u => u.workUnit) },
      skillSet: { entries: [], intakeDiscovery: discovery, zenkiDiscovery: discovery }, finalVerifiers: [], maxAttempts: 8,
      provenance: { scope: 'inferred', exclusions: 'inferred', acceptanceCriteria: 'inferred', workPlan: 'inferred',
        skillSet: 'inferred', finalVerifiers: 'inferred', maxAttempts: 'inferred' } },
    handoff: { sourceRole: 'enno-oduno', taskType: 'build', objective: 'fixture', target: null, expected: null, constraints: [], verification: [], stopConditions: [] },
    workUnits: units, finalEvidenceReady: false, finalEvidence: [], blocker: null, advisoryPhaseState: { state: 'not_started' } }
}
function sources(s = snapshot()) {
  const state = stateForSnapshot(s)
  return { owner: { runId: s.runId, workspace: s.repositoryRoot, sessionId: 'session', mode: 'enno' as const,
    workUnitId: state.directive?.workUnit?.id ?? null, role: state.currentRole }, generation: 'g',
    frame: updateExecutionFrame(undefined, s.repositoryRoot, 'read paths: src'), evidence: [], enno: { snapshot: s, state } }
}
test('Enno dependency reports are model claims and do not duplicate criteria or nextAction', () => {
  const input = sources(), original = structuredClone(input)
  const view = adaptContinuity(input)
  assert.ok(view.items.some(item => item.text.includes('dependency:')))
  assert.ok(view.items.every(item => item.basis === 'model-report' && item.validity === 'unknown'))
  assert.ok(view.items.every(item => !item.text.includes('unrelated')))
  assert.doesNotMatch(JSON.stringify(view.items), /execute_work_unit|meaningful validation/)
  assert.deepEqual(input, original)
})
test('run, session, role, route, contract and WorkUnit mismatches cannot produce a current view', () => {
  const input = sources()
  for (const change of [{ runId: 'other' }, { sessionId: 'other' }, { role: 'zenki' }, { workUnitId: 'other' }]) {
    assert.throws(() => adaptContinuity({ ...input, owner: { ...input.owner, ...change } }))
  }
  for (const change of [{ revision: 2 }, { routeEpoch: 2 }, { dshSessionId: 'another' }]) {
    assert.throws(() => adaptContinuity({ ...input, enno: { ...input.enno, snapshot: { ...input.enno.snapshot, ...change } } }))
  }
  assert.equal(adaptContinuity({ ...input, enno: undefined }).coverage, 'unavailable')
})
test('mutation alters source digest without replay; phase changes discard unrelated reports', () => {
  const input = sources()
  const before = adaptContinuity(input)
  assert.notEqual(adaptContinuity({ ...input, enno: { ...input.enno, snapshot: { ...input.enno.snapshot, mutationRevision: 3 } } }).sourceDigest, before.sourceDigest)
  const next = snapshot()
  next.status = 'enno_verifying'; next.workUnits.forEach(u => { u.status = 'completed' })
  assert.equal(adaptContinuity(sources(next)).items.length, 0)
})

test('a recorded passing verifier never becomes a claim about the current repository', () => {
  const s = snapshot()
  s.finalEvidenceReady = true
  s.finalEvidence = [{ verifier: { id: 'tests', kind: 'test', executable: 'npm', args: ['test'], cwd: '.', timeoutMs: 1000 },
    status: 'passed', exitCode: 0, signal: null, durationMs: 1, stdoutPreview: 'PRIVATE OUTPUT NOT PROJECTED', stderrPreview: '',
    stdoutDigest: 'digest', stderrDigest: 'digest', repositoryStateDigest: 'previous-repository', changedDuringVerification: false }]
  const first = adaptContinuity(sources(s))
  const verifier = first.items.find(item => item.sources[0]?.kind === 'enno-verifier')!
  assert.equal(verifier.validity, 'unknown')
  assert.match(verifier.text, /freshness is not established/)
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE OUTPUT/)
  s.mutationRevision++
  const next = adaptContinuity(sources(s))
  assert.notEqual(next.sourceDigest, first.sourceDigest)
  assert.equal(next.items.find(item => item.sources[0]?.kind === 'enno-verifier')!.validity, 'unknown')
})
