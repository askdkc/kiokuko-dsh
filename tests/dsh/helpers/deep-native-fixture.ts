import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initializeDatabase } from '../../../src/dsh/database.js'
import { openConnection } from '../../../src/db/connection.js'
import { registerRepositoryAndLocation } from '../../../src/repository/binding.js'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { nativeMock } from './native-mock.js'
import { mountDshOrcaCommand } from '../../../src/dsh/orca-command-surface.js'

export async function deepNativeFixture(makeScript: (mock: ReturnType<typeof nativeMock>, root: string, dbPath: string) => any[], options: { budget?: object; orca?: boolean; questions?: (request: any) => Promise<any> } = {}) {
  const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT!
  const [cordis,llm,session,projection,systemPrompt,tools,agents,loop,skills,subagents,spawn,commands] = await Promise.all(
    ['cordis','llm','session','session-projection','system-prompt','tools','agent','agent-loop','skill','subagent','subagent-spawn-in-process','commands'].map(name => import(pathToFileURL(join(packages,'@deepseek-ai',name==='cordis'?name:`dsh-${name}`,'lib/index.js')).href)))
  const root=realpathSync(await mkdtemp(join(tmpdir(),'deep-native-cases-'))), data=await mkdtemp(join(tmpdir(),'deep-native-state-'))
  execFileSync('git',['init','-q',root])
  const dbPath=join(data,'state.sqlite3'); await initializeDatabase({databasePath:dbPath})
  const db=openConnection(dbPath)
  registerRepositoryAndLocation(db,{repositoryId:'deep-cases',workspace:'deep-cases',displayName:'Deep cases',canonicalRoot:root,remoteFingerprint:null,bindingSchemaVersion:1,agentTemplateVersion:1});db.close()
  const mock=nativeMock(llm), provider=new mock.MockAdapter(makeScript(mock,root,dbPath))
  const ctx=new cordis.Context(), fibers:any[]=[]
  for(const plugin of [llm,session,projection,systemPrompt,tools,agents,skills,subagents,commands]) fibers.push(await ctx.plugin(plugin.default,plugin===systemPrompt?{persona:''}:undefined))
  fibers.push(await ctx.plugin(loop.default,{agents:[]}));fibers.push(await ctx.plugin(spawn,{providerName:'spawn'}))
  if(options.questions) fibers.push(await ctx.plugin({name:'deep-case-questions',apply(c:any){return c.provide('userQuestions',{ask:options.questions})}}))
  ctx.llm.registerAdapter(['mock'],provider)
  const adapter=createDshHostAdapter(ctx,{repositoryRoot:root,databasePath:dbPath,modelRoutes:[{provider:'mock',family:'other',connection:'api',protocol:'chat-completions'}],orca:{enabled:options.orca??false},deepPlanning:{budget:options.budget??{}}})
  const composition=await mountDshComposition(ctx,adapter.host)
  const disposeOrca=options.orca&&adapter.host.orca?mountDshOrcaCommand(ctx,true,adapter.host.orca):undefined
  const parent=await ctx.agentLoop.create(session.SessionId('deep-case-parent'),{provider:'mock',model:'mock'},{cwd:root})
  const deep=adapter.host.deepPlanning!
  const command=(line:string)=>ctx.commands.execute(parent,line,[],new AbortController().signal)
  const complete=async()=>{await parent.whenIdle();const intent=await deep.store.intent(parent.session.id);if(intent?.runId){await deep.kick(parent);await deep.scheduler.idle(intent.runId)};await adapter.host.memoryFinalizer!.whenIdle();return intent}
  return {root,dbPath,ctx,parent,provider,adapter,deep,command,complete,mock,llm,
    close:async()=>{composition.stopIngress();disposeOrca?.();await adapter.dispose();await composition.dispose();for(const fiber of fibers.reverse())await fiber?.dispose?.();await rm(root,{recursive:true,force:true});await rm(data,{recursive:true,force:true})} }
}
