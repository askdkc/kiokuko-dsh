import { isolateSkillHome } from '../helpers/skill-home.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdtemp, readFile, readdir, rm, writeFile, symlink, rename, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import * as dshPlugin from '../../../src/dsh/index.js'
import { mountSessionHistoryCompatibility } from '../../../src/dsh/session-history-compatibility.js'
import { readHistoricalDshSession } from '../../../src/dsh/session-history-lookup.js'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { DshMemoryFinalizer } from '../../../src/dsh/session-memory-finalizer.js'
import { LedgerStore } from '../../../src/ledger/store.js'
import { withImmediateTransaction } from '../../../src/db/transaction.js'
import { realpathSync } from 'node:fs'
import { decodeSessionLog, encodeSessionLog, parseJsonl } from '../../../scripts/session-history-codec.mjs'

const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const sourceRoot = process.env.KIOKUKO_DSH_SOURCE_ROOT
const sourceModules: Record<string, string> = { cordis: 'vendor/cordis', 'dsh-session': 'packages/core/session',
  'dsh-session-persistence-jsonl': 'packages/session/session-persistence-jsonl', 'dsh-session-query': 'packages/session-query/session-query' }
const modulePath = (name: string) => sourceRoot ? join(sourceRoot, sourceModules[name]!, 'src/index.ts') : join(packageRoot, '@deepseek-ai', name, 'lib/index.js')
const jsonlPath = modulePath('dsh-session-persistence-jsonl')
const available = await access(jsonlPath).then(() => true, () => false)
if (!available && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1') throw new Error('Native history compatibility requires the selected DSH runtime')
const options = { skip: available ? false : 'requires selected DSH runtime', timeout: 30_000 }
const types = ['kiokuko/evolution-observation', 'kiokuko/completion-report', 'kiokuko/execution-status', 'kiokuko/deep-report', 'kiokuko/deep-status']

test('compressed compatibility input is bounded across all frames', () => {
  const plaintext = Buffer.from('{"type":"session"}\n{"data":"' + 'x'.repeat(1024) + '"}\n')
  const compressed = encodeSessionLog(plaintext)
  assert.deepEqual(decodeSessionLog(compressed, plaintext.length), plaintext)
  assert.throws(() => decodeSessionLog(compressed, plaintext.length - 1), /failed validation/)
})

function rows() {
  return [
    { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { id: 'old-message', role: 'user', content: [{ type: 'text', text: 'Original existing chat' }], source: { kind: 'user' } } },
    ...types.map((type, index) => ({ type, seq: index + 1, time: index + 2, data: { preserved: type } })),
  ]
}

async function fixture(compression: 'zstd' | 'none' = 'zstd') {
  const [cordis, { default: jsonl }, session] = await Promise.all(['cordis', 'dsh-session-persistence-jsonl', 'dsh-session'].map(name => import(pathToFileURL(modulePath(name)).href)))
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-legacy-history-'))
  const ctx = new cordis.Context()
  const fiber = ctx.plugin(jsonl, { root: join(root, 'history'), compression })
  await fiber
  const backend = ctx.sessionPersistence
  const disposers: Array<() => Promise<unknown>> = []
  const encode = (data: Buffer) => compression === 'zstd' ? encodeSessionLog(data) : data
  const decode = (data: Buffer) => compression === 'zstd' ? decodeSessionLog(data) : data
  return { ctx, backend, root, jsonl, session, cordis, encode, decode, disposers,
    async old(id: string, events: any[] = rows(), extraHeader = {}) {
      const header = { version: 3, id, createdAt: 1, delegationDepth: 0, isSeeded: false, cwd: root, ...extraHeader }
      await backend.persistHeader(header, 0)
      const path = await backend.resolveCurrentLog(id)
      const physical = parseJsonl(decode(await readFile(path))).records[0]
      const original = encode(Buffer.from([physical, ...events].map(row => JSON.stringify(row)).join('\n') + '\n'))
      await writeFile(path, original)
      return { id, path, original, header, events }
    },
    async legacy(id: string, events: any[] = legacyRows(), version: 0 | 1 | 2 = 0) {
      const header = { version: 3, id, createdAt: 1, delegationDepth: 0, isSeeded: false, cwd: root }
      await backend.persistHeader(header, 0)
      const currentPath = await backend.resolveCurrentLog(id)
      const path = currentPath.replace('session.v3.', version === 0 ? 'session.' : `session.v${version}.`)
      const { isSeeded: _seeded, ...physical } = header
      const original = encode(Buffer.from([{ ...physical, ...(version === 2 ? { isSeeded: false } : {}), type: 'session', version }, ...events].map(row => JSON.stringify(row)).join('\n') + '\n'))
      await rm(currentPath)
      await writeFile(path, original)
      return { id, path, currentPath, original, header, events }
    },
    async mount() {
      const handle = await mountDshComposition(ctx, {})
      disposers.push(handle.dispose)
      await handle.historyCheck
      return handle
    },
    async close() {
      try { for (const dispose of disposers.reverse()) await dispose() } finally {
        try { await fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
      }
    },
  }
}

function legacyRows() {
  const message = (id: string) => ({ id, role: 'user', content: [{ type: 'text', text: 'Original continuation' }],
    source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'continuation', deliveryId: 'old-delivery' } })
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'agent/inbox/spliced', seq: 2, time: 3, data: { target: 'next-step', start: 0, inserted: [message('queued')] } },
    { type: 'user/message', seq: 3, time: 4, data: message('delivered'), surfaceOp: 'append' },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'parent', stack: 'Original diagnostic stack' } } } },
  ]
}

