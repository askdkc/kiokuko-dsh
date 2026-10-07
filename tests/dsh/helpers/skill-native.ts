import assert from 'node:assert/strict'
import { mkdtemp, rm, realpath, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { DshSkillPrompts } from '../../../src/dsh/skill-prompts.js'
import { nativeMock } from './native-mock.js'

/** The same native host, model loop and Lisp boundary serve delivery and behavior probes. */
export async function nativeSkillFixture(options: { packages: string; packageRoot?: string; explicit?: boolean|'prompt-only'; mode?: 'full'|'compiled'; extra?: object; nativeAnswer?: (request: any) => Promise<any>; prompts?: DshSkillPrompts }) {
  const { packages, packageRoot, explicit = false, mode = 'compiled', extra = {}, nativeAnswer, prompts } = options
  if (prompts && explicit !== true) throw new Error('Custom source snapshots require the explicit production host')
  const subject: typeof import('../../../src/dsh/index.js') = await import(packageRoot
    ? pathToFileURL(join(packageRoot, 'dist/index.js')).href : '../../../src/dsh/index.js')
  const modules = await Promise.all(['cordis','llm','session','session-projection','system-prompt','tools','agent','agent-loop','skill','tool-skill','commands','subagent','subagent-spawn-in-process']
    .map(name=>import(pathToFileURL(join(packages!,'@deepseek-ai',name==='cordis'?name:`dsh-${name}`,'lib/index.js')).href)))
  const [cordis,llm,session,projection,prompt,tools,agents,loop,skills,skillTool,commands,subagents,spawn]=modules
  const dir = await realpath(await mkdtemp(join(tmpdir(),'skill-delivery-'))), previousData = process.env.KIOKUKO_DATA_DIR
  process.env.KIOKUKO_DATA_DIR = dir
  const ctx = new cordis.Context(), fibers: any[] = [], mock = nativeMock(llm)
  let adapter: ReturnType<typeof subject.createDshHostAdapter> | undefined
  let plugin: { dispose(): Promise<unknown> } | undefined
  let off = () => {}, offQuestions: (() => void) | undefined
  const workspace = prompts ? join(dir, 'workspace') : dir
  const mountPlugin = async (nextMode: 'full'|'compiled') => {
    // The bundled host binds its workspace at startup, just as a real DSH
    // process does. Keep the session in that same disposable workspace without
    // weakening the on-demand identity check or leaking cwd to later tests.
    const previousCwd = process.cwd()
    try {
      process.chdir(workspace)
      return await ctx.plugin(subject, { enabled: true, skillPrompts: { mode: nextMode }, orca: { enabled: false }, ...extra })
    } finally { process.chdir(previousCwd) }
  }
  const close = async () => {
    const failures: unknown[] = []
    off(); offQuestions?.()
    for (const dispose of [() => plugin?.dispose(), () => adapter?.dispose(), ...[...fibers].reverse().map(fiber => () => fiber.dispose())]) {
      try { await dispose() } catch (error) { failures.push(error) }
    }
    if (previousData === undefined) delete process.env.KIOKUKO_DATA_DIR
    else process.env.KIOKUKO_DATA_DIR = previousData
    await rm(dir, { recursive: true, force: true })
    if (failures.length) throw new AggregateError(failures, 'Native fixture cleanup failed')
  }
  try {
  await mkdir(workspace, { recursive: true })
  fibers.push(await ctx.plugin({name:'headless-web-connection',apply(c:any){return c.provide('connection',{fetch:{register:()=>()=>{}}})}}))
  if('lisp' in extra) {
    if (nativeAnswer) {
      const questions = await import(pathToFileURL(join(packages!, '@deepseek-ai/dsh-user-questions/lib/index.js')).href)
      fibers.push(await ctx.plugin(questions.default, {}))
    } else fibers.push(await ctx.plugin({name:'delivery-intent-answer',apply(c:any){return c.provide('userQuestions',{ask:async(r:any)=>({answers:r.questions.map((q:any)=>{
      assert.ok(['taskType','enno-execution-mode'].includes(q.id),JSON.stringify(q))
      return{id:q.id,selected:[q.id==='taskType'?'chat':'通常実行']}
    })})})}}))
  }
  const initial=explicit==='prompt-only'?[llm,prompt,skills]:[llm,session,projection,prompt,tools,agents,skills,commands,subagents,skillTool]
  for(const m of initial) fibers.push(await ctx.plugin(m.default??m, m===prompt?{persona:''}:undefined))
  if(explicit!=='prompt-only'){fibers.push(await ctx.plugin(loop.default,{agents:[]}));fibers.push(await ctx.plugin(spawn,{providerName:'spawn'}))}
  const responses: any[] = [], model = new mock.MockAdapter(responses)
  ctx.llm.registerAdapter(['mock'],model)
  if(explicit===true) {
    adapter = subject.createDshHostAdapter(ctx,{databasePath:join(dir,'state.sqlite3'),repositoryRoot:workspace,orca:{enabled:false}, ...(prompts ? {
      skillPrompts: prompts, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, typedDecisions: { mode: 'off' },
      // Auxiliary finalization must not consume evaluation scripts or provider
      // budgets. Foreground native model and tool dispatch remain unchanged.
      llm: { async *stream() { throw new Error('Auxiliary model generation is unavailable in isolated Skill evaluation') } },
    } : {})})
    fibers.push(await ctx.plugin({name:'explicit-skill-host',apply(c:any){return c.provide('kiokukoDsh',adapter!.host)}}))
  }
  plugin = prompts
    ? await subject.mountDshComposition(ctx, adapter!.host, subject.Config.parse({ ...extra }).lisp, prompts)
    : await mountPlugin(mode)
  if(explicit==='prompt-only'){
    for(const m of [session,projection,tools,agents,commands,skillTool])fibers.push(await ctx.plugin(m.default??m))
    fibers.push(await ctx.plugin(loop.default,{agents:[]}))
  }
  const agent = await ctx.agentLoop.create(session.SessionId('skill-main'),{provider:'mock',model:'qwen3-coder'},{cwd:workspace})
  offQuestions = nativeAnswer ? agent.ctx.on('user-questions/request', nativeAnswer) : undefined
  const errors: unknown[]=[]
  off=ctx.on('agent/error',(e:any)=>errors.push(e.error))
  const turn=async(input='この内容を日本語で説明してください。')=>{agent.followup(llm.createUserMessage({content:[{type:'text',text:input}],source:{kind:'user'}}));await agent.whenIdle();assert.deepEqual(errors,[])}
  return {ctx,agent,model,responses,mock,turn,adapter,dir:workspace,llm,
    async reload(nextMode: 'full'|'compiled') { if (prompts) throw new Error('Snapshot fixtures cannot change representation'); await plugin!.dispose(); plugin=await mountPlugin(nextMode) },
    close }
  } catch (error) { await close(); throw error }
}
