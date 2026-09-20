import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../src/db/connection.ts'
import { migrateDatabase } from '../src/db/migrate.ts'
import { recordEntry } from '../src/memory/entries.ts'
import { resolveProjectWorkspace } from '../src/memory/workspaces.ts'
import { recallScopedMemory } from '../src/memory/scoped-memory.ts'
import { DecisionService } from '../src/dsh/decisions/service.ts'
import { TypedDecisionsConfig } from '../src/dsh/decisions/config.ts'
import { TypeSafeDecisionProvider, NimbleDecisionProvider } from '../src/dsh/decisions/providers.ts'
import { createMemoryReuseRuntime } from '../src/dsh/memory-reuse.ts'

// All transmitted material comes from these checked-in synthetic fixtures, never a user database.
const fixtures = JSON.parse(await readFile(new URL('../tests/fixtures/memory-reuse-evaluation.json', import.meta.url), 'utf8'))
const live = process.argv.includes('--live') || process.argv.includes('--probe')
const providerName = process.argv.find(arg => arg.startsWith('--provider='))?.slice(11) ?? 'typesafe'
assert.ok(['typesafe', 'nimble'].includes(providerName), 'provider must be typesafe or nimble')
const configured = providerName === 'typesafe' ? Boolean(process.env.TYPESAFE_API_KEY)
  : Boolean(process.env.NIMBLE_ENDPOINT && process.env.NIMBLE_MODEL)
if (live && !configured) {
  console.log(JSON.stringify({ mode: 'live', provider: providerName, status: 'skipped', reason: 'Provider configuration is not available in this process; DSH credential storage was not inspected.' }))
  process.exit(0)
}
const config = TypedDecisionsConfig.parse({ provider: providerName, ...(providerName === 'nimble' && live ? {
  nimble: { endpoint: process.env.NIMBLE_ENDPOINT, model: process.env.NIMBLE_MODEL },
} : {}), ...(process.env.TYPESAFE_MODEL ? { typesafe: { model: process.env.TYPESAFE_MODEL } } : {}) })
let calls = 0
const request = async (...args) => { calls++; return fetch(...args) }
const labels = fixtures.flatMap(f => f.memories)
const oracle = {
  capabilities: { maxQuestions: 64, maxChoices: 26, maxBytes: 262144 },
  async evaluate(batch) {
    calls++
    return { provider: 'fixture-oracle', requestedModel: 'fixture-oracle', policyVersion: 'fixture-v1', answers: batch.questions.map(q => {
      if (q.id === 'fruit') return { id: q.id, status: 'selected', choiceId: 'apple' }
      const expected = labels.find(m => batch.state.memories[q.id].includes(m.body))
      assert.ok(expected, 'Every assessed record must be a known synthetic projection')
      return { id: q.id, status: 'selected', choiceId: expected.relevant ? 'applicable' : 'not_applicable' }
    }) }
  },
}
const service = new DecisionService(config, c => !live ? oracle : providerName === 'typesafe'
  ? new TypeSafeDecisionProvider(c.typesafe, async () => process.env.TYPESAFE_API_KEY, request)
  : new NimbleDecisionProvider(c.nimble, async () => process.env.NIMBLE_API_KEY, request))
const signal = new AbortController().signal
if (process.argv.includes('--probe')) {
  const readiness = await service.probe(signal)
  console.log(JSON.stringify({ mode: 'synthetic-probe', provider: providerName, readiness, calls }))
  if (readiness.state !== 'ready') process.exitCode = 1
} else {
  const rows = []
  for (const fixture of fixtures) {
    const root = await mkdtemp(join(tmpdir(), 'kioku-reuse-eval-')), db = openConnection(':memory:')
    try {
      await mkdir(join(root, '.git')); migrateDatabase(db)
      const project = await resolveProjectWorkspace(db, root)
      for (const m of fixture.memories) recordEntry(db, { workspace: project.workspace, kind: 'lesson', title: fixture.task.split(/[:： ]/)[0], body: m.body, scope: { visibility: 'project' }, createdBy: 'synthetic-evaluation' }, { idFactory: () => m.id })
      const input = { project, query: fixture.task, scope: 'project', readOnly: true, limit: 2, maxChars: 4000 }
      const before = calls, started = performance.now()
      const baseline = await recallScopedMemory(db, input)
      const baselineMs = performance.now() - started
      const runtime = await createMemoryReuseRuntime(service, fixture.id, signal), selectedStarted = performance.now()
      let selectionStatus = 'unassessed', fallbackReason = null
      const observedRuntime = { ...runtime, async select(input) {
        const result = await runtime.select(input)
        selectionStatus = result.status; if (result.status === 'fallback') fallbackReason = result.reason
        return result
      } }
      const selected = await recallScopedMemory(db, input, {}, { runtime: observedRuntime, constraints: fixture.constraints, assertCurrent: () => {} })
      const selectedMs = performance.now() - selectedStarted
      const expected = fixture.memories.filter(m => m.relevant).map(m => m.id)
      const metrics = result => {
        const items = result.project.memory.items, hits = items.filter(m => expected.includes(m.id)).length
        return { precision: items.length ? hits / items.length : 0, recall: hits / expected.length, missed: expected.filter(id => !items.some(m => m.id === id)),
          delivered: items.length, contextChars: result.project.memory.characterCount, serializedChars: JSON.stringify(result).length }
      }
      rows.push({ id: fixture.id, baseline: metrics(baseline), selected: metrics(selected), baselineMs, selectedMs, addedLatencyMs: selectedMs - baselineMs, calls: calls - before, selectionStatus, fallbackReason })
      if (!live) { assert.equal(rows.at(-1).selected.precision, 1); assert.equal(rows.at(-1).selected.recall, 1) }
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
  }
  console.log(JSON.stringify({ mode: live ? 'live-model-quality' : 'fixture-oracle-integration', provider: live ? providerName : 'fixture-oracle',
    note: live ? 'Small synthetic sample; not a production accuracy estimate.' : 'Labels are supplied to a mock adapter. These results verify plumbing, not model quality.', calls, readiness: service.status(), rows }, null, 2))
  if (live && rows.some(row => row.selectionStatus !== 'completed')) process.exitCode = 1
}
