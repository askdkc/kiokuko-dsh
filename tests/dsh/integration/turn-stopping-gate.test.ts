import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DshEnnoController,
  mountDshEnnoController,
  type DshTurnStoppingEvent,
} from '../../../src/dsh/enno-controller.js'
import type { EnnoOdunoState } from '../../../src/enno-oduno/types.js'

function state(nextAction: EnnoOdunoState['nextAction'], directive: boolean | 'work' = true): EnnoOdunoState {
  return {
    applicable: true,
    status: 'goki_executing',
    orchestrationId: 'orchestration',
    clientBinding: null,
    contractRevision: 2,
    routeEpoch: 0,
    ideal: null,
    meditation: null,
    currentRole: 'goki',
    directive: directive === false ? null : {
      protocolVersion: 1,
      runId: 'run',
      contractRevision: 2,
      routeEpoch: 0,
      role: 'goki',
      harness: { kind: 'dsh', version: null, continuation: 'turn_stopping_plugin', instructions: [] },
      handoff: null,
      objective: 'continue',
      requiredSkills: ['kiokuko-soul', 'kiokuko-single-purpose-functions'],
      workUnit: directive === 'work' ? {
        id: 'U11', objective: 'gate', scope: ['src/dsh/enno-controller.ts'], dependencies: [],
        skillNames: ['kiokuko-soul', 'kiokuko-single-purpose-functions'],
        expertRefs: [{ id: 'code.domain.v1', reason: 'state map' }], acceptanceCriteria: ['pass'], focusedVerifiers: [], routes: ['code'],
      } : null,
      stopConditions: ['continue'],
      reportSchema: {},
    },
    nextAction,
    advisoryPhaseState: { state: 'not_started' },
  } as EnnoOdunoState
}

function event(agent: { id: string; steers: unknown[]; cancels: string[] }, turn = 1): DshTurnStoppingEvent {
  return {
    agent: {
      id: agent.id,
      steer: (message) => { agent.steers.push(message) },
      cancel: (reason) => { agent.cancels.push(reason) },
    },
    turn,
    signal: new AbortController().signal,
  }
}

test('an incomplete Enno state steers the same turn and injects only current directive sources', async () => {
  const agent = { id: 'session', steers: [] as unknown[], cancels: [] as string[] }
  const injected: unknown[] = []
  const controller = new DshEnnoController({
    readState: async () => state('execute_work_unit', 'work'),
    injectNextStepContext: async (input) => { injected.push(input.selection) },
  })
  const decision = await controller.handle(event(agent))
  assert.equal(decision.kind, 'steer')
  assert.equal(agent.steers.length, 1)
  assert.match(JSON.stringify(agent.steers[0]), /現在の WorkUnit はまだ受理されていません/u)
  assert.match(JSON.stringify(agent.steers[0]), /同じ WorkUnit の修正または再報告/u)
  assert.deepEqual(injected, [{
    routeSkillNames: ['kiokuko-soul', 'kiokuko-single-purpose-functions'],
    expertRefs: [{ skillName: 'kiokuko-single-purpose-functions', relativePath: 'references/domain-and-types.md' }],
  }])
})

test('completed and blocked states close silently without an extra model request', async () => {
  for (const nextAction of ['complete', 'report_blocker'] as const) {
    const agent = { id: nextAction, steers: [] as unknown[], cancels: [] as string[] }
    const controller = new DshEnnoController({ readState: async () => state(nextAction) })
    const decision = await controller.handle(event(agent))
    assert.deepEqual(decision, { kind: 'close', nextAction })
    assert.equal(agent.steers.length, 0)
    assert.equal(agent.cancels.length, 0)
  }
})

test('confirmation is settled at turn stopping before the next role is injected', async () => {
  const agent = { id: 'confirmation', steers: [] as unknown[], cancels: [] as string[] }
  const waiting = state('ask_user_confirmation', false)
  waiting.status = 'needs_confirmation'
  waiting.currentRole = 'enno-oduno'
  waiting.directive = {
    ...state('submit_plan').directive!,
    role: 'enno-oduno',
    workUnit: null,
    userFacingConfirmation: {
      presentationVersion: 2,
      language: 'en',
      title: 'Approve plan',
      summary: { basis: 'proposal', text: 'Implement the bounded plan.' },
      scope: { basis: 'user', paths: ['src'] },
      exclusions: { basis: 'user', paths: [] },
      completion: { basis: 'proposal', items: ['Tests pass'] },
      skills: [],
      workItems: [],
      finalChecks: { basis: 'proposal', checks: [] },
      attemptLimit: { basis: 'proposal', maxAttempts: 3 },
      actions: ['approve', 'revise', 'cancel'],
    },
  }
  const executing = state('execute_work_unit', 'work')
  const reads = [waiting, executing]
  const injected: EnnoOdunoState[] = []
  let confirmations = 0
  const controller = new DshEnnoController({
    readState: async () => reads.shift() ?? executing,
    confirmUser: async ({ state: current }): Promise<'submitted'> => {
      confirmations += 1
      assert.equal(current.nextAction, 'ask_user_confirmation')
      return 'submitted'
    },
    injectNextStepContext: async ({ state: current }) => { injected.push(current) },
  })

  const decision = await controller.handle(event(agent))

  assert.equal(confirmations, 1)
  assert.equal(decision.kind, 'steer')
  assert.deepEqual(injected.map((current) => current.nextAction), ['execute_work_unit'])
  assert.equal(agent.steers.length, 1)
  assert.deepEqual(agent.cancels, [])
})

