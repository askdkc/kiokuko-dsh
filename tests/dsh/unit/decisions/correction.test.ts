import assert from 'node:assert/strict'
import test from 'node:test'
import {TypedDecisionsConfig} from '../../../../src/dsh/decisions/config.js'
import {DecisionService} from '../../../../src/dsh/decisions/service.js'
import {correctionClassifier} from '../../../../src/dsh/decisions/correction.js'
import {correctionClassificationBatch} from '../../../../src/memory/correction-classification.js'
import {TypeSafeDecisionProvider,NimbleDecisionProvider} from '../../../../src/dsh/decisions/providers.js'
import {LayaCoreMLDecisionProvider} from '../../../../src/dsh/decisions/laya-coreml.js'
import {LayaV1DecisionProvider} from '../../../../src/dsh/decisions/laya-v1.js'
import {layaConfig,layaReply,layaV1Reply} from '../../helpers/laya.js'
const input={title:'Synthetic',body:'Check the operation instead of rejecting for a different label.',summary:null}
const signal=()=>new AbortController().signal
for(const kind of ['typesafe','nimble','laya-strict','laya-v1'] as const)test(`correction meaning uses the same Choice contract through ${kind}`,async()=>{
  const configuration=kind==='laya-strict'?layaConfig():TypedDecisionsConfig.parse({provider:kind==='laya-v1'?'laya-coreml':kind,
    nimble:{endpoint:'http://localhost:9999/v1/systemone',model:'fixture'},...(kind==='laya-v1'?{'laya-coreml':{protocol:'v1',model:'laya-rl-agent'}}:{})})
  const http:typeof fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.equal(body.state.correction.body,input.body)
    return Response.json({model:body.model,answers:Object.fromEntries(Object.entries(body.questions).map(([id,q]:[string,any])=>[id,{type:'choice',choice:'capability_compatibility',confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k==='capability_compatibility'?1:0]))}]))})}
  const operations:string[]=[]
  const service=new DecisionService(configuration,c=>kind==='typesafe'?new TypeSafeDecisionProvider(c.typesafe,async()=> 'fixture-only',http)
    :kind==='nimble'?new NimbleDecisionProvider(c.nimble,async()=>undefined,http)
    :kind==='laya-strict'?new LayaCoreMLDecisionProvider(c['laya-coreml'],async(_path,json)=>{const request=JSON.parse(json);operations.push(request.op);return layaReply(request,()=> 'capability_compatibility')})
    :new LayaV1DecisionProvider(c['laya-coreml']!,async(_path,json)=>layaV1Reply(JSON.parse(json),()=> 'capability_compatibility')))
  const classifier=await correctionClassifier(service),outcome=await classifier.backend!.evaluate('fixture',correctionClassificationBatch(input),signal())
  assert.equal(classifier.mode,'shadow');assert.equal(outcome.status,'completed')
  if(outcome.status==='completed'){assert.equal((outcome.result as any).answers[0].choiceId,'capability_compatibility');assert.equal(outcome.attested,kind!=='laya-v1')}
  if(kind==='laya-strict')assert.ok(operations.indexOf('preflight')>=0&&operations.indexOf('preflight')<operations.indexOf('predict_strict'))
})
test('strict truncation admission fails before correction inference; decision-off performs no inference',async()=>{
  let predictions=0
  const configuration=layaConfig(),service=new DecisionService(configuration,c=>new LayaCoreMLDecisionProvider(c['laya-coreml'],async(_path,json)=>{
    const request=JSON.parse(json),reply=layaReply(request);if(request.op==='preflight')reply.input_tokens=999;if(request.op==='predict_strict')predictions++;return reply
  }))
  const classifier=await correctionClassifier(service),outcome=await classifier.backend!.evaluate('overflow',correctionClassificationBatch(input),signal())
  assert.equal(outcome.status,'fallback');assert.equal(predictions,0)
  const off=new DecisionService(TypedDecisionsConfig.parse({mode:'off'}),()=>{throw new Error('must not construct a provider')})
  assert.deepEqual(await correctionClassifier(off),{mode:'off'})
})
