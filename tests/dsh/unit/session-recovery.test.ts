import assert from 'node:assert/strict'
import test from 'node:test'
import { Session, SessionId, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionRecovery, SessionRecoveryError } from '../../../src/dsh/session-recovery.js'
import { sessionRecoveryResponse } from '../../../src/dsh/session-recovery-surface.js'

function fixture() {
  const agents = new Map<string, any>(), sessions = new Map<string, Session>(), sent: any[] = [], created: any[] = []
  let available = true, resolved: (selection: any) => Promise<unknown> = async value => value, createFailure = false
  let flush: () => Promise<void> = async () => {}, readCloses = 0, activations = 0
  const make = (id: string, cwd = '/tmp', preset = 'standard') => {
    const base = Session.create(SessionId(id))
    const session = Session.create(SessionId(id), [], { ...base.header, cwd, agentPreset: preset })
    let selection: any = { provider: 'fixture', model: 'fixture', reasoningEffort: 'high' }
    const agent = { id, session, status: 'idle', inbox: { nextStep: [] as any[], nextTurn: [] as any[] },
      model: { current: () => selection, select: (value: any) => { selection = { ...value }; (session as any).append('model/selection', value) } },
      followup(message: any) { sent.push(message); agent.inbox.nextTurn.push(message); agent.status = 'running' },
    }
    agents.set(id, agent); sessions.set(id, session)
    return agent
  }
  const source = make('recovery-source')
  source.session.append('turn/start', { turn: 1 })
  source.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Inspect package.json' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  source.session.append('tool/call', { turn: 1, step: 1, callId: 'lost-call' as never, name: 'bash', arguments: '{}' })
  source.session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
  const workspaceRegistry: any = { list: () => [{ id: 'workspace-a', sessionIds: [source.id] }], archivedSessionIds: [] }
  const host: any = { get(name: string) { return ({
    agents: { get: (id: string) => agents.get(id), create: async (options: any) => { created.push(options); return { agent: make(options.sessionId, options.meta.cwd), async dispose() {} } } },
    sessions: { get: (id: string) => sessions.get(id), flush: () => flush() },
    llm: { listProviders: () => available ? [{ id: 'fixture' }] : [], resolveCallConfig: (selection: any) => resolved(selection) },
    sessionController: {
      async create(options: any) { created.push(options); if (createFailure) { createFailure = false; throw new Error('Creation unavailable') }; make(options.sessionId); return { sessionId: options.sessionId } },
      async *follow(request: any) { activations++; agents.set(request.sessionId, { ...source, status: 'idle' }); yield { type: 'snapshot' } },
    },
    workspaceRegistry,
    sessionPersistence: {
      stat: async (id: string) => sessions.has(id) ? { header: sessions.get(id)!.header } : undefined,
      async open(id: string) { const session = sessions.get(id)!; return { header: session.header, read: async () => ({ meta: session.header, events: session.snapshotEvents() }), close: async () => { readCloses++ } } },
    },
  } as any)[name] } }
  const service = new SessionRecovery(host)
  const input = (action: 'continue' | 'new', operationId = 'operation-a') => ({ sessionId: source.id, action, operationId, expectedSeq: source.session.snapshotEvents().at(-1)!.seq })
  return { service, source, agents, sessions, sent, created, host, input, make,
    unavailable() { available = false }, failCreate() { createFailure = true },
    resolveWith(next: typeof resolved) { resolved = next }, flushWith(next: typeof flush) { flush = next },
    readCloses: () => readCloses, activations: () => activations,
  }
}

