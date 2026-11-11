import { mountNativeExecutor } from '../helpers/native-tools.js'
/** Real native file reads; scripted generation does not establish model intent quality. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import * as sourceFull from '../../../src/dsh/index.js'
import * as sourceCore from '../../../src/dsh/core/index.js'
import { nativeMock } from '../helpers/native-mock.js'
import { withIsolatedSkillHome } from '../helpers/skill-home.js'
import { openConnection } from '../../../src/db/connection.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_TEST_PLUGIN_PACKAGE_ROOT
const full = packageRoot ? await import(pathToFileURL(join(packageRoot, 'dist/dsh/index.js')).href) : sourceFull
const core = packageRoot ? await import(pathToFileURL(join(packageRoot, 'dist/dsh/core/index.js')).href) : sourceCore

import { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'
import { resolveProjectWorkspaceReadOnly } from '../../../src/memory/workspaces.js'
import { createRequestIntentContext, requestIntentMessageRefs, requestIntentReferenceIds } from '../../../src/dsh/decisions/request-intent.js'

for (const presentation of ['native', 'ptc'] as const) for (const mode of ['full', 'core'] as const) for (const outcome of ['write', 'prepare-then-write', 'native-denial', 'stop'] as const) {
  test(`conflicting memory binding after restart: ${mode} ${presentation} ${outcome}`, {timeout:30000}, async () => withIsolatedSkillHome(async () => {
    const load = (name: string) => import(name === 'dsh-agent-loop' ? new URL('../helpers/kiokuko-driver.mjs', import.meta.url).href
      : pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
    const [cordis,llm,sessions,projection,prompt,tools,agents,skills,loop,fs,directory,policy,files] = await Promise.all([
      'cordis','dsh-llm','dsh-session','dsh-session-projection','dsh-system-prompt','dsh-tools','dsh-agent','dsh-skill',
      'dsh-agent-loop','dsh-fs-local','dsh-working-directory','dsh-fs-observation-policy','dsh-tool-fs'].map(load))
    const root = realpathSync(await mkdtemp(join(tmpdir(),'memory-binding-native-')))
    const databasePath=join(root,'memory.sqlite3'), ctx=new cordis.Context(), fibers:any[]=[], errors:unknown[]=[]
    let handle:any, mounted:any, adapter:any, deniedAttempts=0
    const original = 'export const enabled = true;\n', changed = 'export const enabled = false;\n'
    const task='Update policy.mjs to export enabled=false. Preserve other files. Verify the saved file.'
    try {
      await mkdir(join(root,'.git'))
      await writeFile(join(root,'policy.mjs'),original)
      const seed = new DshCoreRuntime({repositoryRoot:root,databasePath,autoRegisterRepository:true})
      await seed.start(); await seed.close()
      const before=openConnection(databasePath)
      const binding=before.prepare('SELECT * FROM repository_locations').all()
      before.close()
      const conflict=JSON.stringify({schemaVersion:1,repositoryId:'repo_foreign',workspace:'project:foreign',agentFile:'AGENTS.md',templateVersion:1})
      await writeFile(join(root,'.kiokuko.json'),conflict)
      for (const plugin of [llm,sessions,projection,prompt,tools,agents,skills,fs,directory,policy,files])
        fibers.push(await ctx.plugin(plugin.default??plugin,plugin===fs?{cwd:root}:plugin===directory?{defaultDirectory:root}:plugin===prompt?{persona:''}:undefined))
      if(presentation==='native')await mountNativeExecutor(ctx,packages,fibers)
      fibers.push(await ctx.plugin(loop.default,{agents:[]}))
      ctx.on('agent/error',(event:any)=>errors.push(String(event.error)))
      if(outcome==='native-denial')ctx.tools.guard((execution:any)=>execution.name==='write'?(deniedAttempts++,'NATIVE_FILE_DENIED'):undefined)
      if(outcome==='stop')ctx.tools.guard((execution:any)=>{if(execution.name==='write'){deniedAttempts++;handle.agent.cancel({kind:'user'},{keepInbox:true});return 'NATIVE_USER_STOP'}})
      const mock=nativeMock(llm), responses:any[]=[], model=new mock.MockAdapter(responses)
      ctx.llm.registerAdapter(['fixture'],model)
      const config={repositoryRoot:root,databasePath,typedDecisions:{mode:'off'},answerReview:{mode:'off'},semanticCompaction:{mode:'off'},modelAutoMode:{mode:'off'}}
      if(mode==='core')mounted=await core.mountCore(ctx,config,[])
      else {adapter=full.createDshHostAdapter(ctx,{...config,agenticReplay:{enabled:false},toolExposure:{mode:'full'},deepPlanning:{enabled:false}});mounted=await full.mountDshComposition(ctx,adapter.host)}
      handle=await ctx.agents.create({sessionId:sessions.SessionId(`binding-${mode}-${outcome}`),agentOptions:{provider:'fixture',model:'mock'},meta:{cwd:root}})
      if(presentation==='ptc'){
        for(const name of ['dsh-subprocess-local','dsh-sandbox-local','dsh-sandbox-policy','dsh-ptc-runtime-node'])
          fibers.push(await ctx.plugin((await load(name)).default,name==='dsh-sandbox-policy'?{mode:'read-only',workspaceRoot:root}:name==='dsh-ptc-runtime-node'?{timeoutMs:10000}:undefined))
        fibers.push(await ctx.plugin(await load('dsh-tool-executor-ptc'),{}))
      }
      const call=(id:string,name:string,args:object)=>presentation==='native'?mock.toolCallResponse(id,name,args)
        :mock.toolCallResponse(id,'run_code',{description:'Continue the requested file update',code:`return await tools.${name}(${JSON.stringify(args)})`})
      const message=llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:task}]})
      responses.push(call('read-existing','read',{file_path:'policy.mjs'}))
      if(outcome==='prepare-then-write'){
        const context=createRequestIntentContext({task,workspaceDirectory:root,messageRefs:requestIntentMessageRefs([message],task)})!
        responses.push(call('optional-record','prepare_requested_work',{requestIntent:{relation:'new',action:'change',changeScope:'implementation',evidenceRefs:requestIntentReferenceIds(context)}}))
      }
      responses.push(call('native-write','write',{file_path:'policy.mjs',content:changed}),call('verify-saved','read',{file_path:'policy.mjs'}),mock.textResponse('Finished'))
      handle.agent.followup(message);await handle.agent.whenIdle()
      assert.deepEqual(errors,[])
      const results=handle.agent.session.snapshotEvents().filter((event:any)=>event.type==='tool/result').map((event:any)=>event.data.message)
      if(outcome==='prepare-then-write'){
        const preparation=results.find((result:any)=>result.toolCallId==='optional-record')
        assert.equal(preparation?.isError,false,JSON.stringify(preparation))
        assert.match(JSON.stringify(preparation),/repository_memory_unavailable/)
      }
      const succeeded=outcome==='write'||outcome==='prepare-then-write'
      if(!succeeded)assert.equal(deniedAttempts,1,'native policy must receive the actual file call')
      assert.equal(await readFile(join(root,'policy.mjs'),'utf8'),succeeded?changed:original,JSON.stringify(results))
      assert.equal(await readFile(join(root,'.kiokuko.json'),'utf8'),conflict)
      const db=openConnection(databasePath)
      try {
        assert.deepEqual(db.prepare('SELECT * FROM repository_locations').all(),binding)
        assert.equal(await resolveProjectWorkspaceReadOnly(db,root),undefined,'neither conflicting memory identity is adopted')
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ledger_runs').get()?.count,0)
      } finally {db.close()}
    } finally {
      await handle?.dispose();await mounted?.dispose();await adapter?.dispose()
      for(const fiber of fibers.reverse())await fiber.dispose()
      await rm(root,{recursive:true,force:true})
    }
  }))
}