for (const compression of ['zstd', 'none'] as const) test(`startup migrates legacy ${compression} sources and retains the original generation`, options, async () => {
  const f = await fixture(compression)
  try {
    const old = await f.legacy('legacy-source')
    await assert.rejects(() => restored(f.backend, old.id), /source.*deliveryId/)
    const composition = await f.mount()
    assert.equal((await composition.historyCheck).repaired, 1)
    const result = await restored(f.backend, old.id)
    assert.equal(result.header.version, 3)
    const message = result.state.events.find((event: any) => event.type === 'user/message')
    assert.deepEqual(message.data.content, [{ type: 'text', text: 'Original continuation' }])
    assert.deepEqual(message.data.source, { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'instructions' })
    assert.deepEqual(result.state.events.at(-1).data.reason, { kind: 'aborted', reason: { kind: 'parent' } })
    assert.deepEqual(await readFile(old.path), old.original)
    assert.deepEqual(await readFile(`${old.path}.bak`), old.original)
    const migrated = await readFile(old.currentPath)
    const writer = await f.backend.open(old.id, 'write')
    try { await writer.append([{ type: 'session/title', seq: result.state.events.length, time: 20, data: { title: 'Resume migrated history' } }]); await writer.flush() }
    finally { await writer.close() }
    await composition.dispose()
    const reloaded = await f.mount()
    assert.equal((await reloaded.historyCheck).repaired, 0)
    assert.deepEqual(await readFile(old.path), old.original)
    assert.deepEqual(await readFile(`${old.path}.bak`), old.original)
    assert.notDeepEqual(await readFile(old.currentPath), migrated)
  } finally { await f.close() }
})

for (const defect of ['foreign-plugin', 'unexpected-source-field', 'invalid-stack', 'missing-turn-end'] as const) {
  test(`legacy migration refuses ${defect} before backup or publication`, options, async () => {
    const f = await fixture()
    try {
      const events: any[] = legacyRows()
      if (defect === 'foreign-plugin') events[3].data.source.plugin = 'other-plugin'
      if (defect === 'unexpected-source-field') events[3].data.source.unrecognized = true
      if (defect === 'invalid-stack') events.at(-1).data.reason.reason.stack = 42
      if (defect === 'missing-turn-end') events[5] = { type: 'turn/start', seq: 5, time: 6, data: { turn: 2 } }
      const old = await f.legacy(`refused-${defect}`, events)
      const handle = await f.mount(), result = await handle.historyCheck
      assert.equal(result.failed, 1)
      assert.equal(result.repaired, 0)
      assert.match(result.failures[0]!.error, defect === 'missing-turn-end' ? /does not close the prior turn/ : /unexpected member/)
      assert.deepEqual(await readFile(old.path), old.original)
      await assert.rejects(access(old.currentPath), { code: 'ENOENT' })
      await assert.rejects(access(`${old.path}.bak`), { code: 'ENOENT' })
    } finally { await f.close() }
  })
}

test('legacy migration respects the native write lease and never overwrites an existing successor', options, async () => {
  const f = await fixture()
  try {
    const old = await f.legacy('legacy-lease')
    const lease = await f.backend.acquireWriteLease(old.header)
    try {
      const mounted = await f.mount()
      assert.equal((await mounted.historyCheck).failed, 1)
      assert.deepEqual(await readFile(old.path), old.original)
      await assert.rejects(access(old.currentPath), { code: 'ENOENT' })
      await assert.rejects(access(`${old.path}.bak`), { code: 'ENOENT' })
    } finally { await lease.release() }
    await restored(f.backend, old.id)
    const successor = await readFile(old.currentPath)
    await restored(f.backend, old.id)
    assert.deepEqual(await readFile(old.currentPath), successor)
    assert.deepEqual(await readFile(old.path), old.original)
  } finally { await f.close() }
})

test('a successor created during legacy publication is never overwritten', options, async () => {
  const f = await fixture(), originalStat = f.backend.stat
  try {
    const old = await f.legacy('legacy-publication-race')
    const concurrent = Buffer.from('a concurrently created successor')
    let reads = 0
    f.backend.stat = async (...args: any[]) => {
      const snapshot = await originalStat.apply(f.backend, args)
      if (++reads === 2) await writeFile(old.currentPath, concurrent, { flag: 'wx' })
      return snapshot
    }
    const handle = await f.mount(), result = await handle.historyCheck
    assert.equal(result.failed, 1)
    assert.equal(result.repaired, 0)
    assert.match(result.failures[0]!.error, /EEXIST/)
    assert.deepEqual(await readFile(old.currentPath), concurrent)
    assert.deepEqual(await readFile(old.path), old.original)
    assert.deepEqual(await readFile(`${old.path}.bak`), old.original)
    assert.equal((await readdir(dirname(old.path))).some(name => name.includes('.kiokuko-')), false)
  } finally { f.backend.stat = originalStat; await f.close() }
})

async function restored(backend: any, id: string, access = 'read') {
  const handle = await backend.open(id, access)
  try { return { state: await handle.read(), header: handle.header, inherited: handle.inheritedEventCount } } finally { await handle.close() }
}

