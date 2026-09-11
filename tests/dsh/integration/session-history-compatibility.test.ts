import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdtemp, readFile, readdir, rm, writeFile, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import * as dshPlugin from '../../../src/dsh/index.js'
import { mountSessionHistoryCompatibility } from '../../../src/dsh/session-history-compatibility.js'
import { decodeSessionLog, encodeSessionLog, parseJsonl } from '../../../scripts/session-history-codec.mjs'

const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const jsonlPath = join(packageRoot, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')
const available = await access(jsonlPath).then(() => true, () => false)
if (!available && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1') throw new Error('Native history compatibility requires the pinned DSH runtime')
const options = { skip: available ? false : 'requires pinned DSH runtime', timeout: 30_000 }
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
  const [cordis, { default: jsonl }, session] = await Promise.all(['cordis', 'dsh-session-persistence-jsonl', 'dsh-session'].map(name => import(pathToFileURL(join(packageRoot, '@deepseek-ai', name, 'lib/index.js')).href)))
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
    async mount() {
      const handle = await mountDshComposition(ctx, {})
      disposers.push(handle.dispose)
      return handle
    },
    async close() {
      try { for (const dispose of disposers.reverse()) await dispose() } finally {
        try { await fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
      }
    },
  }
}

async function restored(backend: any, id: string, access = 'read') {
  const handle = await backend.open(id, access)
  try { return { state: await handle.read(), header: handle.header, inherited: handle.inheritedEventCount } } finally { await handle.close() }
}

for (const compression of ['zstd', 'none'] as const) test(`normal history open repairs multiple old ${compression} chats and supports cold resume`, options, async () => {
  const f = await fixture(compression)
  try {
    const first = await f.old('legacy-first'), second = await f.old('legacy-second'), untouched = await f.old('legacy-unopened')
    await assert.rejects(() => restored(f.backend, first.id), /unknown to this harness/)
    await f.mount()
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
    assert.deepEqual(await readFile(untouched.path), untouched.original, 'opening a chat does not scan and rewrite other chats')
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
    const events = rows()
    events.splice(1, 0, { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } } as any)
    events.forEach((row, index) => { row.seq = index })
    const old = await f.old('legacy-fork', events, { isSeeded: true, parentSession: 'parent' })
    await f.mount()
    const loaded = await Promise.all([restored(f.backend, old.id), restored(f.backend, old.id)])
    assert.deepEqual(loaded[0], loaded[1])
    assert.equal(loaded[0]!.inherited, 1)
    assert.deepEqual(await readFile(`${old.path}.bak`), old.original)
  } finally { await f.close() }
})

test('normal plugin loading restores the session query used by the chat page', options, async () => {
  const f = await fixture()
  try {
    const query = await import(pathToFileURL(join(packageRoot, '@deepseek-ai/dsh-session-query/lib/index.js')).href)
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
    await f.mount()
    const lease = await f.backend.acquireWriteLease(old.header)
    try {
      await assert.rejects(() => restored(f.backend, old.id), /legacy history compatibility failed/)
      assert.deepEqual(await readFile(old.path), old.original)
      await assert.rejects(access(`${old.path}.bak`), { code: 'ENOENT' })
    } finally { await lease.release() }
    await restored(f.backend, old.id)
  } finally { await f.close() }
})

test('unload restores the original reader and duplicate mounts retain the remaining owner', options, async () => {
  const f = await fixture()
  try {
    const first = mountSessionHistoryCompatibility(f.ctx), second = mountSessionHistoryCompatibility(f.ctx)
    f.disposers.push(first.dispose, second.dispose)
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
    const old = await f.old('legacy-aborted'), controller = new AbortController()
    await f.mount()
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
