// Explicit live/synthetic evaluation only. No private correction memory is read.
import {parseArgs} from 'node:util'
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {TypedDecisionsConfig} from '../src/dsh/decisions/config.ts'
import {DecisionService} from '../src/dsh/decisions/service.ts'
import {TypeSafeDecisionProvider,NimbleDecisionProvider} from '../src/dsh/decisions/providers.ts'
import {LayaCoreMLDecisionProvider} from '../src/dsh/decisions/laya-coreml.ts'
import {LayaV1DecisionProvider} from '../src/dsh/decisions/laya-v1.ts'
import {correctionClassifier} from '../src/dsh/decisions/correction.ts'
import {classifyCorrection,correctionClassificationBatch} from '../src/memory/correction-classification.ts'
import {CORRECTION_POLICY_VERSION} from '../src/memory/correction-contract.ts'
import {recordEntry,updateCandidateEntry} from '../src/memory/entries.ts'
import {openConnection} from '../src/db/connection.ts'
import {migrateDatabase} from '../src/db/migrate.ts'
import {correctionEvaluation,originalCorrectionRegex} from './correction-evaluation.mjs'

const {values}=parseArgs({options:{live:{type:'boolean'},config:{type:'string'},split:{type:'string'},output:{type:'string'},prototype:{type:'boolean'},'prototype-only':{type:'boolean'}}})
if(!values.live||!values.config||!values.output||!['development','held-out'].includes(values.split)){console.error('Use --live --config PATH --split development|held-out --output PATH [--prototype]');process.exit(2)}
const config=TypedDecisionsConfig.parse(JSON.parse(readFileSync(values.config,'utf8')))
if(config.mode!=='auto')throw new Error('The selected provider must be enabled for this explicit synthetic benchmark')
let providerCalls=0
const service=new DecisionService(config,c=>{const provider=c.provider==='typesafe'?new TypeSafeDecisionProvider(c.typesafe,async()=>process.env.TYPESAFE_API_KEY)
  :c.provider==='nimble'?new NimbleDecisionProvider(c.nimble,async()=>c.nimble.credentialRef?process.env[c.nimble.credentialRef]:undefined)
  :c['laya-coreml']?.protocol==='v1'?new LayaV1DecisionProvider(c['laya-coreml']):new LayaCoreMLDecisionProvider(c['laya-coreml']);
  return {capabilities:provider.capabilities,...(provider.preflight?{preflight:(batch,signal)=>provider.preflight(batch,signal)}:{}),evaluate:(batch,signal)=>{providerCalls++;return provider.evaluate(batch,signal)}}})
const setup=await correctionClassifier(service);if(!setup.backend)throw new Error('Semantic backend is unavailable')
const corpusBytes=readFileSync(new URL('../tests/fixtures/correction-classification.json',import.meta.url)),corpus=JSON.parse(corpusBytes)
if(values['prototype-only']&&!values.prototype)throw new Error('--prototype-only requires --prototype')
const groups=values['prototype-only']?[]:values.split==='development'?corpus.development:corpus.heldOut
const root=mkdtempSync(path.join(tmpdir(),'correction-live-synthetic-')),db=openConnection(path.join(root,'state.sqlite3'));migrateDatabase(db)
const hash=x=>createHash('sha256').update(x).digest('hex'),rows=[]
const report={schema:'correction-live-evaluation-v1',mode:'live-synthetic',split:values.split,prototypeOnly:!!values['prototype-only'],sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),policy:CORRECTION_POLICY_VERSION,
  startedAt:new Date().toISOString(),nodeVersion:process.version,
  implementationSha256:Object.fromEntries(['src/memory/correction-contract.ts','src/memory/correction-classification.ts','src/dsh/decisions/correction.ts','src/dsh/decisions/contracts.ts','src/dsh/decisions/service.ts','src/dsh/decisions/providers.ts'].map(file=>[file,hash(readFileSync(new URL('../'+file,import.meta.url)))])),
  corpusSha256:hash(corpusBytes),batchContractSha256:hash(JSON.stringify(correctionClassificationBatch({title:'<title>',body:'<body>',summary:'<summary>'}))),
  baselineSourceSha:'01e27576d2efe5020c19e93bdba1a6528bfcaee1',provider:config.provider,configuredModel:config[config.provider]?.model??null,
  acceptance:config[config.provider]?.acceptance??null,distinctSemanticFamilies:groups.length,limitations:corpus.limitations,rows,metrics:null,prototype:null}
