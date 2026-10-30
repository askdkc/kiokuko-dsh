import assert from 'node:assert/strict'
import { mkdtemp, rm, realpath, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { DshSkillPrompts } from '../../../src/dsh/skill-prompts.js'
import type { DecisionService } from '../../../src/dsh/decisions/service.js'
import { nativeMock } from './native-mock.js'
import { mountNativeTools } from './native-tools.js'
import { answerTaskStartup, type StartupFixtureChoice } from './task-startup-fixture.js'

/** The same native host, model loop and Lisp boundary serve delivery and behavior probes. */
export async function nativeSkillFixture(options: { packages: string; packageRoot?: string; explicit?: boolean|'prompt-only'; mode?: 'full'|'compiled'; extra?: object; hostPlugin?: any; skillToolPlacement?: 'global' | 'late' | 'agent'; nativeAnswer?: (request: any) => Promise<any>; prompts?: DshSkillPrompts; decisions?: DecisionService; startupChoice?: StartupFixtureChoice; startupChoices?: readonly StartupFixtureChoice[] }) {
  const { packages, packageRoot, explicit = false, mode = 'compiled', extra = {}, skillToolPlacement = 'global', hostPlugin, nativeAnswer, prompts, decisions } = options
  if (prompts && explicit !== true) throw new Error('Custom source snapshots require the explicit production host')
  const subject: typeof import('../../../src/dsh/index.js') = await import(packageRoot
    ? pathToFileURL(join(packageRoot, 'dist/index.js')).href : '../../../src/dsh/index.js')
  const modules = await Promise.all(['cordis','llm','session','session-projection','system-prompt','tools','agent','agent-loop','skill','tool-skill','commands','subagent','subagent-spawn-in-process','fs-local','working-directory']
    .map(name=>import(pathToFileURL(join(packages!,'@deepseek-ai',name==='cordis'?name:`dsh-${name}`,'lib/index.js')).href)))
  const [cordis,llm,session,projection,prompt,tools,agents,loop,skills,skillTool,commands,subagents,spawn,fsLocal,workingDirectory]=modules
  const dir = await realpath(await mkdtemp(join(tmpdir(),'skill-delivery-'))), previousData = process.env.KIOKUKO_DATA_DIR
  process.env.KIOKUKO_DATA_DIR = dir
  const ctx = new cordis.Context(), fibers: any[] = [], mock = nativeMock(llm)
  const startupQuestions: Array<{ id: string; selected: StartupFixtureChoice }> = []
  let adapter: ReturnType<typeof subject.createDshHostAdapter> | undefined
  let plugin: { dispose(): Promise<unknown> } | undefined
  let hostFiber: any
  let adapterOptions: Parameters<typeof subject.createDshHostAdapter>[1] | undefined
  let off = () => {}, offQuestions: (() => void) | undefined
  const workspace = prompts ? join(dir, 'workspace') : dir
  const mountPlugin = async (nextMode: 'full'|'compiled') => {
    // The bundled host binds its workspace at startup, just as a real DSH
    // process does. Keep the session in that same disposable workspace without
    // weakening the on-demand identity check or leaking cwd to later tests.
    const previousCwd = process.cwd()
    try {
      process.chdir(workspace)
      return await ctx.plugin(subject, { enabled: true, skillPrompts: { mode: nextMode }, agenticReplay: { enabled: false }, ...extra })
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
  // Keep repository discovery inside this disposable workspace, even when the
  // system temporary directory belongs to an enclosing checkout.
  await mkdir(join(workspace, '.git'), { recursive: true })
  fibers.push(await ctx.plugin(fsLocal.default, { cwd: workspace }))
  fibers.push(await ctx.plugin(workingDirectory.default, { defaultDirectory: workspace }))
  fibers.push(await ctx.plugin({name:'headless-web-connection',apply(c:any){return c.provide('connection',{fetch:{register:()=>()=>{}}})}}))
  if('lisp' in extra) {
    if (nativeAnswer) {
      const questions = await import(pathToFileURL(join(packages!, '@deepseek-ai/dsh-user-questions/lib/index.js')).href)
      fibers.push(await ctx.plugin(questions.default, {}))
    } else fibers.push(await ctx.plugin({name:'delivery-intent-answer',apply(c:any){return c.provide('userQuestions',{ask:async(r:any)=>({answers:r.questions.map((q:any)=>{
      if (q.id.startsWith('task-startup:')) {
        const selected = options.startupChoices ? options.startupChoices[startupQuestions.length] : options.startupChoice ?? 'decision OFF / Lisp OFF'
        const response = answerTaskStartup(r, selected!)
        assert.ok(!startupQuestions.some(previous => previous.id === q.id), 'same startup question must not repeat')
        startupQuestions.push({ id: q.id, selected: selected! })
        return response.answers[0]
      }
      assert.ok((['taskType','enno-execution-mode'].includes(q.id) || q.id.startsWith('coding-lisp-') || q.id.startsWith('lisp-early-')),JSON.stringify(q))
      return{id:q.id,selected:[(q.id.startsWith('coding-lisp-') || q.id.startsWith('lisp-early-')) ? '使わない' : q.id==='taskType'?'chat':'通常実行']}
    })})})}}))
  }
  const initial=explicit==='prompt-only'?[llm,prompt,skills]:[llm,session,projection,prompt,tools,agents,skills,commands,subagents,skillTool]
  for(const m of initial) {
    if (m === tools) await mountNativeTools(ctx, tools, packages, fibers)
    else if (m !== skillTool || skillToolPlacement === 'global') fibers.push(await ctx.plugin(m.default??m, m===prompt?{persona:''}:undefined))
  }
  if(explicit!=='prompt-only'){fibers.push(await ctx.plugin(loop.default,{agents:[]}));fibers.push(await ctx.plugin(spawn,{providerName:'spawn'}))}
  const responses: any[] = [], model = new mock.MockAdapter(responses)
  ctx.llm.registerAdapter(['mock'],model)
  if (hostPlugin) fibers.push(await ctx.plugin(hostPlugin))
  if(explicit===true) {
    adapterOptions = {databasePath:join(dir,'state.sqlite3'),repositoryRoot:workspace,agenticReplay:{enabled:false},
      ...('typedDecisions' in extra ? {typedDecisions:subject.Config.parse(extra).typedDecisions} : {}), ...(decisions ? { decisions } : {}), ...(prompts ? {
      skillPrompts: prompts, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, typedDecisions: { mode: 'off' },
      // Auxiliary finalization must not consume evaluation scripts or provider
      // budgets. Foreground native model and tool dispatch remain unchanged.
      llm: { async *stream() { throw new Error('Auxiliary model generation is unavailable in isolated Skill evaluation') } },
    } : {})}
    adapter = subject.createDshHostAdapter(ctx,adapterOptions)
    hostFiber = await ctx.plugin({name:'explicit-skill-host',apply(c:any){return c.provide('kiokukoDsh',adapter!.host)}})
    fibers.push(hostFiber)
  }
  plugin = prompts
    ? await subject.mountDshComposition(ctx, adapter!.host, subject.Config.parse({ ...extra }).lisp, prompts)
    : await mountPlugin(mode)
  if(explicit==='prompt-only'){
    for(const m of [session,projection,tools,agents,commands,skillTool]) {
      if (m === tools) await mountNativeTools(ctx, tools, packages, fibers)
      else if (m !== skillTool || skillToolPlacement === 'global') fibers.push(await ctx.plugin(m.default??m))
    }
    fibers.push(await ctx.plugin(loop.default,{agents:[]}))
  }
  if (skillToolPlacement === 'late') fibers.push(await ctx.plugin(skillTool.default ?? skillTool))
  const agent = await ctx.agentLoop.create(session.SessionId('skill-main'),{provider:'mock',model:'qwen3-coder'},{cwd:workspace})
  if (skillToolPlacement === 'agent') fibers.push(await agent.ctx.plugin(skillTool.default ?? skillTool))
  offQuestions = nativeAnswer ? agent.ctx.on('user-questions/request', nativeAnswer) : undefined
  const errors: unknown[]=[]
  off=ctx.on('agent/error',(e:any)=>errors.push(e.error))
  const turn=async(input='この内容を日本語で説明してください。')=>{agent.followup(llm.createUserMessage({content:[{type:'text',text:input}],source:{kind:'user'}}));await agent.whenIdle();assert.deepEqual(errors,[])}
  return {ctx,agent,model,responses,mock,turn,adapter,dir:workspace,llm,startupQuestions,
    async reload(nextMode: 'full'|'compiled') { if (prompts) throw new Error('Snapshot fixtures cannot change representation'); await plugin!.dispose(); plugin=await mountPlugin(nextMode) },
    async reloadHost(nextMode: 'full'|'compiled') {
      if (explicit!==true || prompts || !adapterOptions) throw new Error('Full host reload requires the explicit native host fixture')
      await plugin!.dispose(); plugin=undefined
      await adapter!.dispose(); adapter=undefined
      await hostFiber.dispose(); fibers.splice(fibers.indexOf(hostFiber),1)
      adapter=subject.createDshHostAdapter(ctx,adapterOptions)
      hostFiber=await ctx.plugin({name:'explicit-skill-host',apply(c:any){return c.provide('kiokukoDsh',adapter!.host)}})
      fibers.push(hostFiber);plugin=await mountPlugin(nextMode)
    },
    close }
  } catch (error) { await close(); throw error }
}
