import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { TypedDecisionsConfig } from '../src/dsh/decisions/config.js'
import { discoverLayaConfiguration, LayaCoreMLDecisionProvider } from '../src/dsh/decisions/laya-coreml.js'
import { requestLaya } from '../src/dsh/decisions/laya-transport.js'
import { findSecretInValue } from '../src/memory/secrets.js'
import { DecisionService } from '../src/dsh/decisions/service.js'
import { captureCompactionArm, type EvaluationFixture } from './laya-compaction-native.mjs'

const fixtureSchema = z.object({ id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/), family: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/), language: z.enum(['en','ja']),
  task: z.string().min(1), body: z.string().min(1), tool: z.string().min(1), constraints: z.string().min(1) }).strict()
const datasetSchema = z.object({ kind: z.enum(['development', 'regression', 'holdout']), independentReviewer: z.string().min(1).optional(), fixtures: z.array(fixtureSchema).min(1) }).strict()
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
const save = async (path: string, value: unknown) => { await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }) }
const fileEntry = async (path: string) => ({ path: resolve(path), sha256: hash(await readFile(path)) })

export async function sourceManifest(root = process.cwd()): Promise<Array<{ path: string; sha256: string }>> {
  const files: string[] = []
  const visit = async (path: string) => { for (const entry of await readdir(path, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue
    const full = resolve(path, entry.name)
    if (entry.isDirectory()) await visit(full)
    else if (entry.isFile() && /\.(?:ts|mts|mjs|json|yaml|md)$/.test(entry.name)) files.push(full)
  } }
  for (const directory of ['src', 'scripts', 'tests', 'skills']) await visit(resolve(root, directory))
  for (const file of ['package.json','package-lock.json','pnpm-lock.yaml','tsconfig.json','tsconfig.build.json']) files.push(resolve(root, file))
  return Promise.all(files.sort().map(async path => ({ path: relative(root, path), sha256: hash(await readFile(path)) })))
}
export async function verifyManifest(manifest: any) {
  for (const entry of [manifest.policy, manifest.dataset, manifest.oracles])
    if (hash(await readFile(entry.path)) !== entry.sha256) throw new Error(`Frozen input changed: ${entry.path}`)
  const current = await sourceManifest(manifest.repositoryRoot)
  if (JSON.stringify(current) !== JSON.stringify(manifest.sources)) throw new Error('Frozen source or lockfile changed')
}
export function validateDataset(value: unknown) {
  const dataset = datasetSchema.parse(value)
  if (findSecretInValue(dataset) !== undefined) throw new Error('Evaluation fixtures must not contain secrets')
  if (new Set(dataset.fixtures.map(fixture => fixture.id)).size !== dataset.fixtures.length) throw new Error('Duplicate fixture ID')
  const families = new Map<string, Set<string>>()
  for (const fixture of dataset.fixtures) { const languages = families.get(fixture.family) ?? new Set(); if (languages.has(fixture.language)) throw new Error('Duplicate family/language'); languages.add(fixture.language); families.set(fixture.family, languages) }
  if (dataset.kind === 'holdout' && (dataset.fixtures.length !== 120 || families.size !== 60
    || [...families.values()].some(languages => languages.size !== 2) || !dataset.independentReviewer)) throw new Error('Holdout requires independent reviewer and 60 paired families / 120 requests')
  return dataset
}
/** Supplemental runs never qualify a release: this harness captures requests, without real downstream tasks or exact target tokens. */
export function captureGateReport(dataset: { kind: string; fixtures: EvaluationFixture[] }, rows: any[]) {
  const laya = rows.filter(row => row.arm === 'laya')
  const attempted = laya.length, predictions = laya.flatMap(row => row.wire ?? []).filter(entry => entry.request.op === 'predict_strict')
  const gates = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`C${index}`, { status: 'UNVERIFIED', reason: [
    'Independent 120-request / 200-item comparison not completed',
    'Local property tests and capture history checks do not replace full holdout/injected fault coverage',
    'Strict worker preflight observed; token arrays and full frozen holdout not audited independently',
    'Shadow is non-mutating; no final accepted request changes are counted',
    'Target exact tokenizer unavailable for the capture route',
    'Downstream generation is scripted capture; no oracle-scored real task outputs',
    'No real paired downstream task results for O/D/L bootstrap',
    '600 quiet deployment trials and cache/e2e measurements not completed',
  ][index] }]))
  return { policyVersion: 'compaction-acceptance-v1', datasetKind: dataset.kind, requests: dataset.fixtures.length,
    attemptedLayaRequests: attempted, realPredictions: predictions.length,
    readinessPredictions: predictions.filter(entry => Object.keys(entry.request.questions ?? {}).includes('fruit')).length,
    realCandidatePredictions: predictions.filter(entry => !Object.keys(entry.request.questions ?? {}).includes('fruit')).length,
    modelLosslessSelections: laya.flatMap(row => row.diagnostics ?? []).filter(entry => entry.status === 'selected' && entry.choice === 'lossless').length,
    acceptedRequestChanges: 0, qualified: false, gates }
}

