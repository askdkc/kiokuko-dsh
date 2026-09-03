import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as dshPlugin from '../../../src/dsh/index.js'
import { loadSoulPrompt } from '../../../src/dsh/prompt-policy.js'
import { createStandardSkillProvider } from '../../../src/dsh/standard-skill-provider.js'
import { DshEnnoController } from '../../../src/dsh/enno-controller.js'
import { DshPonytailModes } from '../../../src/dsh/commands.js'
import { DshToolPolicy, mountDshToolPolicy } from '../../../src/dsh/tool-policy.js'
import { mountDshTools } from '../../../src/dsh/tools.js'
import { DshRunLifecycle, DshSessionBridge } from '../../../src/dsh/session-bridge.js'
import { createDshConfirmationAnswerer } from '../../../src/dsh/user-interaction.js'

function hostServices(includeTools = true) {
  const providers: unknown[] = []
  const sections = new Map<string, string>()
  const registeredTools: Array<{ name: string; execute: Function }> = []
  const guards: Function[] = []
  const services = {
    skills: {
      registerProvider(create: (control: { signal: AbortSignal }) => unknown) {
        const provider = create({ signal: new AbortController().signal })
        providers.push(provider)
        return () => { const index = providers.indexOf(provider); if (index >= 0) providers.splice(index, 1) }
      },
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      section(input: { name: string; order: number; text: string }) {
        sections.set(input.name, input.text)
        return () => { sections.delete(input.name) }
      },
    },
    commands: {
      register(_definition: unknown) { return () => undefined },
    },
    ...(includeTools ? {
      tools: {
        register(definition: { name: string; execute: Function }) {
          registeredTools.push(definition)
          return () => { const index = registeredTools.indexOf(definition); if (index >= 0) registeredTools.splice(index, 1) }
        },
        guard(guard: Function) { guards.push(guard); return () => { const index = guards.indexOf(guard); if (index >= 0) guards.splice(index, 1) } },
      },
    } : {}),
  }
  return { providers, sections, registeredTools, guards, services }
}

function installHost(root: Context, host: ReturnType<typeof hostServices>) {
  return root.plugin({
    name: 'dsh-test-host',
    apply(ctx: Context) {
      const disposers = Object.entries(host.services).map(([name, service]) => ctx.provide(name, service))
      return () => { for (const dispose of disposers.reverse()) dispose() }
    },
  })
}

test('real Cordis composition mounts and unloads the bundled dsh surfaces', async () => {
  const host = hostServices(false)
  const root = new Context()
  const hostFiber = installHost(root, host)
  await hostFiber
  const pluginFiber = root.plugin({ ...dshPlugin, inject: ['skills', 'systemPrompt'] }, { enabled: true })
  await pluginFiber
  const provider = host.providers[0] as ReturnType<typeof createStandardSkillProvider>
  const listed = await provider.list({})
  assert.equal('complete' in listed ? listed.complete : false, true)
  assert.equal('complete' in listed ? listed.candidates.length : listed.length, 6)
  assert.equal(host.sections.get('kiokuko:soul'), await loadSoulPrompt())
  await pluginFiber.dispose()
  assert.deepEqual(host.providers, [])
  assert.deepEqual([...host.sections], [])
  await hostFiber.dispose()
})

