// node --import tsx scripts/verify-correction-product-pair.ts MAIN_PACKAGE ABSOLUTE_RUSTC
// Two independent fixture databases exercise the same source identity. This does
// not connect production stores or measure language quality of a real model.
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {nativeSkillFixture} from '../tests/dsh/helpers/skill-native.js'
import {nativeToolResults} from '../tests/dsh/helpers/native-mock.js'
import {codingPrelude,toolValue} from '../tests/dsh/helpers/coding-script.js'
import {withIsolatedSkillHome} from '../tests/dsh/helpers/skill-home.js'
import {openConnection} from '../src/db/connection.js'
import {recordEntry} from '../src/memory/entries.js'
import {correctionDecisionFixture} from '../tests/dsh/helpers/correction-decisions.js'

assert.ok(process.argv[2]&&process.argv[3],'Pass the built Kiokuko package and an installed absolute rustc')
const main=realpathSync(resolve(process.argv[2]!)),rustc=realpathSync(process.argv[3]!)
assert.equal(JSON.parse(await readFile(join(main,'package.json'),'utf8')).name,'kiokuko')
const load=(file:string)=>import(pathToFileURL(join(main,file)).href)
const requireMain=createRequire(join(main,'package.json'))
const [{Client},{StdioClientTransport},{initializeDatabase},{openConnection:openMain},{recordEntry:recordMain},{buildStructuredScope}]=await Promise.all([
  import(pathToFileURL(requireMain.resolve('@modelcontextprotocol/sdk/client/index.js')).href),import(pathToFileURL(requireMain.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href),
  load('dist/commands/init.js'),load('dist/db/connection.js'),load('dist/memory/entries.js'),load('dist/memory/structured-memory.js'),
])
const compiler=execFileSync(rustc,['--version'],{encoding:'utf8'}).trim()
assert.match(compiler,/^rustc \d+\.\d+\.\d+ /)
assert.ok(!compiler.startsWith('rustc 1.85.0 '),'A distinct capable compiler is needed to reproduce the original version-only rejection')
const data=realpathSync(await mkdtemp(join(tmpdir(),'correction-product-pair-'))),databasePath=join(data,'kiokuko.sqlite3')
await initializeDatabase({databasePath});const mainDb=openMain(databasePath)
const content={workspace:'global',kind:'lesson' as const,title:'Rust compiler compatibility',body:'Do not reject Rust compiler compatibility only because versions differ. Verify actual compiler capabilities.',
  summary:'Verify compiler capabilities instead of arbitrary version-only rejection.',tags:['subject:rust'],scope:buildStructuredScope({visibility:'global',retrievalScope:'global',portableReason:'Compiler capability checks apply across projects.'}),
  provenance:{type:'interaction_capture',reference:'user_correction'},createdBy:'fixture'}
const source=recordMain(mainDb,content),client=new Client({name:'correction-pair',version:'1'})
const transport=new StdioClientTransport({command:process.execPath,args:[join(main,'dist/bin/kiokuko.js'),'mcp','--profile','chatgpt-memory'],env:{PATH:process.env.PATH??'',KIOKUKO_DATA_DIR:data},stderr:'pipe'})
const records:unknown[]=[]
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`
try{
  await client.connect(transport);await client.listTools()
  const policyResult=(await client.callTool({name:'memory_policy',arguments:{}})).structuredContent
  const policy={version:policyResult.policyVersion,digest:policyResult.policyDigest,read:true}
  const recalled=await client.callTool({name:'memory_recall',arguments:{policy,query:'Rust compiler compatibility',subjects:['rust']}})
  assert.notEqual(recalled.isError,true);const remote=recalled.structuredContent
  assert.equal(remote.corrections.retrieval,'retrieved');assert.equal(remote.corrections.modelInput,'unobserved')
  const remoteSource=remote.corrections.sources.find((item:any)=>item.entryId===source.id);assert.ok(remoteSource)
  const badDecision={kind:'compatibility',target:'scripts/check.mjs',basis:'version_only',requiredVersion:'1.85.0',observedVersion:compiler.split(' ')[1]}
  const unbound=(await client.callTool({name:'memory_correction_check',arguments:{policy,decision:badDecision}})).structuredContent
  assert.equal(unbound.retrieval,'retrieved');assert.equal(unbound.binding,'missing');assert.deepEqual(unbound.sources,[])
  const reviewed=(await client.callTool({name:'memory_correction_check',arguments:{policy,recallId:remote.corrections.recallId,decision:badDecision}})).structuredContent
  assert.equal(reviewed.binding,'bound')
  assert.equal(remoteSource.rule,'uncertain','standalone MCP has no implicitly configured semantic provider')
  assert.equal(reviewed.state,'unverified');assert.equal(reviewed.verification,'unverified');assert.equal(reviewed.modelInput,'unobserved')
  await withIsolatedSkillHome(async()=>{
    for(const explicit of [false,true])for(const drop of [false,true]){
      let questions=0
      const semantic=await correctionDecisionFixture(content.body)
      const packages=process.env.KIOKUKO_DSH_PACKAGE_ROOT??join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules'),packageRoot=process.env.KIOKUKO_SKILL_PACKAGE_ROOT
      const f=await nativeSkillFixture({packages,...(packageRoot?{packageRoot}:{}),explicit,extra:{lisp:{enabled:false},typedDecisions:semantic.configuration,answerReview:{mode:'off'},memoryReview:{mode:'off'},memoryEvolution:{mode:'off'},memoryIndexReasoning:{mode:'off'},deepPlanning:{enabled:false},modelAutoMode:{mode:'off'}},nativeAnswer:async request=>{
        const q=request.questions[0];if(q.id.startsWith('correction-')){questions++;return {answers:[{id:q.id,selected:['見直す']}]}}
        return {answers:[{id:q.id,selected:['使わない']}]}
      }})
      const db=openConnection(join(f.dir,explicit?'state.sqlite3':'kiokuko-dsh.sqlite3'))
      const off=drop?(f.ctx.on as any)('agent/pre-step',async(_:unknown,next:()=>Promise<any>)=>{
        const result=await next();return result?.kind==='enter'?{...result,messages:result.messages.filter((m:any)=>!m.source?.sections?.some((s:any)=>s.name===`memory:memory:${source.id}`))}:result
      },{prepend:true}):()=>{}
      try{
        recordEntry(db,content,{idFactory:()=>source.id});await mkdir(join(f.dir,'scripts'))
        await writeFile(join(f.dir,'capability.rs'),'fn main() { let values = [2, 4, 6]; assert_eq!(values.into_iter().sum::<i32>(), 12); println!("capability-confirmed"); }\n')
        const command=`${quote(rustc)} --edition=2024 ${quote(join(f.dir,'capability.rs'))} -o ${quote(join(f.dir,'capability'))} && ${quote(join(f.dir,'capability'))}`
        const result=(request:any,id:string)=>nativeToolResults(request.messages).find((r:any)=>r.toolCallId===id)
        f.responses.push(...codingPrelude(f.mock,'pair'),f.mock.toolCallResponse('actual-capability','kioku_exec',{command,timeoutMs:30000}),
          (request:any)=>{assert.equal(result(request,'actual-capability')?.isError,false);assert.match(JSON.stringify(result(request,'actual-capability')),/capability-confirmed/)
            const delivered=request.messages.some((m:any)=>m.source?.sections?.some((s:any)=>s.name===`memory:memory:${source.id}`&&s.text.includes('compiler capabilities')))
            assert.equal(delivered,!drop,'inspect the final provider request, not an injection claim')
            return f.mock.toolCallResponse('bad-write','kioku_write',{path:'scripts/check.mjs',content:'assert.match(compiler.stdout, /^rustc 1\\.85\\.0 /)\n'})},
          (request:any)=>{assert.equal(result(request,'bad-write')?.isError,true);return f.mock.toolCallResponse('capable-write','kioku_write',{path:'scripts/check.mjs',content:'export const capabilityAccepted = true\n'})},
          (request:any)=>{assert.equal(result(request,'capable-write')?.isError,false);return f.mock.toolCallResponse('inspect-correction','correction_check',{decision:{...badDecision,basis:'capability'}})},
          (request:any)=>{const checked=toolValue(request,'inspect-correction');assert.equal(checked.delivery,drop?'not_delivered':'delivered');assert.equal(checked.verification,'unverified');return f.mock.textResponse('Actual compiler capability passed and the capability-based write succeeded.')})
        await f.turn('Verify Rust compiler capabilities and fix scripts/check.mjs. 通常実行で。')
        assert.equal(await readFile(join(f.dir,'scripts/check.mjs'),'utf8'),'export const capabilityAccepted = true\n');assert.equal(questions,1)
        const observations=db.prepare("SELECT payload_json FROM ledger_events WHERE event_type='correction.recorded'").all<{payload_json:string}>().map(r=>JSON.parse(r.payload_json))
        const bound=observations.flatMap(e=>e.sources).find(s=>s.entryId===source.id)
        const identity=({entryId,revision,workspace,origin,sourceDigest}:any)=>({entryId,revision,workspace,origin,sourceDigest})
        assert.deepEqual(identity(bound),identity(remoteSource),'both actual product entries bind the identical correction evidence, independently of classifier availability')
        assert.equal(bound.rule,'capability_compatibility');assert.equal(semantic.calls(),1)
        assert.ok(observations.some(e=>e.state===(drop?'handoff_missing':'contradiction')&&e.allowed===false))
        assert.equal(db.prepare('SELECT count(*) AS n FROM entries').get()?.n,1)
        records.push({entry:explicit?'adapter':'public',inputRemoved:drop,actualCapabilityPassed:true,versionOnlyWriteRejected:true,capabilityWriteAccepted:true,source:bound})
      }finally{off();db.close();await f.close();await semantic.close()}
    }
  })
  console.log(JSON.stringify({schema:'correction-product-pair-v1',status:'passed',compiler,model:'scripted',realModelEfficacy:'not_measured',mainModelInput:'unobserved',cases:records}))
}finally{await client.close();mainDb.close();await rm(data,{recursive:true,force:true})}
