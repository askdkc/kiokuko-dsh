import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { initializeDatabase } from '../src/dsh/database.js'
import { openConnection } from '../src/db/connection.js'
import { registerRepositoryAndLocation } from '../src/repository/binding.js'
import { createDshCapabilityCatalog } from '../src/dsh/capability-catalog.js'
import { DshIntakeGate } from '../src/dsh/intake-gate.js'
import { createStandardSkillProvider } from '../src/dsh/standard-skill-provider.js'
import { DshRuntime } from '../src/dsh/runtime.js'
import { TypedDecisionsConfig } from '../src/dsh/decisions/config.js'
import { discoverLayaConfiguration, LayaCoreMLDecisionProvider } from '../src/dsh/decisions/laya-coreml.js'
import { requestLaya } from '../src/dsh/decisions/laya-transport.js'
import { DecisionService } from '../src/dsh/decisions/service.js'
import { selectInstalledSkills } from '../src/dsh/decisions/skill-selection.js'
import { findSecretInValue } from '../src/memory/secrets.js'
import { sourceManifest } from './evaluate-laya-compaction.mjs'

/** Only a disposable fixture database is opened; existing user state is never used. */
async function intake(task: string, service: DecisionService, signal: AbortSignal) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'kiokuko-laya-intake-'))), databasePath = join(root, 'fixture.sqlite3')
  const migrationsDirectory = resolve('migrations')
  await initializeDatabase({ databasePath, migrationsDirectory })
  const db = openConnection(databasePath)
  try { registerRepositoryAndLocation(db, { repositoryId: 'quality-repo', workspace: 'quality-workspace', displayName: 'Fixture replay',
    canonicalRoot: root, remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 1 }) } finally { db.close() }
  const runtime = new DshRuntime({ repositoryRoot: root, databasePath, migrationsDirectory,
    embeddingConfig: { mode: 'off', provider: 'openai-compatible', allowRemote: false, vectorBackend: 'auto', timeoutMs: 1000, batchSize: 1 } })
  const provider = createStandardSkillProvider()
  try {
    const listed = await provider.list({}), candidates = 'complete' in listed ? listed.candidates : listed
    const capabilities = createDshCapabilityCatalog(candidates.map(({ name, description }) => ({ kind: 'skill', name, description })))
    const gate = new DshIntakeGate(runtime, undefined); gate.configureDecisions(service)
    const result = await gate.prepare({ agent: { id: 'fixture-agent' }, sessionId: 'fixture-session', turn: 1, step: 1,
      task, cwd: root, capabilities, skillDiscoveryMode: 'off', signal })
    return { admitted: result.admitted, questionId: result.prepared.intake.question?.id ?? null, profile: result.prepared.intake.profile }
  } finally { provider.dispose(); await runtime.close(); await rm(root, { recursive: true, force: true }) }
}

async function replay() {
  const out = process.argv[2]
  if (!out || process.argv.includes('--help')) { console.log('node --import tsx scripts/replay-laya-workflows.mts NEW_OUTPUT_DIRECTORY\nReplays archived Akinator v3 / Skill v2 fixtures through the running strict CoreML worker. No independent holdout claim.'); return }
  await mkdir(out, { recursive: true })
  const inputs = await Promise.all(['evaluation-v3.json', 'evaluation-skills-v2.json'].map(async name => {
    const path = resolve('evaluation/workflow-regression', name), bytes = await readFile(path)
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), fixtures: JSON.parse(bytes.toString()) }
  }))
  if (inputs.some(input => findSecretInValue(input.fixtures) !== undefined)) throw new Error('Fixture secret rejected')
  const config = await discoverLayaConfiguration(TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': {
    compaction: { mode: 'off' }, skillAcceptance: { policyVersion: 'laya-skill-shortlist-v2', minProbability: .8, minMargin: .2 },
  } }), process.cwd(), AbortSignal.timeout(5000))
  if (config['laya-coreml']?.protocol === 'v1' || config['laya-coreml']?.model !== 'aac6fef/laya-multilingual-coreml') throw new Error('Strict multilingual worker required')
  const sources = await sourceManifest()
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ sources, inputs, config, kind: 'archive_regression_replay' }, null, 2), { flag: 'wx' })
  const rows = []
  for (const fixture of inputs.flatMap(input => input.fixtures)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(fixture.id) || !['akinator', 'skills'].includes(fixture.usecase)) throw new Error('Invalid fixture identity')
    const wire: unknown[] = [], diagnostics: unknown[] = [], observations: unknown[] = []
    const service = new DecisionService(config, settings => new LayaCoreMLDecisionProvider(settings['laya-coreml'], async (path, body, signal, timeout) => {
      const request = JSON.parse(body)
      try { const response = await requestLaya(path, body, signal, timeout); wire.push({ request, response }); return response }
      catch (error) { wire.push({ request, error: String(error) }); throw error }
    }, diagnostic => diagnostics.push(diagnostic)), undefined, { onEvaluation: observation => observations.push(observation) })
    const signal = AbortSignal.timeout(30_000)
    const resolution: any = { availability: 'known-nonempty', catalogProvided: true, availableSkillCount: fixture.catalog?.length ?? 0,
      diagnostics: { received: fixture.catalog?.length ?? 0, accepted: fixture.catalog?.length ?? 0, truncated: 0, dropped: 0 }, warnings: [],
      recommendations: [...(fixture.mandatory ?? []).map((name: string) => ({ kind: 'skill', name, availability: 'available', reason: 'fixture-policy', source: 'akinator_policy', required: true })),
        ...(fixture.baseline ?? []).map((name: string) => ({ kind: 'skill', name, availability: 'available', reason: 'fixture-similarity', source: 'catalog_similarity' }))] }
    const output = fixture.usecase === 'akinator' ? await intake(fixture.task, service, signal)
      : { selected: await selectInstalledSkills(service, fixture.id, fixture.task, fixture.catalog, resolution, signal) }
    const row = { fixtureId: fixture.id, fixture, output, wire, diagnostics, observations }
    rows.push(row); await writeFile(join(out, `${fixture.id}.json`), JSON.stringify(row, null, 2), { flag: 'wx' })
  }
  if (JSON.stringify(sources) !== JSON.stringify(await sourceManifest())) throw new Error('Source changed during replay')
  for (const input of inputs) if (createHash('sha256').update(await readFile(input.path)).digest('hex') !== input.sha256) throw new Error('Fixture changed during replay')
  await writeFile(join(out, 'results.json'), JSON.stringify({ kind: 'archive_regression_replay', rows }, null, 2), { flag: 'wx' })
  console.log(JSON.stringify({ replayed: rows.length, output: resolve(out) }))
}
replay().catch(error => { console.error(String(error)); process.exitCode = 1 })
