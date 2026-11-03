import assert from 'node:assert/strict'
import test from 'node:test'
import {DatabaseSync} from 'node:sqlite'
import {mkdtemp,mkdir,realpath,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {NodeSqliteAdapter} from '../../../../src/db/adapter.js'
import {migrateDatabase} from '../../../../src/db/migrate.js'
import {LispManager} from '../../../../src/dsh/lisp/manager.js'
import {LispStore} from '../../../../src/dsh/lisp/store.js'
import {LispConfig,type LispOwner} from '../../../../src/dsh/lisp/contracts.js'
import {LispWorker} from '../../../../src/dsh/lisp/worker.js'
import {CompiledLispCache} from '../../../../src/dsh/lisp/compiled-cache.js'
import {workingLispTask} from '../../helpers/lisp-task.js'
import {captureTaskLease} from '../../../../src/dsh/task-state.js'
import {withTaskAuthority} from '../../../../src/dsh/task-authority-context.js'

// These are manager/transport policy tests, not execution of Lisp or an OS sandbox.
async function fixture(t:test.TestContext,mode:'development'|'protected'='protected') {
 const base=await realpath(await mkdtemp(join(tmpdir(),'lisp-composition-'))),root=join(base,'workspace')
 await mkdir(root);await mkdir(join(root,'.git'));await mkdir(join(base,'runtime'))
 const db=new NodeSqliteAdapter(':memory:',new DatabaseSync(':memory:'));migrateDatabase(db)
 const store=new LispStore(async fn=>fn(db)),owner={sessionId:'parent',agentId:'parent',root}
 const starts:LispWorker[]=[],requests:Array<{worker:LispWorker;method:string;args:Record<string,unknown>;rpc:boolean}>=[],stopped=new WeakSet<LispWorker>()
 let answer:unknown=42
 t.mock.method(CompiledLispCache.prototype,'ensure',async()=>({key:'transport-fixture',path:base,reused:true,prepareMs:0}))
 t.mock.method(LispWorker.prototype,'start',async function(this:LispWorker){this.repositoryRoot=this.layout.workspace??null;starts.push(this)})
 t.mock.getter(LispWorker.prototype,'healthy',function(this:LispWorker){return!stopped.has(this)})
 t.mock.getter(LispWorker.prototype,'stopped',function(this:LispWorker){return stopped.has(this)})
 t.mock.method(LispWorker.prototype,'stop',async function(this:LispWorker){stopped.add(this)})
 t.mock.method(LispWorker.prototype,'request',async function(this:LispWorker,method:string,args:Record<string,unknown>,_timeout:number,signal?:AbortSignal,rpc=true){
  signal?.throwIfAborted();requests.push({worker:this,method,args,rpc})
  if(method==='task')await writeFile(join(String(args.scratch??this.layout.scratch),'task-result.json'),JSON.stringify(answer))
  return {version:1,type:'result',id:'transport-result',ok:true,value:method==='eval'?{printed:'fixture',json:null}:null,proposals:[]}
 })
 const options={store,dataRoot:join(base,'runtime'),config:LispConfig.parse({enabled:true,executionMode:mode}),questions:{ask:async(request:any)=>({answers:[{id:request.questions[0].id,selected:[request.questions[0].intent.approve]}] as const})}}
 let manager=new LispManager(options);await manager.start()
 t.after(async()=>{await manager.dispose();db.close();await rm(base,{recursive:true,force:true})})
 return{base,root,owner,db,store,starts,requests,stopped,get manager(){return manager},set answer(value:unknown){answer=value},async restart(){await manager.dispose();manager=new LispManager(options);await manager.start()}}
}
const definition={name:'add-one',description:'A reusable task function',source:'(lambda (input) (+ input 1))',inputSchema:{type:'integer'},outputSchema:{type:'integer'}}

test('session workers retain separate runtimes, coalesce admission and restore their mode after host restart',async t=>{
 const f=await fixture(t,'development'),a={...f.owner,sessionId:'a',agentId:'a'},b={...f.owner,sessionId:'b',agentId:'b'}
 await f.manager.enable(f.owner)
 await f.manager.enableTask(a)
 const [first,repeated,second]=await Promise.all([f.manager.enableSessionWorker(a),f.manager.enableSessionWorker(a),f.manager.enableSessionWorker(b)]) as any[]
 assert.equal(first.state,'READY');assert.equal(first.generation,repeated.generation);assert.notEqual(first.generation,second.generation)
 assert.equal(await f.manager.isTaskMode(a),false,'Existing disposable child sessions are promoted without erasing their journal')
 assert.equal(f.starts.length,3)
 for(const worker of f.starts.slice(1)){assert.equal(worker.layout.workspace,undefined);assert.equal(worker.layout.protected,true)}
 await f.manager.enableSessionWorker(a);assert.equal(f.starts.length,3)
 await f.manager.disposeSession(a.sessionId)
 assert.equal(f.stopped.has(f.starts.find(worker=>worker.generation===first.generation)!),true)
 assert.equal(f.stopped.has(f.starts.find(worker=>worker.generation===second.generation)!),false);assert.equal(f.stopped.has(f.starts[0]!),false)
 await f.restart()
 const restored=await f.manager.prepare(a) as any
 assert.equal(restored.state,'READY');assert.notEqual(restored.generation,first.generation)
 assert.equal(f.starts.at(-1)!.layout.workspace,undefined,'Restored worker must not acquire the parent repository lease')
})

test('cancelled session-worker admission cannot start a process',async t=>{
 const f=await fixture(t),abort=new AbortController();abort.abort()
 await assert.rejects(f.manager.enableSessionWorker(f.owner,false,abort.signal),{name:'AbortError'})
 assert.equal(f.starts.length,0)
 assert.equal(f.manager.enabled.has(f.owner.sessionId),false)
})

test('failed session-worker startup retains its route and requires recovery without retrying on projection',async t=>{
 const f=await fixture(t,'development');let attempts=0
 t.mock.method(LispWorker.prototype,'start',async()=>{attempts++;throw new Error('worker startup failed')})
 await assert.rejects(f.manager.enableSessionWorker(f.owner),/worker startup failed/)
 assert.equal(await f.manager.isSessionWorker(f.owner),true)
 assert.equal((await f.manager.enableSessionWorker(f.owner) as any).state,'RECOVERY_REQUIRED')
 assert.equal(attempts,1,'Repeated prompt assembly cannot silently retry a failed worker')
})

test('host observation needs no task mode or coding workflow and preserves paths, owner receipts and replay',async t=>{
 const f=await fixture(t);await f.store.enable(f.owner);f.manager.enabled.set(f.owner.sessionId,f.owner.root);await writeFile(join(f.root,'input.json'),'[20,22]')
 const prepare=f.db.prepare.bind(f.db)
 t.mock.method(f.db,'prepare',(sql:string)=>{assert.ok(!sql.includes('w.snapshot_json'),'read-only observation must not depend on coding workflow readiness');return prepare(sql)})
 const result=await f.manager.execute(f.owner,'lisp_observe',{operationId:'observe',paths:['input.json'],format:'json'}) as any
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(f.starts.length,0);assert.equal(result.items[0].content,undefined)
 assert.equal((await f.store.get(f.owner,result.resultRef))!.state,'SUCCEEDED')
 assert.equal((await f.manager.execute(f.owner,'lisp_observe',{operationId:'observe',paths:['input.json'],format:'json'}) as any).replay,true)
 assert.equal((await f.manager.execute(f.owner,'lisp_observe',{operationId:'escape',paths:['../outside']}) as any).ok,false)
 assert.equal((await f.manager.execute({...f.owner,root:f.base},'lisp_observe',{operationId:'foreign',paths:['input.json']}) as any).ok,false)
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM ledger_runs').get<{n:number}>()!.n,0)
})

test('resident protected worker defines, composes and calls exact functions without mode switch or task',async t=>{
 const f=await fixture(t);await f.manager.enable(f.owner)
 const generation=f.starts[0]!.generation
 const first=await f.manager.execute(f.owner,'lisp_define',{operationId:'define',...definition}) as any
 assert.equal(first.ok,true,JSON.stringify(first))
 const second=await f.manager.execute(f.owner,'lisp_define',{operationId:'compose',...definition,name:'twice',source:'(lambda (input) (add-one (add-one input)))',dependencies:[{binding:'add-one',toolRef:first.toolRef}]}) as any
 assert.equal(second.ok,true,JSON.stringify(second))
 const call=await f.manager.execute(f.owner,'lisp_call',{operationId:'call',toolRef:second.toolRef,input:40}) as any
 assert.equal(call.ok,true,JSON.stringify(call));assert.equal(call.generation,generation);assert.equal(f.starts.length,1)
 assert.ok(f.requests.some(r=>r.method==='task'&&String(r.args.code).includes('(flet ((add-one')))
 assert.ok(f.requests.filter(r=>r.method.startsWith('task')).every(r=>r.rpc===false))
 const count=f.requests.length;assert.equal((await f.manager.execute(f.owner,'lisp_call',{operationId:'call',toolRef:second.toolRef,input:40}) as any).replay,true);assert.equal(f.requests.length,count)
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM ledger_runs').get<{n:number}>()!.n,0)
})

test('arbitrary generated code cannot borrow a development heap or acquire repository scope',async t=>{
 const f=await fixture(t,'development');await f.manager.enable(f.owner)
 const parent=f.starts[0]!,epoch=(await f.store.session(f.owner.sessionId))!.epoch
 const result=await f.manager.execute(f.owner,'lisp_define',{operationId:'untrusted',...definition,source:'(lambda (input) (declare (ignore input)) (with-open-file (s "outside" :direction :output) (write-line "bad" s)))'}) as any
 assert.equal(result.ok,true,JSON.stringify(result)) // Transport accepted it; schema is never a safety proof.
 assert.equal(f.starts[0],parent);assert.equal(f.stopped.has(parent),false);assert.equal((await f.store.session(f.owner.sessionId))!.epoch,epoch)
 assert.ok(f.starts.length>1)
 for(const worker of f.starts.slice(1)){assert.equal(worker.layout.protected,true);assert.equal(worker.config.executionMode,'protected');assert.equal(worker.layout.workspace,undefined);assert.equal(worker.hostCall,undefined);assert.equal(worker.rpcAllowed('tool-call'),false)}
})

test('approved shared functions use the child owner after restart without borrowing parent task authority',async t=>{
 const f=await fixture(t);const task=workingLispTask(f.db,f.owner);await f.manager.enable(f.owner)
 const contract=await f.manager.execute(f.owner,'lisp_hot_contract',{operationId:'contract',name:'shared',description:'Shared fixed fixture response',inputSchema:{type:'integer'},outputSchema:{type:'integer'},properties:[{input:0,expected:42}]}) as any
 assert.equal(contract.ok,true,JSON.stringify(contract))
 const install=await f.manager.execute(f.owner,'lisp_hot_install',{operationId:'install',name:'shared',contractRef:contract.contractRef,expectedRevision:0,source:'(lambda (input) (declare (ignore input)) 42)'}) as any
 assert.equal(install.ok,true,JSON.stringify(install))
 const child:LispOwner={sessionId:'child',agentId:'child',root:f.root};await f.store.enable(child);f.manager.enabled.set(child.sessionId,child.root)
 const first=await f.manager.execute(child,'lisp_hot_call',{operationId:'child-call',name:'shared',input:0}) as any
 assert.equal(first.ok,true,JSON.stringify(first));assert.equal((await f.store.get(child,first.resultRef))!.state,'SUCCEEDED');assert.equal(await f.store.get(f.owner,first.resultRef),undefined)
 await f.manager.taskAuthority.run(child,async()=>{await assert.rejects(f.manager.taskAuthority.authorizeEffect(child),{code:'TASK_REQUIRED'})})
 const inherited=await withTaskAuthority(captureTaskLease(f.db,task),()=>f.manager.execute(child,'lisp_hot_call',{operationId:'inherited',name:'shared',input:0})) as any
 assert.equal(inherited.code,'TASK_OWNER_MISMATCH')
 const parent=f.starts[0]!;assert.equal(f.stopped.has(parent),false)
 await f.restart();const count=f.requests.length
 const replay=await f.manager.execute(child,'lisp_hot_call',{operationId:'child-call',name:'shared',input:0}) as any
 assert.equal(replay.replay,true);assert.equal(f.requests.length,count)
 assert.equal((await f.manager.execute(child,'lisp_hot_call',{operationId:'new-child-call',name:'shared',input:0}) as any).ok,true)
})
