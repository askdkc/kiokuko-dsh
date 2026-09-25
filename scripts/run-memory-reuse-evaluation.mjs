import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
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
const fixtureBytes = await readFile(new URL('../tests/fixtures/memory-reuse-evaluation.json', import.meta.url))
const fixtures = JSON.parse(fixtureBytes.toString('utf8'))
const live = process.argv.includes('--live') || process.argv.includes('--probe')
const selectedMode = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7) ?? 'all'
assert.ok(['baseline', 'choice', 'noul', 'all'].includes(selectedMode), 'mode must be baseline, choice, noul or all')
const modes = selectedMode === 'all' ? ['baseline', 'choice', 'noul'] : [selectedMode]
const explicitModel = process.argv.find(arg => arg.startsWith('--model='))?.slice(8)
const acceptProbability = Number(process.argv.find(arg => arg.startsWith('--accept='))?.slice(9) ?? .9)
const rejectProbability = Number(process.argv.find(arg => arg.startsWith('--reject='))?.slice(9) ?? .1)
assert.ok(rejectProbability >= 0 && rejectProbability < .5 && acceptProbability > .5 && acceptProbability <= 1, 'invalid Noul thresholds')
const providerName = process.argv.find(arg => arg.startsWith('--provider='))?.slice(11) ?? 'typesafe'
assert.ok(['typesafe', 'nimble'].includes(providerName), 'provider must be typesafe or nimble')
if (providerName !== 'typesafe' && modes.includes('noul')) {
  console.error('Noul memory evaluation requires TypeSafe; use --mode=choice for Nimble.')
  process.exit(1)
}
const configured = providerName === 'typesafe' ? Boolean(process.env.TYPESAFE_API_KEY)
  : Boolean(process.env.NIMBLE_ENDPOINT && process.env.NIMBLE_MODEL)
