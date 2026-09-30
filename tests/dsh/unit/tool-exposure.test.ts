import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../../../src/dsh/config.js'
import { projectToolsForMinimal, resolveToolExposureMode, eligibleDshModelTools, projectToolsForLean, projectToolsForPhase, supportsLeanToolExposureRoute, ToolExposureConfig } from '../../../src/dsh/tool-exposure.js'
import { hasKnownDshToolPolicyState, type DshToolPhase, type DshToolPolicyState } from '../../../src/dsh/tool-policy.js'
import { DSH_LEAN_DESCRIPTION_OPERATIONS, DSH_MODEL_FACING_OPERATIONS, createDshToolDefinitions, leanDshToolDescription } from '../../../src/dsh/tools.js'

function state(phase: DshToolPhase, overrides: Partial<DshToolPolicyState> = {}): DshToolPolicyState {
  return { runId: 'run-1', workspace: 'workspace-1', orchestrationId: 'orchestration-1', revision: 1, routeEpoch: 0, phase, ...overrides }
}

const phaseCases: readonly { phase: DshToolPhase; names: readonly string[] }[] = [
  { phase: 'normal', names: ['curator_check', 'memory_checkpoint'] },
  { phase: 'intake', names: [] },
  { phase: 'ideal', names: ['enno_ideal_submit'] },
  { phase: 'planning', names: ['enno_plan_review', 'enno_plan_submit'] },
  { phase: 'confirmation', names: [] },
  { phase: 'goki', names: ['curator_check', 'enno_delegate', 'enno_work_report', 'memory_checkpoint'] },
  { phase: 'verifying', names: ['curator_check', 'enno_finish', 'memory_checkpoint'] },
  { phase: 'meditation', names: ['enno_meditation_submit'] },
  { phase: 'completed', names: [] },
  { phase: 'blocked', names: [] },
  { phase: 'cancelled', names: [] },
]
for (const item of phaseCases) test(`phase exposure reuses the execution allowlist for ${item.phase}`, () => {
  const actual = [...eligibleDshModelTools(state(item.phase, item.phase === 'goki' ? { workUnitId: 'unit-1', currentWorkUnitId: 'unit-1', leaseToken: 'lease-1' } : {}))].sort()
  assert.deepEqual(actual, [...item.names].sort())
})

test('nextAction exceptions and live WorkUnit lease constraints match the execution policy', () => {
  const plan = eligibleDshModelTools(state('planning', { nextAction: 'submit_plan' }))
  assert.deepEqual([...plan].sort(), ['enno_plan_review', 'enno_plan_submit'])
  const work = eligibleDshModelTools(state('goki', { nextAction: 'execute_work_unit', workUnitId: 'unit-1', currentWorkUnitId: 'unit-1', leaseToken: 'lease-1' }))
  assert.ok(work.has('enno_work_report'))
  assert.ok(work.has('enno_delegate'))
  assert.ok(!work.has('curator_check'))
  const staleLease = eligibleDshModelTools(state('goki', { workUnitId: 'unit-old', currentWorkUnitId: 'unit-new', leaseToken: 'lease-1' }))
  assert.ok(!staleLease.has('enno_work_report'))
  assert.ok(!staleLease.has('enno_delegate'))
  assert.ok(staleLease.has('curator_check'))
})

test('phase projection removes only proven owned, ineligible Kiokuko definitions and preserves order and references', () => {
  const curatorExecute = async () => undefined
  const memoryExecute = async () => undefined
  const external = { name: 'observation_read', parameters: { type: 'object' } }
  const lispTool = { name: 'lisp_status', parameters: { type: 'object' } }
  const curator = { name: 'curator_check', parameters: { type: 'object', required: ['query'] } }
  const memory = { name: 'memory_checkpoint', parameters: { type: 'object' } }
  const tools = [lispTool, external, curator, memory]
  const registered = new Map([['curator_check', { execute: curatorExecute }], ['memory_checkpoint', { execute: memoryExecute }]])
  const result = projectToolsForPhase(tools, state('completed'), registered, name => name === 'curator_check' ? { execute: curatorExecute } : { execute: memoryExecute })
  assert.equal(result.reason, 'projected')
  assert.deepEqual(result.tools, [lispTool, external])
  assert.strictEqual(result.tools[0], lispTool)
  assert.strictEqual(result.tools[1], external)
  assert.deepEqual(tools.map(tool => tool.name), ['lisp_status', 'observation_read', 'curator_check', 'memory_checkpoint'])
  assert.ok(DSH_MODEL_FACING_OPERATIONS.includes('curator_check'))
})