for (const version of [0, 1, 2] as const) for (const customEvents of [false, true]) test(`v${version} session ID lookup ${customEvents ? 'reports the unsupported Kiokuko history without changing it' : 'reads supported history through the native query'}`, options, async () => {
  const f = await fixture()
  try {
    const query = await import(pathToFileURL(modulePath('dsh-session-query')).href)
    for (const plugin of [f.session.default, query.default]) {
      const fiber = f.ctx.plugin(plugin)
      await fiber
      f.disposers.push(() => fiber.dispose())
    }
    const old = await f.legacy(`historical-v${version}`, [
      { type: 'session/title', seq: 0, time: 1, data: { title: 'Historical session', messageSeqs: [], source: { kind: 'user' } } },
      ...(customEvents ? rows().slice(1) : []),
    ], version)
    const historical = await readHistoricalDshSession(f.backend, old.id)
    assert.equal(historical?.session.id, old.id)
    assert.deepEqual(JSON.parse(JSON.stringify(historical?.events)), old.events, 'lookup retains old coordinates and custom payloads without migration')
    await assert.rejects(access(old.currentPath), { code: 'ENOENT' })
    const refusal = /unknown historical event|unknown event|unclassified event/
    if (customEvents) await assert.rejects(() => f.ctx.sessionQuery.readSession(old.id), refusal)
    const composition = await f.mount()
    const check = await composition.historyCheck
    assert.equal(check.listed, 1, 'the native store finds the original session ID')
    assert.equal(check.failed, customEvents ? 1 : 0)
    if (customEvents) {
      assert.match(check.failures[0]!.error, refusal)
      await assert.rejects(() => f.ctx.sessionQuery.readSession(old.id), refusal)
      await assert.rejects(access(old.currentPath), { code: 'ENOENT' })
    } else {
      const result = await f.ctx.sessionQuery.readSession(old.id)
      assert.equal(result.session.id, old.id)
      assert.equal(result.session.version, 3)
      assert.equal(result.events[0].data.title, old.events[0].data.title)
    }
    assert.deepEqual(await readFile(old.path), old.original)
    await assert.rejects(access(`${old.path}.bak`), { code: 'ENOENT' })
    const listed = await f.backend.list()
    assert.equal(listed.filter((item: any) => item.header.id === old.id).length, 1)
  } finally { await f.close() }
})

for (const compression of ['zstd', 'none'] as const) for (const version of [0, 1, 2] as const) test(`cold v${version} ${compression} lookup reaches the host cache and export without native migration`, options, async () => {
  const f = await fixture(compression)
  try {
    execFileSync('git', ['init', '-q', f.root])
    const sessions = f.ctx.plugin(f.session.default)
    await sessions
    f.disposers.push(() => sessions.dispose())
    const events: any[] = rows().slice(1).map((event, seq) => ({ ...event, seq }))
    if (version < 2) events.push({ type: 'text-chunks', seq0: events.length, time0: 100,
      data: { turn: 1, step: 1, index: 0, dt: [3], texts: ['Historical ', 'reply'] } })
    const old = await f.legacy(`export-v${version}`, events, version)
    const nativeBefore = await f.backend.stat(old.id)
    const listedBefore = await f.backend.list()
    assert.equal(nativeBefore.header.id, old.id)
    let originalRefusal: { name: string; message: string } | undefined
    await assert.rejects(() => restored(f.backend, old.id), (error: Error) => {
      assert.match(error.message, /unknown historical event|unknown event|unclassified event/)
      originalRefusal = { name: error.name, message: error.message }
      return true
    })
    let nativeReads = 0
    const adapter = createDshHostAdapter(f.ctx, {
      repositoryRoot: f.root, databasePath: join(f.root, 'memory.sqlite3'),
      migrationsDirectory: join(process.cwd(), 'migrations'),
      sessionQuery: { async readSession() { nativeReads++; throw new Error('migration must not be used for historical lookup') } },
    })
    f.disposers.push(adapter.dispose)
    const result = await adapter.host.sessionExport!.open(old.id)
    assert.equal(result.status, 200)
    const parts: Buffer[] = []
    for await (const part of result.body) parts.push(Buffer.from(part))
    const archive = Buffer.concat(parts)
    const start = 30 + archive.readUInt16LE(26)
    const end = archive.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), start)
    assert.ok(end > start)
    const exported = archive.subarray(start, end).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(exported.slice(0, 5), events.slice(0, 5))
    if (version < 2) {
      assert.deepEqual(exported.slice(5).map(event => [event.seq, event.time, event.data.chunk.text]), [
        [5, 100, 'Historical '], [6, 103, 'reply'],
      ])
    }
    assert.equal(nativeReads, 0)
    assert.deepEqual(await readFile(old.path), old.original)
    await assert.rejects(access(old.currentPath), { code: 'ENOENT' })
    await assert.rejects(access(`${old.path}.bak`), { code: 'ENOENT' })
    // A second request uses the persistent mirror, not an in-memory decoder result.
    const cached = await adapter.host.sessionExport!.open(old.id)
    for await (const _part of cached.body) { /* drain */ }
    assert.equal(nativeReads, 0)
    assert.deepEqual(await f.backend.stat(old.id), nativeBefore, 'import retains the native ID, header, revision and size')
    assert.deepEqual(await f.backend.list(), listedBefore, 'import neither duplicates nor renames native sessions')
    // Recreate the native persistence service so these assertions cannot rely on cached identity.
    const reopened = new f.cordis.Context()
    const fiber = reopened.plugin(f.jsonl, { root: join(f.root, 'history'), compression })
    await fiber
    try {
      assert.deepEqual(await reopened.sessionPersistence.stat(old.id), nativeBefore)
      assert.deepEqual(await reopened.sessionPersistence.list(), listedBefore)
      await assert.rejects(() => restored(reopened.sessionPersistence, old.id), (error: Error) => {
        assert.deepEqual({ name: error.name, message: error.message }, originalRefusal,
          'native reopening retains the original format refusal rather than introducing an ID integrity failure')
        return true
      })
      assert.deepEqual(await readFile(old.path), old.original)
      await assert.rejects(access(old.currentPath), { code: 'ENOENT' })
    } finally { await fiber.dispose() }
  } finally { await f.close() }
})

