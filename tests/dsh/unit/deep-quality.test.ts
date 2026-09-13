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
