import type { Context } from '@deepseek-ai/cordis'
import type { DshSkillPrompts } from '../skill-prompts.js'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { DshRuntime } from '../runtime.js'
import type { DshNativeCommandDefinition } from '../commands.js'
import type { DshUserQuestions } from '../user-interaction.js'
import { LispManager } from './manager.js'
import { LispStore } from './store.js'
import { createLispCodingChoice, LISP_CODING_SERVICE } from './coding-choice.js'
import { LISP_ASSEMBLY_SERVICE, type LispAssemblyService } from './request-surface.js'
import { mountLispHttp } from './http.js'
import { createLispCiAdapter } from './ci.js'
import { attachmentInput, type LispAttachmentSession, type LispAttachmentStore } from './attachment-input.js'
import { LISP_TOOLS, failure, fail, identifier, renderResult, type LispConfiguration, type LispOwner, type LispTool } from './contracts.js'

interface Session extends LispAttachmentSession { id: string; header: { cwd: string; parentSession?: string } }
interface Agent { id: string; status?: string; session: Session; ctx: { get(name: string, strict?: boolean): any }; inject?: (message: unknown) => void }
interface Tools { register(definition: any): () => void; guard(fn: (execution: any) => string | undefined): () => void; get(name: string, scope?: unknown): any; schemas(scope?: unknown): { name: string; description: string; parameters: unknown }[]; presentAs(mode: 'native'): () => void; restrict(options: { allow: string[] }): () => void; execute(execution: unknown): Promise<unknown> }
interface Fence { sessions: Map<string, string>; controller?: LispManager; prepareAgent?: (agent: Agent) => Promise<boolean>; definitions: Map<string, object>; stopped: boolean }
const fenceKey = Symbol.for('kiokuko.lisp.host-fence.v1')
const LISP_READ_TOOLS = ['read', 'glob', 'grep', 'skill'] as const

/** Keep admitted inherited reads without naming agent-owned tools in restrict(). */
function restrictToReads(tools: Tools, scopedTools: Tools, agent: Agent, reads: string[]): () => void {
  // DSH restricts inherited tools (global + preset ancestors), but rejects
  // names registered on the agent itself. Its global get() cannot distinguish
  // those cases. An empty mask exposes only own registrations through the
  // public lookup API; remove it synchronously before installing the real mask.
  const restore = scopedTools.restrict({ allow: [] })
  let inherited: string[]
  try { inherited = reads.filter(name => !tools.get(name, agent)) }
  finally { restore() }
  return scopedTools.restrict({ allow: inherited })
}

function text(value: unknown): string {
  const result = value as { state?: string; enabled?: boolean; ok?: boolean; message?: string; recovery?: string; error?: { message?: string; recovery?: string }; operations?: { id: string; state: string }[] }
  if (result.message) return `${result.message}\n${result.recovery ?? ''}`
  return `Lisp: ${result.state ?? (result.ok ? '処理完了' : '状態不明')}\n${result.error?.message ?? ''}\n${result.error?.recovery ?? result.recovery ?? ''}\n${result.operations?.map(o => `${o.id}: ${o.state}`).join('\n') ?? ''}`.trim()
}
const ToolInput = z.object({ operationId: identifier.optional(), code: z.string().max(262144).optional(), inputs: z.array(z.string().max(4096)).max(100).optional(),
  timeoutMs: z.number().int().min(100).max(600000).optional(), symbol: z.string().max(256).optional(), ref: identifier.optional(), generation: identifier.optional(),
  resultOperationId: identifier.optional(), section: z.enum(['result', 'value', 'stdout', 'stderr', 'changes']).optional(),
  pointer: z.string().max(1024).optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(2000).optional() }).strict()

