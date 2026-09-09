import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const catalogPath = join(process.cwd(), '..', 'deepseek-harness', 'packages/session/session-format-catalog/lib/index.js')

function frame(value: string | Buffer): Buffer {
  return zstdCompressSync(typeof value === 'string' ? Buffer.from(value, 'utf8') : value, {
    params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
  })
}

function message(id: string, source: Record<string, unknown>) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: 'continue' }],
    source,
  }
}

function artifactLines() {
  const header = { type: 'session', version: 0, id: 'repair-source-test', createdAt: 1, delegationDepth: 0 }
  const spliceMessage = message('legacy-splice', {
    kind: 'plugin', plugin: 'kiokuko-dsh', form: 'loop-recovery', deliveryId: 'a'.repeat(64),
  })
  const userMessage = message('legacy-user', {
    kind: 'plugin', plugin: 'kiokuko-dsh', form: 'continuation', deliveryId: 'b'.repeat(64),
  })
  const rows = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    // The v2-to-v3 migration anchors the system head to the first real step.
    // Keep the fixture migratable without asking source repair to invent history.
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'agent/inbox/spliced', seq: 2, time: 3, data: { target: 'next-step', start: 0, inserted: [spliceMessage] } },
    { type: 'user/message', seq: 3, time: 4, data: userMessage, surfaceOp: 'append' },
    { type: 'user/message', seq: 4, time: 5, data: message('clean-user', { kind: 'user' }), surfaceOp: 'append' },
    { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return { header, rows, lines: [header, ...rows].map(value => JSON.stringify(value)) }
}

type Catalog = { currentVersion?: number } & ({
  createRestore: (header: unknown, options: { recovery: 'strict'; validation: 'current' }) => {
    decodeRow: (row: unknown) => void
    finish: () => unknown
  }
} | {
  decodeRecoverableArtifact: (header: unknown, rows: readonly unknown[]) => unknown
  migrate: (artifact: unknown) => unknown
})

async function loadCatalog(): Promise<Catalog | undefined> {
  try {
    await access(catalogPath)
  } catch {
    return undefined
  }
  return (await import(pathToFileURL(catalogPath).href)).sessionFormatCatalog
}

function validate(catalog: Catalog, header: unknown, rows: readonly unknown[]) {
  if ('createRestore' in catalog) {
    const restore = catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of rows) restore.decodeRow(row)
    return restore.finish()
  }
  const decoded = catalog.decodeRecoverableArtifact(header, rows)
  return catalog.migrate(decoded)
}

