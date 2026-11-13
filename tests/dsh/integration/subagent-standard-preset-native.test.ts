import { executeNativeTool } from '../helpers/native-tools.js'
import { continuableSessionIds } from '../helpers/subagent-receipts.js'
import { answerTaskStartup } from '../helpers/task-startup-fixture.js'
import {fixtureDefinition,toolValue,interpretedPreparation} from '../helpers/coding-script.js'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { nativeMock, nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
import { TASK_PREPARE_TOOL } from '../../../src/dsh/on-demand-intake.js'
import { mountLispSurface } from '../../../src/dsh/lisp/surface.js'
import { LispConfig } from '../../../src/dsh/lisp/contracts.js'

isolateSkillHome()

const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT
  ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const dshManifest = join(packageRoot, '@deepseek-ai/dsh/package.json')
const explicitRuntime = process.env.KIOKUKO_DSH_PACKAGE_ROOT !== undefined || process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1'
if (!existsSync(dshManifest) && explicitRuntime) throw new Error('Current DSH native subagent runtime is required')
const available = existsSync(dshManifest)
const current = available
const moduleUrl = (name: string) => pathToFileURL(join(packageRoot, '@deepseek-ai', name, 'lib/index.js')).href
function findPatchRows(value: unknown, id: string): Record<string, any>[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(item => findPatchRows(item, id))
  const row = value as Record<string, any>
  return [...(row.id === id ? [row] : []), ...Object.values(row).flatMap(item => findPatchRows(item, id))]
}
async function waitBounded(promise: Promise<unknown>, failure: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(failure)), 10_000) })])
  } finally { if (timer) clearTimeout(timer) }
}
for (const mode of ['unprepared-spawn', 'unprepared-fork', 'foreground', 'parallel', 'parallel-staggered', 'fork', 'fork-lisp', 'failure', 'authority'] as const) test(`shipped standard preset ${mode} runs without Kiokuko child intake`, {
  skip: current ? false : 'requires the canonical current DSH runtime', timeout: 120_000,
}, async () => {
  const [cordis, appBoot, llm, session, cmdline] = await Promise.all([
    import(moduleUrl('cordis')), import(moduleUrl('dsh-app-boot')),
    import(moduleUrl('dsh-llm')), import(moduleUrl('dsh-session')), import(moduleUrl('dsh-cmdline')),
  ])
  const temporary = await mkdtemp(join(tmpdir(), 'kiokuko-standard-subagent-'))
  const profileDir = join(temporary, 'profiles/spec')
  const repository = join(temporary, 'repository')
  let ctx: any
  let adapter: ReturnType<typeof createDshHostAdapter> | undefined
  let composition: Awaited<ReturnType<typeof mountDshComposition>> | undefined
  let lisp: Awaited<ReturnType<typeof mountLispSurface>> | undefined
  let parent: any
  let releaseChildren: (() => void) | undefined
  let releaseSecondChild: (() => void) | undefined
  const parallel = mode === 'parallel' || mode === 'parallel-staggered'
  const unprepared = mode === 'unprepared-spawn' || mode === 'unprepared-fork'
  const fork = mode.startsWith('fork') || mode === 'unprepared-fork'
  try {
    await mkdir(repository)
    await writeFile(join(repository, 'authority.txt'), 'original')
    await mkdir(profileDir, { recursive: true })
    const base = join(packageRoot, '@deepseek-ai/dsh-base')
    const web = join(packageRoot, '@deepseek-ai/dsh-web-app')
    const bundle = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')).dsh.bundle
    const patches = [
      ...appBoot.loadOverlayPatches('subagent-test', join(base, 'cordis.patch.yml')),
      ...appBoot.bundlePatchPaths(web, bundle).flatMap((file: string) => appBoot.loadOverlayPatches('subagent-test', file)),
    ]
    for (const [id, provider, toolName] of [
      ['tool-subagent', 'spawn', 'subagent'], ['tool-subagent-fork', 'fork', 'subagent_fork'],
    ] as const) {
      const row = findPatchRows(patches, id).find(item => item.config?.provider === provider && item.config?.toolName === toolName)
      assert.equal(row?.name, '@deepseek-ai/dsh-tool-subagent')
      assert.equal(row?.config?.provider, provider)
      assert.equal(row?.config?.toolName, toolName)
    }
    const overrides = [
      { id: 'storage-json', config: { root: join(temporary, 'storage') } },
      { id: 'session-persistence-jsonl', config: { root: join(temporary, 'sessions') } },
      ...['webserver', 'hmr', 'web-runtime', 'session-telemetry-otel', 'modules', 'connection',
        'session-log-download', 'open-in-app', 'client-hmr', 'directory-picker'].map(id => ({ id, disabled: true })),
      { insert: [{ id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' }] },
      { id: 'agent-preset-registry', config: { default: 'standard' } },
    ]
    await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
    const installAnchor = join(packageRoot, '@deepseek-ai/dsh/package.json')
    const profile = { skippedBundles: [], name: 'spec', dir: profileDir, layers: [],
      patchPath: join(profileDir, 'cordis.patch.yml'), patches: [] }
    const resolution = await appBoot.createRuntimeResolution({ installAnchor, home: temporary, profile })
    ctx = await appBoot.boot('subagent-test', join(profileDir, 'cordis.yml'), [...patches, ...overrides], async (bootCtx: any) => {
      bootCtx.provide('profileContext', { name: 'spec', dir: profileDir, patchPath: profile.patchPath,
        installAnchor, home: temporary, cwd: repository,
        startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], overlays: [], telemetryDisabledEnv: '1' })
      await bootCtx.plugin(appBoot.PluginPackages, { resolution })
      bootCtx.provide('connection', { fetch: { register: () => () => {} }, rpc: { intercept: () => () => {} } })
      cmdline.provideCmdline(bootCtx, { args: [], exit: () => {} })
    })
    const mock = nativeMock(llm)
    const requests: any[] = []
    const started: any[] = [], ended: any[] = []
    const childrenReleased = new Promise<void>(resolve => { releaseChildren = resolve })
    const secondChildReleased = new Promise<void>(resolve => { releaseSecondChild = resolve })
    let bothStarted!: () => void
    const childrenStarted = new Promise<void>(resolve => { bothStarted = resolve })
    let childRequests = 0
    let finishChildren!: () => void
    const childrenFinished = new Promise<void>(resolve => { finishChildren = resolve })
    let firstSpliced!: () => void
    const firstNoticeSpliced = new Promise<void>(resolve => { firstSpliced = resolve })
    ctx.on('session/event', (nativeSession: any, event: any) => {
      if (nativeSession.id === 'standard-parent' && event.type === 'agent/inbox/spliced'
        && event.data?.inserted?.some((message: any) => message.source?.kind === 'subagent-settled')) firstSpliced()
    })
    ctx.on('subagent/start', (info: any) => { started.push({ ...info, header: ctx.sessions.get(info.id)?.header }) })
    ctx.on('subagent/end', (info: any) => { ended.push(info); if (ended.length === (parallel ? 2 : 1)) finishChildren() })
    let parentRequests = 0
    let childStep = 0
    const childAgents: any[] = [], authorityResults: any[] = []
    let continuationDone!: () => void
    const continuationFinished = new Promise<void>(resolve => { continuationDone = resolve })
    ctx.on('subagent/start', (event: any) => { childStep = 0; childAgents.push(ctx.agents.get(event.id)) })
    ctx.on('subagent/end', () => { if (ended.length === 2) continuationDone() })
    const invoke = (agent: any, name: string, args: any, callId: string) => executeNativeTool(ctx, packageRoot, {
      agent, name, arguments: args, callId, signal: new AbortController().signal,
    })
    class ScriptedAdapter extends llm.LlmAdapter {
      async listModels(provider: string) { return [{ provider, id: 'mock', name: 'mock' }] }
      async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      async *stream(options: any) {
        if (options.purpose === 'akinator-expected') { yield* mock.textResponse('{"expected":null}'); return }
        requests.push(options)
        const child = options.sessionId !== 'standard-parent'
        if (child && mode === 'authority') {
          if (++childStep === 1) {
            yield* mock.toolCallResponse(`edit-${started.length}`, 'kioku_edit', {
              path: 'authority.txt', oldText: started.length === 1 ? 'original' : 'first', newText: started.length === 1 ? 'first' : 'resumed',
            }); return
          }
          const agent = ctx.agents.get(options.sessionId)
          for (const [name, args] of [[TASK_PREPARE_TOOL, { taskType: 'build' }], ['task_operation', { operation: 'create', taskType: 'build' }]] as const) {
            authorityResults.push({ name, result: await invoke(agent, name, args, `child-${name}-${started.length}`) })
          }
          const forged = { id: agent.id, session: agent.session, ctx: agent.ctx }
          authorityResults.push({ name: 'forged', result: await invoke(forged, 'kioku_write', { path: 'authority.txt', content: 'forged' }, `forged-${started.length}`) })
          yield* mock.textResponse('CHILD_COMPLETE'); return
        }
        if (child && mode.startsWith('fork')) {
          childStep++
          if (childStep === 1) { yield* mock.toolCallResponse('child-read', 'read', { file_path: 'authority.txt' }); return }
          const read = nativeToolResults(options.messages).find((result: any) => result.toolCallId === 'child-read')
          assert.ok(read && !read.isError, JSON.stringify(read))
          assert.match(JSON.stringify(read.content), /original/)
          if (childStep === 2) { yield* mock.toolCallResponse('child-completion', 'task_completion', { action: 'status' }); return }
          const completion = nativeToolResults(options.messages).find((result: any) => result.toolCallId === 'child-completion')
          assert.ok(completion && !completion.isError, JSON.stringify(completion))
          if (childStep === 3) { yield* mock.toolCallResponse('child-workflow', 'coding_workflow', { action: 'status' }); return }
          const workflow = nativeToolResults(options.messages).find((result: any) => result.toolCallId === 'child-workflow')
          assert.ok(workflow && !workflow.isError, JSON.stringify(workflow))
          assert.equal(toolValue(options, 'child-workflow').applicable, true)
          if (childStep === 4) {
            yield* mock.toolCallResponse('child-bind-denied', 'task_completion', { action: 'bind', criterionId: 'parent-check',
              method: { kind: 'native_command', command: 'printf original', cwd: repository, sourcePaths: ['authority.txt'],
                assertion: 'output_matches', expectedOutput: 'original' } }); return
          }
          const bind = nativeToolResults(options.messages).find((result: any) => result.toolCallId === 'child-bind-denied')
          assert.ok(bind?.isError, 'child status access must not grant parent verification binding')
          assert.match(JSON.stringify(bind), /exact active native run/)
          if (mode === 'fork-lisp') {
            assert.equal(toolValue(options, 'child-workflow').choice.state, 'yes')
            assert.ok(options.tools.some((tool: any) => tool.name === 'lisp_eval'), 'the admitted child keeps its own Lisp surface')
            if (childStep === 5) { yield* mock.toolCallResponse('child-lisp', 'lisp_eval', { operationId: 'child-lisp', code: '(+ 20 22)' }); return }
            const evaluated = toolValue(options, 'child-lisp')
            assert.equal(evaluated.ok, true, JSON.stringify(evaluated))
            assert.equal(evaluated.value.json, 42)
          }
          yield* mock.textResponse('CHILD_COMPLETE'); return
        }
        if (child && mode === 'failure') throw new Error('child fixture failure')
        if (child && parallel) {
          const childRequest = ++childRequests
          if (childRequest === 2) bothStarted()
          await childrenReleased
          if (mode === 'parallel-staggered' && childRequest === 2) await secondChildReleased
        }
        const tool = (id: string, name: string, background: boolean) => mock.toolCallResponse(id, name,
          { description: 'Implement bounded change', prompt: `Implement ${id} bounded change.`, ...(background ? {} : { run_in_background: false }) })
        const multi = (calls: readonly [string, string][]) => [
          ...calls.flatMap(([id, name], index) => [
            { type: 'block-start', index, blockType: 'tool-call' },
            { type: 'tool-call-delta', index, id, name, argumentsDelta: JSON.stringify({ description: 'Implement bounded change', prompt: `Implement ${id} bounded change.` }) },
            { type: 'block-end', index, block: { type: 'tool-call', id, name,
              arguments: JSON.stringify({ description: 'Implement bounded change', prompt: `Implement ${id} bounded change.` }) } },
          ]),
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ]
        const parentStep = child || !options.tools?.length ? 0 : ++parentRequests
        const chunks = child ? mock.textResponse('CHILD_COMPLETE')
          : fork && parentStep === 1 ? mock.textResponse('PARENT_SEED')
          : unprepared ? parentStep === (fork ? 2 : 1)
            ? tool('unprepared-child', fork ? 'subagent_fork' : 'subagent', false)
            : parentStep === (fork ? 3 : 2)
              ? (() => {
                const rejected = nativeToolResults(options.messages).find(message => message.toolCallId === 'unprepared-child')
                assert.ok(rejected?.isError, 'unprepared delegation must not launch a child')
                assert.match(JSON.stringify(rejected), /Native delegation requires a prepared parent task/)
                assert.match(JSON.stringify(rejected), /requestIntent.*evidenceRefs/)
                assert.equal(started.length, 0)
                return interpretedPreparation(mock, 'prepare-parent', 'new', 'change', 'build')(options)
              })()
              : parentStep === (fork ? 4 : 3)
                ? tool('recovered-child', fork ? 'subagent_fork' : 'subagent', false)
                : mock.textResponse('PARENT_COMPLETE')
          : parentStep === (mode.startsWith('fork') ? 2 : 1) ? interpretedPreparation(mock, 'prepare-parent', 'new', 'change', 'build')(options)
          : parentStep === (mode.startsWith('fork') ? 3 : 2) ? mock.toolCallResponse('goal-status','coding_workflow',{action:'status'})
          : parentStep === (mode.startsWith('fork') ? 4 : 3) ? (() => {
              const status = toolValue(options, 'goal-status')
              return mock.toolCallResponse('goal-propose','coding_workflow',{action:'propose',expectedRevision:status.revision,definition:fixtureDefinition()})
            })()
          : mode.startsWith('fork') && parentStep === 5 ? tool('fork-1', 'subagent_fork', false)
          : parallel && parentStep === 4 ? multi([['spawn-1', 'subagent'], ['spawn-2', 'subagent']])
          : (mode === 'foreground' || mode === 'failure' || mode === 'authority') && parentStep === 4 ? tool('spawn-1', 'subagent', false)
          : mock.textResponse('PARENT_COMPLETE')
        for (const chunk of chunks) yield chunk
      }
    }
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter())
    const questions: any[] = []
    const nativeQuestions = ctx.get('userQuestions', false)
    assert.ok(nativeQuestions)
    nativeQuestions.ask = async (request: any) => {
      assert.notEqual(request.agent?.session?.header?.origin, 'subagent', 'generic children must never receive startup or intake questions')
      if (request.questions[0]?.id.startsWith('task-startup:')) return answerTaskStartup(request, mode === 'fork-lisp' ? 'decision OFF / Lisp ON' : 'decision OFF / Lisp OFF')
      questions.push(request)
      if (request.agent?.session?.header?.origin === 'subagent') throw new Error('Kiokuko asked a generic child')
      return { answers: request.questions.map((question: any) => ({ id: question.id,
        selected: [question.id.startsWith('coding-lisp-') ? '使わない' : question.id === 'execution-mode' ? '通常実行' : question.options?.[0]?.label ?? 'build'] })) }
    }
    const hostRepository = mode.startsWith('fork') ? join(temporary, 'host-workspace') : repository
    if (hostRepository !== repository) await mkdir(hostRepository)
    adapter = createDshHostAdapter(ctx as typeof cordis.Context, {
      repositoryRoot: hostRepository, databasePath: join(temporary, 'kiokuko.sqlite3'),
      migrationsDirectory: join(process.cwd(), 'migrations'), agenticReplay: { enabled: false }, typedDecisions: { mode: 'off' },
    })
    composition = await mountDshComposition(ctx, adapter.host)
    if (mode === 'fork-lisp') lisp = await mountLispSurface(ctx, adapter.host.runtime!, LispConfig.parse({
      enabled: true, executionMode: 'development', sbclPath: process.env.KIOKUKO_LISP_SBCL, startupTimeoutMs: 60000,
    }))
    parent = await ctx.agents.create({ sessionId: session.SessionId('standard-parent'),
      agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: repository },
      setup: (agentCtx: any) => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined) })
    const names = ctx.tools.schemas(parent.agent).map((schema: any) => schema.name)
    assert.ok(names.includes('subagent'))
    assert.ok(names.includes('subagent_fork'))
    if (fork) {
      parent.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Remember the first completed turn.' }], source: { kind: 'user' } }))
      await parent.agent.whenIdle()
    }
    parent.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Implement a bounded change using a subagent.' }], source: { kind: 'user' } }))
    if (parallel) {
      try {
        await waitBounded(childrenStarted, 'Two children did not start together')
        assert.equal(ended.length, 0, 'both children must start before either finishes')
        await waitBounded(parent.agent.whenIdle(), 'Continuable launch did not return before child completion')
        const ids = await continuableSessionIds(parent.agent, ctx.subagents)
        assert.equal(ids.length, 2, 'both continuable launches must return child ids')
        assert.equal(new Set(ids).size, 2)
        assert.deepEqual(new Set(ids), new Set(started.map(item => item.id)))
        releaseChildren?.()
        if (mode === 'parallel-staggered') {
          await waitBounded(firstNoticeSpliced, 'First child notification did not reach the parent')
          await waitBounded(parent.agent.whenIdle(), 'Parent did not settle after the first child notification')
          assert.equal(ended.length, 1, 'second child stays running while the parent consumes the first result')
        }
      } finally { releaseChildren?.(); releaseSecondChild?.() }
    }
    await parent.agent.whenIdle()
    if (unprepared) {
      const firstRequest = requests.find(request => request.sessionId === 'standard-parent' && request.tools?.length)
      assert.match(JSON.stringify(firstRequest?.messages), /Native delegation requires a prepared parent task/,
        'the parent must receive the prerequisite before its first delegation, not only after failure')
      const launch = parent.agent.session.snapshotEvents().find((event: any) => event.type === 'tool/result' && event.data.message.toolCallId === 'recovered-child')
      assert.ok(launch && !launch.data.message.isError, JSON.stringify(launch?.data ?? { error: 'Missing native delegation result' }))
    }
    await waitBounded(childrenFinished, 'Continuable children did not settle')
    assert.ok(requests.some(request => request.sessionId !== 'standard-parent'),
      `real child LLM request must occur: ${JSON.stringify({ requests: requests.map(request => ({ sessionId: request.sessionId, tools: request.tools?.map((tool: any) => tool.name) })), questions: questions.map(request => request.questions?.map((question: any) => ({ id: question.id, options: question.options?.map((option: any) => option.label) }))), events: parent.agent.session.snapshotEvents().filter((event: any) => event.type === 'tool/result' || event.type === 'tool/call').map((event: any) => event.data) })}`)
    const preparation = parent.agent.session.snapshotEvents().find((event: any) => event.type === 'tool/result' && event.data.message.toolCallId === 'prepare-parent')
    assert.ok(preparation && !preparation.data.message.isError, 'explicit parent preparation must succeed')
    if (!unprepared) {
      const initialStatus = parent.agent.session.snapshotEvents().find((event: any) => event.type === 'tool/result' && event.data.message.toolCallId === 'goal-status')
      assert.equal(toolValue({ messages: [initialStatus.data.message] }, 'goal-status').choice.state, mode === 'fork-lisp' ? 'yes' : 'no',
        'the confirmed startup Lisp choice must survive task admission before a Goal exists')
    }
    assert.equal(questions.some(request => request.agent?.session?.header?.origin === 'subagent'), false)
    const parentRows = await adapter.host.runtime!.withDatabase(db => db.prepare('SELECT COUNT(*) AS count FROM ledger_runs WHERE dsh_session_id=?').get<{ count: number }>(parent.agent.session.id))
    assert.equal(parentRows?.count, 1, 'recovery must prepare exactly one parent run')
    assert.ok(requests.some(request => request.sessionId === 'standard-parent' &&
      request.tools?.some((tool: any) => tool.name === 'subagent') &&
      request.tools?.some((tool: any) => tool.name === 'subagent_fork')), 'both tools must reach the parent model request')
    if (!parallel) {
      const result = parent.agent.session.snapshotEvents().find((event: any) => event.type === 'tool/result' &&
        event.data.message.toolCallId === (unprepared ? 'recovered-child' : fork ? 'fork-1' : 'spawn-1'))
      const child = ended.find(item => item.id === started[0]?.id)
      assert.ok(child)
      if (mode === 'failure') {
        assert.equal(child.stopReason, 'error')
      } else {
        assert.equal(child.stopReason, 'completed', JSON.stringify(requests.filter(request => request.sessionId !== 'standard-parent')
          .flatMap(request => nativeToolResults(request.messages)).filter(result => result.toolCallId.startsWith('child-'))))
        assert.match(JSON.stringify(child.lastAssistantMessage), /CHILD_COMPLETE/)
      }
      assert.equal(result?.data.message.isError, false, 'launch result reports asynchronous child startup')
    }
    assert.equal(started.length, parallel ? 2 : 1,
      JSON.stringify(parent.agent.session.snapshotEvents().filter((event: any) => event.type === 'tool/call' || event.type === 'tool/result').map((event: any) => event.data)))
    assert.equal(ended.length, started.length)
    assert.equal(new Set(started.map(item => item.id)).size, started.length)
    for (const child of started) {
      assert.ok(ended.some(item => item.runId === child.runId))
      assert.equal(child.header?.origin, 'subagent')
      assert.equal(child.header?.parentSession, parent.agent.session.id)
      assert.throws(() => adapter!.host.toolHost!.bind({ agent: {
        dshSessionId: child.id, nativeSession: ctx.sessions.get(child.id),
      } } as any), /not bound to an active run/)
      const childRows: { count: number } | undefined = await adapter.host.runtime!.withDatabase(db => db.prepare('SELECT count(*) AS count FROM ledger_runs WHERE dsh_session_id = ?').get<{count:number}>(child.id))
      assert.equal(childRows?.count, 0)
    }
    if (fork) {
      const seed = JSON.stringify(requests.find(request => request.sessionId !== 'standard-parent')?.messages)
      assert.match(seed, /PARENT_SEED/)
      assert.doesNotMatch(seed, /Implement a bounded change using a subagent\./)
    }
    if (mode === 'authority') {
      assert.equal(readFileSync(join(repository, 'authority.txt'), 'utf8'), 'first', 'first child effect needs no child intake')
      authorityResults.push({ name: 'ended', result: await invoke(childAgents[0], 'kioku_write', { path: 'authority.txt', content: 'ended' }, 'ended-child') })
      await ctx.subagents.sendMessage(parent.agent, started[0].id, [{ type: 'text', text: 'Continue the delegated edit.' }],
        { delivery: 'queue', signal: new AbortController().signal })
      await waitBounded(continuationFinished, 'Resumed child did not settle')
      assert.equal(readFileSync(join(repository, 'authority.txt'), 'utf8'), 'resumed', 'first resumed effect uses the original task lease')
      const unregistered = await ctx.agents.create({ sessionId: session.SessionId('unregistered-child'),
        agentOptions: { provider: 'mock', model: 'mock' },
        meta: { cwd: repository, origin: 'subagent', parentSession: parent.agent.session.id, delegationDepth: 1 },
        setup: (agentCtx: any) => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined) })
      try {
        authorityResults.push({ name: 'unregistered', result: await invoke(unregistered.agent, 'kioku_write', { path: 'authority.txt', content: 'unregistered' }, 'unregistered-edit') })
      } finally { await unregistered.dispose() }
      assert.equal(authorityResults.length, 8, 'both activations probe parent tools and forgery, plus ended and unregistered edits')
      for (const { name, result } of authorityResults) {
        assert.equal(result.isError, true, JSON.stringify({ name, result }))
        assert.match(JSON.stringify(result), name === 'forged' ? /runtime_identity_mismatch/ : name === 'ended' ? /activation_ended/ : name === 'unregistered' ? /launch_not_reserved/ : /parent-only/, name)
      }
      for (const request of requests.filter(request => request.sessionId !== 'standard-parent')) {
        for (const tool of request.tools?.filter((tool: any) => [TASK_PREPARE_TOOL, 'task_operation'].includes(tool.name)) ?? []) {
          assert.match(tool.description, /Parent-only/, 'schema must not suggest these tools recover child authority')
        }
        const system = JSON.stringify(request.messages.filter((message: any) => message.role === 'system'))
        assert.match(system, /Delegated work uses the host-reserved parent task authority/)
        assert.doesNotMatch(system, /The public prepare_requested_work tool accepts/)
      }
      assert.equal(readFileSync(join(repository, 'authority.txt'), 'utf8'), 'resumed', 'all rejected edits leave content unchanged')
    }
    if (parallel) {
      await parent.agent.whenIdle()
      const notices = parent.agent.session.snapshotEvents().flatMap((event: any) => event.type === 'agent/inbox/spliced' ? event.data?.inserted ?? [] : [])
        .filter((message: any) => message.source?.kind === 'subagent-settled')
      assert.equal(notices.length, 2)
      assert.ok(notices.every((notice: any) => JSON.stringify(notice).includes('CHILD_COMPLETE')))
      assert.deepEqual(new Set(notices.map((notice: any) => notice.source.senderSessionId)), new Set(await continuableSessionIds(parent.agent, ctx.subagents)))
    }
  } finally {
    releaseChildren?.()
    releaseSecondChild?.()
    composition?.stopIngress()
    let cleanupError: unknown
    for (const cleanup of [
      () => lisp?.dispose(), () => adapter?.dispose(), () => parent?.dispose(), () => composition?.dispose(),
      () => ctx?.fiber.dispose(), () => rm(temporary, { recursive: true, force: true }),
    ]) {
      try { await cleanup() } catch (error) { cleanupError ??= error }
    }
    if (cleanupError !== undefined) throw cleanupError
  }
})