test('composed host boundaries preserve model, tool, question, ledger, and turn-end evidence', async () => {
  const modelMessages: unknown[][] = []
  const toolCalls: string[] = []
  const questionAnswers: string[] = []
  const bridgeOutput: string[] = []
  const host = hostServices()
  const root = new Context()
  const hostFiber = installHost(root, host)
  await hostFiber
  const nativeToolServices = host.services.tools!

  const policy = new DshToolPolicy({
    phase: 'goki', runId: 'run-e2e', workspace: 'workspace-e2e', orchestrationId: 'orch-e2e', revision: 2,
    routeEpoch: 0, dshSessionId: 'session-e2e', workUnitId: 'unit-e2e', currentWorkUnitId: 'unit-e2e', leaseToken: 'lease-e2e',
  })
  const disposePolicy = mountDshToolPolicy({ tools: nativeToolServices }, policy)
  const disposeTools = mountDshTools({ tools: nativeToolServices }, {
    bind: () => ({ runId: 'run-e2e', workspace: 'workspace-e2e', orchestrationId: 'orch-e2e', revision: 2, routeEpoch: 0, workUnitId: 'unit-e2e', leaseToken: 'lease-e2e' }),
    execute: async (operation) => { toolCalls.push(operation); return { ok: true } },
  })
  const tool = host.registeredTools.find((candidate) => candidate.name === 'enno_work_report')!
  const toolExecution = {
    callId: 'tool-e2e', name: 'enno_work_report', origin: 'model' as const,
    arguments: { result: { outcome: 'completed', summary: 'done', mutated: false, changedPaths: [] } }, signal: new AbortController().signal,
  }
  assert.equal(policy.decide(toolExecution).kind, 'allow')
  await tool.execute(toolExecution.arguments, toolExecution)
  assert.deepEqual(toolCalls, ['enno_work_report'])
  assert.equal(host.registeredTools.length, 7)

  const fakeModel = { async request(messages: readonly unknown[]) { modelMessages.push([...messages]); return 'model-output' } }
  await fakeModel.request([{ role: 'system', source: 'soul', content: await loadSoulPrompt() }])
  const controller = new DshEnnoController({
    readState: async () => ({ applicable: true, nextAction: 'execute_work_unit', contractRevision: 2, routeEpoch: 0,
      directive: { contractRevision: 2, routeEpoch: 0, requiredSkills: ['kiokuko-soul'], workUnit: null } } as never),
    injectNextStepContext: async ({ selection }) => { bridgeOutput.push(selection.routeSkillNames.join(',')) },
  })
  let steers = 0
  const turn = await controller.handle({ agent: { id: 'agent-e2e', steer: () => { steers += 1 } }, turn: 1, signal: new AbortController().signal })
  assert.equal(turn.kind, 'steer')
  assert.equal(steers, 1)
  assert.deepEqual(modelMessages.length, 1)

  const answerer = createDshConfirmationAnswerer({
    async ask(request) {
      questionAnswers.push(request.questions[0].question)
      return { answers: [{ id: request.questions[0].id, selected: ['approve'] }] }
    },
  })
  const confirmation = {
    presentationVersion: 2, language: 'en',
    title: 'Confirm', summary: { basis: 'proposal', text: 'Proceed' }, scope: { basis: 'proposal', paths: [] },
    exclusions: { basis: 'proposal', paths: [] }, completion: { basis: 'proposal', items: ['done'] }, skills: [], workItems: [],
    finalChecks: { basis: 'proposal', checks: [] }, attemptLimit: { basis: 'proposal', maxAttempts: 1 }, actions: ['approve', 'revise', 'cancel'],
  } as never
  assert.equal((await answerer.ask(confirmation)).action, 'approve')
  assert.equal(questionAnswers.length, 1)

  const bridge = new DshSessionBridge({
    runtime: { withDatabase: async <T,>(_operation: unknown) => undefined as T },
    appendBatch: async (_runId, events) => { bridgeOutput.push(`events:${events.length}`) },
  })
  bridge.bindSession('session-e2e', 'run-e2e')
  bridge.observe({ sessionId: 'session-e2e', runId: 'run-e2e', event: { type: 'turn/end', seq: 4, time: 0, data: { reason: 'completed' } } })
  const statuses: string[] = []
  const lifecycle = new DshRunLifecycle({ bridge, closeRun: ({ status }) => { statuses.push(status) } })
  await lifecycle.closeTurn({ runId: 'run-e2e', status: 'completed' })
  assert.deepEqual(bridgeOutput, ['kiokuko-soul', 'events:1'])
  assert.deepEqual(statuses, ['completed'])
  await lifecycle.dispose()

  const modes = new DshPonytailModes()
  modes.begin('request-e2e')
  modes.set('request-e2e', 'full')
  assert.equal(modes.mode('request-e2e'), 'full')
  modes.end('request-e2e')
  disposeTools()
  disposePolicy()
  assert.equal(host.registeredTools.length, 0)
  assert.equal(host.guards.length, 0)
  await hostFiber.dispose()
})
