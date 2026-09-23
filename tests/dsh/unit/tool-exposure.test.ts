import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../../../src/dsh/config.js'
import { eligibleDshModelTools, projectToolsForPhase, ToolExposureConfig } from '../../../src/dsh/tool-exposure.js'
import { hasKnownDshToolPolicyState, type DshToolPhase, type DshToolPolicyState } from '../../../src/dsh/tool-policy.js'
import { DSH_MODEL_FACING_OPERATIONS } from '../../../src/dsh/tools.js'

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

test('configuration defaults to full and rejects unknown modes', () => {
  assert.equal(ToolExposureConfig.parse({}).mode, 'full')
  assert.equal(Config.parse({}).toolExposure.mode, 'full')
  assert.throws(() => ToolExposureConfig.parse({ mode: 'guess' }))
})