test('same directive pauses the turn after one steer and remains resumable on the next turn', async () => {
  const agent = { id: 'session', steers: [] as unknown[], cancels: [] as string[] }
  const controller = new DshEnnoController({ readState: async () => state('submit_plan') })
  assert.equal((await controller.handle(event(agent, 4))).kind, 'steer')
  const second = await controller.handle(event(agent, 4))
  assert.deepEqual(second, { kind: 'pause', nextAction: 'submit_plan', reason: 'continuation_limit' })
  assert.equal(agent.steers.length, 1)
  assert.equal(agent.cancels.length, 0)
  assert.equal((await controller.handle(event(agent, 5))).kind, 'steer')
  assert.equal(agent.steers.length, 2)
})

test('concurrent duplicate callbacks share one continuation decision without cancellation', async () => {
  const agent = { id: 'concurrent', steers: [] as unknown[], cancels: [] as string[] }
  let release!: () => void
  let started!: () => void
  const startedPromise = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const controller = new DshEnnoController({
    readState: async () => state('submit_plan'),
    injectNextStepContext: async () => {
      started()
      await gate
    },
  })
  const first = controller.handle(event(agent, 8))
  await startedPromise
  const second = controller.handle(event(agent, 8))
  release()
  const decisions = await Promise.all([first, second])
  assert.deepEqual(decisions[0], decisions[1])
  assert.equal(decisions[0]?.kind, 'steer')
  assert.equal(agent.steers.length, 1)
  assert.equal(agent.cancels.length, 0)
})

test('state, directive, context, and abort failures never become a normal close', async () => {
  const cases = [
    { readState: async () => { throw new Error('read failed') } },
    { readState: async () => state('submit_plan', false) },
    { readState: async () => state('submit_plan'), injectNextStepContext: async () => { throw new Error('inject failed') } },
  ]
  const firstAgent = { id: 'first', steers: [] as unknown[], cancels: [] as string[] }
  const first = await new DshEnnoController(cases[0]!).handle(event(firstAgent))
  assert.deepEqual(first, { kind: 'abort', reason: 'state_unavailable' })
  assert.equal(firstAgent.cancels.length, 1)
  const secondAgent = { id: 'second', steers: [] as unknown[], cancels: [] as string[] }
  const second = await new DshEnnoController(cases[1]!).handle(event(secondAgent))
  assert.deepEqual(second, { kind: 'abort', reason: 'directive_missing' })
  const thirdAgent = { id: 'third', steers: [] as unknown[], cancels: [] as string[] }
  const third = await new DshEnnoController(cases[2]!).handle(event(thirdAgent))
  assert.deepEqual(third, { kind: 'abort', reason: 'context_injection_failed' })
  assert.equal(thirdAgent.steers.length, 0)
})

test('an unknown persisted next action fails closed instead of throwing or closing', async () => {
  const agent = { id: 'unknown-action', steers: [] as unknown[], cancels: [] as string[] }
  const controller = new DshEnnoController({
    readState: async () => state('not-a-real-action' as EnnoOdunoState['nextAction']),
  })
  const decision = await controller.handle(event(agent))
  assert.deepEqual(decision, { kind: 'abort', reason: 'state_unavailable' })
  assert.equal(agent.steers.length, 0)
  assert.equal(agent.cancels.length, 1)
})

test('abort during awaited continuation work cannot steer the native agent', async () => {
  const controller = new AbortController()
  const agent = { id: 'abort-during-context', steers: [] as unknown[], cancels: [] as string[] }
  const enno = new DshEnnoController({
    readState: async () => state('submit_plan'),
    injectNextStepContext: async () => { controller.abort(new Error('cancelled')) },
  })
  const decision = await enno.handle({
    agent: { ...agent, steer: (message) => agent.steers.push(message), cancel: (reason) => agent.cancels.push(reason) },
    turn: 1,
    signal: controller.signal,
  })
  assert.deepEqual(decision, { kind: 'abort', reason: 'aborted' })
  assert.equal(agent.steers.length, 0)
  assert.equal(agent.cancels.length, 0)
})

test('a directive from an older revision is rejected before context or steering effects', async () => {
  const agent = { id: 'stale', steers: [] as unknown[], cancels: [] as string[] }
  const current = state('submit_plan')
  current.directive!.contractRevision = 1
  const controller = new DshEnnoController({
    readState: async () => current,
    injectNextStepContext: async () => { throw new Error('must not inject stale context') },
  })
  const decision = await controller.handle(event(agent))
  assert.deepEqual(decision, { kind: 'abort', reason: 'stale_directive' })
  assert.equal(agent.steers.length, 0)
  assert.equal(agent.cancels.length, 1)
})

test('a changed live capability catalog is rejected before host effects or steering', async () => {
  const agent = { id: 'catalog-changed', steers: [] as unknown[], cancels: [] as string[] }
  let injected = false
  const controller = new DshEnnoController({
    readState: async () => state('submit_plan'),
    validateBoundary: async () => { throw new Error('capability catalog changed') },
    injectNextStepContext: async () => { injected = true },
  })

  const decision = await controller.handle(event(agent))

  assert.deepEqual(decision, { kind: 'abort', reason: 'catalog_changed' })
  assert.equal(injected, false)
  assert.equal(agent.steers.length, 0)
  assert.equal(agent.cancels.length, 1)
})

test('the controller mounts at the awaited turn-stopping seam', async () => {
  let listener: ((event: DshTurnStoppingEvent) => Promise<void>) | undefined
  const controller = new DshEnnoController({ readState: async () => state('complete') })
  const dispose = mountDshEnnoController({
    on: (_name, next) => { listener = next; return () => undefined },
  }, controller)
  assert.equal(typeof listener, 'function')
  const agent = { id: 'mount', steers: [] as unknown[], cancels: [] as string[] }
  await listener!(event(agent))
  assert.equal(agent.steers.length, 0)
  dispose()
})
