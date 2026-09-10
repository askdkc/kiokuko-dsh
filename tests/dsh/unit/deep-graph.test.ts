import assert from 'node:assert/strict'
import test from 'node:test'
import { DeepConfigurationSchema, DeepStateSchema, DEEP_ROLES } from '../../../src/deep-thinker/core/contracts.js'
import { initialDeepState } from '../../../src/deep-thinker/initial-state.js'
import { applyReply, assertAcyclic, advanceGraph, invalidateNodes, runnableNodes, validateDecomposition } from '../../../src/deep-thinker/core/graph.js'
import { parseDeepCommand } from '../../../src/deep-thinker/commands.js'
import { budgetProblem, stopClock } from '../../../src/deep-thinker/core/budget.js'
import { DeepSlots } from '../../../src/deep-thinker/slots.js'

const configuration = DeepConfigurationSchema.parse({ roles: Object.fromEntries(DEEP_ROLES.map(role => [role, {provider:'test',model:role}])) })
const initial = () => initialDeepState({ revision:0, startId:'start', runId:null, workspace:'workspace', sessionId:'session', rootPath:'/repo', commandId:'command', messageId:'message', task:'Solve the complete problem', status:'pending', configuration, messages:[], problem:'' }, 'run', '')
const proposal = { kind: 'decompose' as const, synthesis: 'Combine both independently checked parts', children: ['a','b'].map(key => ({ key, question: `Question ${key}`, requirementIds:['request'], acceptanceCriteria:['Satisfy the obligation'], assumptions:[], dependsOn:[] })) }

test('Deep command grammar preserves body whitespace and literal flags', () => {
  assert.deepEqual(parseDeepCommand(' --status'), {kind:'status'})
  assert.deepEqual(parseDeepCommand(' -- --status\n  ```ts\n  x()\n  ```'), {kind:'start',task:'--status\n  ```ts\n  x()\n  ```'})
  assert.deepEqual(parseDeepCommand('\nFirst\n  second'), {kind:'start',task:'First\n  second'})
  assert.throws(() => parseDeepCommand(' --resume extra'), /不明/u)
  assert.deepEqual(parseDeepCommand(''), {kind:'arm'})
})
test('decomposition verifies closure, requirement coverage, depth and cumulative node budgets', () => {
  const state = initial(), root = state.nodes[0]!
  assert.throws(() => validateDecomposition(state, root, { ...proposal, children: proposal.children.map(c => ({...c,dependsOn:[c.key === 'a' ? 'b' : 'a']})) }), /cycle/u)
  assert.throws(() => validateDecomposition(state, root, { ...proposal, children: proposal.children.map(c => ({...c,requirementIds:['invented']})) }), /requirements/u)
  state.configuration.budget.maxNodes = 2
  assert.throws(() => validateDecomposition(state, root, proposal), /budget/u)
  assert.throws(() => assertAcyclic([{id:'a',parentId:null,dependencies:['b']},{id:'b',parentId:'a',dependencies:['a']}]), /cycle/u)
})
test('host controls child identities, independent invalidation, dependency failure and aggregation readiness', () => {
  const state = initial(), root = state.nodes[0]!
  applyReply(state, root, 'planner', proposal, [])
  applyReply(state, root, 'critic', {kind:'supported',requirementIds:['request'],reason:'Complete',evidence:[]}, ['host-a','host-b'])
  assert.deepEqual(runnableNodes(state).map(n => n.id), ['host-a','host-b'])
  for (const child of state.nodes.slice(1)) child.status = 'accepted'
  advanceGraph(state); assert.equal(root.status,'composing')
  invalidateNodes(state,['host-a'],'Source changed')
  assert.equal(state.nodes[1]!.status,'planning'); assert.equal(state.nodes[2]!.status,'accepted'); assert.equal(root.status,'waiting-children')
  state.nodes[1]!.status='unresolved'; advanceGraph(state); assert.equal(root.status,'unresolved'); assert.equal(runnableNodes(state).length,0)
  DeepStateSchema.parse(state)
})
test('pauses do not replenish active time or settled and uncertain budget', () => {
  const state = initial(); state.usage.activeSince=100; stopClock(state,200)
  assert.equal(state.usage.activeMs,100); stopClock(state,99999); assert.equal(state.usage.activeMs,100)
  state.configuration.budget.maxTotalTokens=100; state.usage.reservedTokens=99
  assert.equal(budgetProblem(state,200,'request',1),undefined)
  assert.match(budgetProblem(state,200,'request',2)!,/トークン/u)
  state.usage.reservedTokens=100; assert.match(budgetProblem(state,200,'job')!,/トークン/u)
})
test('process slots rotate waiting runs and serialize a local connection', async () => {
  const slots = new DeepSlots(), signal = new AbortController().signal, order: string[] = []
  const first = await slots.acquire('a','local',true,1,signal)
  const a = slots.acquire('a','local',true,1,signal).then(release => { order.push('a'); release() })
  const b = slots.acquire('b','local',true,1,signal).then(release => { order.push('b'); release() })
  first(); await Promise.all([a,b]); assert.deepEqual(order,['b','a'])
})
