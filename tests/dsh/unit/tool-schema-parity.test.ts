import assert from 'node:assert/strict'
import test from 'node:test'
import * as z from 'zod/v4'
import { MODEL_TOOL_OPERATION_NAMES } from '../../../src/model-tools/contracts.js'
import { modelFacingInputSchema, modelFacingTransportSchema } from '../../../src/model-tools/registry.js'
import { projectDshDirective } from '../../../src/dsh/directive-projection.js'
import {
  DSH_MODEL_FACING_OPERATIONS,
  bindDshToolInvocation,
  createDshToolDefinitions,
  dshToolIdempotencyKey,
} from '../../../src/dsh/tools.js'

const signal = new AbortController().signal
const host = {
  bind: () => ({ runId: 'run-1', workspace: 'workspace-1', orchestrationId: 'orch-1', revision: 2, routeEpoch: 0 }),
  execute: async () => ({ ok: true }),
}

function execution(name: string, args: unknown = {}) {
  return { callId: 'call-1', name, arguments: args, agent: { dshSessionId: 'session-1', turn: 1 }, signal }
}

test('dsh registry contains exactly the seven model-visible operations', () => {
  const owned = [...DSH_MODEL_FACING_OPERATIONS]
  assert.deepEqual([...owned].sort(), [...MODEL_TOOL_OPERATION_NAMES].sort())
  assert.equal(new Set(owned).size, 7)
  const definitions = createDshToolDefinitions(host)
  assert.deepEqual(definitions.map((definition) => definition.name), MODEL_TOOL_OPERATION_NAMES)
  assert.equal(definitions.filter((definition) => definition.modelFacing).length, 7)
})

test('model-facing schemas exclude every host-owned field', () => {
  const hostFields = new Set(['runId', 'workspace', 'orchestrationId', 'resumeToken', 'expectedRevision', 'leaseToken', 'routeEpoch', 'idempotencyKey'])
  for (const operation of DSH_MODEL_FACING_OPERATIONS) {
    const schema = modelFacingInputSchema(operation)
    const properties = schema.properties as Record<string, unknown>
    assert.deepEqual([...hostFields].filter((field) => Object.hasOwn(properties, field)), [], operation)
  }
  for (const operation of ['enno_ideal_submit', 'enno_plan_submit', 'enno_finish'] as const) {
    const properties = modelFacingInputSchema(operation).properties as Record<string, unknown>
    assert.equal(properties.advisoryRoundDigest, undefined, operation)
    assert.ok(properties.advisoryDisposition, operation)
  }
})

test('native transport schemas expose JSON shapes without consuming business validation', () => {
  for (const operation of DSH_MODEL_FACING_OPERATIONS) {
    const schema = modelFacingTransportSchema(operation)
    assert.equal(schema.type, 'object', operation)
    assert.equal(schema.additionalProperties, true, operation)
    assert.equal(schema.required, undefined, operation)
  }

  const workReport = modelFacingTransportSchema('enno_work_report')
  const result = (workReport.properties as Record<string, any>).result
  assert.equal(result.type, 'object')
  assert.equal(result.additionalProperties, true)
  assert.equal(result.required, undefined)
  assert.equal(result.properties.outcome.type, 'string')
  assert.equal(result.properties.summary.type, 'string')
  assert.equal(result.properties.mutated.type, 'boolean')
  assert.equal(result.properties.changedPaths.type, 'array')
  assert.equal(result.properties.changedPaths.items.type, 'string')

  const definition = createDshToolDefinitions(host).find((item) => item.name === 'enno_work_report')!
  assert.deepEqual(definition.parameters, workReport)
  assert.match(definition.description, /never encode an object or array as a JSON string/u)

  const transportBoundary = z.fromJSONSchema(workReport as z.core.JSONSchema.BaseSchema)
  assert.equal(transportBoundary.safeParse({}).success, true)
  assert.equal(transportBoundary.safeParse({ result: JSON.stringify({
    outcome: 'completed', summary: 'done', mutated: false, changedPaths: [],
  }) }).success, false)
  assert.equal(transportBoundary.safeParse({
    result: { outcome: 'completed', summary: 'done', mutated: false, changedPaths: [] },
  }).success, true)
})

