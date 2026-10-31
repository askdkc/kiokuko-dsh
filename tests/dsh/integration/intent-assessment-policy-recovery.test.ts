/** Scripted OpenAI inference, real decoder and native finite checker. No claim
 * about the model's judgment: its insufficient verdict is intentionally retained. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenAIDecisionProvider } from '../../../src/dsh/decisions/openai.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import { assessRequestIntent, assessmentAllowsPreparation } from '../../../src/dsh/decisions/intent-assessment.js'
import { createRequestIntentContext, validateMainModelRequestIntent, requestIntentReferenceIds, type RequestIntentDecision } from '../../../src/dsh/decisions/request-intent.js'
const usage = { input_tokens: 9, output_tokens: 1, total_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
const context = createRequestIntentContext({task:'readme.mdを修正して欲しかった',messageRefs:[{id:'current-human',digest:'a'.repeat(64)}]})!
const parsed = validateMainModelRequestIntent({relation:'new',action:'change',changeScope:'document',evidenceRefs:requestIntentReferenceIds(context)},context)
assert.ok(parsed.ok)
const candidate = parsed.decision
for (const scenario of ['insufficient','confirmed','supported','contradicted','refusal','provider-candidate','scope-change','operate','transition','proposal','unknown-scope','forged-message','changed-target','cancelled'] as const) {
 test(`current-request main-model recovery: ${scenario}`, async () => {
  let calls=0
  const service = new DecisionService(TypedDecisionsConfig.parse({provider:'openai'}), (_config,observer)=>new OpenAIDecisionProvider(undefined,async()=>'fixture-key',async(_url,init)=>{
   calls++
   const body=JSON.parse(String(init!.body)), state=body.input[0].content[1].data.state
   assert.deepEqual(state.source,context)
   const choice=scenario==='supported'?'supported':scenario==='contradicted'?'contradicted':'insufficient'
   return Response.json({model:'gpt-6-luna',usage,answers:body.questions.map((q:any)=>scenario==='refusal'?{name:q.name,type:'refusal'}:{name:q.name,type:'choice',choice,confidence:1,probabilities:q.choices.map((c:any)=>({value:c.value,probability:c.value===choice?1:0}))})})
  },observer))
  const c:RequestIntentDecision=structuredClone(candidate)
  const changes:Record<string,unknown>={
   'provider-candidate':{source:'decision-provider'},'scope-change':{relation:'scope_change'},operate:{action:'operate'},transition:{taskOperation:'wait'},
   proposal:{evidence:{...c.evidence,proposalRefs:[{id:'foreign',revision:1,digest:'b'.repeat(64)}]}},'unknown-scope':{changeScope:'unknown'},
   'forged-message':{evidence:{...c.evidence,messageRefs:[{id:'foreign',digest:'a'.repeat(64)}]}},
   'changed-target':{evidence:{...c.evidence,requestDigest:'b'.repeat(64)}}}
  Object.assign(c,changes[scenario]??{})
  const controller=new AbortController();if(scenario==='cancelled')controller.abort()
  if(scenario==='cancelled'){await assert.rejects(assessRequestIntent(service,'request',context,c,controller.signal));return}
  const result=(await assessRequestIntent(service,'request',context,c,controller.signal,{userConfirmed:scenario==='confirmed'}))!
  assert.equal(calls,1)
  const allows=scenario==='confirmed'||scenario==='supported'
  assert.equal(assessmentAllowsPreparation(result),allows,JSON.stringify(result))
  assert.equal(result.semantic,scenario==='refusal'?'unavailable':scenario==='supported'?'supported':scenario==='contradicted'?'contradicted':'insufficient')
  if(scenario==='confirmed'){
   assert.equal(result.outcome,'user_confirmed')
   assert.ok(result.semanticChecks?.every(c=>c.status==='abstained'&&c.reason==='insufficient'))
  }
 })
}