test('unknown or colliding ownership returns the exact original tool surface', () => {
  const execute = async () => undefined
  const otherExecute = async () => undefined
  const tools = [{ name: 'curator_check' }, { name: 'memory_checkpoint' }, { name: 'observation_read' }]
  const registered = new Map([['curator_check', { execute }], ['memory_checkpoint', { execute }]])
  const missing = projectToolsForPhase(tools, state('completed'), registered, name => name === 'curator_check' ? { execute } : undefined)
  assert.equal(missing.reason, 'ownership_unknown')
  assert.strictEqual(missing.tools, tools)
  const collision = projectToolsForPhase(tools, state('completed'), registered, name => ({ execute: name === 'curator_check' ? otherExecute : execute }))
  assert.equal(collision.reason, 'ownership_unknown')
  assert.strictEqual(collision.tools, tools)
  const withoutOwnedNames = [tools[2]!]
  assert.equal(projectToolsForPhase(withoutOwnedNames, state('completed'), registered, () => undefined).reason, 'no_owned_tools')
  assert.strictEqual(projectToolsForPhase(withoutOwnedNames, state('completed'), registered, () => undefined).tools, withoutOwnedNames)
})

test('unknown policy state fails open to the unchanged surface, never an empty projection', () => {
  const unknownPhase = state('completed', { phase: 'future' as DshToolPhase })
  assert.equal(hasKnownDshToolPolicyState(unknownPhase), false)
  const unknownAction = state('normal', { nextAction: 'future_action' as NonNullable<DshToolPolicyState['nextAction']> })
  assert.equal(hasKnownDshToolPolicyState(unknownAction), false)
  const tools = [{ name: 'curator_check' }]
  const result = projectToolsForPhase(tools, unknownPhase, new Map([['curator_check', { execute: async () => undefined }]]), () => ({ execute: async () => undefined }))
  assert.equal(result.reason, 'unknown_state')
  assert.strictEqual(result.tools, tools)
})

test('configuration defaults to auto and rejects unknown modes', () => {
  assert.equal(ToolExposureConfig.parse({}).mode, 'auto')
  assert.equal(Config.parse({}).toolExposure.mode, 'auto')
  assert.equal(ToolExposureConfig.parse({ mode: 'lean' }).mode, 'lean')
  assert.throws(() => ToolExposureConfig.parse({ mode: 'guess' }))
})

test('lean mode admits only explicit OpenAI pi-ai HTTP protocols', () => {
  assert.equal(supportsLeanToolExposureRoute({ provider: 'openai', family: 'openai', connection: 'api', protocol: 'responses' }), true)
  assert.equal(supportsLeanToolExposureRoute({ provider: 'openai', family: 'openai', connection: 'api', protocol: 'chat-completions' }), true)
  assert.equal(supportsLeanToolExposureRoute({ provider: 'openrouter', family: 'openrouter', connection: 'api', protocol: 'chat-completions' }), false)
  assert.equal(supportsLeanToolExposureRoute({ provider: 'openai', family: 'openai', connection: 'local', protocol: 'responses' }), false)
  assert.equal(supportsLeanToolExposureRoute(undefined), false)
})

