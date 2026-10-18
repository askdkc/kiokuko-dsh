import assert from 'node:assert/strict'
import test from 'node:test'
import {CodingDefinitionSchema,CODING_MINIMUM_DEFINITION_EXAMPLE} from '../../../../src/dsh/coding-workflow/contracts.js'
import {mountCodingWorkflow} from '../../../../src/dsh/coding-workflow/host.js'
function example(){const d=structuredClone(CODING_MINIMUM_DEFINITION_EXAMPLE);d.goal.criterionIds.push('c-real-run');d.criteria.push({...d.criteria[1]!,criterionId:'c-real-run',procedure:'Check both HTTP ports 5940 and 15940'});return d}
test('uncovered final checks name every criterion and its repair field without guessing an item',()=>{
 const d=example();d.goal.criterionIds.push('c-second');d.criteria.push({...d.criteria[1]!,criterionId:'c-second'})
 const r=CodingDefinitionSchema.safeParse(d);assert.equal(r.success,false)
 if(r.success)return
 const issues=r.error.issues.filter(i=>i.message.includes('implementing item'))
 assert.equal(issues.length,2);assert.deepEqual(issues.map(i=>i.path),[['goal','criterionIds',1],['goal','criterionIds',2]])
 assert.match(issues[0]!.message,/c-real-run.*items\[\]\.goalCriterionIds/u);assert.match(issues[1]!.message,/c-second/u)
 assert.deepEqual(d.items[0]!.goalCriterionIds,['goal-check'],'validation never invents the implementing item')
})
test('coverage repair, unknown references, duplicate declarations and a valid minimum example remain distinct',()=>{
 assert.equal(CodingDefinitionSchema.safeParse(CODING_MINIMUM_DEFINITION_EXAMPLE).success,true)
 const repaired=example();repaired.items[0]!.goalCriterionIds.push('c-real-run');assert.equal(CodingDefinitionSchema.safeParse(repaired).success,true)
 const unknown=structuredClone(repaired);unknown.items[0]!.goalCriterionIds.push('not-a-goal');const u=CodingDefinitionSchema.safeParse(unknown);assert.equal(u.success,false);if(!u.success)assert.match(u.error.message,/not-a-goal/u)
 const duplicate=structuredClone(repaired);duplicate.criteria[1]!.criterionId=duplicate.criteria[0]!.criterionId;const d=CodingDefinitionSchema.safeParse(duplicate);assert.equal(d.success,false);if(!d.success)assert.match(d.error.message,/Duplicate IDs/u)
})
test('actual apply tool returns specific corrections and accepts the repaired retry',async()=>{
 const definitions=new Map<string,any>();const agent={id:'agent'},identity={agent,runId:'run',sessionId:'session',repositoryRoot:'/isolated'}
 const dispose=mountCodingWorkflow({tools:{register:d=>{definitions.set(d.name,d);return()=>definitions.delete(d.name)}},on:()=>()=>{}}, {runtime:{withDatabase:async()=>{throw new Error('invalid definitions must not touch the database')}} as any,resolve:()=>identity,lisp:()=>undefined})
 try{
 const tool=definitions.get('coding_workflow_apply'),execution={name:tool.name,callId:'bad',agent,signal:new AbortController().signal}
 await assert.rejects(tool.execute({action:'propose',expectedRevision:1,definition:example()},execution),(error:any)=>{
  assert.equal(error.code,'VALIDATION_ERROR');assert.match(error.message,/definition.goal.criterionIds.1/u);assert.match(error.message,/c-real-run.*items\[\]\.goalCriterionIds/u);assert.doesNotMatch(error.message,/constraints|unique goalId/u);return true})
 assert.match(JSON.stringify(tool.parameters),/every.*Goal criterion|Every.*Goal criterion/u)
 const repaired=example();repaired.items[0]!.goalCriterionIds.push('c-real-run')
 await assert.rejects(tool.execute({action:'propose',expectedRevision:1,definition:repaired},{...execution,callId:'fixed'}),/invalid definitions must not touch the database/u)
 }finally{dispose()}
})
