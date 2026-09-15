import assert from 'node:assert/strict'
import test from 'node:test'
import { extractMemorySignals, mergeMemorySignals, buildEnnoMemoryFocus, memoryRelativePath } from '../../../../src/enno-oduno/memory-focus.js'
import { decideMemoryRefresh } from '../../../../src/enno-oduno/memory-refresh-policy.js'
import { renderScopedRetrievalQuery } from '../../../../src/context/retrieval-query.js'
import { EnnoMemoryConfig, Config } from '../../../../src/dsh/config.js'
import { inapplicableEnnoState } from '../../../../src/enno-oduno/service.js'

const failed = (text: string) => ({ value: { exitCode: 1, stderr: text }, content: [{ type: 'text', text }], isError: true })
test('bounded evidence is semantic, preserves Unicode, excludes external paths and ignores unknown/success/background results', () => {
  const result = failed('E_LOCK_TIMEOUT src/queue.ts package-name@1.2.3')
  const before = structuredClone(result), a = extractMemorySignals(result, '/repo')
  assert.deepEqual(a.errors, ['E_LOCK_TIMEOUT']); assert.deepEqual(a.paths, ['src/queue.ts'])
  assert.deepEqual(mergeMemorySignals(a, a), a); assert.deepEqual(result, before)
  for (const interruption of [{ timedOut: true }, { aborted: true }, { signal: 'SIGTERM' }, { spawnFailed: true }]) {
    assert.deepEqual(extractMemorySignals({ value: { exitCode: null, stderr: 'E_LOCK_TIMEOUT', ...interruption } }, '/repo').errors, ['E_LOCK_TIMEOUT'])
  }
  assert.deepEqual(extractMemorySignals({ value: { signal: {}, stderr: 'E_LOCK_TIMEOUT' } }, '/repo').errors, [])
  for (const output of [null, {}, { ...result, value: { exitCode: 0 } }, { ...result, value: { kind: 'background', exitCode: 1 } }]) assert.deepEqual(extractMemorySignals(output, '/repo'), { errors: [], paths: [], identifiers: [] })
  assert.equal(memoryRelativePath('/other/private.ts', '/repo'), undefined)
  assert.equal(memoryRelativePath('../private.ts', '/repo'), undefined)
  assert.equal(memoryRelativePath('/repo/src/a.ts', '/repo'), 'src/a.ts')
  const enormous = failed('E_LOCK_TIMEOUT ' + 'x'.repeat(1000000) + ' E_NEW_FAILURE')
  assert.deepEqual(extractMemorySignals(enormous, '/repo').errors, ['E_LOCK_TIMEOUT', 'E_NEW_FAILURE'])
  assert.ok(mergeMemorySignals(a, extractMemorySignals(failed(Array.from({ length: 40 }, (_, i) => `E_ERROR_${i}`).join(' ')), '/repo')).errors.length <= 16)
})
test('roles and revision metadata cannot cause Full; new domains and durable budget exhaustion can', () => {
  const input = { active: true, previousFocus: 'same', focus: 'same', corpusChanged: false, configChanged: false, cold: false, fullCount: 0, maxFull: 8 }
  assert.equal(decideMemoryRefresh(input).decision, 'reuse')
  assert.equal(decideMemoryRefresh({ ...input, focus: 'new' }).decision, 'full')
  assert.equal(decideMemoryRefresh({ ...input, corpusChanged: true }).decision, 'full')
  assert.equal(decideMemoryRefresh({ ...input, cold: true, fullCount: 8 }).reason, 'budget_exhausted')
  const base = { state: inapplicableEnnoState(), root: '/repo', signals: extractMemorySignals(failed('E_LOCK_TIMEOUT'), '/repo'), constraints: 'current input', characterBudget: 8000 }
  const first = buildEnnoMemoryFocus(base)
  const next = buildEnnoMemoryFocus({ ...base, state: { ...base.state, currentRole: 'zenki', status: 'zenki_planning', contractRevision: 99 } })
  assert.equal(first.retrievalDomainDigest, next.retrievalDomainDigest)
  assert.notEqual(first.rankingFocusDigest, next.rankingFocusDigest)
})
test('long Japanese task cannot displace new error signals; off rendering and strict config are preserved', () => {
  const query = { task: '日本語😀'.repeat(20000), taskProfile: { taskType: 'debug' as const, target: null, expected: null, constraints: null },
    errorSignatures: ['E_LOCK_TIMEOUT'], focus: { objective: null, identifiers: [], constraints: '', retrievalDomainDigest: 'd', rankingFocusDigest: 'r' } }
  const rendered = renderScopedRetrievalQuery(query)
  assert.ok(rendered.startsWith('E_LOCK_TIMEOUT\n')); assert.ok(Buffer.byteLength(rendered) <= 16384)
  assert.equal(renderScopedRetrievalQuery({ task: 'task', taskProfile: query.taskProfile }), 'task\ndebug\n\n\n')
  assert.equal(Config.parse({}).ennoMemory.mode, 'off')
  for (const bad of [{ mode: 'bad' }, { maxFullSearchesPerRun: 0 }, { maxFullSearchesPerRun: 33 }, { localBudgetMs: 99 }, { rerank: true }]) assert.equal(EnnoMemoryConfig.safeParse(bad).success, false)
})
