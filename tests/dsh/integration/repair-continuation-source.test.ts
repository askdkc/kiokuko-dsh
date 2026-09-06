import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    { type: 'agent/inbox/spliced', seq: 1, time: 2, data: { target: 'next-step', start: 0, inserted: [spliceMessage] } },
    { type: 'user/message', seq: 2, time: 3, data: userMessage, surfaceOp: 'append' },
    { type: 'user/message', seq: 3, time: 4, data: message('clean-user', { kind: 'user' }), surfaceOp: 'append' },
    { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return { header, rows, lines: [header, ...rows].map(value => JSON.stringify(value)) }
}

type Catalog = {
  decodeRecoverableArtifact: (header: unknown, rows: readonly unknown[]) => unknown
  migrate: (artifact: unknown) => unknown
}

async function loadCatalog(): Promise<Catalog | undefined> {
  try {
    await access(catalogPath)
  } catch {
    return undefined
  }
  return (await import(pathToFileURL(catalogPath).href)).sessionFormatCatalog
}

function validate(catalog: Catalog, header: unknown, rows: readonly unknown[]) {
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
    assert.throws(() => validate(catalog, artifact.header, artifact.rows))
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
    assert.deepEqual(repairedArtifact.records[4], artifact.rows[3])

    const beforeSecondRun = await readFile(path)
    execFileSync(process.execPath, [
      join(process.cwd(), 'scripts/repair-continuation-source.mjs'),
      path,
      '--catalog',
      catalogPath,
    ], { encoding: 'utf8' })
    assert.deepEqual(await readFile(path), beforeSecondRun)
    assert.deepEqual(await readFile(`${path}.bak`), original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
