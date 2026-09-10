// Real-model evaluation. No label-derived vectors and no network calls without an explicit config.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { openConnection } from '../src/db/connection.ts'
import { migrateDatabase } from '../src/db/migrate.ts'
import { withImmediateTransaction } from '../src/db/transaction.ts'
import { DshMemoryFinalizer } from '../src/dsh/session-memory-finalizer.ts'
import { MemoryEvolutionConfig } from '../src/memory/evolution/contracts.ts'
import { evolutionStatus } from '../src/memory/evolution/store.ts'
import { readEntry, updateCandidateEntry } from '../src/memory/entries.ts'
import { queryScopedContextGated } from '../src/context/scoped-broker.ts'
import { hybridSearch } from '../src/memory/hybrid-retrieval.ts'
import { buildEmbeddingDocument } from '../src/embedding/document.ts'
import { parseEmbeddingConfig, requireEnabledEmbeddingConfig } from '../src/embedding/config.ts'
import { createEmbeddingProfile } from '../src/embedding/profile.ts'
import { activateEmbeddingProfile, upsertEntryEmbedding } from '../src/embedding/store.ts'
import { JavaScriptVectorSearchBackend } from '../src/embedding/javascript-backend.ts'
import { hashVector, normalizeVector } from '../src/embedding/vector.ts'
import { isRetrievableEntry } from '../src/memory/hybrid-retrieval.ts'
import { buildDshMessageSources } from '../src/dsh/message-sources.ts'
import { retrievalMetrics, measureDatabase } from './evolution-evaluation-metrics.mjs'
import { execFileSync } from 'node:child_process'

const REPORT_VERSION = 2