for (const compression of ['zstd', 'none'] as const) for (const version of [0, 1, 2] as const) test(`native DSH reopens imported supported v${version} ${compression} history with the original ID`, options, async () => {
  const f = await fixture(compression)
  try {
    execFileSync('git', ['init', '-q', f.root])
    const sessions = f.ctx.plugin(f.session.default)
    await sessions
    f.disposers.push(() => sessions.dispose())
    const old = await f.legacy(`reopen-v${version}`, [
      { type: 'session/title', seq: 0, time: 1, data: { title: 'Original title', messageSeqs: [], source: { kind: 'user' } } },
    ], version)
    const before = await f.backend.stat(old.id)
    const adapter = createDshHostAdapter(f.ctx, {
      repositoryRoot: f.root, databasePath: join(f.root, 'memory.sqlite3'),
      migrationsDirectory: join(process.cwd(), 'migrations'),
      sessionQuery: { async readSession() { throw new Error('import must use the historical reader') } },
    })
    f.disposers.push(adapter.dispose)
    const result = await adapter.host.sessionExport!.open(old.id)
    assert.equal(result.status, 200)
    for await (const _part of result.body) { /* drain */ }
    assert.deepEqual(await f.backend.stat(old.id), before)
    assert.deepEqual(await readFile(old.path), old.original)
    await assert.rejects(access(old.currentPath), { code: 'ENOENT' })
    const reopened = new f.cordis.Context()
    const fiber = reopened.plugin(f.jsonl, { root: join(f.root, 'history'), compression })
    await fiber
    try {
      assert.deepEqual(await reopened.sessionPersistence.stat(old.id), before)
      const restoredSession = await restored(reopened.sessionPersistence, old.id)
      assert.equal(restoredSession.header.id, old.id)
      assert.equal(restoredSession.state.events[0].data.title, 'Original title')
      const listed = await reopened.sessionPersistence.list()
      assert.equal(listed.length, 1)
      assert.equal(listed[0].header.id, old.id)
      assert.deepEqual(await readFile(old.path), old.original)
    } finally { await fiber.dispose() }
  } finally { await f.close() }
})

for (const defect of ['gap', 'torn-frame', 'wrong-id', 'symlink', 'changed-revision', 'current-generation'] as const) test(`historical lookup rejects or defers ${defect} without changing the source`, options, async () => {
  const f = await fixture()
  try {
    const old = await f.legacy(`lookup-${defect}`, rows().slice(1).map((event, seq) => ({ ...event, seq })))
    if (defect === 'gap') {
      const parsed = parseJsonl(f.decode(old.original)).records as any[]
      parsed[2].seq = 99
      await writeFile(old.path, f.encode(Buffer.from(parsed.map(row => JSON.stringify(row)).join('\n') + '\n')))
    }
    if (defect === 'torn-frame') await writeFile(old.path, old.original.subarray(0, old.original.length - 1))
    if (defect === 'wrong-id') {
      const parsed = parseJsonl(f.decode(old.original)).records as any[]
      parsed[0].id = 'another-session'
      await writeFile(old.path, f.encode(Buffer.from(parsed.map(row => JSON.stringify(row)).join('\n') + '\n')))
    }
    if (defect === 'symlink') { await rename(old.path, `${old.path}.target`); await symlink(`${old.path}.target`, old.path) }
    if (defect === 'current-generation') await writeFile(old.currentPath, f.encode(Buffer.from(JSON.stringify({ type: 'session', ...old.header }) + '\n')))
    if (defect === 'changed-revision') {
      const originalStat = f.backend.stat.bind(f.backend)
      let count = 0
      f.backend.stat = async (id: string) => {
        const snapshot = await originalStat(id)
        return ++count === 1 ? snapshot : { ...snapshot, revision: 'concurrent-update' }
      }
    }
    const before = await readFile(old.path)
    if (defect === 'current-generation') assert.equal(await readHistoricalDshSession(f.backend, old.id), undefined)
    else await assert.rejects(() => readHistoricalDshSession(f.backend, old.id))
    assert.deepEqual(await readFile(old.path), before)
    await assert.rejects(access(`${old.path}.bak`), { code: 'ENOENT' })
  } finally { await f.close() }
})

