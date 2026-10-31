import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openConnection } from '../../../../src/db/connection.js'
import { mountLispSurface as sourceLispSurface } from '../../../../src/dsh/lisp/surface.js'
import { mountOwnedExecution as sourceOwnedExecution } from '../../../../src/dsh/owned-execution.js'
import { OnDemandIntake as SourceOnDemandIntake } from '../../../../src/dsh/on-demand-intake.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { workingLispTask } from '../../helpers/lisp-task.js'
import { executeNativeTool, mountNativeTools } from '../../helpers/native-tools.js'

const artifact = process.env.KIOKUKO_OWNED_PACKAGE_ROOT
const mountLispSurface:typeof sourceLispSurface = artifact ? (await import(pathToFileURL(join(artifact,'dist/dsh/lisp/surface.js')).href)).mountLispSurface : sourceLispSurface
const mountOwnedExecution:typeof sourceOwnedExecution = artifact ? (await import(pathToFileURL(join(artifact,'dist/dsh/owned-execution.js')).href)).mountOwnedExecution : sourceOwnedExecution
const OnDemandIntake:typeof SourceOnDemandIntake = artifact ? (await import(pathToFileURL(join(artifact,'dist/dsh/on-demand-intake.js')).href)).OnDemandIntake : SourceOnDemandIntake
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
test('pre-dispatch intake denial preserves Lisp state while dispatched failure remains unknown', {
  skip: !packages || process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires native DSH and actual SBCL' : false,
  timeout: 90000,
}, async () => {
  const [cordis, prompt, tools, scope, sessions] = await Promise.all(
    ['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope', 'dsh-session']
      .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)),
  )
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-admission-'))), root = join(base, 'project')
  await mkdir(root); execFileSync('git', ['init', '-q', root])
  const db = openConnection(join(base, 'state.sqlite3'))
  const session = sessions.Session.create('admission', [], {version:4,id:'admission',createdAt:Date.now(),isSeeded:false,cwd:root})
  session.append('turn/start', {turn:1})
  const agent: any = {id:'admission-agent',session}, owner = {sessionId:session.id,agentId:agent.id,root}
  const task = workingLispTask(db, owner)
  const runtime: any = {executionJournalDirectory:join(base,'journal'),withDatabase:async(fn:any)=>fn(db)}
  const ctx = new cordis.Context(), fibers: any[] = [], commands = new Map<string,any>()
  let local: any, surface: any, intake: SourceOnDemandIntake | undefined, unmountOwned: (()=>Promise<void>) | undefined
  let ready = false, preparations = 0, calls = 0
  const signal = new AbortController().signal
  const execute = (name:string,args:object) => executeNativeTool(ctx,packages!,{name,arguments:args,agent,callId:'admission-'+(++calls),signal})
  const evaluate = async (code:string) => {
    const result = await execute('lisp_eval',{operationId:'evaluation-'+calls,code})
    assert.equal(result.isError,false,JSON.stringify(result))
    return result.value
  }
  try {
    fibers.push(await ctx.plugin(prompt.default,{})); await mountNativeTools(ctx,tools,packages!,fibers)
    fibers.push(await ctx.plugin({name:'admission-services',apply(c:any){
      c.provide('agents',{get:(id:string)=>id===agent.id?agent:undefined})
      c.provide('sessions',{get:(id:string)=>id===session.id?session:undefined})
      c.provide('commands',{register:(d:any)=>{commands.set(d.name,d);return()=>commands.delete(d.name)}})
      c.provide('planMode',{get:()=>({active:false})})
    }}))
    local = scope.createScope(ctx,agent); agent.ctx=local.ctx
    intake = new OnDemandIntake({validate:async()=>{},nativeOwnership:async()=>'owned',existing:async()=>false,
      classify:async()=>({deferInference:true}),prepare:async()=>{preparations++;ready=true;return true},ready:()=>ready})
    intake.mount(ctx,ctx.tools)
    unmountOwned = mountOwnedExecution(ctx,{runtime,resolve:e=>e.agent===agent
      ?{runId:task.taskId,sessionId:session.id,repositoryRoot:root,workspace:db.prepare('SELECT workspace FROM ledger_runs WHERE run_id=?').get<{workspace:string}>(task.taskId)!.workspace,generation:'fixture-generation',agent}:undefined})
    surface = await mountLispSurface(ctx,runtime,LispConfig.parse({enabled:true,sbclPath:process.env.KIOKUKO_LISP_SBCL??'sbcl',startupTimeoutMs:60000}))
    const enabled = await commands.get('kioku-lisp').handler({rawInput:'enable',agent,signal})
    assert.equal(enabled.kind,'success',enabled.text)
    await intake.capture({agent,turn:1,step:0,messages:[{id:'current-human',role:'user',source:{kind:'user'},
      content:[{type:'text',text:'Continue the requested fixture work.'}]}],signal})
    const setup = await evaluate('(defparameter *kept-answer* 42)')
    assert.equal(setup.ok,true,JSON.stringify(setup))
    const before = await surface.manager.status(owner)
    for (let attempt=0;attempt<2;attempt++) {
      const rejected = await evaluate('(kioku.files:propose-write "result.txt" "requested content")')
      assert.equal(rejected.ok,false)
      assert.equal(rejected.state,'FAILED',JSON.stringify(rejected))
      assert.equal(rejected.changes[0].state,'NOT_APPLIED',JSON.stringify(rejected))
      assert.match(rejected.changes[0].message,/prepare_requested_work/)
      await assert.rejects(readFile(join(root,'result.txt')),{code:'ENOENT'})
      const status = await surface.manager.status(owner)
      assert.equal(status.state,'READY',JSON.stringify(status))
      assert.equal(status.generation,before.generation)
      assert.equal(status.runtimePid,before.runtimePid);assert.equal(status.supervisorPid,before.supervisorPid)
      const kept = await evaluate('*kept-answer*')
      assert.equal(kept.ok,true,JSON.stringify(kept)); assert.match(kept.value.printed,/42/)
    }
    assert.equal(preparations,0,'a denied effect must not auto-admit the request')
    assert.equal(db.prepare("SELECT count(*) n FROM dsh_owned_operations").get<any>()!.n,0)
    const prepared = await execute('prepare_requested_work',{taskType:'debug'})
    assert.equal(prepared.isError,false,JSON.stringify(prepared)); assert.equal(preparations,1)
    const applied = await evaluate('(kioku.files:propose-write "result.txt" "requested content")')
    assert.equal(applied.ok,true,JSON.stringify(applied))
    assert.equal(await readFile(join(root,'result.txt'),'utf8'),'requested content')
    assert.equal(applied.generation,setup.generation)
    // A dispatched body may have mutated files even when the returned text
    // resembles the earlier denial. No string or serialized flag proves non-execution.
    const remove = ctx.on('tools/execute',async(e:any,next:any)=>{
      const result=await next()
      if(e.name==='kioku_write')throw new Error('Before tool-backed work, call prepare_requested_work')
      return result
    },{global:true})
    try {
      const unknown = await evaluate('(kioku.files:propose-write "after-dispatch.txt" "effect happened")')
      assert.equal(unknown.ok,false); assert.equal(unknown.state,'UNKNOWN',JSON.stringify(unknown))
      assert.equal(unknown.changes[0].state,'UNKNOWN')
      assert.equal(await readFile(join(root,'after-dispatch.txt'),'utf8'),'effect happened')
      assert.equal((await surface.manager.status(owner)).state,'RECOVERY_REQUIRED')
      const store = new LispStore(async fn => fn(db))
      for (let i=0;i<110;i++) {
        const id='successful-history-'+i
        await store.reserve(owner,id,'lisp_eval','history-hash','history-generation',{})
        await store.transition(owner,id,['RUNNING'],'SUCCEEDED',{ok:true})
      }
      const raw = await commands.get('kioku-lisp').handler({rawInput:'status --json',agent,signal})
      const detail = JSON.parse(raw.text)
      assert.ok(detail.operations.some((o:any)=>o.id==='successful-history-109'&&o.state==='SUCCEEDED'),'detail retains successful history')
      const human = await commands.get('kioku-lisp').handler({rawInput:'status',agent,signal})
      assert.ok(!human.text.includes('successful-history-'),'normal status must not enumerate successful UUID history')
      assert.ok(human.text.split('\n').length<30,'normal status stays bounded')
      assert.ok(human.text.includes('/kioku-lisp diagnostics '+unknown.operationId),'show the exact unresolved operation, without replaying it')
      assert.doesNotMatch(human.text,/\/kioku-lisp status(?! --json)/,'plain status must not send the user back to plain status')
    } finally {remove()}
  } finally {
    await intake?.dispose();surface?.stop();await surface?.dispose();await unmountOwned?.();await local?.dispose()
    for(const fiber of fibers.reverse())await fiber.dispose()
    db.close();await rm(base,{recursive:true,force:true})
  }
})