test('continuation retains history, queues one new human action, and never replays the unknown call', async () => {
  const f = fixture(), original = f.source.session.snapshotEvents()
  try {
    const request = f.input('continue')
    await f.service.act(request)
    await f.service.act(request)
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0].source.kind, 'user')
    assert.match(f.sent[0].content[0].text, /無条件に再実行しない/)
    assert.deepEqual(f.source.session.snapshotEvents().slice(0, original.length), original)
    assert.equal(f.source.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 1)
    assert.equal(f.created.length, 0)
  } finally { await f.service.dispose() }
})
test('fresh recovery preserves workspace, preset, model, all human context, and waits for a new send', async () => {
  const f = fixture()
  f.source.session.append('turn/start', { turn: 2 })
  f.source.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'please continue' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  f.source.session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'no adapter', code: 'NO_ADAPTER' } } })
  try {
    const input = f.input('new'), result = await f.service.act(input)
    assert.notEqual(result.sessionId, f.source.id)
    assert.match(result.draft!, /Inspect package.json/)
    assert.match(result.draft!, /please continue/)
    assert.equal(f.created[0].workspaceId, 'workspace-a')
    assert.equal(f.created[0].agentPreset, 'standard')
    assert.deepEqual(f.agents.get(result.sessionId).model.current(), f.source.model.current())
    assert.equal(f.sessions.get(result.sessionId)!.snapshotEvents().some(event => event.type === 'user/message'), false)
    assert.equal(f.sent.length, 0)
    await f.service.act(input)
    assert.equal(f.created.length, 1)
    assert.equal((await f.service.inspect(f.source.id)).lastRestart!.sessionId, result.sessionId)
  } finally { await f.service.dispose() }
})
test('missing provider blocks continuation but permits an empty new conversation without changing the source model', async () => {
  const f = fixture(); f.unavailable()
  try {
    assert.equal((await f.service.inspect(f.source.id)).canContinue, false)
    await assert.rejects(f.service.act(f.input('continue')), (error: any) => error.code === 'model_unavailable')
    const result = await f.service.act(f.input('new'))
    assert.ok(result.warnings.some(warning => warning.includes('モデル接続')))
    assert.equal(f.sent.length, 0)
    assert.equal(f.source.model.current().provider, 'fixture')
  } finally { await f.service.dispose() }
})
test('busy, stale and mismatched operations cannot mutate a session', async () => {
  const f = fixture()
  try {
    const stale = f.input('new')
    f.source.status = 'running'
    await assert.rejects(f.service.act(stale), (error: any) => error.code === 'session_busy')
    f.source.status = 'idle'
    appendPluginRecord(f.source.session, 'plugin:kiokuko-dsh/session-recovery', { version: 1, ...stale, operationId: 'other', sourceSessionId: f.source.id, targetSessionId: 'target', state: 'planned' })
    await assert.rejects(f.service.act(stale), (error: any) => error.code === 'session_changed')
    const request = f.input('new')
    await f.service.act(request)
    await assert.rejects(f.service.act({ ...request, action: 'continue' }), (error: any) => error.code === 'operation_conflict')
    assert.equal(f.created.length, 1)
    assert.equal(f.sent.length, 0)
  } finally { await f.service.dispose() }
})
test('a partial creation can retry its durable plan after the recovery service restarts', async () => {
  const f = fixture(); f.failCreate()
  const request = f.input('new')
  try {
    await assert.rejects(f.service.act(request), /Creation unavailable/)
    const reloaded = new SessionRecovery(f.host)
    try {
      const result = await reloaded.act(request)
      await reloaded.act(request)
      assert.equal(f.created.length, 2, 'one rejected creation and one successful retry, with no extra target')
      assert.equal(f.agents.size, 2)
      assert.equal((await reloaded.inspect(f.source.id)).lastRestart!.sessionId, result.sessionId)
    } finally { await reloaded.dispose() }
  } finally { await f.service.dispose() }
})
test('a source replacement while model preparation waits cannot enqueue recovery', async () => {
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
  const f = fixture(), gate = deferred(), entered = deferred()
  f.resolveWith(async () => { entered.resolve(); await gate.promise })
  const pending = f.service.act(f.input('continue'))
  await entered.promise
  f.make(f.source.id)
  gate.resolve()
  await assert.rejects(pending, (error: any) => error.code === 'session_changed')
  assert.equal(f.sent.length, 0)
  await f.service.dispose()
})
test('cold status only reads; continuation uses native activation', async () => {
  const f = fixture(); f.agents.delete(f.source.id)
  try {
    const status = await f.service.inspect(f.source.id)
    assert.equal(status.interrupted, true)
    assert.equal(f.activations(), 0)
    assert.equal(f.readCloses(), 1)
    await f.service.act(f.input('continue'))
    assert.equal(f.activations(), 1)
    assert.equal(f.sent.length, 1)
  } finally { await f.service.dispose() }
})
test('Web recovery validates requests and origin without leaking provider errors', async () => {
  const f = fixture(), url = 'http://dsh.internal/api/kiokuko.session-recovery'
  try {
    assert.equal((await sessionRecoveryResponse(f.service, new Request(url))).status, 400)
    assert.equal((await sessionRecoveryResponse(f.service, new Request(url, { method: 'POST', headers: { origin: 'http://foreign.test', 'content-type': 'application/json' }, body: '{}' }))).status, 403)
    assert.equal((await sessionRecoveryResponse(f.service, new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }))).status, 400)
    assert.equal((await sessionRecoveryResponse(f.service, new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f.input('continue'), extra: true }) }))).status, 400)
    f.resolveWith(async () => { throw new Error('SECRET_PROVIDER_DETAIL') })
    const response = await sessionRecoveryResponse(f.service, new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f.input('continue')) }))
    assert.equal(response.status, 409)
    assert.doesNotMatch(await response.text(), /SECRET_PROVIDER_DETAIL/)
    assert.equal(f.sent.length, 0)
  } finally { await f.service.dispose() }
})