for (const version of [0, 1, 2] as const) test(`historical v${version} lookup retains the inherited prefix`, options, async () => {
  const f = await fixture()
  try {
    const old = await f.legacy(`seeded-v${version}`, [
      { type: 'kiokuko/completion-report', seq: 0, time: 1, data: { text: 'inherited' } },
      { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } },
      { type: 'kiokuko/completion-report', seq: 2, time: 3, data: { text: 'own' } },
    ], version)
    const parsed = parseJsonl(f.decode(old.original)).records as any[]
    if (version < 2) parsed[0].seedLength = 1
    else parsed[0].isSeeded = true
    await writeFile(old.path, f.encode(Buffer.from(parsed.map(row => JSON.stringify(row)).join('\n') + '\n')))
    const result = await readHistoricalDshSession(f.backend, old.id)
    assert.equal(result?.inheritedEventCount, 1)
    assert.deepEqual(result?.events.map(event => event.seq), [0, 1, 2])
    await assert.rejects(access(old.currentPath), { code: 'ENOENT' })
  } finally { await f.close() }
})

test('historical lookup selects the newest stored generation and never falls back from its damaged body', options, async () => {
  const f = await fixture()
  try {
    const old = await f.legacy('multiple-generations', [{ type: 'kiokuko/completion-report', seq: 0, time: 1, data: { text: 'v0' } }])
    const newerPath = old.currentPath.replace('.v3.', '.v2.')
    const physical = { type: 'session', ...old.header, version: 2 }
    const event = { type: 'kiokuko/completion-report', seq: 0, time: 2, data: { text: 'v2' } }
    await writeFile(newerPath, f.encode(Buffer.from([physical, event].map(row => JSON.stringify(row)).join('\n') + '\n')))
    assert.deepEqual(JSON.parse(JSON.stringify((await readHistoricalDshSession(f.backend, old.id))?.events)), [event])
    await writeFile(newerPath, f.encode(Buffer.from([physical, { ...event, seq: 99 }].map(row => JSON.stringify(row)).join('\n') + '\n')))
    await assert.rejects(() => readHistoricalDshSession(f.backend, old.id), /seq gap/)
    assert.deepEqual(await readFile(old.path), old.original)
    await assert.rejects(access(old.currentPath), { code: 'ENOENT' })
  } finally { await f.close() }
})

for (const limit of ['file', 'expanded'] as const) test(`historical lookup reports the ${limit} size limit as 413 before caching`, options, async () => {
  const f = await fixture()
  try {
    const events = [{ type: 'kiokuko/completion-report', seq: 0, time: 1,
      data: { text: limit === 'expanded' ? 'x'.repeat(32 * 1024 * 1024) : 'small' } }]
    const old = await f.legacy(`oversized-${limit}`, events)
    if (limit === 'file') await truncate(old.path, 64 * 1024 * 1024 + 1)
    await assert.rejects(() => readHistoricalDshSession(f.backend, old.id), (error: any) => error.details?.httpStatus === 413)
    await assert.rejects(access(old.currentPath), { code: 'ENOENT' })
    await assert.rejects(access(`${old.path}.bak`), { code: 'ENOENT' })
  } finally { await f.close() }
})

for (const version of [0, 1, 2] as const) test(`host finalization extracts memory from a cold v${version} log with its original source range`, options, async () => {
  const f = await fixture()
  try {
    execFileSync('git', ['init', '-q', f.root])
    const sessions = f.ctx.plugin(f.session.default)
    await sessions
    f.disposers.push(() => sessions.dispose())
    const message = (id: string, text: string) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
    const old = await f.legacy(`memory-v${version}`, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: message('old-user', 'Preserve historical lookup coordinates.'), surfaceOp: 'append' },
      { type: 'request/header', seq: 2, time: 3, data: { header: { config: { provider: 'test-provider', model: 'test-model' } }, reason: 'initial' } },
      { type: 'kiokuko/completion-report', seq: 3, time: 4, data: { text: 'Historical custom event' } },
      { type: 'assistant/message', seq: 4, time: 5, data: { message: { id: 'old-answer', role: 'assistant', content: [{ type: 'text', text: 'Historical lookup verified.' }], source: { kind: 'model', provider: 'test-provider', model: 'test-model' } } }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
      { type: 'user/message', seq: 7, time: 8, data: message('future-user', 'FUTURE TURN MUST NOT LEAK'), surfaceOp: 'append' },
      { type: 'turn/end', seq: 8, time: 9, data: { turn: 2, reason: { kind: 'completed' } } },
    ], version)
    const calls: string[] = []
    const adapter = createDshHostAdapter(f.ctx, {
      repositoryRoot: f.root, databasePath: join(f.root, 'memory.sqlite3'), migrationsDirectory: join(process.cwd(), 'migrations'),
      memoryEvolution: { mode: 'off' },
      sessionQuery: { async readSession() { throw new Error('historical finalization must not invoke native migration') } },
      llm: { async * stream(request) {
        calls.push(JSON.stringify(request))
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ schemaVersion: 1, memories: [
          { kind: 'lesson', title: 'Historical coordinates', body: 'Preserve original event coordinates when reading old logs.', summary: null, confidence: 0.9, tags: [] },
        ] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } },
    })
    f.disposers.push(adapter.dispose)
    const runtime = adapter.host.runtime!, finalizer = adapter.host.memoryFinalizer!
    assert.ok(finalizer instanceof DshMemoryFinalizer)
    const workspace = await runtime.withDatabase(database => {
      const binding = database.prepare('SELECT r.workspace FROM repositories r JOIN repository_locations l ON l.repository_id = r.repository_id WHERE l.canonical_root = ?')
        .get<{ workspace: string }>(realpathSync(f.root))!
      new LedgerStore(database).createRun({ runId: 'lookup-run', workspace: binding.workspace, dshSessionId: old.id,
        protocolVersion: '1', captureProfile: 'minimal', coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
        task: { title: 'Historical lookup', query: 'Historical lookup', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } } })
      return binding.workspace
    })
    await finalizer.bindRunStart({ runId: 'lookup-run', workspace, dshSessionId: old.id, sourceStartSeq: 0, sourceStartTurn: 1 })
    await runtime.withDatabase(database => withImmediateTransaction(database, () => {
      new LedgerStore(database).updateRunStatusInTransaction('lookup-run', 'completed')
      finalizer.scheduleInTransaction(database, { runId: 'lookup-run', workspace, dshSessionId: old.id, sourceEndSeq: 5 })
      if (version === 0) database.prepare("UPDATE dsh_memory_finalizations SET status = 'failed', attempt_count = 1 WHERE run_id = ?").run('lookup-run')
    }))
    // A pre-update failed lookup is retried on startup within the existing budget.
    await finalizer.start()
    await finalizer.whenIdle()
    const evidence = await runtime.withDatabase(database => ({
      job: database.prepare('SELECT * FROM dsh_memory_finalizations WHERE run_id = ?').get('lookup-run'),
      memory: database.prepare('SELECT provenance_json FROM entry_revisions WHERE title = ?').get<{ provenance_json: string }>('Historical coordinates'),
    }))
    assert.equal(evidence.job?.status, 'completed', JSON.stringify(evidence.job))
    assert.equal(evidence.job?.attempt_count, version === 0 ? 2 : 1)
    assert.equal(calls.length, 1)
    assert.ok(calls[0]!.includes('Preserve historical lookup coordinates.'))
    assert.ok(calls[0]!.includes('Historical lookup verified.'))
    assert.ok(!calls[0]!.includes('FUTURE TURN MUST NOT LEAK'))
    assert.ok(JSON.parse(evidence.memory!.provenance_json).reference.startsWith(`dsh-session:${old.id}?seq=0-5#sha256:`))
    assert.deepEqual(await readFile(old.path), old.original)
    await assert.rejects(access(old.currentPath), { code: 'ENOENT' })
  } finally { await f.close() }
})