function create(group,language,suffix=''){
  return recordEntry(db,{workspace:'global',kind:'lesson',title:`Synthetic correction${suffix}`,body:group.texts[language],summary:group.summaries?.[language]??null,
    provenance:{type:'interaction_capture',reference:'user_correction'},createdBy:'synthetic-benchmark'})
}
try{
  // Deterministic interleaving; every semantic input has one real provider call.
  for(const language of corpus.languages)for(const group of groups){
    const entry=create(group,language),start=performance.now(),before=providerCalls,result=await classifyCorrection(db,entry,setup.backend,AbortSignal.timeout(7000))
    rows.push({id:group.id,language,category:group.category,gold:group.gold,state:result.state,actual:result.rule,reason:result.reason,
      elapsedMs:performance.now()-start,providerCalls:providerCalls-before,inputTokens:result.inputTokens??null,outputTokens:result.outputTokens??null,inputDigest:result.inputDigest,
      provider:result.provider??null,requestedModel:result.requestedModel??null,returnedModel:result.returnedModel??null,providerRevision:result.providerRevision??null,attested:result.attested,baseline:originalCorrectionRegex(entry)})
    writeFileSync(values.output,JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify({split:values.split,completed:rows.length,total:groups.length*corpus.languages.length,id:group.id,language,state:result.state,rule:result.rule}))
  }
  if(!values['prototype-only'])report.metrics=correctionEvaluation(rows)
  if(values.prototype){
    let calls=0;const backend={...setup.backend,evaluate:async(...args)=>{calls++;return setup.backend.evaluate(...args)}}
    const group=corpus.development[0],begin=performance.now(),capture=create(group,'en','-capture'),captureWriteMs=performance.now()-begin
    const a=performance.now(),captured=await classifyCorrection(db,capture,backend,AbortSignal.timeout(7000)),captureInferenceMs=performance.now()-a,captureMs=performance.now()-begin
    const b=performance.now(),lazy=create(group,'en','-first-use'),firstUseCaptureMs=performance.now()-b
    const c=performance.now(),first=await classifyCorrection(db,lazy,backend,AbortSignal.timeout(7000)),firstUseLookupMs=performance.now()-c
    const before=calls,d=performance.now();for(let i=0;i<20;i++)await classifyCorrection(db,lazy,backend,AbortSignal.timeout(7000));const cachedLookupMs=(performance.now()-d)/20,repeatedProviderCalls=calls-before
    const changed=updateCandidateEntry(db,{...lazy,entryId:lazy.id,expectedRevision:lazy.revision,summary:'Updated synthetic summary',createdBy:'synthetic-benchmark'})
    const e=performance.now();await classifyCorrection(db,changed,backend,AbortSignal.timeout(7000))
    const changedElapsedMs=performance.now()-e,oldObjectState=(await classifyCorrection(db,lazy,backend,AbortSignal.timeout(7000))).state
    report.prototype={capture:{writeMs:captureWriteMs,totalMs:captureMs,inferenceMs:captureInferenceMs,inputTokens:captured.inputTokens??null},
      firstUse:{captureMs:firstUseCaptureMs,coldLookupMs:firstUseLookupMs,cachedLookupMeanMs:cachedLookupMs,repeatedLookups:20,repeatedProviderCalls,inputTokens:first.inputTokens??null},
      changedEntry:{providerCalls:calls-before,elapsedMs:changedElapsedMs,oldObjectState},selection:'first-use with durable content/revision/policy/configuration cache',rationale:'Capture does not wait for inference; unused corrections cause no model calls. First use pays one inference; unchanged repeated use pays cache I/O. A changed entry is reclassified.'}
  }
  writeFileSync(values.output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({metrics:report.metrics,prototype:report.prototype}))
}finally{db.close();rmSync(root,{recursive:true,force:true})}
