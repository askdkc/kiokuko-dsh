import assert from 'node:assert/strict'
import test from 'node:test'
import { DeepConfigurationSchema, DEEP_ROLES, DeepStateSchema, type DeepArtifact } from '../../../src/deep-thinker/core/contracts.js'
import { initialDeepState } from '../../../src/deep-thinker/initial-state.js'
import { jobFor } from '../../../src/deep-thinker/prompts.js'
import { applyReply, replan, invalidateNodes } from '../../../src/deep-thinker/core/graph.js'
import { acceptDeepReply } from '../../../src/deep-thinker/acceptance.js'
import { qualityInput, qualityResponse } from '../helpers/deep-quality-fixture.js'
const configuration=DeepConfigurationSchema.parse({roles:Object.fromEntries(DEEP_ROLES.map(role=>[role,{provider:'test',model:role}]))})
function initial(quality=true) {
  return initialDeepState({revision:0,startId:'start',runId:null,workspace:'workspace',sessionId:'session',rootPath:'/repo',commandId:'command',messageId:'message',task:'Solve the complete problem',status:'pending',configuration:quality?{...configuration,reasoningMode:'quality',alternativeSolver:configuration.roles.solver}:configuration,messages:[],problem:''},'run','')
}
test('quality evidence packing handles eight large reads without changing legacy bounds',()=>{
  const state=initial(), node=state.nodes[0]!
  const artifacts:DeepArtifact[]=Array.from({length:8},(_,i)=>({id:`a${i}`,runId:'run',nodeId:node.id,nodeRevision:1,requirementRevision:1,path:`file${i}.txt`,content:'a'.repeat(16383),digest:'digest',sourceDigest:'source',startLine:1,endLine:1}))
  assert.ok(Buffer.byteLength(jobFor(state,node,'planner',artifacts).prompt)<131072)
  const old=initial(false);assert.throws(()=>jobFor(old,old.nodes[0]!,'planner',artifacts),/bounded input limit/)
})
test('quality job rejects an outdated pool and preserves the correction allowance across invalidation',()=>{
  const state=initial(),node=state.nodes[0]!,job=jobFor(state,node,'planner',[])
  const reply=qualityResponse(qualityInput(job));node.quality!.correctionUsed=true
  assert.throws(()=>acceptDeepReply(state,node,job,'attempt',reply,[],[]),/stale/)
  invalidateNodes(state,[node.id],'source changed');assert.equal(node.quality!.correctionUsed,true)
  replan(state,node,'replan');assert.equal(node.quality!.correctionUsed,true)
})
test('legacy configuration stays unversioned and quality cannot be smuggled into a version 1 state',()=>{
  const state=initial(false);assert.equal(state.protocolVersion,1);assert.equal('reasoningMode' in state.configuration,false);assert.equal('quality' in state.nodes[0]!,false)
  applyReply(state,state.nodes[0]!,'planner',{kind:'leaf',reason:'bounded'},[]);assert.equal(state.nodes[0]!.status,'ready')
  assert.equal(DeepStateSchema.safeParse({...state,protocolVersion:2}).success,false)
})
test('a plan cannot omit original requirements or rewrite inherited checks',()=>{
  const state=initial(),node=state.nodes[0]!
  const job=jobFor(state,node,'planner',[]),reply=qualityResponse(qualityInput(job))
  assert.equal(reply.kind,'quality-plan');if(reply.kind!=='quality-plan')return
  reply.checks[0]!.requirementId='invented'
  assert.throws(()=>acceptDeepReply(state,node,job,'attempt',reply,[],[]),/requirements/)
})

for (const complete of [false, true]) test(`child requirement coverage is ${complete ? 'complete even when shared' : 'not replaced by sibling coverage'}`, () => {
  const state = initial(), root = state.nodes[0]!
  root.requirementIds = ['R1', 'R2']
  const job = jobFor(state, root, 'planner', []), plan = qualityResponse(qualityInput(job))
  assert.equal(plan.kind, 'quality-plan'); if (plan.kind !== 'quality-plan') return
  plan.decision = 'decompose'
  plan.children = [
    { key: 'a', question: 'Check both requirements', requirementIds: ['R1', 'R2'], acceptanceCriteria: ['Cover R1 and R2'], assumptions: [], dependsOn: [], checkKeys: plan.checks.filter(c => complete || c.requirementId === 'R1').map(c => c.key) },
    { key: 'b', question: 'Check R2 independently', requirementIds: ['R2'], acceptanceCriteria: ['Cover R2'], assumptions: [], dependsOn: [], checkKeys: plan.checks.filter(c => c.requirementId === 'R2').map(c => c.key) },
  ]
  if (!complete) {
    assert.throws(() => acceptDeepReply(state, root, job, 'plan', plan, [], []), /requirements/)
    assert.equal(state.nodes.length, 1)
    assert.equal(root.proposal, null)
    assert.equal(root.receipt, null)
    return
  }
  acceptDeepReply(state, root, job, 'plan', plan, [], [])
  const reviewJob = jobFor(state, root, 'critic', [])
  acceptDeepReply(state, root, reviewJob, 'review', qualityResponse(qualityInput(reviewJob)), [], ['a', 'b'])
  for (const child of state.nodes.slice(1)) {
    for (let i = 0; i < 5; i++) {
      const next = jobFor(state, child, 'planner', [])
      acceptDeepReply(state, child, next, `${child.id}-${i}`, qualityResponse(qualityInput(next)), [], [])
    }
    assert.equal(child.status, 'accepted')
    assert.deepEqual(new Set(child.quality!.checks.map(c => c.requirementId)), new Set(child.requirementIds))
  }
})

test('inherited checks cannot omit one of the child requirements', () => {
  const state = initial(), node = state.nodes[0]!
  node.requirementIds.push('missing')
  node.quality!.inheritedChecks = [{ id: 'inherited', key: 'one', requirementId: 'request', text: 'One check', evidenceNeeded: 'Source' }]
  const job = jobFor(state, node, 'planner', [])
  assert.throws(() => acceptDeepReply(state, node, job, 'plan', qualityResponse(qualityInput(job)), [], []), /requirements/)
})

for (const [phase, precedingJobs] of [['plan-review', 1], ['draft-a', 2], ['compare', 4]] as const) {
  test(`saved incomplete checks cannot pass ${phase}`, () => {
    const state = initial(), node = state.nodes[0]!
    for (let i = 0; i < precedingJobs; i++) {
      const job = jobFor(state, node, 'planner', [])
      acceptDeepReply(state, node, job, `preceding-${i}`, qualityResponse(qualityInput(job)), [], [])
    }
    assert.equal(node.quality!.phase, phase)
    node.requirementIds.push('missing')
    const before = structuredClone(node), job = jobFor(state, node, 'planner', [])
    assert.throws(() => acceptDeepReply(state, node, job, 'invalid', qualityResponse(qualityInput(job)), [], []), /requirements/)
    assert.deepEqual(node, before)
  })
}
