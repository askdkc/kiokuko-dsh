import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { gte } from 'semver'
import { parse } from 'yaml'
import { installedAgenticReplayCoreVersion, loadAgenticReplayLibrary } from '../../../src/dsh/agenticreplay-libraries.js'

const root = new URL('../../../', import.meta.url)
const json = async (file: string) => JSON.parse(await readFile(new URL(file, root), 'utf8'))

test('AgenticReplay tracks latest with one tested distribution in both lockfiles', async () => {
  const manifest = await json('package.json')
  const npm = await json('package-lock.json')
  const pnpm = parse(await readFile(new URL('pnpm-lock.yaml', root), 'utf8'))
  assert.equal(manifest.dependencies.agenticreplay, 'latest')
  assert.equal(npm.packages[''].dependencies.agenticreplay, 'latest')
  assert.equal(pnpm.importers['.'].dependencies.agenticreplay.specifier, 'latest')
  const locked = npm.packages['node_modules/agenticreplay']
  assert.ok(gte(locked.version, '0.1.18'))
  assert.equal(pnpm.importers['.'].dependencies.agenticreplay.version, locked.version)
  assert.equal(pnpm.packages[`agenticreplay@${locked.version}`].resolution.integrity, locked.integrity)
  assert.equal(await installedAgenticReplayCoreVersion(), locked.version)
})

test('the installed AgenticReplay schema resolves patched bundled fast-uri through AJV', async () => {
  const distribution = createRequire(import.meta.resolve('agenticreplay'))
  const schema = createRequire(distribution.resolve('@agenticreplay/schema'))
  const ajv = createRequire(schema.resolve('ajv'))
  const uri = ajv('fast-uri/package.json')
  assert.ok(gte(uri.version, '3.1.9'), `AJV resolves fast-uri ${uri.version}`)
  for (const name of ['core', 'schema', 'viewer'] as const) {
    assert.ok(await loadAgenticReplayLibrary(name))
  }
})

test('the current reader and HTML viewer preserve a real 0.1.9 trace including its blob', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'agenticreplay-legacy-'))
  const trace = join(temporary, 'trace')
  try {
    await cp(new URL('../../fixtures/agenticreplay-0.1.9/trace', import.meta.url), trace, { recursive: true })
    const files = (await readdir(trace, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
    const snapshot = () => Promise.all(files.map(async file => createHash('sha256').update(await readFile(file)).digest('hex')))
    const before = await snapshot()
    const manifest = JSON.parse(await readFile(join(trace, 'manifest.json'), 'utf8'))
    const core = await loadAgenticReplayLibrary('core')
    const viewer = await loadAgenticReplayLibrary('viewer')
    const events = await (await core.TraceReader.open(trace)).events()
    assert.equal(manifest.agenticreplay_version, '0.1.9')
    assert.deepEqual(events.map(event => event.seq), [0, 1, 2, 3])
    assert.deepEqual(events.map(event => event.type), ['run.start', 'model.request', 'model.response', 'run.end'])
    assert.equal(manifest.counts.events, events.length)
    assert.equal(manifest.counts.blobs, 1)
    assert.equal(createHash('sha256').update(await readFile(join(trace, 'events.jsonl'))).digest('hex'), manifest.integrity.events_sha256)
    assert.equal(viewer.buildTimeline(events).length, 4)
    const output = join(temporary, 'legacy.html')
    assert.ok((await viewer.exportTraceHtml(trace, output)).bytes > 0)
    assert.match(await readFile(output, 'utf8'), /legacy response ordinary visible text/u)
    assert.deepEqual(await snapshot(), before, 'read and export must not rewrite historical traces')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