for (const compression of ['zstd', 'none'] as const) test(`normal history open repairs multiple old ${compression} chats and supports cold resume`, options, async () => {
  const f = await fixture(compression)
  try {
    const first = await f.old('legacy-first'), second = await f.old('legacy-second'), untouched = await f.old('legacy-unopened')
    await assert.rejects(() => restored(f.backend, first.id), /unknown to this harness/)
    const composition = await f.mount()
    assert.deepEqual(await composition.historyCheck, { supported: true, listed: 3, checked: 3, repaired: 3, failed: 0, cancelled: false, failures: [] })
    for (const old of [first, second]) {
      const loaded = await restored(f.ctx.sessionPersistence, old.id)
      const expected = old.events.map(row => types.includes(row.type) ? { ...row, ignorable: true } : row)
      assert.deepEqual(loaded.state.events, expected)
      assert.deepEqual(await readFile(`${old.path}.bak`), old.original)
      f.session.Session.fromRestore(old.id, loaded.state.events, loaded.header, loaded.inherited, loaded.state.eventState)
      const repaired = await readFile(old.path)
      await restored(f.backend, old.id)
      assert.deepEqual(await readFile(old.path), repaired, 'a second open does not rewrite history')
      const writer = await f.backend.open(old.id, 'write')
      try {
        await writer.append([{ type: 'session/title', seq: expected.length, time: 20, data: { title: 'Resumed chat' } }])
        await writer.flush()
      } finally { await writer.close() }
    }
    assert.deepEqual(await readFile(`${untouched.path}.bak`), untouched.original, 'startup checks and repairs IDs before the user opens those chats')
    const cold = new f.cordis.Context(), coldFiber = cold.plugin(f.jsonl, { root: join(f.root, 'history'), compression })
    await coldFiber
    try {
      const loaded = await restored(cold.sessionPersistence, second.id)
      assert.equal(loaded.state.events.at(-1).data.title, 'Resumed chat', 'fresh native backend without adapter accepts persisted result')
    } finally { await coldFiber.dispose() }
  } finally { await f.close() }
})

test('concurrent reads share a safe repair and seeded histories retain their inherited boundary', options, async () => {
  const f = await fixture()
  try {
    await f.mount()
    const events = rows()
    events.splice(1, 0, { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } } as any)
    events.forEach((row, index) => { row.seq = index })
    const old = await f.old('legacy-fork', events, { isSeeded: true, parentSession: 'parent' })
    const loaded = await Promise.all([restored(f.backend, old.id), restored(f.backend, old.id)])
    assert.deepEqual(loaded[0], loaded[1])
    assert.equal(loaded[0]!.inherited, 1)
    assert.deepEqual(await readFile(`${old.path}.bak`), old.original)
  } finally { await f.close() }
})

