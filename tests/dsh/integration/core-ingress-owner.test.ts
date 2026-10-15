import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { mountCore, type CoreModuleHost } from '../../../src/dsh/core/host.js'
import type { DshModule } from '../../../src/dsh/core/modules.js'
import type { DshTaskWorkflow } from '../../../src/dsh/task-state-host.js'
import { TASK_PREPARE_TOOL } from '../../../src/dsh/on-demand-intake.js'

async function fixture(questions?: { ask(request: any): Promise<any> }) {
  const directory = await mkdtemp(join(tmpdir(), 'kiokuko-core-')), root = realpathSync(directory)
  const listeners = new Map<string, Function>(), tools: any[] = [], providers: any[] = [], sections: any[] = []
  const events: any[] = [], guards: Function[] = []
  const handlers = new Map<string, Function[]>()
  const session = { id: 'core-session', header: { cwd: root }, snapshotEvents: () => events }, agent = { id: 'core-agent', session, status: 'idle', async whenIdle() {} }
  const services: Record<string, any> = {
    sessions: { get: (id: string) => id === session.id ? session : undefined, async flush() {} },
    agents: { get: (id: string) => id === agent.id ? agent : undefined },
    skills: { registerProvider(create: Function) { const provider = create({ signal: new AbortController().signal }); providers.push(provider); return () => { providers.splice(providers.indexOf(provider), 1) } }, async snapshot() { return { complete: true, skills: (await Promise.all(providers.map(provider => provider.list({})))).flatMap(result => result.candidates) } } },
    tools: {
      get(name: string, scope?: unknown) { return scope && scope !== agent ? undefined : tools.find(tool => tool.name === name) },
      guard(guard: Function) { guards.push(guard); return () => { guards.splice(guards.indexOf(guard), 1) } },
      schemas: () => tools.map(({ name, description }) => ({ name, description })), register(tool: any) { tools.push(tool); return () => { tools.splice(tools.indexOf(tool), 1) } } },
    systemPrompt: { section(section: any) { sections.push(section); return () => { sections.splice(sections.indexOf(section), 1) } } },
    ...(questions ? { userQuestions: questions } : {}),
  }
  const ctx = { get: (name: string) => services[name],
    provide(name: string, service: unknown) { services[name] = service; return () => { if (services[name] === service) delete services[name] } },
    emit(name: string, payload: unknown) { return listeners.get(name)?.(payload) }, on(name: string, callback: Function, options?: { prepend?: boolean }) {
    const registered = handlers.get(name) ?? []
    if (options?.prepend) registered.unshift(callback); else registered.push(callback)
    handlers.set(name, registered)
    listeners.set(name, (...args: any[]) => {
      if (name === 'agent/pre-step' && events.filter(event => event.type === 'turn/start').at(-1)?.data.turn !== args[0].turn) events.push({ type: 'turn/start', data: { turn: args[0].turn } })
      if (typeof args.at(-1) === 'function') {
        const terminal = args.pop()
        const dispatch = (index: number): any => registered[index] ? registered[index]!(...args, () => dispatch(index + 1)) : terminal()
        return dispatch(0)
      }
      return Promise.all(registered.map(handler => handler(...args)))
    })
    return () => { registered.splice(registered.indexOf(callback), 1); if (!registered.length) { handlers.delete(name); listeners.delete(name) } }
  } } as unknown as Context
  let callId = 0
  const execute = async (name: string, args: unknown, signal = new AbortController().signal) => {
    const definition = services.tools.get(name, agent)
    assert.ok(definition, `native fixture must register ${name}`)
    const execution = { callId: `core-call-${++callId}`, name, arguments: args, agent, signal }
    const decision = await listeners.get('tools/pre-execute')?.(execution, async () => ({ kind: 'allow' }))
    if (decision?.kind === 'deny' || decision?.kind === 'cancel') throw new Error(decision.reason ?? 'Native policy cancelled')
    for (const guard of guards) { const reason = guard(execution); if (reason) throw new Error(reason) }
    const body = () => definition.execute(args, execution)
    return listeners.has('tools/execute') ? listeners.get('tools/execute')!(execution, body) : body()
  }
  return { root, ctx, agent, session, events, listeners, tools, sections, providers, services, execute,
    prepare: (taskType = 'research', signal?: AbortSignal) => execute(TASK_PREPARE_TOOL, { taskType }, signal),
    async event(event: any) { events.push(event); await listeners.get('session/event')?.(session, event) },
    async cleanup() { await rm(root, { recursive: true, force: true }) } }

}