if (live && (!configured || providerName === 'typesafe' && (!explicitModel || !/-\d+(?:\.\d+){1,2}(?:-[A-Za-z0-9.]+)?$/.test(explicitModel)))) {
  console.error('Live evaluation requires provider credentials and --model=VERSIONED_MODEL for TypeSafe.')
  process.exit(1)
}
let calls = 0
const request = async (...args) => { calls++; return fetch(...args) }
const labels = fixtures.flatMap(f => f.memories)
const oracle = {
  capabilities: { maxQuestions: 64, maxChoices: 26, maxBytes: 262144, questionTypes: ['choice', 'noul'] },
  async evaluate(batch) {
    calls++
    return { provider: 'fixture-oracle', requestedModel: 'fixture-oracle', policyVersion: 'fixture-v1', answers: batch.questions.map(q => {
      if (q.id === 'fruit') return { id: q.id, status: 'selected', choiceId: 'apple' }
      const memoryId = batch.state.questionMemory?.[q.id] ?? q.id
      const expected = labels.find(m => batch.state.memories[memoryId].includes(m.body))
      assert.ok(expected, 'Every assessed record must be a known synthetic projection')
      if (q.type === 'noul') return { id: q.id, status: 'measured', type: 'noul',
        probability: expected.noul?.[q.id.split(':')[1]] ?? (expected.relevant ? 1 : 0) }
      return { id: q.id, status: 'selected', choiceId: expected.relevant ? 'applicable' : 'not_applicable' }
    }) }
  },
}
const serviceFor = (mode, evidence) => {
  const config = TypedDecisionsConfig.parse({ provider: providerName,
    ...(mode === 'noul' ? { memorySelection: { mode: 'noul', policyVersion: 'memory-reuse-noul-v1', acceptProbability, rejectProbability } }
      : { memorySelection: { mode: 'choice' } }),
    ...(providerName === 'nimble' && live ? { nimble: { endpoint: process.env.NIMBLE_ENDPOINT, model: process.env.NIMBLE_MODEL } } : {}),
    ...(explicitModel ? { typesafe: { model: explicitModel } } : {}) })
  return new DecisionService(config, c => { const provider = !live ? oracle : providerName === 'typesafe'
    ? new TypeSafeDecisionProvider(c.typesafe, async () => process.env.TYPESAFE_API_KEY, request)
    : new NimbleDecisionProvider(c.nimble, async () => process.env.NIMBLE_API_KEY, request)
    return { capabilities: provider.capabilities,
      ...(provider.preflight ? { preflight: (batch, signal) => provider.preflight(batch, signal) } : {}),
      async evaluate(batch, signal) {
        const result = await provider.evaluate(batch, signal)
        if (batch.purpose === 'memory-reuse' && batch.questions[0]?.id !== 'fruit') evidence.push({ requestedModel: result.requestedModel,
          returnedModel: result.returnedModel ?? null, revision: result.revision ?? null, usage: result.usage ?? null,
          answerStatus: Object.fromEntries(result.answers.map(answer => [answer.id, answer.status])),
          probabilities: Object.fromEntries(result.answers.filter(answer => answer.status === 'measured' && answer.type === 'noul')
            .map(answer => [answer.id, answer.probability])) })
        return result
      } }
  })
}
const signal = new AbortController().signal
if (process.argv.includes('--probe')) {
  const service = serviceFor('choice', [])
  const readiness = await service.probe(signal)
  console.log(JSON.stringify({ mode: 'synthetic-probe', provider: providerName, readiness, calls }))
  if (readiness.state !== 'ready') process.exitCode = 1
} else {
  const rows = []
  for (const mode of modes) for (const fixture of fixtures) {
    const evidence = [], service = serviceFor(mode, evidence)
    const root = await mkdtemp(join(tmpdir(), 'kioku-reuse-eval-')), db = openConnection(':memory:')
    try {
      await mkdir(join(root, '.git')); migrateDatabase(db)
      const project = await resolveProjectWorkspace(db, root)
      for (const m of fixture.memories) recordEntry(db, { workspace: project.workspace, kind: 'lesson', title: fixture.task.split(/[:： ]/)[0], body: m.body, scope: { visibility: 'project' }, createdBy: 'synthetic-evaluation' }, { idFactory: () => m.id })
      const input = { project, query: fixture.task, scope: 'project', readOnly: true, limit: 2, maxChars: 4000 }
      const before = calls, started = performance.now()
      const baseline = await recallScopedMemory(db, input)
      const baselineMs = performance.now() - started
      const runtime = mode === 'baseline' ? null : await createMemoryReuseRuntime(service, `${mode}:${fixture.id}`, signal)
      const selectedStarted = performance.now()
      let selectionStatus = 'unassessed', fallbackReason = null, verdicts = [], assessedCandidates = []
      const observedRuntime = runtime && { ...runtime, async select(input) {
        assessedCandidates = input.candidates
        const result = await runtime.select(input)
        selectionStatus = result.status; if (result.status === 'fallback') fallbackReason = result.reason
        else verdicts = result.verdicts
        return result
      } }
      const selected = observedRuntime ? await recallScopedMemory(db, input, {}, { runtime: observedRuntime, constraints: fixture.constraints, assertCurrent: () => {} }) : baseline
      const selectedMs = performance.now() - selectedStarted
      const expected = fixture.memories.filter(m => m.relevant).map(m => m.id)
      const unsafe = new Set(fixture.memories.filter(m => m.unsafeReuse).map(m => m.id))
      const conflicts = new Set(fixture.memories.filter(m => m.noul?.constraints === 0).map(m => m.id))
      const metrics = result => {
        const items = result.project.memory.items, hits = items.filter(m => expected.includes(m.id)).length
        return { precision: items.length ? hits / items.length : 0, recall: expected.length ? hits / expected.length : 1,
          tp: hits, fp: items.length - hits, fn: expected.length - hits,
          missed: expected.filter(id => !items.some(m => m.id === id)),
          delivered: items.length, contextChars: result.project.memory.characterCount, serializedChars: JSON.stringify(result).length }
      }
      const sweep = {}
      if (mode === 'noul' && selectionStatus === 'completed') {
        const probabilities = Object.assign({}, ...evidence.map(part => part.probabilities))
        for (const reject of [0, .01, .025, .05, .1]) for (const accept of [.8, .9, .95, .99, 1]) {
          const trialVerdicts = assessedCandidates.map((_, index) => {
            const values = ['applicability', 'constraints', 'prerequisites'].map(name => probabilities[`memory_${index}:${name}`])
            return values.some(value => value !== undefined && value <= reject) ? 'not_applicable'
              : values.every(value => value !== undefined && value >= accept) ? 'applicable' : 'uncertain'
          })
          const trial = await recallScopedMemory(db, input, {}, { runtime: { identity: `${runtime.identity}:${reject}:${accept}`,
            maxCandidates: runtime.maxCandidates, async select() { return { status: 'completed', verdicts: trialVerdicts } } },
          constraints: fixture.constraints, assertCurrent: () => {} })
          sweep[`${reject}:${accept}`] = { ...metrics(trial), unsafeDelivered: trial.project.memory.items.filter(item => unsafe.has(item.id)).length,
            conflictDelivered: trial.project.memory.items.filter(item => conflicts.has(item.id)).length,
            excludedUseful: assessedCandidates.filter((item, index) => trialVerdicts[index] === 'not_applicable' && expected.includes(item.entryId)).length }
        }
      }
      const assessedIds = new Set(evidence.flatMap(part => Object.keys(part.answerStatus)))
      const abstainedIds = new Set(evidence.flatMap(part => Object.entries(part.answerStatus).filter(([, status]) => status === 'abstained').map(([id]) => id)))
      rows.push({ id: fixture.id, split: fixture.split, mode, language: fixture.id.slice(0, 2), baseline: metrics(baseline), selected: metrics(selected), sweep,
        unsafeDelivered: selected.project.memory.items.filter(item => unsafe.has(item.id)).length,
        conflictDelivered: selected.project.memory.items.filter(item => conflicts.has(item.id)).length,
        excluded: verdicts.filter(value => value === 'not_applicable').length, uncertain: verdicts.filter(value => value === 'uncertain').length,
        unassessed: assessedCandidates.filter((_, index) => !assessedIds.has(mode === 'noul' ? `memory_${index}:applicability` : `memory_${index}`)).length,
        abstained: assessedCandidates.filter((_, index) => abstainedIds.has(mode === 'noul' ? `memory_${index}:applicability` : `memory_${index}`)).length,
        baselineMs, selectedMs: mode === 'baseline' ? baselineMs : selectedMs,
        addedLatencyMs: mode === 'baseline' ? 0 : selectedMs - baselineMs, calls: calls - before, selectionStatus, fallbackReason, evidence })
      if (!live && mode !== 'baseline') { assert.equal(rows.at(-1).selected.fp, 0); assert.equal(rows.at(-1).selected.recall, 1) }
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
  }
  const percentile = (values, fraction) => values.length ? values.sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null
  const aggregate = subset => ({ attempted: subset.length, completed: subset.filter(row => row.selectionStatus !== 'fallback').length,
    tp: subset.reduce((sum, row) => sum + row.selected.tp, 0), fp: subset.reduce((sum, row) => sum + row.selected.fp, 0),
    fn: subset.reduce((sum, row) => sum + row.selected.fn, 0), unsafeDelivered: subset.reduce((sum, row) => sum + row.unsafeDelivered, 0),
    conflictDelivered: subset.reduce((sum, row) => sum + row.conflictDelivered, 0),
    excluded: subset.reduce((sum, row) => sum + row.excluded, 0), uncertain: subset.reduce((sum, row) => sum + row.uncertain, 0),
    unassessed: subset.reduce((sum, row) => sum + row.unassessed, 0), abstained: subset.reduce((sum, row) => sum + row.abstained, 0),
    fallbackCount: subset.filter(row => row.selectionStatus === 'fallback').length,
    usageReports: subset.reduce((sum, row) => sum + row.evidence.filter(part => part.usage).length, 0),
    inputTokens: subset.reduce((sum, row) => sum + row.evidence.reduce((partSum, part) => partSum + (part.usage?.input_tokens ?? 0), 0), 0),
    outputTokens: subset.reduce((sum, row) => sum + row.evidence.reduce((partSum, part) => partSum + (part.usage?.output_tokens ?? 0), 0), 0),
    p50Ms: percentile(subset.map(row => row.selectedMs), .5), p95Ms: percentile(subset.map(row => row.selectedMs), .95) })
  const noulRows = rows.filter(row => row.mode === 'noul')
  const trialKeys = [0, .01, .025, .05, .1].flatMap(reject => [.8, .9, .95, .99, 1].map(accept => ({ reject, accept, key: `${reject}:${accept}` })))
  const calibrate = candidate => {
    const sample = noulRows.filter(row => row.split === 'calibration').map(row => row.sweep[candidate.key])
    if (sample.length === 0 || sample.some(value => !value)) return null
    return { ...candidate, tp: sample.reduce((sum, value) => sum + value.tp, 0),
      fn: sample.reduce((sum, value) => sum + value.fn, 0), fp: sample.reduce((sum, value) => sum + value.fp, 0),
      excludedUseful: sample.reduce((sum, value) => sum + value.excludedUseful, 0),
      conflictDelivered: sample.reduce((sum, value) => sum + value.conflictDelivered, 0),
      unsafeDelivered: sample.reduce((sum, value) => sum + value.unsafeDelivered, 0) }
  }
  const calibrated = trialKeys.map(calibrate).filter(value => value && value.excludedUseful === 0)
    .sort((a, b) => (b.tp / (b.tp + b.fn || 1)) - (a.tp / (a.tp + a.fn || 1)) || a.conflictDelivered - b.conflictDelivered
      || a.fp - b.fp || a.reject - b.reject || b.accept - a.accept)[0]
  const recall = values => { const tp = values.reduce((sum, value) => sum + value.tp, 0), fn = values.reduce((sum, value) => sum + value.fn, 0)
    return tp + fn ? tp / (tp + fn) : 1 }
  let adoptionGate = { status: 'unverified', reason: 'A complete versioned live comparison is required before changing the default.',
    calibration: live ? calibrated ?? null : null }
  if (live && selectedMode === 'all' && calibrated && providerName === 'typesafe'
    && noulRows.filter(row => row.split === 'validation').every(row => row.sweep[calibrated.key])) {
    const validation = noulRows.filter(row => row.split === 'validation')
    const selected = validation.map(row => row.sweep[calibrated.key])
    const choice = rows.filter(row => row.mode === 'choice' && row.split === 'validation')
    const baseline = rows.filter(row => row.mode === 'baseline' && row.split === 'validation')
    const languages = ['ja', 'en'].map(language => ({ language,
      noul: recall(validation.filter(row => row.language === language).map(row => row.sweep[calibrated.key])),
      choice: recall(choice.filter(row => row.language === language).map(row => row.selected)),
      baseline: recall(baseline.filter(row => row.language === language).map(row => row.selected)) }))
    const checks = { noUsefulExclusion: selected.every(value => value.excludedUseful === 0),
      languageRecall: languages.every(value => value.noul >= value.choice && value.noul >= value.baseline),
      noAddedConstraintConflicts: selected.reduce((sum, value) => sum + value.conflictDelivered, 0) <= choice.reduce((sum, row) => sum + row.conflictDelivered, 0),
      materialImprovement: recall(selected) > recall(choice.map(row => row.selected)) || recall(selected) === recall(choice.map(row => row.selected))
        && selected.reduce((sum, value) => sum + value.fp, 0) < choice.reduce((sum, row) => sum + row.selected.fp, 0),
      completedWithinBudget: rows.filter(row => row.mode !== 'baseline').every(row => row.selectionStatus === 'completed')
        && aggregate(noulRows).p95Ms <= 5000 }
    adoptionGate = { status: Object.values(checks).every(Boolean) ? 'eligible' : 'failed', calibration: calibrated,
      checks, languages, validationScenarios: validation.map(row => row.id) }
  }
  console.log(JSON.stringify({ mode: live ? 'live-synthetic' : 'fixture-oracle-integration', provider: live ? providerName : 'fixture-oracle',
    model: explicitModel ?? null, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    fixtureDigest: createHash('sha256').update(fixtureBytes).digest('hex'), policy: { version: 'memory-reuse-noul-v1', acceptProbability, rejectProbability },
    configuration: { provider: providerName, model: explicitModel ?? (providerName === 'nimble' ? process.env.NIMBLE_MODEL ?? null : 'jev-latest'),
      candidateLimit: 2, maxChars: 4000, maxCandidates: 24, budgetMs: 5000, timeoutMs: 5000,
      thresholdGrid: { reject: [0, .01, .025, .05, .1], accept: [.8, .9, .95, .99, 1] } },
    note: live ? 'Small synthetic sample; not a production accuracy estimate.' : 'Labels are supplied to a mock adapter. These results verify plumbing, not model quality.',
    calls, adoptionGate, byMode: Object.fromEntries(modes.map(mode => [mode, aggregate(rows.filter(row => row.mode === mode))])),
    byLanguage: Object.fromEntries(['ja', 'en'].map(language => [language,
      Object.fromEntries(modes.map(mode => [mode, aggregate(rows.filter(row => row.mode === mode && row.language === language))]))])),
    rows: rows.map(({ sweep, ...row }) => row) }, null, 2))
  if (live && rows.some(row => row.selectionStatus !== 'completed')) process.exitCode = 1
}