test('repairs legacy continuation sources with backup, catalog validation, atomic output, and idempotence', async (t) => {
  const catalog = await loadCatalog()
  if (catalog === undefined) {
    t.skip('built DeepSeek Harness session-format catalog is unavailable')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-repair-source-'))
  const path = join(root, 'session.jsonl.zstd')
  const artifact = artifactLines()
  const headerLine = `${artifact.lines[0]}\n`
  const body = `${artifact.lines.slice(1).join('\n')}\n`
  await writeFile(path, Buffer.concat([frame(headerLine), frame(body)]))
  const original = await readFile(path)
  try {
    assert.throws(() => validate(catalog, artifact.header, artifact.rows), /source.*deliveryId/u)
    execFileSync(process.execPath, [
      join(process.cwd(), 'scripts/repair-continuation-source.mjs'),
      path,
      '--catalog',
      catalogPath,
    ], { encoding: 'utf8' })
    const repaired = await readFile(path)
    const backup = await readFile(`${path}.bak`)
    assert.notDeepEqual(repaired, original)
    assert.deepEqual(backup, original)

    const repairModule = await import(pathToFileURL(join(process.cwd(), 'scripts/repair-continuation-source.mjs')).href)
    const decodedText = repairModule.decodeSessionLog(repaired).toString('utf8')
    assert.match(decodedText, /"form":"instructions"/u)
    const repairedArtifact = repairModule.parseJsonl(repairModule.decodeSessionLog(repaired))
    assert.doesNotThrow(() => validate(catalog, repairedArtifact.records[0], repairedArtifact.records.slice(1)))
    assert.match(decodedText, /"id":"clean-user","role":"user","content"/u)
    assert.deepEqual(repairedArtifact.records[5], artifact.rows[4])
    assert.deepEqual(repairedArtifact.records.filter((row: { type: string }) => row.type.startsWith('step/')), [artifact.rows[1], artifact.rows[5]])

    const beforeSecondRun = await readFile(path)
    execFileSync(process.execPath, [
      join(process.cwd(), 'scripts/repair-continuation-source.mjs'),
      path,
      '--catalog',
      catalogPath,
    ], { encoding: 'utf8' })
    assert.deepEqual(await readFile(path), beforeSecondRun)
    assert.deepEqual(await readFile(`${path}.bak`), original)

    if ((catalog.currentVersion ?? 0) >= 3) {
      // Source repair must still reject the original fixture's impossible chronology.
      const invalidPath = join(root, 'missing-step.jsonl.zstd')
      const invalidRows = artifact.rows.filter(row => !row.type.startsWith('step/'))
        .map((row, seq) => ({ ...row, seq, time: seq + 1 }))
      const invalidOriginal = frame(`${[artifact.header, ...invalidRows].map(row => JSON.stringify(row)).join('\n')}\n`)
      await writeFile(invalidPath, invalidOriginal)
      const result = spawnSync(process.execPath, [
        join(process.cwd(), 'scripts/repair-continuation-source.mjs'), invalidPath, '--catalog', catalogPath,
      ], { encoding: 'utf8' })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /surface before first step.*chronology/u)
      assert.deepEqual(await readFile(invalidPath), invalidOriginal)
      assert.deepEqual((await readdir(root)).sort(), ['missing-step.jsonl.zstd', 'session.jsonl.zstd', 'session.jsonl.zstd.bak'])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const fixtureValidation = `
import assert from 'node:assert/strict'
function validate(header, rows) {
  assert.equal(header.version, 0)
  assert.equal(rows.length, 7)
  assert.deepEqual(rows.map(row => row.seq), [0, 1, 2, 3, 4, 5, 6])
  for (const message of [rows[2].data.inserted[0], rows[3].data]) {
    assert.deepEqual(message.source, { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions' })
  }
}
`

for (const [name, implementation] of [
  ['streaming', `
    createRestore(header, options) {
      assert.deepEqual(options, { recovery: 'strict', validation: 'current' })
      const rows = []
      return { decodeRow(row) { rows.push(row) }, finish() { validate(header, rows) } }
    },
    decodeRecoverableArtifact() { throw new Error('legacy decoder must not run') },
    migrate() { throw new Error('legacy migration must not run') },
  `],
  ['legacy', `
    decodeRecoverableArtifact(header, rows) { return { header, rows } },
    migrate({ header, rows }) { validate(header, rows) },
  `],
] as const) {
  test(`repair CLI validates every repaired row with the ${name} catalog API`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiokuko-repair-api-'))
    try {
      const path = join(root, 'session.jsonl.zstd')
      const fixturePath = join(root, 'catalog.mjs')
      const original = frame(`${artifactLines().lines.join('\n')}\n`)
      await writeFile(path, original)
      await writeFile(fixturePath, `${fixtureValidation}\nexport const sessionFormatCatalog = { ${implementation} }`)
      const result = spawnSync(process.execPath, [
        join(process.cwd(), 'scripts/repair-continuation-source.mjs'), path, '--catalog', fixturePath,
      ], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Repaired 2 session record\(s\)/u)
      assert.deepEqual(await readFile(`${path}.bak`), original)
      const repairModule = await import(pathToFileURL(join(process.cwd(), 'scripts/repair-continuation-source.mjs')).href)
      const output = repairModule.parseJsonl(repairModule.decodeSessionLog(await readFile(path)))
      assert.equal(output.records.length, 8)
      assert.deepEqual(output.records[5], artifactLines().rows[4])
      assert.deepEqual((await readdir(root)).sort(), ['catalog.mjs', 'session.jsonl.zstd', 'session.jsonl.zstd.bak'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

for (const [name, implementation, expectedError] of [
  ['row rejection', `createRestore() { return {
    decodeRow() { throw new Error('catalog row rejected') }, finish() {},
  } }, decodeRecoverableArtifact() {}, migrate() {}`, /catalog row rejected/u],
  ['final validation rejection', `createRestore() { return {
    decodeRow() {}, finish() { throw new Error('catalog final validation rejected') },
  } }, decodeRecoverableArtifact() {}, migrate() {}`, /catalog final validation rejected/u],
  ['unsupported API', 'readHeader() {}', /Unsupported session-format catalog API/u],
] as const) {
  test(`repair CLI preserves the original and creates no backup or output after ${name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiokuko-repair-rejected-'))
    try {
      const path = join(root, 'session.jsonl.zstd')
      const fixturePath = join(root, 'catalog.mjs')
      const original = frame(`${artifactLines().lines.join('\n')}\n`)
      await writeFile(path, original)
      await writeFile(fixturePath, `export const sessionFormatCatalog = { ${implementation} }`)
      const result = spawnSync(process.execPath, [
        join(process.cwd(), 'scripts/repair-continuation-source.mjs'), path, '--catalog', fixturePath,
      ], { encoding: 'utf8' })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, expectedError)
      assert.deepEqual(await readFile(path), original)
      assert.deepEqual((await readdir(root)).sort(), ['catalog.mjs', 'session.jsonl.zstd'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
