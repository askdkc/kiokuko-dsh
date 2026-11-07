import assert from 'node:assert/strict'
import test from 'node:test'
import {CodingDefinitionSchema,CODING_MINIMUM_DEFINITION_EXAMPLE} from '../../../../src/dsh/coding-workflow/contracts.js'
import {mountCodingWorkflow} from '../../../../src/dsh/coding-workflow/host.js'
import { KiokukoError } from '../../../../src/errors.js'
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

test('a single Goal and item criterion collision names the ID and both indexed paths', () => {
  const definition = structuredClone(CODING_MINIMUM_DEFINITION_EXAMPLE)
  const item = definition.items[0]!
  item.criterionIds[0] = 'goal-check'

  const result = CodingDefinitionSchema.safeParse(definition)
  assert.equal(result.success, false)
  const collisions = result.error!.issues.filter(issue =>
    issue.code === 'custom' && issue.params?.criterionDiagnostic?.kind === 'goal_item_criterion_collision')
  assert.deepEqual(collisions.map(issue => issue.path), [['items', 0, 'criterionIds', 0]])
  const [collision] = collisions
  assert.ok(collision?.code === 'custom')
  assert.deepEqual(collision.params?.criterionDiagnostic, {
    kind: 'goal_item_criterion_collision',
    criterionId: 'goal-check',
    relatedPath: ['goal', 'criterionIds', 0],
  })

  item.criterionIds[0] = 'item-check'
  assert.deepEqual(item.goalCriterionIds, ['goal-check'])
  assert.equal(CodingDefinitionSchema.safeParse(definition).success, true)
})

test('apply reports each criterion collision and invalid Goal reference separately', async () => {
  const definition = example()
  const item = definition.items[0]!
  item.criterionIds.push('goal-check', 'goal-check')
  item.goalCriterionIds.push('c-real-run', 'unknown-goal')
  definition.items.push({
    ...item, itemId: 'second-item', criterionIds: ['c-real-run', 'goal-check'], goalCriterionIds: [],
  })
  const original = structuredClone(definition)
  const definitions = new Map<string, any>()
  const agent = { id: 'agent' }
  const dispose = mountCodingWorkflow({
    tools: { register: tool => { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } },
    on: () => () => {},
  }, {
    runtime: { withDatabase: async () => assert.fail('invalid definitions must not touch the database') } as any,
    resolve: () => ({ agent, runId: 'run', sessionId: 'session', repositoryRoot: '/isolated' }),
    lisp: () => undefined,
  })
  try {
    const tool = definitions.get('coding_workflow_apply')
    await assert.rejects(tool.execute({ action: 'propose', expectedRevision: 1, definition }, {
      name: tool.name, callId: 'mixed', agent, signal: new AbortController().signal,
    }), (error: unknown) => {
      assert.ok(error instanceof KiokukoError)
      assert.equal(error.code, 'VALIDATION_ERROR')
      const issues = error.details.issues as {
        field: string; reason: string; correction: string; kind?: string; criterionId?: string; relatedField?: string
      }[]
      const collisions = issues.filter(issue => issue.kind === 'goal_item_criterion_collision')
      assert.deepEqual(collisions.map(({ field, criterionId, relatedField }) => [field, criterionId, relatedField]), [
        ['definition.items.0.criterionIds.1', 'goal-check', 'definition.goal.criterionIds.0'],
        ['definition.items.0.criterionIds.2', 'goal-check', 'definition.goal.criterionIds.0'],
        ['definition.items.1.criterionIds.0', 'c-real-run', 'definition.goal.criterionIds.1'],
        ['definition.items.1.criterionIds.1', 'goal-check', 'definition.goal.criterionIds.0'],
      ])
      for (const issue of collisions) {
        assert.match(issue.correction, /Keep .*goalCriterionIds.*do not empty/u)
        assert.ok(error.message.split('\n').some(line => line.includes(issue.field)
          && line.includes(issue.kind!) && line.includes(issue.criterionId!) && line.includes(issue.relatedField!)))
      }
      const unknown = issues.find(issue => issue.kind === 'unknown_goal_criterion_reference')
      assert.equal(unknown?.field, 'definition.items.0.goalCriterionIds.2')
      assert.equal(unknown.criterionId, 'unknown-goal')
      assert.match(unknown.correction, /Keep other valid references.*Remove this reference.*declared.*goal\.criterionIds.*implements.*does not already reference/u)
      const empty = issues.find(issue => issue.kind === 'empty_goal_criterion_references')
      assert.equal(empty?.field, 'definition.items.1.goalCriterionIds')
      assert.match(empty.reason, /at least one/u)
      assert.match(empty.correction, /coding_workflow_blocker/u)
      return true
    })
    assert.deepEqual(definition, original)
  } finally {
    dispose()
  }
})
