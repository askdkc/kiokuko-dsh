// Synthetic live provider -> main Kiokuko capture/cache -> real MCP wire -> safe shadow check.
import assert from 'node:assert/strict'
import {readFile,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
import {TypedDecisionsConfig} from '../src/dsh/decisions/config.js'
import {DecisionService} from '../src/dsh/decisions/service.js'
import {TypeSafeDecisionProvider,NimbleDecisionProvider} from '../src/dsh/decisions/providers.js'
import {LayaCoreMLDecisionProvider} from '../src/dsh/decisions/laya-coreml.js'
import {LayaV1DecisionProvider} from '../src/dsh/decisions/laya-v1.js'
import {correctionClassifier} from '../src/dsh/decisions/correction.js'
assert.ok(process.argv[2]&&process.argv[3]&&process.argv[4],'Pass MAIN_REPOSITORY CONFIG OUTPUT')
const main=resolve(process.argv[2]!),load=(file:string)=>import(pathToFileURL(join(main,file)).href),requireMain=createRequire(join(main,'package.json'))
const [{Client},{InMemoryTransport},{initializeDatabase},{openConnection},{captureInteractionMemory},{createCorrectionEnrichment},{ChatgptRuntimeOwner},{createChatgptMemoryServer}]=await Promise.all([
  import(pathToFileURL(requireMain.resolve('@modelcontextprotocol/sdk/client/index.js')).href),import(pathToFileURL(requireMain.resolve('@modelcontextprotocol/sdk/inMemory.js')).href),
  load('src/commands/init.ts'),load('src/db/connection.ts'),load('src/memory/interaction-capture.ts'),load('src/memory/correction-classification.ts'),load('src/mcp/chatgpt-runtime.ts'),load('src/mcp/chatgpt-server.ts')])
const configuration=TypedDecisionsConfig.parse(JSON.parse(await readFile(process.argv[3]!,'utf8')))
assert.equal(configuration.mode,'auto');let calls=0
const service=new DecisionService(configuration,c=>{const provider=c.provider==='typesafe'?new TypeSafeDecisionProvider(c.typesafe,async()=>process.env.TYPESAFE_API_KEY!)
  :c.provider==='nimble'?new NimbleDecisionProvider(c.nimble,async()=>c.nimble.credentialRef?process.env[c.nimble.credentialRef]:undefined)
  :c['laya-coreml']?.protocol==='v1'?new LayaV1DecisionProvider(c['laya-coreml']):new LayaCoreMLDecisionProvider(c['laya-coreml']);return {capabilities:provider.capabilities,
    ...(provider.preflight?{preflight:(batch,signal)=>provider.preflight(batch,signal)}:{}),evaluate:async(batch,signal)=>{calls++;return provider.evaluate(batch,signal)}}})
const backend=(await correctionClassifier(service)).backend;assert.ok(backend)
const root=await mkdtemp(join(tmpdir(),'correction-live-mcp-')),databasePath=join(root,'memory.sqlite3');await initializeDatabase({databasePath})
const db=openConnection(databasePath),owner=new ChatgptRuntimeOwner(databasePath),enrichment=createCorrectionEnrichment({withDatabase:async(fn:any)=>fn(db)},backend,'shadow')
const server=createChatgptMemoryServer(owner,{correctionClassifier:enrichment}),client=new Client({name:'synthetic-correction-live',version:'1'}),[c,s]=InMemoryTransport.createLinkedPair()
try{
  const corpus=JSON.parse(await readFile(new URL('../tests/fixtures/correction-classification.json',import.meta.url),'utf8'))
  await captureInteractionMemory(db,{operationId:'synthetic-live-correction',memories:corpus.development.slice(0,2).map((group:any,index:number)=>({kind:'lesson',scope:'global',basis:'user_correction',
    title:`Synthetic compiler note ${index+1}`,body:group.texts.en,subjects:['synthetic-compiler'],portableReason:'Synthetic cross-project evaluation only'}))},{cwd:root,clientKind:'chatgpt-memory',enabled:true})
  await server.connect(s);await client.connect(c);await client.listTools()
  const policyResult:any=(await client.callTool({name:'memory_policy',arguments:{}})).structuredContent,policy={version:policyResult.policyVersion,digest:policyResult.policyDigest,read:true}
  const recall=async()=>{const result=await client.callTool({name:'memory_recall',arguments:{policy,query:'compiler',subjects:['synthetic-compiler']}});assert.notEqual(result.isError,true);return result.structuredContent as any}
  const result=await recall(),sources=result.corrections.sources
  assert.equal(sources.length,2);assert.ok(sources.some((x:any)=>x.classification.rule==='capability_compatibility'));assert.ok(sources.some((x:any)=>x.classification.rule==='reference'))
  assert.ok(sources.every((x:any)=>x.rule==='uncertain'&&x.classification.mode==='shadow'))
  const checked:any=(await client.callTool({name:'memory_correction_check',arguments:{policy,recallId:result.corrections.recallId,decision:{kind:'compatibility',target:'check.mjs',basis:'version_only',requiredVersion:'1.85',observedVersion:'1.99'}}})).structuredContent
  assert.equal(checked.state,'unverified');assert.equal(checked.verification,'unverified');assert.equal(checked.modelInput,'unobserved');assert.equal(checked.authorizationGranted,false)
  const firstCalls=calls;await recall();assert.equal(calls,firstCalls)
  const report={schema:'correction-live-mcp-v1',status:'passed',dshSourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    mainSourceSha:execFileSync('git',['rev-parse','HEAD'],{cwd:main,encoding:'utf8'}).trim(),provider:configuration.provider,model:configuration[configuration.provider]?.model,
    syntheticEntries:2,providerCalls:firstCalls,repeatProviderCalls:calls-firstCalls,cachedResults:db.prepare('SELECT count(*) AS n FROM correction_classifications').get()?.n,
    observedRules:sources.map((x:any)=>({rule:x.rule,observed:x.classification.rule,model:x.classification.returnedModel,mode:x.classification.mode,inputTokens:x.classification.inputTokens})),
    modelInput:checked.modelInput,verification:checked.verification,authorizationGranted:checked.authorizationGranted,qualityMeasurement:'separate held-out corpus, not these two handoff cases'}
  await writeFile(process.argv[4]!,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}finally{await client.close();await server.close();await owner.close();db.close();await rm(root,{recursive:true,force:true})}
