import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { stateForSnapshot } from '../../../src/enno-oduno/service.js'
import { createDshCapabilityCatalog, DSH_CAPABILITY_CATALOG_VERSION } from '../../../src/dsh/capability-catalog.js'
import { MODEL_TOOL_OPERATION_NAMES } from '../../../src/model-tools/contracts.js'
import { STANDARD_SKILL_MANIFESTS } from '../../../src/dsh/standard-skills.js'

const root = path.resolve(import.meta.dirname, '../../..')

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(absolute) : /\.(?:ts|mts)$/u.test(entry.name) ? [absolute] : []
  }))
  return nested.flat()
}

function resolveImport(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = path.resolve(path.dirname(file), specifier)
  const candidates = [
    base,
    base.replace(/\.js$/u, '.ts'),
    base.replace(/\.js$/u, '.mts'),
    base.replace(/\.mjs$/u, '.mts'),
    `${base}.ts`,
    `${base}.mts`,
    path.join(base, 'index.ts'),
  ]
  return candidates.find((candidate) => allSources.has(candidate))
}

const allSources = new Set(await sourceFiles(path.join(root, 'src')))

test('every active source is reachable from the sole DSH entrypoint', async () => {
  const reached = new Set<string>()
  const visit = async (file: string): Promise<void> => {
    if (reached.has(file)) return
    reached.add(file)
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/gu)) {
      const target = resolveImport(file, match[1]!)
      if (target !== undefined) await visit(target)
    }
  }
  await visit(path.join(root, 'src/dsh/index.ts'))
  assert.deepEqual([...allSources].filter((file) => !reached.has(file)), [])
})

test('active source has no legacy client branch or generic Enno projection', async () => {
  const forbidden = /\b(?:Codex|Claude|OpenCode|Hermes|EnnoClientKind|EnnoHarnessDirective|clientBinding)\b|directive\.harness/gu
  const violations: Array<{ file: string; matches: string[] }> = []
  for (const file of allSources) {
    const source = await readFile(file, 'utf8')
    const matches = [...source.matchAll(forbidden)].map((match) => match[0])
    if (matches.length > 0) violations.push({ file: path.relative(root, file), matches })
  }
  assert.deepEqual(violations, [])
})

test('active source has no legacy compatibility identifiers', async () => {
  const forbidden = /\blegacy[A-Z_]|\bLegacy[A-Z_]|\bclient_kind\b|\bmcp_tool\b|digestForVersion|legacyRequestDigests|legacyScopedDeliveryId|rebuildLegacyHybridSearch/u
  const violations: Array<{ file: string; match: string }> = []
  for (const file of allSources) {
    const source = await readFile(file, 'utf8')
    const match = forbidden.exec(source)
    if (match !== null) violations.push({ file: path.relative(root, file), match: match[0] })
  }
  assert.deepEqual(violations, [])
})

test('migrations preserve the immutable baseline and append forward-only evolution', async () => {
  const entries = await readdir(path.join(root, 'migrations'), { withFileTypes: true })
  const sqlFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).map((entry) => entry.name)
  assert.deepEqual(sqlFiles, ['001_baseline.sql', '002_dsh_memory_finalization.sql'])
  assert.equal(entries.some((entry) => entry.name === 'down'), false, 'migrations/down must not exist')
  const packed = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(packed.files.includes('migrations/'), true)
})

test('package and model surfaces are DSH-only', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.exports), ['./dsh'])
  assert.equal(manifest.bin, undefined)
  assert.equal(manifest.dependencies?.commander, undefined)
  assert.equal(manifest.dependencies?.['@modelcontextprotocol/sdk'], undefined)
  assert.equal(manifest.files.includes('templates/'), false)
  assert.equal(DSH_CAPABILITY_CATALOG_VERSION, 2)
  assert.equal(MODEL_TOOL_OPERATION_NAMES.length, 7)
  const catalog = createDshCapabilityCatalog({
    skills: STANDARD_SKILL_MANIFESTS.map(({ name }) => ({ kind: 'skill', name })),
    tools: [{ kind: 'tool', name: 'native' }],
  })
  assert.equal(catalog.tools[0]?.kind, 'tool')
})

test('model-visible Enno state has no generic client or harness projection', () => {
  const state = stateForSnapshot({
    runId: 'run',
    workspace: 'workspace',
    orchestrationId: 'orchestration',
    dshSessionId: 'dsh-session',
    repositoryRoot: root,
    taskType: 'build',
    userFacingLanguage: 'en',
    status: 'completed',
    revision: 1,
    confirmationState: 'not_required',
    attempts: 0,
    mutationRevision: 0,
    routeEpoch: 0,
    ideal: null,
    meditation: null,
    contract: {
      revision: 1,
      scope: [],
      exclusions: [],
      acceptanceCriteria: [],
      workPlan: { objective: 'done', units: [] },
      skillSet: { entries: [], intakeDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] }, zenkiDiscovery: { attempted: false, mode: 'off', requirements: [], queries: [], cacheHits: 0, candidates: 0, selected: [], failures: [] } },
      finalVerifiers: [],
      maxAttempts: 8,
      provenance: { scope: 'inferred', exclusions: 'inferred', acceptanceCriteria: 'inferred', workPlan: 'inferred', skillSet: 'inferred', finalVerifiers: 'inferred', maxAttempts: 'inferred' },
    },
    handoff: { sourceRole: 'enno-oduno', taskType: 'build', objective: 'done', target: null, expected: null, constraints: [], verification: [], stopConditions: [] },
    workUnits: [],
    finalEvidenceReady: false,
    finalEvidence: [],
    blocker: null,
    advisoryPhaseState: { state: 'not_started' },
  })
  const serialized = JSON.stringify(state)
  assert.equal(serialized.includes('clientBinding'), false)
  assert.equal(serialized.includes('harness'), false)
})
