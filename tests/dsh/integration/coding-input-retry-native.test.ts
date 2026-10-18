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
for(const explicit of [false,true])test(`Goal coverage native retry (${explicit?'adapter':'public'}): concrete missing ID, unchanged state, corrected input reaches ready`,{timeout:60000},async()=>{
 let choices=0
 const f=await nativeSkillFixture({packages,...(packageRoot ? {packageRoot} : {}),explicit,mode:'compiled',extra:{lisp:{enabled:false},typedDecisions:{mode:'off'},answerReview:{mode:'off'},memoryReview:{mode:'off'},memoryEvolution:{mode:'off'},memoryIndexReasoning:{mode:'off'},deepPlanning:{enabled:false},modelAutoMode:{mode:'off'}},nativeAnswer:async q=>{choices++;return{answers:[{id:q.questions[0].id,selected:['使わない']}]}}})
 const definition=fixtureDefinition();definition.goal.criterionIds.push('c-real-run');definition.criteria.push({...definition.criteria[1]!,criterionId:'c-real-run',procedure:'Assert real HTTP results from both 5940 and 15940'})
 let initial:number=0
 try{
 f.responses.push(interpretedPreparation(f.mock,'prepare','new','change'),f.mock.toolCallResponse('initial','coding_workflow',{action:'status'}),(q:any)=>{initial=toolValue(q,'initial').revision;return f.mock.toolCallResponse('uncovered','coding_workflow_apply',{action:'propose',expectedRevision:initial,definition})},(q:any)=>{const r=nativeToolResults(q.messages).find((r:any)=>r.toolCallId==='uncovered');assert.ok(r?.isError);assert.match(JSON.stringify(r.content),/c-real-run.*items\[\]\.goalCriterionIds/u);assert.doesNotMatch(JSON.stringify(r.content),/put constraints|unique goalId/u);return f.mock.toolCallResponse('unchanged','coding_workflow',{action:'status'})},(q:any)=>{const state=toolValue(q,'unchanged');assert.equal(state.revision,initial);assert.equal(state.state,'preparing');assert.equal(choices,0);const repaired=structuredClone(definition);repaired.items[0]!.goalCriterionIds.push('c-real-run');return f.mock.toolCallResponse('corrected','coding_workflow_apply',{action:'propose',expectedRevision:state.revision,definition:repaired})},f.mock.toolCallResponse('ready','coding_workflow',{action:'status'}),(q:any)=>{const state=toolValue(q,'ready');assert.equal(state.revision,initial+2);assert.equal(state.state,'ready');assert.equal(state.choice.state,'no');assert.equal(choices,1);return f.mock.textResponse('The corrected definition is ready; implementation and final HTTP verification remain pending.')})
 await f.turn('Implement src/parser.mjs and verify the real HTTP behavior. 通常実行で。')
 }finally{await f.close()}
})
