import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createDshHostAdapter } from '../../../src/dsh/host-adapter.js'
import { mountDshComposition } from '../../../src/dsh/composition.js'
import { nativeMock } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()

const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT
  ?? join(process.cwd(), 'tests/fixtures/dsh-runtime-current/node_modules')
const dshManifest = join(packageRoot, '@deepseek-ai/dsh/package.json')
const explicitRuntime = process.env.KIOKUKO_DSH_PACKAGE_ROOT !== undefined || process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1'
if (!existsSync(dshManifest) && explicitRuntime) throw new Error('Current DSH native subagent runtime is required')
const available = existsSync(dshManifest)
if (available) {
  const version = JSON.parse(readFileSync(dshManifest, 'utf8')).version
  if (version !== '0.1.7-rc.2') throw new Error(`Subagent test requires DSH 0.1.7-rc.2, received ${version}`)
}
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
function continuableIds(agent: any): string[] {
  return agent.session.snapshotEvents().flatMap((event: any) => event.type === 'tool/result'
    ? event.data.message?.content?.flatMap((block: any) => {
      const match = block.type === 'text' ? /^started subagent (\S+)$/.exec(block.text) : null
      return match ? [match[1]!] : []
    }) ?? [] : [])
}

for (const mode of ['foreground', 'parallel', 'fork', 'failure'] as const) test(`shipped standard preset ${mode} runs without Kiokuko child intake`, {
  skip: current ? false : 'requires the pinned DSH 0.1.7-rc.2 runtime', timeout: 120_000,
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
  let parent: any
  let releaseChildren: (() => void) | undefined
  try {
    await mkdir(repository)
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
      const row = findPatchRows(patches, id).find(item => item.config?.backgroundMode === 'continuable')
      assert.equal(row?.name, '@deepseek-ai/dsh-tool-subagent')
      assert.equal(row?.config?.provider, provider)
      assert.equal(row?.config?.toolName, toolName)
      assert.equal(row?.config?.backgroundMode, 'continuable')
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
    let bothStarted!: () => void
    const childrenStarted = new Promise<void>(resolve => { bothStarted = resolve })
    let childRequests = 0
    let finishChildren!: () => void
    const childrenFinished = new Promise<void>(resolve => { finishChildren = resolve })
    ctx.on('subagent/start', (info: any) => { started.push({ ...info, header: ctx.sessions.get(info.id)?.header }) })
    ctx.on('subagent/end', (info: any) => { ended.push(info); if (ended.length === (mode === 'parallel' ? 2 : 1)) finishChildren() })
    let parentRequests = 0
    class ScriptedAdapter extends llm.LlmAdapter {
      async listModels(provider: string) { return [{ provider, id: 'mock', name: 'mock' }] }
      async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
      async *stream(options: any) {
        requests.push(options)
        const child = options.sessionId !== 'standard-parent'
        if (child && mode === 'failure') throw new Error('child fixture failure')
        if (child && mode === 'parallel') {
          if (++childRequests === 2) bothStarted()
          await childrenReleased
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
          : mode === 'fork' && parentStep === 1 ? mock.textResponse('PARENT_SEED')
          : mode === 'fork' && parentStep === 2 ? tool('fork-1', 'subagent_fork', false)
          : mode === 'parallel' && parentStep === 1 ? multi([['spawn-1', 'subagent'], ['spawn-2', 'subagent']])
          : (mode === 'foreground' || mode === 'failure') && parentStep === 1 ? tool('spawn-1', 'subagent', false)
          : mock.textResponse('PARENT_COMPLETE')
        for (const chunk of chunks) yield chunk
      }
    }
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter())
    const questions: any[] = []
    const nativeQuestions = ctx.get('userQuestions', false)
    assert.ok(nativeQuestions)
    nativeQuestions.ask = async (request: any) => {
      questions.push(request)
      if (request.agent?.session?.header?.origin === 'subagent') throw new Error('Kiokuko asked a generic child')
      return { answers: request.questions.map((question: any) => ({ id: question.id,
        selected: [question.id === 'enno-execution-mode' ? '通常実行' : question.options?.[0]?.label ?? 'build'] })) }
    }
    adapter = createDshHostAdapter(ctx as typeof cordis.Context, {
      repositoryRoot: repository, databasePath: join(temporary, 'kiokuko.sqlite3'),
      migrationsDirectory: join(process.cwd(), 'migrations'), orca: { enabled: false },
    })
    composition = await mountDshComposition(ctx, adapter.host)
    parent = await ctx.agents.create({ sessionId: session.SessionId('standard-parent'),
      agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: repository },
      setup: (agentCtx: any) => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined) })
    const names = ctx.tools.schemas(parent.agent).map((schema: any) => schema.name)
    assert.ok(names.includes('subagent'))
    assert.ok(names.includes('subagent_fork'))
    if (mode === 'fork') {
      parent.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Remember the first completed turn.' }], source: { kind: 'user' } }))
      await parent.agent.whenIdle()
    }
    parent.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Implement a bounded change using a subagent.' }], source: { kind: 'user' } }))
    if (mode === 'parallel') {
      try {
        await waitBounded(childrenStarted, 'Two children did not start together')
        assert.equal(ended.length, 0, 'both children must start before either finishes')
        await waitBounded(parent.agent.whenIdle(), 'Continuable launch did not return before child completion')
        const ids = continuableIds(parent.agent)
        assert.equal(ids.length, 2, 'both continuable launches must return child ids')
        assert.equal(new Set(ids).size, 2)
        assert.deepEqual(new Set(ids), new Set(started.map(item => item.id)))
      } finally { releaseChildren?.() }
    }
    await parent.agent.whenIdle()
    if (mode === 'parallel') await waitBounded(childrenFinished, 'Continuable children did not settle')
    assert.ok(requests.some(request => request.sessionId !== 'standard-parent'),
      `real child LLM request must occur: ${JSON.stringify({ requests: requests.map(request => ({ sessionId: request.sessionId, tools: request.tools?.map((tool: any) => tool.name) })), questions: questions.map(request => request.questions?.map((question: any) => ({ id: question.id, options: question.options?.map((option: any) => option.label) }))), events: parent.agent.session.snapshotEvents().filter((event: any) => event.type === 'tool/result' || event.type === 'tool/call').map((event: any) => event.data) })}`)
    assert.equal(questions.some(request => request.agent?.session?.header?.origin === 'subagent'), false)
    assert.ok(requests.some(request => request.sessionId === 'standard-parent' &&
      request.tools?.some((tool: any) => tool.name === 'subagent') &&
      request.tools?.some((tool: any) => tool.name === 'subagent_fork')), 'both tools must reach the parent model request')
    if (mode !== 'parallel') {
      const result = parent.agent.session.snapshotEvents().find((event: any) => event.type === 'tool/result')
      assert.match(JSON.stringify(result), mode === 'failure' ? /subagent run failed/ : /CHILD_COMPLETE/)
      if (mode === 'failure') assert.equal(result?.data.message.isError, true)
    }
    assert.equal(started.length, mode === 'parallel' ? 2 : 1,
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
    if (mode === 'fork') {
      const seed = JSON.stringify(requests.find(request => request.sessionId !== 'standard-parent')?.messages)
      assert.match(seed, /PARENT_SEED/)
      assert.doesNotMatch(seed, /Implement a bounded change using a subagent\./)
    }
    if (mode === 'parallel') {
      await parent.agent.whenIdle()
      const notices = parent.agent.session.snapshotEvents().flatMap((event: any) => event.type === 'agent/inbox/spliced' ? event.data?.inserted ?? [] : [])
        .filter((message: any) => message.source?.kind === 'subagent-settled')
      assert.equal(notices.length, 2)
      assert.ok(notices.every((notice: any) => JSON.stringify(notice).includes('CHILD_COMPLETE')))
      assert.deepEqual(new Set(notices.map((notice: any) => notice.source.senderSessionId)), new Set(continuableIds(parent.agent)))
    }
  } finally {
    releaseChildren?.()
    composition?.stopIngress()
    let cleanupError: unknown
    for (const cleanup of [
      () => adapter?.dispose(), () => parent?.dispose(), () => composition?.dispose(),
      () => ctx?.fiber.dispose(), () => rm(temporary, { recursive: true, force: true }),
    ]) {
      try { await cleanup() } catch (error) { cleanupError ??= error }
    }
    if (cleanupError !== undefined) throw cleanupError
  }
})