/** The fence belongs to the host root, so plugin unload cannot restore bash access. */
export async function mountLispSurface(ctx: Context, runtime: DshRuntime, config: LispConfiguration, skillPrompts?: DshSkillPrompts): Promise<{ stop(): void; dispose(): Promise<void>; manager: LispManager }> {
  const root = (ctx.root ?? ctx) as unknown as Context & { [fenceKey]?: Fence }
  const tools = root.get('tools', false) as Tools | undefined
  const agents = root.get('agents', false) as { get(id: string): Agent | undefined } | undefined
  const sessions = root.get('sessions', false) as { get(id: string): Session | undefined } | undefined
  const commands = ctx.get('commands', false) as { register(definition: DshNativeCommandDefinition): () => void } | undefined
  if (!tools || !agents || !sessions || !commands) fail('HOST_CAPABILITY_MISSING', 'Lisp には DSH のツール・セッション・コマンドサービスが必要です。')
  const questions = ctx.get('userQuestions', false) as DshUserQuestions | undefined
  const ownerQuestions = questions ? { ask: (request: Parameters<DshUserQuestions['ask']>[0]) => {
    const agent = request.agent ? agents.get(request.agent.id) : undefined
    if (!agent || sessions.get(agent.session.id) !== agent.session) fail('SESSION_MISMATCH', '確認画面のセッションを確認できません。')
    return questions.ask({ ...request, agent })
  } } : undefined
  const databasePath = await runtime.withDatabase(db => db.filePath)
  const store = new LispStore(fn => runtime.withDatabase(db => fn(db)))
  const manager = new LispManager({ store, config,
    ...(skillPrompts ? { skillPrompts } : {}),
    dataRoot: join(dirname(databasePath), 'lisp'), protectedRoots: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
    ...(ownerQuestions ? { questions: ownerQuestions } : {}),
    ciCall: createLispCiAdapter(ownerQuestions),
    attachmentInput: (owner, path, signal) => {
      const agent = agents.get(owner.agentId)
      if (!agent || agent.session.id !== owner.sessionId || sessions.get(owner.sessionId) !== agent.session || realpathSync(agent.session.header.cwd) !== owner.root) fail('SESSION_MISMATCH', '添付入力のセッションを確認できません。')
      return attachmentInput(agent.session, agent.ctx.get('attachments', false) as LispAttachmentStore | undefined, path, signal)
    },
    toolCall: async (owner, name, args) => {
      const agent = agents.get(owner.agentId)
      if (!agent || agent.session.id !== owner.sessionId || sessions.get(owner.sessionId) !== agent.session || realpathSync(agent.session.header.cwd) !== owner.root) fail('SESSION_MISMATCH', 'ホスト呼び出しの主体を確認できません。')
      return tools.execute({ callId: `lisp-host-${crypto.randomUUID()}`, name, arguments: args, agent, parent: Symbol('lisp-host-read'), signal: new AbortController().signal })
    },
    // The independent Web/command surface displays failures. Do not inject a
    // synthetic user request: it could start intake or a fresh model turn.
  })
  const scopeSession = (agent: Agent | undefined, fence: Fence): string | undefined => {
    let session = agent?.session
    const seen = new Set<string>()
    while (session && !seen.has(session.id)) {
      seen.add(session.id)
      if (fence.sessions.has(session.id)) return session.id
      session = session.header.parentSession ? sessions.get(session.header.parentSession) : undefined
    }
    return undefined
  }
  let fence = root[fenceKey]
  if (!fence) {
    fence = { sessions: new Map(), definitions: new Map(), stopped: true }; root[fenceKey] = fence
    const persistent = fence
    tools.guard(execution => {
      const agent = execution.agent as Agent | undefined
      const scope = scopeSession(agent, persistent)
      if (!scope) return LISP_TOOLS.includes(execution.name) ? 'このセッションでは Lisp が無効です。' : undefined
      if (persistent.stopped || !persistent.controller) return 'Lisp の保護が継続中です。プラグインを戻し /kioku-lisp status で確認してください。'
      if (!agent || agents.get(agent.id) !== agent || sessions.get(agent.session.id) !== agent.session) return 'Lisp のセッションを確認できません。'
      if (agent.session.id !== scope) return '保護中の子セッションでは任意ツールを実行できません。親セッションの Lisp を使用してください。'
      const registered = persistent.definitions.get(`${agent.id}:${execution.name}`)
      if (registered && tools.get(execution.name, agent)?.execute === (registered as { execute: unknown }).execute) return undefined
      return 'Lisp 保護中は Lisp ツールと DSH の読み取り・検索・スキル読み込みを使えます。変更は Lisp 経由で行い、削除・既存ファイルの置換には利用者の確認が必要です。'
    })
    root.on('agent/pre-step' as never, (async (payload: { agent: Agent }, next: () => Promise<unknown>) => {
      const scope = scopeSession(payload.agent, persistent)
      if (!scope) return next()
      if (persistent.stopped || !persistent.controller || scope !== payload.agent.session.id) return { kind: 'reject' }
      return await persistent.prepareAgent?.(payload.agent) ? next() : { kind: 'reject' }
    }) as never, { prepend: true, global: true })
  }
  if (fence.controller && !fence.stopped) fail('HOST_CONFLICT', 'Lisp プラグインが既に接続されています。')
  for (const saved of await runtime.withDatabase(db => db.prepare('SELECT session_id,root_path FROM dsh_lisp_sessions WHERE enabled=1').all<{session_id:string;root_path:string}>())) fence.sessions.set(saved.session_id, saved.root_path)
  await manager.start()
  fence.sessions = manager.enabled; fence.controller = manager; fence.stopped = false
  const disposers: (() => void)[] = []
  try {
  const sessionBindings = new Map<string, { session: Session; abort: AbortController }>()
  const closedSessions = new WeakSet<Session>()
  disposers.push(() => { for (const binding of sessionBindings.values()) binding.abort.abort(); sessionBindings.clear() })
  const owner = (candidate: { id: string } | undefined): { agent: Agent; owner: LispOwner; signal: AbortSignal } => {
    if (!candidate) fail('NO_SESSION', '現在のセッションから実行してください。')
    const agent = agents.get(candidate.id)
    if (!agent || agent !== candidate || sessions.get(agent.session.id) !== agent.session) fail('SESSION_MISMATCH', '現在のセッションを確認できません。')
    if (closedSessions.has(agent.session)) fail('SESSION_MISMATCH', 'このセッションは終了しています。')
    let binding = sessionBindings.get(agent.session.id)
    if (binding?.session !== agent.session) {
      binding?.abort.abort()
      binding = { session: agent.session, abort: new AbortController() }; sessionBindings.set(agent.session.id, binding)
    }
    return { agent, owner: { sessionId: identifier.parse(agent.session.id), agentId: identifier.parse(agent.id), root: realpathSync(agent.session.header.cwd) }, signal: binding.abort.signal }
  }
  const registeredAgents = new WeakSet<object>()
  const agentDisposers = new Map<string, (() => void)[]>()
  const boundAgents = new Map<string, Agent>()
  const runtimePrompts = new Map<string, () => void>()
  const unregister = (agent: Agent) => {
    if (boundAgents.get(agent.id) !== agent) return
    runtimePrompts.get(agent.id)?.(); runtimePrompts.delete(agent.id); boundAgents.delete(agent.id)
    for (const dispose of agentDisposers.get(agent.id)?.reverse() ?? []) dispose()
    agentDisposers.delete(agent.id); registeredAgents.delete(agent)
    for (const name of [...LISP_TOOLS, ...LISP_READ_TOOLS]) fence!.definitions.delete(`${agent.id}:${name}`)
  }
  disposers.push(() => { for (const dispose of runtimePrompts.values()) dispose(); runtimePrompts.clear(); boundAgents.clear(); for (const list of agentDisposers.values()) for (const dispose of list.reverse()) dispose(); agentDisposers.clear(); fence!.definitions.clear() })
  const register = (agent: Agent) => {
    if (registeredAgents.has(agent)) return
    if (boundAgents.has(agent.id)) unregister(boundAgents.get(agent.id)!)
    boundAgents.set(agent.id, agent)
    const local: (() => void)[] = []
    agentDisposers.set(agent.id, local)
    const scopedTools = agent.ctx.get('tools') as Tools
    // Do not depend on arbitrary third-party PTC runtimes enforcing our boundary.
    local.push(scopedTools.presentAs('native'))
    // Retain the host's existing read capabilities, including agent-local preset
    // tools. Pin their implementations so a later same-name registration cannot
    // acquire permission. Dispatch still traverses every native DSH policy/guard.
    const reads: string[] = []
    for (const name of LISP_READ_TOOLS) {
      const definition = tools.get(name, agent)
      if (definition) { fence!.definitions.set(`${agent.id}:${name}`, definition); reads.push(name) }
    }
    local.push(restrictToReads(tools, scopedTools, agent, reads))
    for (const name of LISP_TOOLS) {
      const definition = { name, description: description(name), modelFacing: true,
        parameters: lispToolSchema(name), output: { schema: {}, render: (_: unknown, result: unknown) => [{ type: 'text', text: renderResult(result) }] },
        execute: async (args: unknown, execution: { agent?: Agent; signal?: AbortSignal; callId?: string }) => {
          try {
            const binding = owner(execution.agent), parsed = ToolInput.parse(args)
            if (name === 'lisp_cancel') { identifier.parse(parsed.operationId); identifier.parse(parsed.generation) }
            if (name !== 'lisp_status') parsed.operationId = await store.bind(binding.owner, identifier.parse(execution.callId), identifier.parse(parsed.operationId), { name, input: parsed })
            return await manager.execute(binding.owner, name, parsed, execution.signal)
          }
          catch (error) { return failure(error) }
        } }
      fence!.definitions.set(`${agent.id}:${name}`, definition)
      local.push(scopedTools.register(definition))
    }
    registeredAgents.add(agent)
    const prompt = agent.ctx.get('systemPrompt', false) as { section(input: unknown): () => void } | undefined
    if (prompt) local.push(prompt.section({ name: 'kiokuko:lisp', order: -90000, text: guide }))
  }
  const guide = skillPrompts ? await skillPrompts.require('kiokuko-lisp') : await readFile(fileURLToPath(new URL('../../../skills/kiokuko-lisp/SKILL.md', import.meta.url)), 'utf8')
  fence.prepareAgent = async candidate => {
    const binding = owner(candidate)
    manager.setAgentBusy(binding.owner, true)
    const status = await manager.prepare(binding.owner) as { state: string; generation?: string; resumed?: boolean }
    binding.signal.throwIfAborted()
    register(binding.agent)
    const prompt = binding.agent.ctx.get('systemPrompt', false) as { section(input: unknown): () => void } | undefined
    runtimePrompts.get(candidate.id)?.(); runtimePrompts.delete(candidate.id)
    if (prompt) runtimePrompts.set(candidate.id, prompt.section({ name: 'kiokuko:lisp-runtime', order: -89999,
      text: `Current Lisp generation: ${status.generation ?? 'none'}. State: ${status.state}.` + (status.resumed
        ? ' Lisp was automatically restarted after normal suspension. Definitions, variables and object references from older generations are gone. Recreate needed helpers; never replay completed file or process effects. Compare the generation of previous tool results before reusing state.' : '') }))
    return ['READY', 'EVALUATING'].includes(status.state)
  }
  disposers.push((ctx as any).on('agent/status', (event: { agent: Agent; status: string }) => {
    if (!manager.enabled.has(event.agent.session.id) || agents.get(event.agent.id) !== event.agent || sessions.get(event.agent.session.id) !== event.agent.session) return
    manager.setAgentBusy(owner(event.agent).owner, event.status !== 'idle')
  }, { global: true }))
  disposers.push((ctx as any).on('session/disposed', async (session: Session) => {
    // The host can remove the registry entry before emitting disposal. Match the
    // exact object retained at registration, never a stale event's ID alone.
    const binding = sessionBindings.get(session.id)
    if (binding?.session !== session) return
    closedSessions.add(session); binding.abort.abort(); sessionBindings.delete(session.id)
    const attached = [...boundAgents.values()].filter(agent => agent.session === session)
    try { await manager.disposeSession(session.id) }
    finally { for (const agent of attached) unregister(agent) }
  }, { global: true }))
  const enable = async (binding: ReturnType<typeof owner>): Promise<unknown> => {
    const wasEnabled = manager.enabled.has(binding.owner.sessionId)
    try {
      const result = await manager.enable(binding.owner, binding.agent.status !== undefined && binding.agent.status !== 'idle', binding.signal)
      binding.signal.throwIfAborted()
      register(binding.agent)
      return result
    } catch (error) {
      // Startup failures retain the admitted fence and diagnostic tools.
      if (!binding.signal.aborted && !wasEnabled && manager.enabled.has(binding.owner.sessionId)) register(binding.agent)
      throw error
    }
  }
  if (config.enabled) disposers.push((ctx as any).provide(LISP_CODING_SERVICE, createLispCodingChoice({
    ...(questions ? { questions } : {}),
    enabled: candidate => manager.enabled.has(owner(candidate).owner.sessionId),
    decided: async candidate => {
      const binding = owner(candidate), saved = await store.session(binding.owner.sessionId)
      if (saved && saved.root_path !== binding.owner.root) fail('SCOPE_CONFLICT', 'セッションの作業場所が変わっています。')
      return saved !== undefined
    },
    decline: candidate => store.decline(owner(candidate).owner),
    enable: async candidate => {
      const result = await enable(owner(candidate)) as { state?: string }
      if (!['READY', 'EVALUATING'].includes(result.state ?? '')) fail('RECOVERY_REQUIRED', 'Lisp の起動・復旧が必要です。/kioku-lisp status で状態を確認してください。')
    },
  })))
  const requestSurface: LispAssemblyService = {
    project(candidate, assembly) {
      const binding = owner(candidate)
      if (!manager.enabled.has(binding.owner.sessionId)) return assembly
      register(binding.agent)
      // Native DSH snapshots providers before its assembly waterfall. Admission
      // can activate Lisp inside that waterfall: refresh this request, not only
      // the next one. Use native visibility plus the exact guarded definitions.
      const schemas = tools.schemas(binding.agent).filter(schema => {
        const registered = fence!.definitions.get(`${candidate.id}:${schema.name}`) as { execute?: unknown } | undefined
        return registered && tools.get(schema.name, binding.agent)?.execute === registered.execute
      })
      if (!LISP_TOOLS.every(name => schemas.some(schema => schema.name === name))) fail('HOST_CAPABILITY_MISSING', 'Lisp のツール定義を要求へ反映できません。')
      const sections = assembly.sections.filter(section => section.name !== 'kiokuko:lisp')
      sections.splice(Math.max(0, sections.findIndex(section => section.name === 'kiokuko:soul') + 1), 0,
        { name: 'kiokuko:lisp', text: '{{kiokuko_lisp}}' })
      const projected = { ...assembly, sections, variables: { ...assembly.variables, kiokuko_lisp: guide },
        tools: schemas.sort((a, b) => a.name.localeCompare(b.name)) }
      return projected
    },
  }
  disposers.push((ctx as any).provide(LISP_ASSEMBLY_SERVICE, requestSurface))
  disposers.push(mountLispHttp(ctx, manager, (sessionId, recover) => {
    const agent = agents.get(sessionId)
    const binding = owner(agent)
    if (binding.owner.sessionId !== sessionId) fail('SESSION_MISMATCH', 'セッションが一致しません。')
    if (recover && manager.enabled.has(sessionId)) register(binding.agent)
    return binding.owner
  }))
  disposers.push(commands.register({ name: 'kioku-lisp', description: 'Common Lisp の開始・状態・停止・復旧', input: { hint: 'enable | status [--json] | cancel | recover | abandon ID | restore ID | disable' },
    handler: async invocation => {
      try {
        const binding = owner(invocation.agent)
        const [action = 'status', argument, ...extra] = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
        if (extra.length || (argument && !['status', 'diagnostics', 'abandon', 'restore'].includes(action))) fail('INVALID_COMMAND', '使い方: /kioku-lisp enable|status|diagnostics|cancel|recover|abandon ID|restore ID|disable')
        let result: unknown
        if (action === 'enable') result = await enable(binding)
        else if (action === 'disable') { result = await manager.disable(binding.owner); unregister(binding.agent) }
        else if (action === 'cancel') result = await manager.execute(binding.owner, 'lisp_cancel', {})
        else if (action === 'recover') {
          if (manager.enabled.has(binding.owner.sessionId)) register(binding.agent)
          result = await manager.recover(binding.owner, invocation.signal)
        }
        else if (action === 'abandon') result = await manager.abandon(binding.owner, argument ?? '')
        else if (action === 'restore') result = await manager.restore(binding.owner, argument ?? '', invocation.signal)
        else if (action === 'diagnostics') result = await manager.diagnostics(binding.owner, argument === '--json' ? undefined : argument)
        else if (action === 'status') result = await manager.status(binding.owner)
        else fail('INVALID_COMMAND', '使い方: /kioku-lisp enable|status|diagnostics|cancel|recover|abandon ID|disable')
        return { kind: 'success', text: argument === '--json' || action === 'diagnostics' || (result as {code?:string}).code ? JSON.stringify(result, null, 2) : text(result) }
      } catch (error) { const problem = failure(error); return { kind: 'error', text: `${problem.message}\n${problem.recovery}` } }
    } }))
  return { manager, stop() { fence!.stopped = true; for (const dispose of disposers.splice(0).reverse()) dispose() },
    async dispose() { fence!.stopped = true; await manager.dispose(); delete fence!.controller; for (const dispose of disposers.splice(0).reverse()) dispose() } }
  } catch (error) {
    fence.stopped = true
    for (const dispose of disposers.splice(0).reverse()) dispose()
    await manager.dispose()
    delete fence.controller
    throw error
  }
}
function description(name: LispTool): string {
  return ({ lisp_eval: 'Build and call reusable task functions in persistent Common Lisp. Compose reads, transforms and checks into one useful operation per call; return decision-ready results instead of issuing one call per primitive. Use a new operationId for new work; exact replay never re-evaluates. Host writes use proposals and native approval.',
    lisp_describe: 'Describe Lisp APIs or task functions. symbol="kioku.user" lists this worker\'s functions; symbol="kioku.user::name" returns arguments and documentation. No symbol returns the bundled API/verifier map.', lisp_inspect: 'Read a retained object or a page of saved evidence; never executes the original operation.', lisp_status: 'Read current host state and paged operation summaries without contacting Lisp.',
    lisp_cancel: 'Stop Lisp and all managed jobs without waiting for evaluation.', lisp_reset: 'Stop a healthy worker and start a new generation. Never use to bypass recovery.' })[name]
}
export function lispToolSchema(name: LispTool): object {
  const properties: Record<string, unknown> = name === 'lisp_status' ? {} : { operationId: { type: 'string', minLength: 1, maxLength: 256 } }
  const required = Object.keys(properties)
  if (name === 'lisp_status') properties.offset = { type: 'integer', minimum: 0, description: 'Read the next 10 operation summaries using nextOffset.' }
  if (name === 'lisp_eval') { Object.assign(properties, { code: { type: 'string', maxLength: 262144 }, inputs: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'Workspace-relative files or exact host paths of files uploaded by the user in this session. Copied read-only; other absolute paths are refused.' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 } }); required.push('code') }
  if (name === 'lisp_describe') properties.symbol = { type: 'string', maxLength: 256 }
  if (name === 'lisp_inspect') Object.assign(properties, {
    ref: { type: 'string', maxLength: 256, description: 'Worker reference; use either ref or resultOperationId.' },
    resultOperationId: { type: 'string', maxLength: 256, description: 'Saved operation from this session and agent. Reads evidence without executing again.' },
    section: { type: 'string', enum: ['result', 'value', 'stdout', 'stderr', 'changes'] },
    pointer: { type: 'string', maxLength: 1024, description: 'With section=result, follow the returned JSON pointer to the exact omitted field.' },
    offset: { type: 'integer', minimum: 0, description: 'Unicode character offset; use the returned nextOffset.' },
    limit: { type: 'integer', minimum: 1, maximum: 2000 },
  })
  if (name === 'lisp_cancel') { properties.generation = { type: 'string', maxLength: 256 }; required.push('generation') }
  return { type: 'object', properties, required, additionalProperties: false }
}