test('projected directives retain current dynamic fields while removing host-owned fields', () => {
  const actions = [
    ['submit_ideal', 'enno_ideal_submit'],
    ['submit_plan', 'enno_plan_submit'],
    ['execute_work_unit', 'enno_work_report'],
    ['submit_final_review', 'enno_finish'],
    ['submit_meditation', 'enno_meditation_submit'],
  ] as const
  for (const [nextAction, operation] of actions) {
    const directive = {
      role: 'enno-oduno',
      instructions: [],
      objective: 'current objective', requiredSkills: [], workUnit: null, stopConditions: [],
      reportSchema: modelFacingInputSchema(operation),
    } as any
    const projected = projectDshDirective({ nextAction, directive } as any)
    assert.deepEqual(projected?.reportSchema, modelFacingInputSchema(operation))
  }

  const directive = {
    role: 'enno-oduno',
    instructions: [],
    objective: 'review', requiredSkills: [], workUnit: null, stopConditions: [],
    reportSchema: {
      properties: {
        runId: { type: 'string' },
        advisoryRoundDigest: { type: 'string' },
        advisoryDisposition: { type: 'array' },
        review: { type: 'object' },
      },
      required: ['runId', 'advisoryRoundDigest', 'advisoryDisposition', 'review'],
      advisoryConsumption: { requiredSlots: ['slot-a'] },
    },
  } as any
  const projected = projectDshDirective({ nextAction: 'submit_final_review', directive } as any)!
  const properties = projected.reportSchema.properties as Record<string, unknown>
  assert.equal(properties.runId, undefined)
  assert.equal(properties.advisoryRoundDigest, undefined)
  assert.ok(properties.advisoryDisposition)
  assert.ok(properties.review)
  assert.deepEqual(projected.reportSchema.required, ['advisoryDisposition', 'review'])
  assert.deepEqual(projected.reportSchema.advisoryConsumption, { requiredSlots: ['slot-a'] })
})

test('idempotency follows the root call for nested PTC and changes for a new call', () => {
  const direct = dshToolIdempotencyKey(execution('enno_work_report'))
  const nested = dshToolIdempotencyKey({ ...execution('enno_work_report'), callId: 'nested', rootCallId: 'call-1' })
  const other = dshToolIdempotencyKey({ ...execution('enno_work_report'), callId: 'call-2' })
  assert.equal(direct, nested)
  assert.notEqual(direct, other)
})

test('host binding rejects injected identity and requires a WorkUnit lease', () => {
  assert.throws(() => bindDshToolInvocation(execution('enno_plan_submit', { nested: { runId: 'forged' } }), {
    runId: 'run-1', workspace: 'workspace-1', orchestrationId: 'orch-1', revision: 2, routeEpoch: 0,
  }), /host-owned identity/iu)
  assert.throws(() => bindDshToolInvocation(execution('enno_work_report'), {
    runId: 'run-1', workspace: 'workspace-1', orchestrationId: 'orch-1', revision: 2, routeEpoch: 0,
  }), /current host lease/iu)
  assert.throws(() => bindDshToolInvocation(execution('enno_finish'), {
    runId: 'run-1', workspace: 'workspace-1', orchestrationId: 'orch-1', revision: 2, routeEpoch: 0,
    advisoryRoundDigest: 'not-a-digest',
  }), /advisory round digest/iu)
})

