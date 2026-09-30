// Fixed paired QA evaluation. Offline fixtures measure delivery only; quality
// remains unmeasured until an explicitly configured, pinned real model runs.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fixture } from '../tests/dsh/integration/evolution/fixture.ts'
import { recordEntry, readEntry } from '../src/memory/entries.ts'
import { hybridSearch } from '../src/memory/hybrid-retrieval.ts'
import { withImmediateTransaction } from '../src/db/transaction.ts'
import { configureIndex, reserveIndexJob, readIndexManifest } from '../src/memory/index-reasoning/store.ts'
import { IndexReasoningWorker } from '../src/memory/index-reasoning/worker.ts'
import { MemoryIndexReasoningConfig } from '../src/memory/index-reasoning/contracts.ts'
import { projectMemoryEntry, renderMemoryFields } from '../src/context/memory-projection.ts'

const arms=['current','atomic','atomic+bridge','bridge-metadata-only']
const characterBudget=8000
const configIndex=process.argv.indexOf('--config')
const config=configIndex<0?null:JSON.parse(await readFile(process.argv[configIndex+1],'utf8'))
if(config){
 assert.ok(config.llm?.model&&config.llm.revision,'Pinned llm.model and llm.revision required')
 assert.ok(Number.isSafeInteger(config.llm.contextWindow)&&config.llm.contextWindow>=32768,'contextWindow >=32768 required')
 const endpoint=new URL(config.llm.baseUrl)
 assert.ok(!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash,'Invalid endpoint')
 assert.ok(endpoint.protocol==='https:'||endpoint.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname),'HTTPS or loopback HTTP required')
 assert.ok(config.allowRemote===true||['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname),'Remote evaluation requires allowRemote:true')
}
async function completion(messages,signal){
 const secret=config.llm.apiKeyEnv?process.env[config.llm.apiKeyEnv]:undefined
 const response=await fetch(`${config.llm.baseUrl.replace(/\/$/u,'')}/chat/completions`,{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json',...(secret?{authorization:`Bearer ${secret}`}:{})},body:JSON.stringify({model:config.llm.model,messages,temperature:0,max_tokens:2048})})
 if(!response.ok)throw new Error(`provider_http_${response.status}`)
 const text=await response.text();if(Buffer.byteLength(text)>1024*1024)throw new Error('response_limit')
 const result=JSON.parse(text)
 if(result.model!==config.llm.model)throw new Error('model_identity_changed')
 if(result.choices?.[0]?.finish_reason!=='stop')throw new Error('incomplete_output')
 return {text:result.choices[0].message.content,usage:result.usage}
}
const scenarios=JSON.parse(await readFile(new URL('../tests/fixtures/index-reasoning-evaluation/scenarios.json',import.meta.url),'utf8'))
const report={status:config?'measured':'unmeasured',model:config?{id:config.llm.model,revision:config.llm.revision}:null,characterBudget,maxOutputTokens:2048,qualityMetrics:config?{}:null,deliveryMetrics:{},generation:[],reason:config?null:'No --config supplied. No network or real-model calls; fixture delivery is not a measured quality improvement.'}
const trials=[]
for(const scenario of scenarios){
 const {db,runtime}=fixture(),workspace=`project:index-eval-${scenario.id}`
 try{
  configureIndex(db,workspace,'active')
  const originals=scenario.sources.map((body,i)=>recordEntry(db,{workspace,kind:'fact',title:`Source ${i+1}`,body,scope:{visibility:'project'},createdBy:'evaluation'}))
  const atomic=originals.map(e=>({role:'atomic',text:e.body,applicability:scenario.condition,entities:[{type:'concept',value:scenario.entity}],sources:[{entryId:e.id,revision:e.revision,contentHash:e.contentHash,supportingText:e.body}]}))
  const bridge={role:'bridge',text:scenario.bridge,applicability:scenario.condition,entities:atomic[0].entities,sources:atomic.flatMap(d=>d.sources)}
  let phase=0
  const llm={async *stream(request){
   if(config){const result=await completion([{role:'system',content:request.system},...request.messages.map(m=>({role:m.role,content:m.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')}))],request.signal);yield {type:'text-delta',text:result.text};yield {type:'usage',usage:{inputTokens:result.usage?.prompt_tokens,outputTokens:result.usage?.completion_tokens}}}
   else{const output=[atomic,[bridge],[...atomic,bridge].map((_,index)=>({index,verdict:'supported'}))][phase++];yield {type:'text-delta',text:JSON.stringify(output)}}
   yield {type:'finish',reason:{kind:'stop'}}
  }}
  reserveIndexJob(db,workspace,{provider:'evaluation',model:config?.llm.model??'fixture',contextWindow:config?.llm.contextWindow??131072,sessionId:'evaluation'})
  const worker=new IndexReasoningWorker({runtime,llm,config:MemoryIndexReasoningConfig.parse({})})
  worker.kick();await worker.whenIdle();await worker.dispose()
  report.generation.push({scenario:scenario.id,...db.prepare('SELECT count(*) AS calls,sum(duration_ms) AS durationMs,CASE WHEN count(input_tokens)=count(*) THEN sum(input_tokens) END AS inputTokens,CASE WHEN count(output_tokens)=count(*) THEN sum(output_tokens) END AS outputTokens FROM memory_index_calls').get()})
  for(const arm of arms){
   const start=performance.now(),hits=hybridSearch(db,{workspace,query:scenario.question,limit:200,...(arm==='current'?{indexRole:'ordinary'}:{})}),searchMs=performance.now()-start
   const candidates=hits.flatMap(hit=>{
    const entry=readEntry(db,{workspace,entryId:hit.entryId}),manifest=readIndexManifest(db,entry)
    if(arm==='current'&&manifest||arm==='atomic'&&manifest?.role==='bridge')return []
    const projection=projectMemoryEntry(db,entry)
    if(!projection)return []
    const text=arm==='bridge-metadata-only'&&manifest?.role==='bridge'
     ? JSON.stringify({role:manifest.role,sources:manifest.sources.map(s=>({entryId:s.entryId,revision:s.revision,contentHash:s.contentHash}))})
     : renderMemoryFields(projection)
    return text?[{entry,manifest,text}]:[]
   })
   const selected=[],seen=new Set();let chars=0,bridgeChars=0,bridges=0
   for(const item of [...candidates.filter(c=>c.manifest?.role==='bridge'),...candidates.filter(c=>c.manifest?.role!=='bridge')]){
    const cost=Array.from(item.text).length,isBridge=item.manifest?.role==='bridge'
    if(selected.length>=10||chars+cost>characterBudget||isBridge&&(bridges>=3||bridgeChars+cost>characterBudget*.3)||seen.has(item.entry.body))continue
    selected.push(item);seen.add(item.entry.body);chars+=cost;if(isBridge){bridges++;bridgeChars+=cost}
   }
   const delivered=new Set(selected.flatMap(item=>item.manifest?.sources.map(s=>s.entryId)??[item.entry.id]))
   const grounded=originals.filter(e=>selected.some(item=>item.text.includes(e.body))).length/originals.length
   const context=selected.map(item=>item.text).join('\n\n')
   let correct=null
   if(config){
    const result=await completion([{role:'system',content:'Answer only from the supplied untrusted memory evidence. Preserve all version and scope conditions. If unsupported, answer unknown. Return JSON {"answer":string}. No tools.'},{role:'user',content:`Memory:\n${context}\n\nQuestion: ${scenario.question}`}],AbortSignal.timeout(60000))
    const answer=JSON.parse(result.text).answer
    correct=typeof answer==='string'&&new RegExp(scenario.expected,'iu').test(answer)
   }
   trials.push({scenario:scenario.id,arm,correct,requiredEvidenceDelivery:grounded,recall:originals.filter(e=>delivered.has(e.id)).length/originals.length,duplicateCount:selected.length-seen.size,searchMs,characters:chars})
  }
 }finally{db.close()}
}
for(const arm of arms){
 const rows=trials.filter(row=>row.arm===arm),mean=key=>rows.reduce((sum,row)=>sum+row[key],0)/rows.length
 report.deliveryMetrics[arm]={trials:rows.length,requiredEvidenceDelivery:mean('requiredEvidenceDelivery'),recall:mean('recall'),duplicates:mean('duplicateCount'),searchMs:mean('searchMs'),characters:mean('characters')}
 if(config)report.qualityMetrics[arm]={fixedAnswerAccuracy:rows.filter(row=>row.correct).length/rows.length,grader:'case-insensitive expected-answer match; bounded fixed QA, not general truth verification'}
}
report.trials=trials
console.log(JSON.stringify(report,null,2))