test('public plugin startup repairs unopened histories on first load and reload', options, async (t) => {
  const f = await fixture()
  let resolveScan!: (value: string) => void, rejectScan!: (reason: unknown) => void
  let scan = new Promise<string>((resolve, reject) => { resolveScan = resolve; rejectScan = reject })
  const cancel = () => rejectScan(t.signal.reason)
  t.signal.addEventListener('abort', cancel, { once: true })
  const info = console.info.bind(console)
  t.mock.method(console, 'info', (...args: unknown[]) => {
    info(...args)
    if (typeof args[0] === 'string' && args[0].startsWith('[kiokuko-dsh] [info] Session ID check:')) resolveScan(args[0])
  })
  try {
    const legacy = await f.legacy('first-load-v0')
    const current = await f.old('first-load-v3')
    const healthy = await f.old('first-load-healthy', rows().slice(0, 1))
    const plugin = f.ctx.plugin(dshPlugin, { enabled: true })
    f.disposers.push(() => plugin.dispose())
    await plugin
    assert.match(await scan, /3\/3 checked, 2 repaired, 0 failed$/)
    // No chat open, composition mount, or repair command triggers these writes.
    for (const old of [legacy, current]) assert.deepEqual(await readFile(`${old.path}.bak`), old.original)
    assert.deepEqual(await readFile(legacy.path), legacy.original)
    const migrated = await readFile(legacy.currentPath)
    const repaired = await readFile(current.path)
    assert.deepEqual(await readFile(healthy.path), healthy.original)
    await assert.rejects(access(`${healthy.path}.bak`), { code: 'ENOENT' })

    await plugin.dispose()
    const next = await f.legacy('next-package-load-v0')
    scan = new Promise<string>((resolve, reject) => { resolveScan = resolve; rejectScan = reject })
    const reloaded = f.ctx.plugin(dshPlugin, { enabled: true })
    f.disposers.push(() => reloaded.dispose())
    await reloaded
    assert.match(await scan, /4\/4 checked, 1 repaired, 0 failed$/)
    assert.deepEqual(await readFile(`${next.path}.bak`), next.original)
    assert.deepEqual(await readFile(next.path), next.original)
    assert.deepEqual(await readFile(legacy.currentPath), migrated)
    assert.deepEqual(await readFile(current.path), repaired)
    assert.equal((await restored(f.backend, next.id)).header.version, 3)
  } finally {
    t.signal.removeEventListener('abort', cancel)
    await f.close()
  }
})

test('normal plugin loading restores the session query used by the chat page', options, async () => {
  const f = await fixture()
  try {
    const query = await import(pathToFileURL(modulePath('dsh-session-query')).href)
    for (const plugin of [f.session.default, query.default]) {
      const fiber = f.ctx.plugin(plugin)
      await fiber
      f.disposers.push(() => fiber.dispose())
    }
    const old = await f.old('legacy-page-history')
    await assert.rejects(() => f.ctx.sessionQuery.observeSession(old.id), /failed to observe session.*unknown to this harness/)
    const host = f.ctx.plugin({ name: 'history-host', apply(ctx: any) { return ctx.provide('kiokukoDsh', {}) } })
    await host
    f.disposers.push(() => host.dispose())
    const plugin = f.ctx.plugin(dshPlugin, { enabled: true })
    await plugin
    f.disposers.push(() => plugin.dispose())
    for (let attempt = 0; attempt < 2; attempt++) {
      const observation = await f.ctx.sessionQuery.observeSession(old.id)
      try {
        assert.equal(observation.source, 'prepared')
        assert.equal(observation.events[0].data.content[0].text, 'Original existing chat')
        assert.equal(observation.events.length, old.events.length)
      } finally { observation[Symbol.dispose]() }
    }
    await plugin.dispose()
    const next = await f.old('legacy-after-plugin-unload')
    await assert.rejects(() => f.ctx.sessionQuery.observeSession(next.id), /unknown to this harness/)
  } finally { await f.close() }
})

test('native write lease prevents repair while another owner holds the session', options, async () => {
  const f = await fixture()
  try {
    const old = await f.old('legacy-locked')
    const lease = await f.backend.acquireWriteLease(old.header)
    try {
      const composition = await f.mount()
      assert.equal((await composition.historyCheck).failed, 1)
      await assert.rejects(() => restored(f.backend, old.id), /legacy history compatibility failed/)
      assert.deepEqual(await readFile(old.path), old.original)
      await assert.rejects(access(`${old.path}.bak`), { code: 'ENOENT' })
    } finally { await lease.release() }
    await restored(f.backend, old.id)
  } finally { await f.close() }
})

test('startup continues past a failed ID and runs again on plugin reload', options, async () => {
  const f = await fixture()
  try {
    const failed = await f.old('startup-unsupported', [...rows(), { type: 'other/required', seq: 6, time: 8, data: {} }])
    const healthy = await f.old('startup-healthy', rows().slice(0, 1))
    const legacy = await f.old('startup-legacy')
    const first = await f.mount(), result = await first.historyCheck
    assert.equal(result.checked, 3)
    assert.equal(result.repaired, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.failures[0]?.id, failed.id)
    assert.deepEqual(await readFile(failed.path), failed.original)
    assert.deepEqual(await readFile(healthy.path), healthy.original)
    await assert.rejects(access(`${healthy.path}.bak`), { code: 'ENOENT' })
    assert.deepEqual(await readFile(`${legacy.path}.bak`), legacy.original)
    await first.dispose()
    const next = await f.old('startup-after-update')
    const second = await f.mount(), reloaded = await second.historyCheck
    assert.equal(reloaded.checked, 4)
    assert.equal(reloaded.repaired, 1)
    assert.deepEqual(await readFile(`${next.path}.bak`), next.original)
    assert.deepEqual(await readFile(`${legacy.path}.bak`), legacy.original)
  } finally { await f.close() }
})