test('native tool execution binds the authoritative session without inventing a turn', async () => {
  let seen: any
  const definitions = createDshToolDefinitions({
    bind: (execution) => {
      seen = execution
      return { runId: 'run-1', dshSessionId: 'session-1', workspace: 'workspace-1', orchestrationId: 'orch-1', revision: 2, routeEpoch: 0 }
    },
    execute: async () => ({ ok: true }),
  })
  const definition = definitions.find((item) => item.name === 'enno_plan_submit')!
  await definition.execute({}, {
    callId: 'native-call', name: 'enno_plan_submit', arguments: {},
    agent: { id: 'native-agent', session: { id: 'session-1' }, turn() { throw new Error('native private turn method must not be read') } }, signal,
  } as any)
  assert.equal(seen.agent.dshSessionId, 'session-1')
  assert.equal(seen.agent.turn, undefined)
  await assert.rejects(definition.execute({}, {
    callId: 'missing-session', name: 'enno_plan_submit', arguments: {},
    agent: { id: 'native-agent' }, signal,
  } as any), /authoritative session/u)
  await assert.rejects(definition.execute({ runId: 'forged-run' }, {
    callId: 'forged-args', name: 'enno_plan_submit', arguments: {},
    agent: { id: 'native-agent', session: { id: 'session-1' } }, signal,
  } as any), /host-owned identity/u)
  await assert.rejects(definition.execute({}, {
    callId: 'wrong-definition', name: 'enno_ideal_submit', arguments: {},
    agent: { id: 'native-agent', session: { id: 'session-1' } }, signal,
  } as any), /definition and execution operation differ/u)
  await assert.rejects(definition.execute({}, {
    callId: 'forged-session-field', name: 'enno_plan_submit', arguments: {},
    agent: { id: 'native-agent', dshSessionId: 'forged-session' }, signal,
  } as any), /authoritative session/u)
})

test('a plan awaiting human review concludes the model turn after its successful result', async () => {
  let conclusions = 0
  const definitions = createDshToolDefinitions({
    bind: () => ({
      runId: 'run-1', dshSessionId: 'session-1', workspace: 'workspace-1',
      orchestrationId: 'orch-1', revision: 1, routeEpoch: 0,
      workUnitId: 'unit-1', leaseToken: 'lease-1',
    }),
    execute: async () => ({
      kind: 'applied',
      value: { ennoOduno: { nextAction: 'ask_user_confirmation' } },
      handoff: { schemaVersion: 1, runId: 'run-1', phase: 'planning', revision: 1, nextAction: 'ask_user_confirmation' },
    }),
  })
  const definition = definitions.find((item) => item.name === 'enno_plan_submit')!

  await definition.execute({}, {
    callId: 'plan-review-call', name: 'enno_plan_submit', arguments: {},
    agent: { id: 'native-agent', session: { id: 'session-1' } }, signal,
    concludeTurn: () => { conclusions += 1 },
  } as any)

  assert.equal(conclusions, 1)
})

test('every successful phase result concludes exactly one model turn', async () => {
  const nextActions = new Map([
    ['enno_work_report', 'run_final_verification'],
    ['enno_meditation_submit', 'complete'],
    ['enno_ideal_submit', 'submit_plan'],
  ])
  const definitions = createDshToolDefinitions({
    bind: () => ({
      runId: 'run-1', dshSessionId: 'session-1', workspace: 'workspace-1',
      orchestrationId: 'orch-1', revision: 1, routeEpoch: 0,
      workUnitId: 'unit-1', leaseToken: 'lease-1',
    }),
    execute: async (operation) => ({
      kind: 'applied',
      value: { ennoOduno: { nextAction: nextActions.get(operation) } },
      handoff: { schemaVersion: 1, runId: 'run-1', phase: 'work_unit', revision: 1, nextAction: nextActions.get(operation) },
    }),
  })
  const conclusions: string[] = []

  for (const operation of nextActions.keys()) {
    const definition = definitions.find((item) => item.name === operation)!
    await definition.execute({}, {
      callId: `${operation}-call`, name: operation, arguments: {},
      agent: { id: 'native-agent', session: { id: 'session-1' } }, signal,
      concludeTurn: () => { conclusions.push(operation) },
    } as any)
  }

  assert.deepEqual(conclusions, ['enno_work_report', 'enno_meditation_submit', 'enno_ideal_submit'])
})
