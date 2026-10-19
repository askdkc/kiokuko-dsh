// Scripted independent inference for known fixture sources; never infer truth from the candidate.
import assert from 'node:assert/strict'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { DecisionError, type DecisionBatch, type DecisionBatchResult } from '../../../src/dsh/decisions/contracts.js'
export interface FixtureIntent { action: 'answer'|'research'|'verify'|'change'; changeScope?: 'document'|'implementation'|'unknown'; relation?: 'new'|'same_scope_continuation'|'scope_change'; taskType?: string }
export function semanticFixtureAnswers(batch: DecisionBatch, expected: (task:string) => FixtureIntent|undefined): DecisionBatchResult['answers'] | undefined {
  if(batch.purpose !== 'intent-semantic-match') return undefined
  const state=batch.state as {source:{task:string};candidate:{action:string;changeScope:string;relation:string}}
  assert.equal(typeof state.source?.task,'string','Independent fixture must receive the original human source')
  const truth=expected(state.source.task)
  const matches=truth && state.candidate.action===truth.action && (truth.action!=='change'||state.candidate.changeScope===truth.changeScope)
    && (!truth.relation||state.candidate.relation===truth.relation)
  return batch.questions.map(q=>({id:q.id,status:'selected',choiceId:!truth?'insufficient':matches?'supported':'contradicted'}))
}
export function intentFixtureDecisions(expected: (task:string) => FixtureIntent|undefined) {
  return new DecisionService(TypedDecisionsConfig.parse({mode:'auto'}),()=>({capabilities:{maxQuestions:256,maxChoices:256,maxBytes:262144},async evaluate(batch) {
    const semantic=semanticFixtureAnswers(batch,expected)
    if(semantic)return {provider:'typesafe',requestedModel:'jev-latest',policyVersion:'independent-fixture-v1',answers:semantic}
    if(batch.purpose!=='request-intent')throw new DecisionError('UNAVAILABLE')
    const truth=expected((batch.state as {currentUserMessage:string}).currentUserMessage)
    return {provider:'typesafe',requestedModel:'jev-latest',policyVersion:'fixture-extraction-v1',answers:batch.questions.map(q=>{
      const choiceId=truth?({'request-action':truth.action,'request-change-scope':truth.changeScope??'unknown','request-relation':truth.relation??'new','task-type':truth.taskType??(truth.action==='change'?'writing':'review')} as Record<string,string>)[q.id]:undefined
      return choiceId?{id:q.id,status:'selected' as const,choiceId}:{id:q.id,status:'abstained' as const,reason:'insufficient' as const}
    })}
  }}))
}