test('unload cancels and drains the startup check before any repair writes', options, async () => {
  const f = await fixture()
  const originalOpen = f.backend.open
  try {
    const old = await f.old('startup-cancelled')
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    f.backend.open = async (_id: string, _access: string, options: { signal: AbortSignal }) => {
      signalStarted()
      await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    }
    const handle = mountSessionHistoryCompatibility(f.ctx)
    f.disposers.push(handle.dispose)
    await started
    await handle.dispose()
    const result = await handle.ready
    assert.equal(result.cancelled, true)
    assert.equal(result.checked, 0)
    assert.deepEqual(await readFile(old.path), old.original)
    await assert.rejects(access(`${old.path}.bak`), { code: 'ENOENT' })
  } finally { f.backend.open = originalOpen; await f.close() }
})

test('unsupported older generations retain the original native migration error', options, async () => {
  const f = await fixture(), originalOpen = f.backend.open
  try {
    const old = await f.legacy('unsupported-v0', [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }])
    const error = Object.assign(new Error('Native v0 migration refuses an unsupported source field'), {
      name: 'SessionFormatUnsupportedError', location: { kind: 'jsonl', path: old.path },
    })
    f.backend.open = async () => { throw error }
    const adapter = mountSessionHistoryCompatibility(f.ctx)
    f.disposers.push(adapter.dispose)
    const result = await adapter.ready
    assert.equal(result.failed, 1)
    assert.equal(result.failures[0]?.error, error.message)
    await assert.rejects(f.backend.open('unsupported-v0', 'read'), cause => cause === error)
  } finally { f.backend.open = originalOpen; await f.close() }
})

test('unload restores the original reader and duplicate mounts retain the remaining owner', options, async () => {
  const f = await fixture()
  try {
    const first = mountSessionHistoryCompatibility(f.ctx), second = mountSessionHistoryCompatibility(f.ctx)
    f.disposers.push(first.dispose, second.dispose)
    assert.equal(first.ready, second.ready, 'one startup check is shared by duplicate owners')
    await first.ready
    await first.dispose()
    await restored(f.backend, (await f.old('legacy-one-owner')).id)
    await second.dispose()
    const old = await f.old('legacy-no-owner')
    await assert.rejects(() => restored(f.backend, old.id), /unknown to this harness/)
    assert.deepEqual(await readFile(old.path), old.original)
  } finally { await f.close() }
})

test('abort before replacement leaves original bytes and releases the native lease', options, async () => {
  const f = await fixture()
  try {
    await f.mount()
    const old = await f.old('legacy-aborted'), controller = new AbortController()
    const prototype = f.jsonl.prototype, originalRead = prototype.readStoredLog
    prototype.readStoredLog = async function (...args: any[]) {
      const value = await originalRead.apply(this, args)
      if (args[0] !== old.path) controller.abort(new Error('test cancellation after candidate validation'))
      return value
    }
    try { await assert.rejects(() => f.backend.open(old.id, 'read', { signal: controller.signal }), /test cancellation/) }
    finally { prototype.readStoredLog = originalRead }
    assert.deepEqual(await readFile(old.path), old.original)
    await assert.rejects(access(`${old.path}.bak`), { code: 'ENOENT' })
    await restored(f.backend, old.id)
  } finally { await f.close() }
})

for (const defect of ['unknown', 'surface', 'false-marker', 'sequence', 'wrong-id', 'wrong-cwd', 'malformed', 'torn-frame', 'backup', 'symlink'] as const) {
  test(`refuses ${defect} without replacing the original history`, options, async () => {
    const f = await fixture()
    try {
      const events: any[] = rows()
      if (defect === 'unknown') events.push({ type: 'other/required', seq: events.length, time: 10, data: {} })
      if (defect === 'surface') events[1].surfaceOp = 'append'
      if (defect === 'false-marker') events[1].ignorable = false
      if (defect === 'sequence') events.at(-1).seq = 900
      const old = await f.old(`legacy-${defect}`, events)
      if (defect === 'wrong-id' || defect === 'wrong-cwd') {
        const records: any[] = parseJsonl(f.decode(old.original)).records
        if (defect === 'wrong-id') records[0].id = 'different-session'
        else records[0].cwd = join(f.root, 'different-workspace')
        await writeFile(old.path, f.encode(Buffer.from(records.map(row => JSON.stringify(row)).join('\n') + '\n')))
      }
      if (defect === 'malformed') await writeFile(old.path, f.encode(Buffer.concat([f.decode(old.original), Buffer.from('{bad}\n')])))
      if (defect === 'torn-frame') await writeFile(old.path, Buffer.concat([old.original, f.encode(Buffer.from('{"extra":true}\n')).subarray(0, 7)]))
      if (defect === 'backup') await writeFile(`${old.path}.bak`, 'unrelated backup')
      if (defect === 'symlink') { await rename(old.path, `${old.path}.target`); await symlink(`${old.path}.target`, old.path) }
      const before = await readFile(old.path)
      await f.mount()
      await assert.rejects(() => restored(f.backend, old.id))
      assert.deepEqual(await readFile(old.path), before)
      if (defect === 'backup') assert.equal(await readFile(`${old.path}.bak`, 'utf8'), 'unrelated backup')
      else await assert.rejects(access(`${old.path}.bak`), { code: 'ENOENT' })
      assert.equal((await readdir(dirname(old.path))).some(name => name.endsWith('.tmp')), false)
    } finally { await f.close() }
  })
}

// Isolate the plugin's startup deployment from the user's Skill directory.
isolateSkillHome()
