import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { mountLispSurface } from '../../../../src/dsh/lisp/surface.js'
import { CompiledLispCache } from '../../../../src/dsh/lisp/compiled-cache.js'

test('native lifecycle hooks suspend, resume before model input, preserve fencing and dispose exact sessions', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL' : false, timeout: 90000,
}, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-idle-surface-')))
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const listeners = new Map<string, (...args: any[]) => any>(), definitions = new Map<string, any>(), sections = new Map<string, string>()
  let command: any, guard: any, registrations = 0
  const tools = { guard(fn: any) { guard = fn; return () => {} }, presentAs: () => () => {}, restrict: () => () => {},
    register(d: any) { registrations++; definitions.set(d.name, d); return () => definitions.delete(d.name) }, get: (name: string) => definitions.get(name) }
  const local = { get: (name: string) => name === 'tools' ? tools : name === 'systemPrompt' ? {
    section(d: any) { sections.set(d.name, d.text); return () => sections.delete(d.name) },
  } : undefined }
  let agent: any = { id: 'one', status: 'idle', session: { id: 'one', header: { cwd: base } }, ctx: local }
  let currentAgent: any = agent, currentSession: any = agent.session
  const services: Record<string, any> = { tools, agents: { get: (id: string) => id === currentAgent?.id ? currentAgent : undefined },
    sessions: { get: (id: string) => id === currentSession?.id ? currentSession : undefined }, commands: { register(d: any) { command = d; return () => {} } } }
  const ctx: any = { get: (name: string) => services[name], provide: () => () => {},
    on(name: string, fn: any) { listeners.set(name, fn); return () => listeners.delete(name) } }
  ctx.root = ctx
  const runtime: any = { withDatabase: async (fn: any) => fn(db) }
  const surface = await mountLispSurface(ctx, runtime, LispConfig.parse({ enabled: true, idleTimeoutMs: 1000, startupTimeoutMs: 60000 }))
  const owner = { sessionId: 'one', agentId: 'one', root: base }
  const state = async () => await surface.manager.status(owner) as any
  const step = () => listeners.get('agent/pre-step')!({ agent }, () => 'model-ready')
  try {
    assert.equal((await command.handler({ rawInput: 'enable', agent, signal: new AbortController().signal })).kind, 'success')
    const firstGeneration = (await state()).generation
    await listeners.get('agent/status')!({ agent, status: 'running' })
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal((await state()).state, 'READY')
    await listeners.get('agent/status')!({ agent, status: 'idle' })
    const deadline = Date.now() + 5000
    while ((await state()).state !== 'SUSPENDED') { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)) }
    assert.match(guard({ agent, name: 'bash' }), /Lisp/u, 'normal suspension never releases protection')
    assert.match((await command.handler({ rawInput: 'status', agent })).text, /SUSPENDED/u)
    assert.equal(await step(), 'model-ready')
    const nextGeneration = (await state()).generation
    assert.notEqual(nextGeneration, firstGeneration)
    assert.match(sections.get('kiokuko:lisp-runtime')!, /automatically restarted/u)
    assert.ok(sections.get('kiokuko:lisp-runtime')!.includes(nextGeneration), 'new generation reaches the model before its next step')
    await listeners.get('session/disposed')!({ ...agent.session })
    assert.equal((await state()).state, 'READY', 'a same-ID stale session cannot terminate this worker')
    const ended = agent.session
    currentAgent = undefined; currentSession = undefined
    await listeners.get('session/disposed')!(ended)
    assert.equal((await state()).state, 'SUSPENDED')
    assert.equal(definitions.size, 0)
    assert.equal(sections.size, 0)
    agent = { ...agent, session: { ...ended } }; currentAgent = agent; currentSession = agent.session
    assert.equal(await step(), 'model-ready', 'reopening the conversation resumes without manual recovery')
    assert.ok(definitions.has('lisp_eval'))
    assert.match(guard({ agent, name: 'bash' }), /Lisp/u)
    // Session disposal can arrive before startup registers tools. It still
    // cancels the admission and must not register a dead agent afterward.
    let entered!: () => void, release!: () => void
    const entering = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const ensure = CompiledLispCache.prototype.ensure
    t.mock.method(CompiledLispCache.prototype, 'ensure', async function(this: CompiledLispCache, ...args: Parameters<typeof ensure>) {
      entered(); await gate; return ensure.apply(this, args)
    })
    agent = { ...agent, id: 'starting', session: { id: 'starting', header: { cwd: base } } }
    currentAgent = agent; currentSession = agent.session
    const beforeStartup = registrations
    const starting = command.handler({ rawInput: 'enable', agent, signal: new AbortController().signal })
    await entering
    currentAgent = undefined; currentSession = undefined
    const disposal = listeners.get('session/disposed')!(agent.session)
    release()
    assert.equal((await starting).kind, 'error')
    await disposal
    assert.equal((await surface.manager.status({ ...owner, sessionId: 'starting', agentId: 'starting' }) as any).state, 'RECOVERY_REQUIRED')
    assert.equal(registrations, beforeStartup, 'startup completion cannot register tools for a disposed agent')
  } finally { surface.stop(); await surface.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})