test('lean projection removes only exact duplicate input-schema descriptions and never mutates execution definitions', () => {
  const definitions = createDshToolDefinitions({
    bind: () => ({ runId: 'run-1', workspace: 'workspace-1', orchestrationId: 'orchestration-1', revision: 1, routeEpoch: 0 }),
    execute: async () => undefined,
  })
  const byName = new Map<string, typeof definitions[number]>(definitions.map(definition => [definition.name, definition]))
  const registered = new Map(definitions.map(definition => [definition.name, { execute: definition.execute }]))
  const external = { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
  const tools = [external, ...definitions.map(({ name, description, parameters }) => ({ name, description, parameters }))]
  const originalDescriptions = tools.map(tool => tool.description)
  const originalParameters = new Map(definitions.map(definition => [definition.name, definition.parameters]))
  const result = projectToolsForLean(tools, state('normal'), registered, name => {
    const definition = byName.get(name)
    return definition ? { execute: definition.execute } : undefined
  })

  assert.equal(result.reason, 'projected')
  assert.deepEqual(result.tools.map(tool => tool.name), ['read', 'curator_check', 'memory_checkpoint'])
  assert.strictEqual(result.tools[0], external)
  assert.ok(!result.tools.find(tool => tool.name === 'curator_check')!.description!.includes('Business payload:'))
  assert.strictEqual(result.tools.find(tool => tool.name === 'curator_check')!.parameters, originalParameters.get('curator_check'))
  assert.strictEqual(result.tools.find(tool => tool.name === 'memory_checkpoint')!.parameters, originalParameters.get('memory_checkpoint'))
  assert.deepEqual(tools.map(tool => tool.description), originalDescriptions)
  assert.deepEqual(definitions.map(definition => definition.description), originalDescriptions.slice(1))
  assert.equal(result.metrics.phaseFilteredCount, definitions.length - 2)
  assert.equal(result.metrics.descriptionTransformedCount, 2)
  assert.ok(result.metrics.descriptionBytesAfter < result.metrics.descriptionBytesBefore)
  assert.equal(result.metrics.parameterBytesBefore, Buffer.byteLength(JSON.stringify(external.parameters))
    + definitions.reduce((total, definition) => total + Buffer.byteLength(JSON.stringify(definition.parameters)), 0))
  assert.equal(result.metrics.parameterBytesAfter, Buffer.byteLength(JSON.stringify(external.parameters))
    + Buffer.byteLength(JSON.stringify(byName.get('curator_check')!.parameters))
    + Buffer.byteLength(JSON.stringify(byName.get('memory_checkpoint')!.parameters)))
  assert.equal(result.metrics.unownedSurfaceReductionCount, 0)
  assert.equal(result.metrics.unownedSurfaceReductionReason, 'registration_provenance_unavailable')

  for (const operation of DSH_LEAN_DESCRIPTION_OPERATIONS) {
    const definition = byName.get(operation)!
    const compact = leanDshToolDescription(operation, definition.description)
    assert.ok(compact)
    assert.ok(!compact.includes('Business payload:'))
  }
  for (const operation of ['enno_plan_review', 'enno_delegate']) {
    const definition = byName.get(operation)!
    assert.equal(leanDshToolDescription(operation, definition.description), undefined)
  }
})

test('lean projection fails closed on changed description schema and ownership', () => {
  const definitions = createDshToolDefinitions({
    bind: () => ({ runId: 'run-1', workspace: 'workspace-1', orchestrationId: 'orchestration-1', revision: 1, routeEpoch: 0 }),
    execute: async () => undefined,
  })
  const registered = new Map(definitions.map(definition => [definition.name, { execute: definition.execute }]))
  const tools = definitions.map(({ name, description, parameters }) => ({ name, description, parameters }))
  const changed = tools.map(tool => tool.name === 'curator_check' ? { ...tool, description: `${tool.description} changed` } : tool)
  const unsupportedSchema = projectToolsForLean(changed, state('normal'), registered, name => {
    const definition = definitions.find(item => item.name === name)
    return definition ? { execute: definition.execute } : undefined
  })
  assert.equal(unsupportedSchema.reason, 'unsupported_schema')
  assert.strictEqual(unsupportedSchema.tools, changed)

  const ownershipUnknown = projectToolsForLean(tools, state('normal'), registered, () => undefined)
  assert.equal(ownershipUnknown.reason, 'ownership_unknown')
  assert.strictEqual(ownershipUnknown.tools, tools)
})

const autoRoute = { provider: 'openai', family: 'openai', connection: 'api', protocol: 'responses' } as const
for (const taskType of ['chat', 'research', 'analysis', 'writing', 'review', 'build', 'debug', 'devops'] as const) {
  test(`auto selects task capability before phase for ${taskType}`, () => {
    const minimal = ['chat', 'research', 'analysis', 'writing', 'review'].includes(taskType)
    assert.equal(resolveToolExposureMode({ mode: 'auto', taskType, selectionMode: 'normal', state: state(minimal ? 'completed' : 'normal'), route: autoRoute }).mode, minimal ? 'minimal' : 'lean')
    assert.equal(resolveToolExposureMode({ mode: 'auto', taskType, selectionMode: 'enno', state: state('planning', { nextAction: 'review_plan' }), route: autoRoute }).mode, 'lean')
  })
}
test('auto conservatively retains surface for unknown task, state or route; explicit modes remain overrides', () => {
  const input = { mode: 'auto', taskType: null, selectionMode: 'normal', state: state('normal'), route: autoRoute } as const
  assert.equal(resolveToolExposureMode(input).mode, 'full')
  assert.equal(resolveToolExposureMode({ ...input, taskType: 'chat', route: undefined }).mode, 'full')
  assert.equal(resolveToolExposureMode({ ...input, taskType: 'chat', state: state('future' as DshToolPhase) }).mode, 'full')
  for (const mode of ['full', 'phase', 'lean'] as const) assert.equal(resolveToolExposureMode({ ...input, mode }).mode, mode)
})
test('minimal removes owned tools without changing external definitions or accepting collisions', () => {
  const execute = async () => undefined
  const external = { name: 'web_search', description: 'Search', parameters: { type: 'object' } }
  const tools = [external, { name: 'curator_check' }]
  const registered = new Map([['curator_check', { execute }]])
  const result = projectToolsForMinimal(tools, state('normal'), registered, () => ({ execute }))
  assert.deepEqual(result.tools, [external]); assert.strictEqual(result.tools[0], external)
  assert.equal(result.metrics.taskFilteredCount, 1); assert.equal(result.metrics.phaseFilteredCount, 0)
  assert.equal(tools.length, 2)
  assert.strictEqual(projectToolsForMinimal(tools, state('normal'), registered, () => ({ execute: async () => undefined })).tools, tools)
})