// Native ingress and its task-control surface must share the same lifecycle owner.
for (const intakeMode of ['on-demand', 'eager'] as const) {
  test(`module-owned ${intakeMode} ingress has one task surface and clean remount`, async () => {
    const f = await fixture(), commands: any[] = [], controls: any[] = []
    f.services.commands = { register(command: any) { commands.push(command); return () => commands.splice(commands.indexOf(command), 1) } }
    const provide = (f.ctx as any).provide.bind(f.ctx), registrations: unknown[] = []
    ;(f.ctx as any).provide = (name: string, service: unknown) => {
      if (name === 'kiokukoTaskWorkflow') registrations.push(service)
      return provide(name, service)
    }
    let disposed = 0
    const module: DshModule<CoreModuleHost> = {
      id: 'fixture-owned-ingress', coreVersion: 1, requires: [], configure: value => value,
      async mount({ host, defer }) {
        host.claimNativeIngress()
        const service = { dispose() { disposed++ },
          async modelOperation(agent: unknown, args: unknown, execution: any) {
            assert.equal(agent, f.agent)
            assert.equal(execution.agent, f.agent)
            assert.equal(controls.length, 1, 'the active intake owns this exact control definition')
            assert.equal(controls[0].name, execution.name)
            return { owner: 'module-demand', args }
          } } as unknown as DshTaskWorkflow
        const demand = { registerControlTool(definition: unknown) { controls.push(definition); return () => controls.splice(controls.indexOf(definition), 1) } }
        const { mountTaskWorkflowSurface } = await import('../../../src/dsh/task-state-surface.js')
        defer(mountTaskWorkflowSurface(host.context, service, demand as any))
        return { stopIngress() {}, async drain() {}, async dispose() {} }
      },
    }
    try {
      for (let generation = 1; generation <= 2; generation++) {
        const handle = await mountCore(f.ctx, { intakeMode, repositoryRoot: f.root, databasePath: join(f.root, 'memory.sqlite3') }, [{ module }])
        try {
          assert.equal(registrations.length, generation, 'Core must not register an unrelated workflow before an ingress owner mounts')
          assert.equal(commands.filter(command => command.name === 'kioku-task').length, 1)
          assert.equal(f.tools.filter(tool => tool.name === 'task_operation').length, 1)
          assert.deepEqual(await f.execute('task_operation', { operation: 'snapshot' }), { owner: 'module-demand', args: { operation: 'snapshot' } })
        } finally { await handle.dispose() }
        assert.equal(disposed, generation)
        assert.equal(controls.length, 0)
        assert.equal(commands.length, 0)
        assert.equal(f.tools.length, 0)
        assert.equal(f.listeners.size, 0)
        assert.equal(f.services.kiokukoTaskWorkflow, undefined)
      }
    } finally { await f.cleanup() }
  })
}

test('a failed ingress-owner mount releases its only task surface before Core remount', async () => {
  const f = await fixture(), commands: any[] = []
  f.services.commands = { register(command: any) { commands.push(command); return () => commands.splice(commands.indexOf(command), 1) } }
  let disposed = 0
  const module: DshModule<CoreModuleHost> = {
    id: 'fixture-failing-ingress', coreVersion: 1, requires: [], configure: value => value,
    async mount({ host, defer }) {
      host.claimNativeIngress()
      const { mountTaskWorkflowSurface } = await import('../../../src/dsh/task-state-surface.js')
      defer(mountTaskWorkflowSurface(host.context, { dispose() { disposed++ } } as unknown as DshTaskWorkflow))
      throw new Error('fixture mount failed after acquiring task surface')
    },
  }
  try {
    await assert.rejects(mountCore(f.ctx, { repositoryRoot: f.root, databasePath: join(f.root, 'memory.sqlite3') }, [{ module }]), /fixture mount failed/)
    assert.equal(disposed, 1)
    assert.equal(f.services.kiokukoTaskWorkflow, undefined)
    assert.equal(commands.length, 0)
    assert.equal(f.tools.length, 0)
    assert.equal(f.listeners.size, 0)
    const handle = await mountCore(f.ctx, { repositoryRoot: f.root, databasePath: join(f.root, 'memory.sqlite3') })
    try {
      assert.equal(commands.filter(command => command.name === 'kioku-task').length, 1)
      assert.equal(f.tools.filter(tool => tool.name === 'task_operation').length, 1)
      assert.deepEqual(await (f.services.kiokukoTaskWorkflow as unknown as DshTaskWorkflow).snapshot(f.agent), { sessionId: f.session.id, task: null })
    } finally { await handle.dispose() }
  } finally { await f.cleanup() }
})
