import assert from 'node:assert/strict'
import test from 'node:test'
import {join} from 'node:path'
import {nativeSkillFixture} from '../helpers/skill-native.js'
import {nativeToolResults} from '../helpers/native-mock.js'
import {isolateSkillHome} from '../helpers/skill-home.js'
import {fixtureDefinition,interpretedPreparation,toolValue} from '../helpers/coding-script.js'
isolateSkillHome()
const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT??join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules')
const packageRoot=process.env.KIOKUKO_SKILL_PACKAGE_ROOT
for(const explicit of [false,true])test(`Goal criterion native retry (${explicit?'adapter':'public'}): indexed diagnostics, unchanged state, corrected input reaches ready`,{timeout:60000},async()=>{
 let choices=0
 const f=await nativeSkillFixture({ startupChoice: 'decision OFF / Lisp OFF', packages,...(packageRoot ? {packageRoot} : {}),explicit,mode:'compiled',extra:{lisp:{enabled:false},typedDecisions:{mode:'off'},answerReview:{mode:'off'},memoryReview:{mode:'off'},memoryEvolution:{mode:'off'},memoryIndexReasoning:{mode:'off'},deepPlanning:{enabled:false},modelAutoMode:{mode:'off'}},nativeAnswer:async q=>{if(['target','expected'].includes(q.questions[0].id))return{answers:[{id:q.questions[0].id,selected:[],custom:q.questions[0].id==='target'?'src/parser.mjs':'verify real HTTP behavior'}]};choices++;return{answers:[{id:q.questions[0].id,selected:['使わない']}]}}})
 const definition=fixtureDefinition();definition.goal.criterionIds.push('c-real-run');definition.criteria.push({...definition.criteria[1]!,criterionId:'c-real-run',procedure:'Assert real HTTP results from both 5940 and 15940'})
 const repaired = structuredClone(definition)
 repaired.items[0]!.goalCriterionIds.push('c-real-run')
 repaired.items.push({
   ...repaired.items[0]!, itemId: 'second-item', criterionIds: ['second-check'], goalCriterionIds: ['user-entry'],
 })
 repaired.criteria.push({ ...repaired.criteria[0]!, criterionId: 'second-check' })
 const mixed = structuredClone(repaired)
 mixed.items[0]!.criterionIds[0] = 'user-entry'
 mixed.items[0]!.goalCriterionIds.push('unknown-goal')
 mixed.items[1]!.goalCriterionIds = []

 let initial = 0
 try{
 f.responses.push(
   interpretedPreparation(f.mock, 'prepare', 'new', 'change'),
   f.mock.toolCallResponse('initial', 'coding_workflow', { action: 'status' }),
   (request: any) => {
     initial = toolValue(request, 'initial').revision
     return f.mock.toolCallResponse('uncovered', 'coding_workflow_apply', { action: 'propose', expectedRevision: initial, definition })
   },
   (request: any) => {
     const result = nativeToolResults(request.messages).find(value => value.toolCallId === 'uncovered')
     assert.ok(result?.isError)
     assert.match(JSON.stringify(result.content), /c-real-run.*items\[\]\.goalCriterionIds/u)
     assert.doesNotMatch(JSON.stringify(result.content), /put constraints|unique goalId/u)
     return f.mock.toolCallResponse('mixed', 'coding_workflow_apply', { action: 'propose', expectedRevision: initial, definition: mixed })
   },
   (request: any) => {
     const result = nativeToolResults(request.messages).find(value => value.toolCallId === 'mixed')
     assert.ok(result?.isError)
     const text = result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')
     assert.match(text, /definition\.items\.0\.criterionIds\.0: \[goal_item_criterion_collision\].*user-entry.*definition\.goal\.criterionIds\.0.*Keep .*goalCriterionIds.*do not empty/u)
     assert.match(text, /definition\.items\.0\.goalCriterionIds\.2: \[unknown_goal_criterion_reference\].*unknown-goal.*goal\.criterionIds.*implements/u)
     assert.match(text, /definition\.items\.1\.goalCriterionIds: \[empty_goal_criterion_references\].*at least one.*coding_workflow_blocker/u)
     return f.mock.toolCallResponse('unchanged', 'coding_workflow', { action: 'status' })
   },
   (request: any) => {
     const state = toolValue(request, 'unchanged')
     assert.equal(state.revision, initial)
     assert.equal(state.state, 'preparing')
     assert.equal(choices, 0)
     return f.mock.toolCallResponse('corrected', 'coding_workflow_apply', { action: 'propose', expectedRevision: state.revision, definition: repaired })
   },
   f.mock.toolCallResponse('ready', 'coding_workflow', { action: 'status' }),
   (request: any) => {
     const state = toolValue(request, 'ready')
     assert.equal(state.revision, initial + 2)
     assert.equal(state.state, 'ready')
     assert.equal(state.choice.state, 'no')
     assert.equal(choices, 1)
     assert.deepEqual(state.definition.items.map((item: { goalCriterionIds: string[] }) => item.goalCriterionIds),
       [['user-entry', 'c-real-run'], ['user-entry']])
     return f.mock.textResponse('The corrected definition is ready; implementation and final HTTP verification remain pending.')
   },
 )
 await f.turn('Implement src/parser.mjs and verify the real HTTP behavior. 通常実行で。')
 }finally{await f.close()}
})