const option = name => { const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1] }
const hash = value => createHash('sha256').update(value).digest('hex')
const fixtureRoot=new URL('../tests/fixtures/evolution-evaluation/',import.meta.url)
const fixtureText=await readFile(new URL('scenarios.json',fixtureRoot),'utf8')
const manifest=JSON.parse(await readFile(new URL('manifest.json',fixtureRoot),'utf8'))
assert.equal(hash(fixtureText),manifest.sha256,'Evaluation inputs changed; version the fixture before evaluation')
const scenarios=JSON.parse(fixtureText).scenarios
const reportPath=option('--report')
if(reportPath) {
  const report=JSON.parse(await readFile(reportPath,'utf8'))
  assert.equal(report.reportVersion,REPORT_VERSION,'Re-run evaluation: legacy Top-K metrics cannot be approved')
  const candidates=await readFile(path.join(path.dirname(reportPath),'candidates.json'),'utf8')
  const review=JSON.parse(await readFile(option('--review'),'utf8'))
  assert.equal(report.fixture.sha256,manifest.sha256)
  assert.equal(hash(candidates),report.artifactHash)
  assert.equal(review.artifactHash,report.artifactHash)
  assert.equal(review.fixtureHash,manifest.sha256)
  assert.equal(review.reviewedEntries,JSON.parse(candidates).length)
  report.gates.semanticSafetyReviewed=review.unsupportedSuccessClaims===0
  report.eligibleForActive=Object.values(report.gates).every(Boolean)
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n')
  process.stdout.write(JSON.stringify({gates:report.gates,eligibleForActive:report.eligibleForActive},null,2)+'\n')
  process.exit(0)
}
const configPath=option('--config')
if(!configPath) {
  process.stdout.write(JSON.stringify({reportVersion:REPORT_VERSION,status:'unmeasured',fixture:manifest,reason:'Provide --config with pinned real LLM and embedding identities. No model calls were made.',evaluationMode:'observe'},null,2)+'\n')
  process.exit(0)
}
const config=JSON.parse(await readFile(configPath,'utf8'))
for(const key of ['llm','embedding']) {
  const model=config[key];assert.ok(model?.model && model.revision,`${key} requires an immutable model identity/revision`)
  const url=new URL(model.baseUrl)
  assert.ok(!url.username&&!url.password&&!url.search&&!url.hash,'Endpoint must not contain credentials, query, or fragment')
  assert.ok(['http:','https:'].includes(url.protocol),'Only HTTP(S) endpoints are supported')
  assert.ok(config.allowRemote===true||['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Remote evaluation requires allowRemote:true')
}
assert.ok(Number.isSafeInteger(config.llm.contextWindow)&&config.llm.contextWindow>=32768)
assert.ok(Number.isSafeInteger(config.embedding.dimensions)&&config.embedding.dimensions>0)
const output=path.resolve(option('--output')??'evolution-evaluation-results')
await mkdir(output,{recursive:true})
const root=await mkdtemp(path.join(tmpdir(),'kiokuko-evolution-evaluation-'))
await mkdir(path.join(root,'.git'))
const counters={llmCalls:0,embeddingCalls:0,inputTokens:0,outputTokens:0,reportedUsageCalls:0,llmDurationMs:0,embeddingDurationMs:0}
async function post(model,route,body,signal) {
  const key=model.apiKeyEnv?process.env[model.apiKeyEnv]:undefined
  const response=await fetch(`${model.baseUrl.replace(/\/$/,'')}/${route}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json',...(key?{authorization:`Bearer ${key}`}:{})},body:JSON.stringify(body),signal})
  if(!response.ok) throw new Error(`Evaluation provider returned HTTP ${response.status}`)
  let text='';for await(const chunk of response.body) {text+=Buffer.from(chunk).toString('utf8');if(Buffer.byteLength(text)>4*1024*1024)throw new Error('Evaluation provider response too large')}
  return JSON.parse(text)
}
const llm={async *stream(request) {
  const start=performance.now();counters.llmCalls++
  const messages=[...(request.system?[{role:'system',content:request.system}]:[]),...request.messages.map(m=>({role:m.role,content:typeof m.content==='string'?m.content:m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')}))]
  try {
    const result=await post(config.llm,'chat/completions',{model:config.llm.model,messages,temperature:0,max_tokens:request.maxTokens},AbortSignal.any([request.signal??new AbortController().signal,AbortSignal.timeout(60000)]))
    assert.equal(result.model,config.llm.model,'Provider silently changed model identity')
    const usage=result.usage
    if(Number.isSafeInteger(usage?.prompt_tokens)&&Number.isSafeInteger(usage?.completion_tokens)) {
      counters.inputTokens+=usage.prompt_tokens;counters.outputTokens+=usage.completion_tokens;counters.reportedUsageCalls++
      yield {type:'usage',usage:{inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens}}
    }
    yield {type:'text-delta',text:result.choices?.[0]?.message?.content??''}
    yield {type:'finish',reason:{kind:result.choices?.[0]?.finish_reason==='stop'?'stop':'limit'}}
  } finally {counters.llmDurationMs+=performance.now()-start}
}}
const vectorCache=new Map()
async function embed(text) {
  const cacheKey=hash(text)
  if(vectorCache.has(cacheKey))return vectorCache.get(cacheKey)
  const start=performance.now();counters.embeddingCalls++
  const result=await post(config.embedding,'embeddings',{model:config.embedding.model,input:[text]},AbortSignal.timeout(60000))
  assert.equal(result.model,config.embedding.model,'Embedding provider changed model identity')
  const values=result.data?.[0]?.embedding
  assert.ok(Array.isArray(values)&&values.length===config.embedding.dimensions&&values.every(Number.isFinite),'Invalid real embedding')
  const vector=normalizeVector(Float32Array.from(values),config.embedding.dimensions)
  vectorCache.set(cacheKey,vector);counters.embeddingDurationMs+=performance.now()-start;return vector
}
function nativeLog(s,e) {
  const anchors=e.anchors??s.anchors;const procedure=e.procedure??s.procedure
  const result=(seq,callId,exitCode,text)=>({seq,time:seq,type:'tool/result',data:{exitCode,message:{role:'user',source:{kind:'tool',callId},content:[{type:'text',text}]}}})
  return [{seq:1,time:1,type:'turn/start',data:{turn:1}},
    {seq:2,time:2,type:'request/header',data:{header:{config:{provider:'evaluation',model:config.llm.model}}}},
    {seq:3,time:3,type:'request/context',data:{contextWindow:config.llm.contextWindow}},
    {seq:4,time:4,type:'user/message',surfaceOp:'append',data:{role:'user',source:{kind:'user'},content:[{type:'text',text:`${s.goal}\n${Object.values(anchors).join(' ')}\n${s.boundary}`}]}},
    {seq:5,time:5,type:'tool/call',data:{callId:'original',name:anchors.tool,arguments:anchors.target}},result(6,'original',1,e.observation),
    {seq:7,time:7,type:'tool/call',data:{callId:'retry',name:anchors.tool,arguments:procedure}},
    result(8,'retry',e.verification==='passed'?0:1,`${s.verification}: ${e.verification}`),
    {seq:9,time:9,type:'turn/end',data:{turn:1,reason:{kind:e.outcome}}}]
}
const runScenario=new Map(),runVersion=new Map(),logs=new Map()
const now='2026-09-10T00:00:00.000Z'
async function corpus(mode) {
  const db=openConnection(':memory:');migrateDatabase(db)
  const runtime={withDatabase:async fn=>await fn(db)}
  const finalizer=new DshMemoryFinalizer({runtime,llm,maximumAttempts:1,memoryEvolution:MemoryEvolutionConfig.parse({mode}),now:()=>now,
    sessionQuery:{async readSession(id){return {session:{id},inheritedEventCount:0,events:logs.get(id)}}}})
  await finalizer.start()
  for(const s of scenarios) for(const e of s.episodes) {
    const workspace=e.workspace??s.workspace,id=e.case,session=`session-${id}`
    runScenario.set(id,s.id);runVersion.set(id,(e.anchors??s.anchors).version);logs.set(session,nativeLog(s,e))
    db.prepare('INSERT OR IGNORE INTO repositories VALUES(?,?,?,NULL,1,0,?,?)').run(workspace,workspace,'evaluation',now,now)
    db.prepare(`INSERT INTO ledger_runs(run_id,workspace,dsh_session_id,protocol_version,capture_profile,coverage_json,status,metadata_json,started_at,created_at,updated_at)
      VALUES(?,?,?,'1','evaluation','{}','active','{}',?,?,?)`).run(id,workspace,session,now,now,now)
    await finalizer.bindRunStart({runId:id,workspace,dshSessionId:session,sourceStartSeq:1,sourceStartTurn:1})
    withImmediateTransaction(db,()=>{
      db.prepare('UPDATE ledger_runs SET status=? WHERE run_id=?').run(e.outcome,id)
      // Baseline finalization has no failed-run scheduling; that is part of the ablation.
      if(e.outcome==='completed'||mode!=='off')finalizer.scheduleInTransaction(db,{runId:id,workspace,dshSessionId:session,sourceEndSeq:9})
    })
    finalizer.kick();await finalizer.whenIdle()
    process.stderr.write('.')
  }
  await finalizer.dispose();return db
}
const databases=[]
try {
  const baseline=await corpus('off');databases.push(baseline)
  const evolved=await corpus('observe');databases.push(evolved)
  const profile=createEmbeddingProfile(requireEnabledEmbeddingConfig(parseEmbeddingConfig({KIOKUKO_EMBEDDINGS:'optional',KIOKUKO_EMBEDDING_BASE_URL:config.embedding.baseUrl,KIOKUKO_EMBEDDING_MODEL:config.embedding.model,KIOKUKO_EMBEDDING_DIMENSIONS:String(config.embedding.dimensions),KIOKUKO_EMBEDDING_DISTANCE_CEILING:String(config.distanceCeiling??0.5),KIOKUKO_EMBEDDING_ALLOW_REMOTE:config.allowRemote?'true':'false',KIOKUKO_VECTOR_BACKEND:'javascript'})))
  const backend=new JavaScriptVectorSearchBackend()
  const artifacts=[]
  for(const db of databases) {
    activateEmbeddingProfile(db,profile,{replace:false,now})
    for(const row of db.prepare('SELECT id,workspace FROM entries').all()) {
      const entry=readEntry(db,{workspace:row.workspace,entryId:row.id}),document=buildEmbeddingDocument(entry)
      upsertEntryEmbedding(db,{entryId:entry.id,profileId:profile.profileId,revision:entry.revision,contentHash:entry.contentHash,documentHash:document.documentHash,vector:await embed(document.text),createdAt:now})
      artifacts.push({condition:db===baseline?'baseline':'evolved',...entry})
    }
  }
  // Each ablation starts with the identical post-generation snapshot.
  const conditions={baseline,full:evolved}
  for(const condition of ['episode','lesson']) {
    const file=path.join(root,`${condition}.sqlite3`)
    await writeFile(file,evolved.serializeDatabase())
    conditions[condition]=openConnection(file);databases.push(conditions[condition])
  }
  const metrics=[],exactRanks=new Map(),queryResults=[]
  for(const condition of ['baseline','episode','lesson','full']) {
    const source=conditions[condition]
    if(condition!=='baseline') {
      source.prepare("UPDATE memory_evolution_settings SET mode='active',generation=generation+1").run()
      source.prepare("UPDATE memory_derivations SET state=CASE WHEN ?='episode' AND kind<>'episode' OR ?='lesson' AND kind='episode' THEN 'held' ELSE 'ready' END").run(condition,condition)
      if(condition!=='full')source.prepare('DELETE FROM memory_episode_entries').run()
    }
    for(const split of ['development','heldout']) {
      const measured=measureDatabase(source),db=measured.database
      const stats={condition,split,queries:0,recallHits:0,recallSum:0,recallQueries:0,reciprocalRankSum:0,reciprocalRankAt5Sum:0,exactCount:0,exactHits:0,exactRegressions:0,duplicateChars:0,injectionChars:0,injectionBytes:0,injectedItems:0,falseInjections:0,scopeLeaks:0,staleInjections:0,searchMs:0}
      for(const s of scenarios.filter(s=>s.split===split))for(const q of s.queries) {
        const vector=await embed(q.text),semantic={semantic:{backend,query:{profileId:profile.profileId,dimensions:config.embedding.dimensions,vector,vectorHash:hashVector(vector),backendId:backend.id,distanceCeiling:config.distanceCeiling??0.5}}}
        const relevant=entry=>{
          const r=entry.provenance.runId
          return q.relevantScenarioIds.includes(runScenario.get(r))&&runVersion.get(r)===s.anchors.version
        }
        // Ground truth is the whole eligible corpus, not just retrieved candidates.
        const relevantIds=new Set(source.prepare('SELECT id FROM entries WHERE workspace=?').all(s.workspace).map(row=>readEntry(source,{workspace:s.workspace,entryId:row.id})).filter(entry=>isRetrievableEntry(source,entry)&&relevant(entry)).map(entry=>entry.id))
        const before=counters.llmCalls,start=performance.now()
        const hits=hybridSearch(db,{workspace:s.workspace,query:q.text,limit:5},semantic)
        const metric=retrievalMetrics(hits,relevantIds,5)
        stats.queries++;stats.recallHits+=metric.hitAtK
        if(metric.recallAtK!==null){stats.recallSum+=metric.recallAtK;stats.recallQueries++}
        stats.reciprocalRankSum+=metric.reciprocalRank;stats.reciprocalRankAt5Sum+=metric.reciprocalRankAtK
        if(q.exact){
          stats.exactCount++;stats.exactHits+=metric.hitAtK
          const rank=metric.exactRank??Infinity,key=JSON.stringify([s.id,q.text])
          if(condition==='baseline')exactRanks.set(key,rank)
          if(condition==='full'&&s.split==='heldout'&&rank>(exactRanks.get(key)??Infinity)) stats.exactRegressions++
        }
        const result=await queryScopedContextGated(db,{project:{workspace:s.workspace,repositoryId:s.workspace,repositoryRoot:root,source:'local-path'},task:q.text,taskProfile:{taskType:'debug',target:s.anchors.target,expected:s.goal,constraints:null},limit:20,characterBudget:8000},candidate=>({persist:false,value:candidate}),semantic)
        const sources=await buildDshMessageSources({task:q.text,intakeStatus:'ready',nextAction:'proceed',memoryPolicy:{memoryReasoningRequired:false,contextWithheld:false},context:result.value})
        const supplied=sources.filter(item=>item.kind==='memory')
        const counts=new Map()
        for(const item of result.value.items) {
          const entry=readEntry(db,{workspace:s.workspace,entryId:item.entryId})
          if(entry.workspace!==s.workspace)stats.scopeLeaks++
          const text=supplied.find(source=>source.name===`memory:${item.entryId}`)?.text
          if(text===undefined)continue
          const origin=entry.provenance.runId,size=Array.from(text).length
          stats.injectionChars+=size
          stats.injectionBytes+=Buffer.byteLength(text);stats.injectedItems++;stats.falseInjections+=Number(!relevant(entry))
          if((counts.get(origin)??0)>=2)stats.duplicateChars+=size
          counts.set(origin,(counts.get(origin)??0)+1)
        }
        stats.searchMs+=performance.now()-start
        queryResults.push({condition,split,queryDigest:hash(q.text),...metric,packedIds:result.value.items.map(item=>item.entryId),suppliedIds:supplied.map(item=>item.name.slice(7)),modelRequest:'unmeasured'})
        assert.equal(counters.llmCalls,before,'Retrieval must not call an LLM')
      }
      metrics.push({...stats,...measured.counters,hitRateAt5:stats.recallHits/stats.queries,recallAt5:stats.recallQueries===0?null:stats.recallSum/stats.recallQueries,mrr:stats.reciprocalRankSum/stats.queries,mrrAt5:stats.reciprocalRankAt5Sum/stats.queries,exactHitRateAt5:stats.exactCount===0?null:stats.exactHits/stats.exactCount,falseInjectionRate:stats.injectedItems===0?null:stats.falseInjections/stats.injectedItems})
    }
  }
  const evolutionBeforeInvalidation=evolutionStatus(evolved,'project:evolution-evaluation')
  // Re-check actual retrieval after invalidation, using the same real query vector.
  const roots=evolved.prepare("SELECT DISTINCT e.id FROM entries e JOIN dsh_memory_finalization_entries l ON l.entry_id=e.id").all()
  const rootIds=new Set(roots.map(r=>r.id))
  const invalidated=new Set(evolved.prepare('SELECT entry_id,manifest_json FROM memory_derivations').all().filter(row=>JSON.parse(row.manifest_json).some(e=>e.sources.some(source=>rootIds.has(source.entryId)))).map(row=>row.entry_id))
  for(const row of roots) {
    const workspace=evolved.prepare('SELECT workspace FROM entries WHERE id=?').get(row.id).workspace
    const entry=readEntry(evolved,{workspace,entryId:row.id})
    updateCandidateEntry(evolved,{workspace,entryId:entry.id,expectedRevision:entry.revision,kind:entry.kind,title:entry.title,body:entry.body+' Source revised for invalidation evaluation.',summary:entry.summary,scope:entry.scope,provenance:entry.provenance,tags:entry.tags,now:'2026-09-10T00:00:01.000Z'})
  }
  let staleInjections=0
  for(const s of scenarios) {
    const vector=await embed(s.queries[0].text)
    const result=await queryScopedContextGated(evolved,{project:{workspace:s.workspace,repositoryId:s.workspace,repositoryRoot:root,source:'local-path'},task:s.queries[0].text,taskProfile:{taskType:'debug',target:s.anchors.target,expected:s.goal,constraints:null},limit:20,characterBudget:8000},candidate=>({persist:false,value:candidate}),{semantic:{backend,query:{profileId:profile.profileId,dimensions:config.embedding.dimensions,vector,vectorHash:hashVector(vector),backendId:backend.id,distanceCeiling:config.distanceCeiling??0.5}}})
    staleInjections+=result.value.items.filter(i=>invalidated.has(i.entryId)).length
  }
  const artifactText=JSON.stringify(artifacts,null,2)+'\n',artifactHash=hash(artifactText)
  await writeFile(path.join(output,'candidates.json'),artifactText)
  const reviewPath=option('--review'),review=reviewPath?JSON.parse(await readFile(reviewPath,'utf8')):null
  const semanticSafetyReviewed=review?.artifactHash===artifactHash&&review?.fixtureHash===manifest.sha256&&review?.reviewedEntries===artifacts.length&&review?.unsupportedSuccessClaims===0
  const base=metrics.find(m=>m.condition==='baseline'&&m.split==='heldout'),full=metrics.find(m=>m.condition==='full'&&m.split==='heldout')
  const reduction=base.duplicateChars===0?null:1-full.duplicateChars/base.duplicateChars
  const gates={hitRateAt5:full.hitRateAt5-base.hitRateAt5>=0.05,exact:full.exactRegressions===0,duplicateChars:reduction!==null&&reduction>=0.3,scope:metrics.every(m=>m.scopeLeaks===0),stale:staleInjections===0,semanticSafetyReviewed}
  const report={status:'measured',fixture:manifest,models:{llm:{model:config.llm.model,revision:config.llm.revision},embedding:{model:config.embedding.model,revision:config.embedding.revision}},settings:{characterBudget:8000,distanceCeiling:config.distanceCeiling??0.5,maxDailyExtraCalls:8},metrics,counters,duplicateCharacterReduction:reduction,staleInjections,artifactHash,gates,eligibleForActive:Object.values(gates).every(Boolean),evolution:evolutionBeforeInvalidation,notes:['Candidate text requires human review; a valid reference does not prove entailment.','The production UTC-day call cap is retained, including failed calls.','Model revision is operator-attested; the provider response model is checked exactly.']}
  Object.assign(report,{reportVersion:REPORT_VERSION,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),nodeVersion:process.version,dshVersion:process.env.KIOKUKO_EXPECTED_DSH_VERSION??'unmeasured',queryResults,pairedTaskQuality:{status:'unmeasured',reason:'This runner measures retrieval; native model requests and paired task outcomes require the lifecycle evaluation.'},skipped:0})
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n')
  process.stdout.write(JSON.stringify(report,null,2)+'\n')
} finally {for(const db of databases)db.close();await rm(root,{recursive:true,force:true})}
