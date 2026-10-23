import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeProtocolEvidence } from '../../../src/dsh/guardrail/engine.js'
import type { ProtocolState, ProtocolReceipt } from '../../../src/dsh/guardrail/contracts.js'

const digest='a'.repeat(64)
function fixture() {
  const state={schema:2,lease:{taskId:'task',revision:1,generation:99},generation:700,recipeId:'recipe',source:{'a.mjs':digest},edits:['owned-file-edit']} as unknown as ProtocolState
  const receipt={schema:2,id:'owned-process',digest,ownedReceiptDigest:digest,workerGeneration:'worker-opaque',sourceDigest:digest,testDigest:digest,commandDigest:digest,runtimeDigest:digest,outcome:'passed',exit:0,assertions:1,snapshot:{snapshotId:'snapshot',scope:'scope',version:1,complete:true,count:1,unresolved:0,digest,executions:[{id:'journal-process',scope:'scope',parent:'call',sequence:1,route:'owned',kind:'process',state:'completed',outcome:'succeeded',request:digest,runtime:digest,receipt:digest,workerGeneration:'worker-opaque',protocolGeneration:700,leaseGeneration:99}]}} as ProtocolReceipt
  return {state,receipt}
}
test('schema2 separates state-derived patch from real test execution and generation domains',()=>{
  const {state,receipt}=fixture(),text=serializeProtocolEvidence(state,receipt,'verify-green')
  assert.match(text,/:schema 2/)
  assert.match(text,/:revision 1 :worker-generation "worker-opaque" :protocol-generation 700 :lease-generation 99/)
  assert.match(text,/:provenance :execution-backed :supporting \("journal-process"\)/)
  assert.match(text,/:provenance :state-derived :supporting \(\)/)
  assert.doesNotMatch(text,/:expected-generation|route-of|consumed|discarded/)
  assert.equal((text.match(/\(execution /g)??[]).length,1)
})
test('schema1 and evidence without a matching journal original fail closed',()=>{
  const {state,receipt}=fixture()
  assert.throws(()=>serializeProtocolEvidence({...state,schema:1},receipt,'verify-red'),/rebind-required/)
  assert.throws(()=>serializeProtocolEvidence(state,{...receipt,snapshot:{...receipt.snapshot,executions:[]}},'verify-red'),/no journal/)
})