test('an unusable cold source can start fresh without trying to activate its broken runtime', async () => {
  const f = fixture(); f.agents.delete(f.source.id)
  const original = f.host.get
  let activationAttempts = 0
  f.host.get = (name: string) => name === 'sessionController' ? {
    ...original(name), follow() { activationAttempts++; throw new Error('The old runtime cannot be restored') },
  } : original(name)
  try {
    const result = await f.service.act(f.input('new'))
    assert.notEqual(result.sessionId, f.source.id)
    assert.equal(activationAttempts, 0)
    assert.equal(f.created.length, 1)
    assert.equal(f.sent.length, 0)
  } finally { await f.service.dispose() }
})

test('an ungrouped source gets a usable native workspace for its fresh draft', async () => {
  const f = fixture(), directories: string[] = []
  const registry = f.host.get('workspaceRegistry')
  registry.list = () => []
  registry.create = async (cwd: string) => { directories.push(cwd); return { id: 'restored-workspace', path: cwd, sessionIds: [] } }
  try {
    await f.service.act(f.input('new'))
    assert.deepEqual(directories, ['/tmp'])
    assert.equal(f.created[0].workspaceId, 'restored-workspace')
    assert.equal(f.created[0].cwd, undefined)
    assert.equal(f.sent.length, 0)
  } finally { await f.service.dispose() }
})

test('fresh recovery rejects a source replaced during workspace preparation at the same revision', async () => {
  const f = fixture(), registry = f.host.get('workspaceRegistry')
  registry.list = () => []
  registry.create = async () => {
    f.agents.set(f.source.id, { ...f.source })
    return { id: 'restored-workspace' }
  }
  try {
    await assert.rejects(f.service.act(f.input('new')), (error: any) => error.code === 'session_changed')
    assert.equal(f.created.length, 0)
    assert.equal(f.sent.length, 0)
  } finally { await f.service.dispose() }
})

test('fresh recovery cannot acknowledge a target replaced during model preparation', async () => {
  const f = fixture()
  f.resolveWith(async () => { f.make(f.created.at(-1).sessionId) })
  try {
    await assert.rejects(f.service.act(f.input('new')), (error: any) => error.code === 'session_changed')
    assert.equal(f.sent.length, 0)
    assert.equal(f.source.session.snapshotEvents().some(event => pluginRecordOf(event)?.type === 'plugin:kiokuko-dsh/session-recovery'), false)
  } finally { await f.service.dispose() }
})