export async function main(args: string[]) {
  const [command, ...flags] = args
  if (!command || command === '--help') { console.log('freeze --policy FILE --fixtures FILE --oracles FILE --out DIR [--config FILE]\nrun --manifest FILE --arms original,deterministic,laya --out DIR\nverify --manifest FILE --results DIR --out FILE\nAll current runs are supplemental non-mutating shadow capture. No release qualification.'); return }
  const options = new Map<string, string>()
  for (let index = 0; index < flags.length; index += 2) {
    if (!flags[index]?.startsWith('--') || !flags[index + 1] || options.has(flags[index]!)) throw new Error('Invalid/duplicate option')
    options.set(flags[index]!.slice(2), flags[index + 1]!)
  }
  const required = (name: string) => { const value = options.get(name); if (!value) throw new Error(`Missing --${name}`); return resolve(value) }
  if (command === 'freeze') {
    const policyPath = required('policy'), datasetPath = required('fixtures'), oraclePath = required('oracles'), out = required('out')
    const fixedPolicy = await json(resolve('evaluation/compaction-v1/acceptance-policy.json'))
    if (JSON.stringify(await json(policyPath)) !== JSON.stringify(fixedPolicy)) throw new Error('Acceptance policy mismatch')
    validateDataset(await json(datasetPath)); await json(oraclePath)
    const configured = TypedDecisionsConfig.parse(options.has('config') ? await json(required('config')) : { provider: 'laya-coreml', 'laya-coreml': { compaction: { mode: 'shadow' } } })
    const config = await discoverLayaConfiguration(configured, process.cwd(), AbortSignal.timeout(5000))
    if (config.provider !== 'laya-coreml' || config['laya-coreml']?.protocol === 'v1' || config['laya-coreml']?.model !== 'aac6fef/laya-multilingual-coreml') throw new Error('Strict 1024-token runtime required')
    config['laya-coreml']!.compaction = { mode: 'shadow', policyVersion: 'laya-lossless-task-v3' }
    const sources = await sourceManifest()
    await save(resolve(out, 'source-manifest.json'), sources)
    await save(resolve(out, 'manifest.json'), { version: 1, repositoryRoot: process.cwd(), sources,
      policy: await fileEntry(policyPath), dataset: await fileEntry(datasetPath), oracles: await fileEntry(oraclePath), config,
      nativeRoute: { provider: 'capture', model: 'mock', quality: 'scripted_request_capture_only', tokenizer: 'unsupported' } })
    return
  }
  const manifestPath = required('manifest'), manifest = await json(manifestPath)
  await verifyManifest(manifest)
  const dataset = validateDataset(await json(manifest.dataset.path))
  if (command === 'run') {
    if (options.get('arms') !== 'original,deterministic,laya') throw new Error('All O/D/L arms required in fixed order')
    const current = await discoverLayaConfiguration(TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { socketPath: manifest.config['laya-coreml'].socketPath } }), manifest.repositoryRoot, AbortSignal.timeout(5000))
    if (current['laya-coreml']?.runtimeFingerprint !== manifest.config['laya-coreml'].runtimeFingerprint) throw new Error('Frozen worker fingerprint changed')
    const out = required('out'), rows: any[] = []
    await mkdir(out, { recursive: true })
    // Receipts survive partial failure; an existing run directory is never reused.
    await writeFile(resolve(out, 'run-start.json'), JSON.stringify({ manifest: hash(await readFile(manifestPath)), startedAt: new Date().toISOString() }), { flag: 'wx' })
    for (const fixture of dataset.fixtures) {
      for (const arm of ['original','deterministic','laya'] as const) {
        const wire: unknown[] = [], observations: unknown[] = [], diagnostics: unknown[] = []
        const armConfig = structuredClone(manifest.config)
        if (arm !== 'laya') armConfig['laya-coreml'].compaction.mode = 'off'
        const service = new DecisionService(armConfig, config => new LayaCoreMLDecisionProvider(config['laya-coreml'], async (path, body, signal, timeout) => {
          const request = JSON.parse(body)
          try { const response = await requestLaya(path, body, signal, timeout); wire.push({ request, response }); return response }
          catch (error) { wire.push({ request, failed: error instanceof Error ? error.message : 'unknown' }); throw error }
        }, diagnostic => diagnostics.push(diagnostic)), undefined, { onEvaluation: observation => observations.push(observation) })
        const started = performance.now()
        const result = await captureCompactionArm(fixture, arm, service, AbortSignal.timeout(30_000))
        const row = { fixtureId: fixture.id, family: fixture.family, language: fixture.language, ...result, wire, observations, diagnostics, elapsedMs: performance.now() - started }
        rows.push(row); await save(resolve(out, `${fixture.id}-${arm}.json`), row)
      }
    }
    await verifyManifest(manifest)
    await save(resolve(out, 'results.json'), { manifest: hash(await readFile(manifestPath)), rows })
    return
  }
  if (command === 'verify') {
    const results = await json(resolve(required('results'), 'results.json'))
    if (results.manifest !== hash(await readFile(manifestPath))) throw new Error('Result manifest mismatch')
    const report = captureGateReport(dataset, results.rows)
    await save(required('out'), report)
    process.exitCode = 1 // FAIL/UNVERIFIED is never success.
    return
  }
  throw new Error('Unknown evaluation command')
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
