import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { migrateDatabase } from '../../../../src/db/migrate.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { mountLispSurface as sourceSurface } from '../../../../src/dsh/lisp/surface.js'
import { nativeMock } from '../../helpers/native-mock.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
const providerEntry = process.env.KIOKUKO_CODE_PROVIDER_ENTRY
if (process.env.KIOKUKO_REQUIRE_CODE_PROVIDER === '1' && (!packages || !providerEntry)) throw new Error('Code acceptance requires the pinned DSH and built V1 provider fixtures')
const mountLispSurface: typeof sourceSurface = process.env.KIOKUKO_LISP_PLAN_ENTRY
  ? (await import(pathToFileURL(process.env.KIOKUKO_LISP_PLAN_ENTRY).href)).mountLispSurface : sourceSurface
const modes = (process.env.KIOKUKO_CODE_EXECUTION_MODES ?? 'development,protected').split(',')
if (modes.some(mode => !['development','protected'].includes(mode))) throw new Error('Unknown code acceptance execution mode')
for (const mode of modes as ('development'|'protected')[]) test(`code intelligence: real native ${mode} Lisp and provider entry`, {
  skip: packages && providerEntry ? false : 'requires optional built V1 provider fixture', timeout: 120000,
}, async () => {
  const names = ['cordis','llm','session','session-projection','system-prompt','tools','agent','agent-loop','commands','fs-local','subprocess-local']
  const [cordis,llm,session,projection,prompt,tools,agents,loop,commands,fs,subprocess] = await Promise.all(names.map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name === 'cordis' ? name : `dsh-${name}`, 'lib/index.js')).href)))
  const lsp = await import(new URL('./lsp.js', pathToFileURL(providerEntry!)).href)
  const cli = process.env.KIOKUKO_CODE_CLI_HOST === '1'
    ? await import(pathToFileURL(join(packages!, '@askdkc/dsh-cli/lib/types/dsh-adapter/plugin-host.js')).href) : undefined
  const base = await realpath(await mkdtemp(join(tmpdir(),'code-native-'))), root=join(base,'workspace')
  await mkdir(root); await writeFile(join(root,'index.ts'),'export function hello() { return 1 }\nhello();\n');await writeFile(join(root,'other.ts'),'function first(){}\nfunction second(){}\n')
  const db = new NodeSqliteAdapter(join(base,'state.sqlite3'),new DatabaseSync(join(base,'state.sqlite3'))); migrateDatabase(db)
  const runtime:any={withDatabase:async(fn:any)=>fn(db)},ctx=new cordis.Context(),fibers:any[]=[]
  let surface:Awaited<ReturnType<typeof mountLispSurface>>|undefined
  try {
    for(const [plugin,config] of [[llm.default],[session.default],[projection.default],[prompt.default,{persona:''}],[tools.default,{mode:'native'}],[agents.default],[commands.default],[loop.default,{agents:[]}],[fs.default,{cwd:root}],[subprocess.default],[lsp.default]] as any[]){const fiber=ctx.plugin(plugin,config);fibers.push(fiber);await fiber}
    if(cli){const fiber=ctx.plugin(cli);fibers.push(fiber);await fiber;assert.ok(ctx.get('executionFences',false),'actual CLI execution fence must be mounted')}
    const provider=await import(pathToFileURL(providerEntry!).href),fiber=ctx.plugin(provider,{servers:{phpantom:{enabled:false}},tailwind:{enabled:false}});fibers.push(fiber);await fiber
    const mock=nativeMock(llm);ctx.llm.registerAdapter(['mock'],new mock.MockAdapter([]))
    const agent=await ctx.agentLoop.create(session.SessionId('code-parent'),{provider:'mock',model:'qwen3-coder'},{cwd:root})
    const child=await ctx.agentLoop.create(session.SessionId('code-child'),{provider:'mock',model:'qwen3-coder'},{cwd:root,parentSession:agent.session.id})
    let effects=0
    for(const name of ['lsp','lsp_extra'])ctx.tools.register({name,description:'fence sentinel',parameters:{},output:{schema:{},render:()=>[]},execute:()=>++effects})
    const lispFiber=ctx.plugin({name:'code-lisp-acceptance',async apply(caller:any){surface=await mountLispSurface(caller,runtime,LispConfig.parse({executionMode:mode,enabled:true,startupTimeoutMs:60000}))}});fibers.push(lispFiber);await lispFiber
    assert.ok(surface,'the caller realm must mount the public Lisp surface')
    const enabled=(await ctx.commands.execute(agent,'/kioku-lisp enable',[],new AbortController().signal)).result
    assert.equal(enabled.kind,'success',enabled.text)
    const call=async(name:string,args:any={},caller=agent)=>ctx.tools.execute({name,arguments:args,callId:randomUUID(),agent:caller,signal:new AbortController().signal})
    const evaluation=await call('lisp_eval',{operationId:'code-read',code:`(kioku.code:with-snapshot (s "index.ts")
      (let* ((outline (kioku.code:outline s)) (node (aref (gethash "items" (gethash "data" outline)) 0)))
        (kioku.internal:object "outline" outline "span" (kioku.code:span (gethash "handle" node))
          "hover" (kioku.code:semantic s "hover" :position (kioku.internal:object "line" 1 "character" 2)) "definition" (kioku.code:semantic s "definition" :position (kioku.internal:object "line" 1 "character" 2)) "handle" s)))`})
    assert.equal(evaluation.isError,false,JSON.stringify(evaluation));assert.equal(evaluation.value.ok,true,JSON.stringify(evaluation))
    const result=evaluation.value.value.json
    assert.equal(result.outline.status,'ok');assert.equal(result.span.data.text,'function hello() { return 1 }');assert.equal(result.hover.status,'ok');assert.equal(result.definition.status,'ok',JSON.stringify(result.definition));assert.equal(result.definition.data.items.length,1)
    const aggregate=await call('lisp_eval',{operationId:'aggregate',code:`(let ((processed 0) (declarations 0) (versions nil))
      (dolist (path '("index.ts" "other.ts"))
        (kioku.code:with-snapshot (s path)
          (let ((result (kioku.code:outline s)))
            (unless (equal (gethash "status" result) "ok") (error "incomplete outline"))
            (incf processed) (incf declarations (length (gethash "items" (gethash "data" result))))
            (push (gethash "snapshotVersion" result) versions))))
      (kioku.internal:object "processed" processed "declarations" declarations "unprocessed" 0 "versions" (coerce versions 'vector)))`})
    assert.equal(aggregate.value.ok,true,JSON.stringify(aggregate));assert.deepEqual({...aggregate.value.value.json,versions:undefined},{processed:2,declarations:3,unprocessed:0,versions:undefined});assert.equal(aggregate.value.value.json.versions.length,2)
    const expired=await call('lisp_eval',{operationId:'expired',code:`(kioku.code:outline ${JSON.stringify(result.handle)})`})
    assert.equal(expired.value.value.json.status,'stale','handles cannot cross evaluations')
    const error=await call('lisp_eval',{operationId:'error-cleanup',code:'(handler-case (kioku.code:with-snapshot (s "index.ts") (error "body failure")) (error () "caught"))'})
    assert.equal(error.value.value.json,'caught')
    const service=agent.ctx.get('codeIntelligence'), version=service.version; service.version=2
    try { const unavailable=await call('lisp_eval',{operationId:'old-provider',code:'(kioku.code:capabilities)'});assert.equal(unavailable.value.value.json.reason,'provider_version') } finally {service.version=version}
    for(const caller of [agent,child])for(const name of ['lsp','lsp_extra'])assert.equal((await call(name,{},caller)).isError,mode==='protected'||!!cli&&caller===child)
    await fiber.dispose()
    const removed=await call('lisp_eval',{operationId:'provider-removed',code:'(kioku.code:capabilities)'})
    assert.equal(removed.value.value.json.status,'unavailable');assert.equal(removed.value.value.json.reason,'provider_missing')
    const before=effects;surface.stop();await surface.dispose()
    if(mode==='protected'){for(const caller of [agent,child])for(const name of ['lsp','lsp_extra'])assert.equal((await call(name,{},caller)).isError,true);assert.equal(effects,before)}
  }finally{surface?.stop();await surface?.dispose();for(const fiber of fibers.reverse())await fiber.dispose();db.close();await rm(base,{recursive:true,force:true})}
})
