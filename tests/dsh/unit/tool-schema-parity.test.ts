import assert from 'node:assert/strict'
import test from 'node:test'
import { MODEL_TOOL_OPERATION_NAMES } from '../../../src/model-tools/contracts.js'
import { modelFacingInputSchema } from '../../../src/model-tools/registry.js'
import { projectDshDirective } from '../../../src/dsh/directive-projection.js'
import {
  DSH_HOST_ONLY_OPERATIONS,
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

test('dsh ownership covers the exact 14 Kiokuko operations once', () => {
  const owned = [...DSH_MODEL_FACING_OPERATIONS, ...DSH_HOST_ONLY_OPERATIONS]
  assert.deepEqual([...owned].sort(), [...MODEL_TOOL_OPERATION_NAMES].sort())
  assert.equal(new Set(owned).size, 14)
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
})

test('projected directives use the schema for the current model-facing action', () => {
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
      harness: { kind: 'dsh', version: null, continuation: 'turn_stopping_plugin', instructions: [] },
      objective: 'current objective', requiredSkills: [], workUnit: null, stopConditions: [],
      reportSchema: { properties: { runId: { type: 'string' } }, required: ['runId'] },
    } as any
    const projected = projectDshDirective({ nextAction, directive } as any)
    assert.deepEqual(projected?.reportSchema, modelFacingInputSchema(operation))
    const properties = projected?.reportSchema?.properties as Record<string, unknown> | undefined
    assert.equal(properties?.runId, undefined)
  }
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
    agent: { id: 'native-agent', session: { id: 'session-1' } }, signal,
  })
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
