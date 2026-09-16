import type { Context } from '@deepseek-ai/cordis'
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
import { mountLispHttp } from './http.js'
import { LISP_TOOLS, failure, fail, identifier, renderResult, type LispConfiguration, type LispOwner, type LispTool } from './contracts.js'

interface Session { id: string; header: { cwd: string; parentSession?: string } }
interface Agent { id: string; session: Session; ctx: { get(name: string, strict?: boolean): any }; inject?: (message: unknown) => void }
interface Tools { register(definition: any): () => void; guard(fn: (execution: any) => string | undefined): () => void; get(name: string, scope?: unknown): any; presentAs(mode: 'native'): () => void; restrict(options: { allow: string[] }): () => void; execute(execution: unknown): Promise<unknown> }
interface Fence { sessions: Map<string, string>; controller?: LispManager; definitions: Map<string, object>; stopped: boolean }
const fenceKey = Symbol.for('kiokuko.lisp.host-fence.v1')

function text(value: unknown): string {
  const result = value as { state?: string; enabled?: boolean; ok?: boolean; message?: string; recovery?: string; error?: { message?: string; recovery?: string }; operations?: { id: string; state: string }[] }
  if (result.message) return `${result.message}\n${result.recovery ?? ''}`
  return `Lisp: ${result.state ?? (result.ok ? '処理完了' : '状態不明')}\n${result.error?.message ?? ''}\n${result.error?.recovery ?? result.recovery ?? ''}\n${result.operations?.map(o => `${o.id}: ${o.state}`).join('\n') ?? ''}`.trim()
}
const ToolInput = z.object({ operationId: identifier.optional(), code: z.string().max(262144).optional(), inputs: z.array(z.string().max(4096)).max(100).optional(),
  timeoutMs: z.number().int().min(100).max(600000).optional(), symbol: z.string().max(256).optional(), ref: identifier.optional(), generation: identifier.optional() }).strict()

/** The fence belongs to the host root, so plugin unload cannot restore bash access. */
export async function mountLispSurface(ctx: Context, runtime: DshRuntime, config: LispConfiguration): Promise<{ stop(): void; dispose(): Promise<void>; manager: LispManager }> {
  const root = (ctx.root ?? ctx) as unknown as Context & { [fenceKey]?: Fence }
  const tools = root.get('tools', false) as Tools | undefined
  const agents = root.get('agents', false) as { get(id: string): Agent | undefined } | undefined
  const sessions = root.get('sessions', false) as { get(id: string): Session | undefined } | undefined
  const commands = ctx.get('commands', false) as { register(definition: DshNativeCommandDefinition): () => void } | undefined
  if (!tools || !agents || !sessions || !commands) fail('HOST_CAPABILITY_MISSING', 'Lisp には DSH のツール・セッション・コマンドサービスが必要です。')
  const questions = ctx.get('userQuestions', false) as DshUserQuestions | undefined
  const databasePath = await runtime.withDatabase(db => db.filePath)
  const store = new LispStore(fn => runtime.withDatabase(db => fn(db)))
  const manager = new LispManager({ store, config,
    dataRoot: join(dirname(databasePath), 'lisp'), protectedRoots: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
    ...(questions ? { questions: { ask: (request: Parameters<DshUserQuestions['ask']>[0]) => {
      const agent = request.agent ? agents.get(request.agent.id) : undefined
      if (!agent || sessions.get(agent.session.id) !== agent.session) fail('SESSION_MISMATCH', '確認画面のセッションを確認できません。')
      return questions.ask({ ...request, agent })
    } } } : {}),
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
      return 'Lisp 保護中は六つの Lisp ツールだけを実行できます。削除は利用者の確認が必要です。'
    })
    root.on('agent/pre-step' as never, (async (payload: { agent: Agent }, next: () => Promise<unknown>) => {
      const scope = scopeSession(payload.agent, persistent)
      if (!scope) return next()
      if (persistent.stopped || !persistent.controller || scope !== payload.agent.session.id) return { kind: 'reject' }
      const status = await persistent.controller.status({ sessionId: scope, agentId: payload.agent.id, root: persistent.sessions.get(scope)! }) as { state: string }
      return ['READY', 'EVALUATING'].includes(status.state) ? next() : { kind: 'reject' }
    }) as never, { prepend: true, global: true })
  }
  if (fence.controller && !fence.stopped) fail('HOST_CONFLICT', 'Lisp プラグインが既に接続されています。')
  for (const saved of await runtime.withDatabase(db => db.prepare('SELECT session_id,root_path FROM dsh_lisp_sessions WHERE enabled=1').all<{session_id:string;root_path:string}>())) fence.sessions.set(saved.session_id, saved.root_path)
  await manager.start()
  fence.sessions = manager.enabled; fence.controller = manager; fence.stopped = false
  const disposers: (() => void)[] = []
  try {
  const owner = (candidate: { id: string } | undefined): { agent: Agent; owner: LispOwner } => {
    if (!candidate) fail('NO_SESSION', '現在のセッションから実行してください。')
    const agent = agents.get(candidate.id)
    if (!agent || agent !== candidate || sessions.get(agent.session.id) !== agent.session) fail('SESSION_MISMATCH', '現在のセッションを確認できません。')
    return { agent, owner: { sessionId: identifier.parse(agent.session.id), agentId: identifier.parse(agent.id), root: realpathSync(agent.session.header.cwd) } }
  }
  const registeredAgents = new WeakSet<object>()
  const agentDisposers = new Map<string, (() => void)[]>()
  const unregister = (agent: Agent) => {
    for (const dispose of agentDisposers.get(agent.id)?.reverse() ?? []) dispose()
    agentDisposers.delete(agent.id); registeredAgents.delete(agent)
    for (const name of LISP_TOOLS) fence!.definitions.delete(`${agent.id}:${name}`)
  }
  disposers.push(() => { for (const list of agentDisposers.values()) for (const dispose of list.reverse()) dispose(); agentDisposers.clear(); fence!.definitions.clear() })
  const register = (agent: Agent) => {
    if (registeredAgents.has(agent)) return
    const local: (() => void)[] = []
    agentDisposers.set(agent.id, local)
    const scopedTools = agent.ctx.get('tools') as Tools
    // Do not depend on arbitrary third-party PTC runtimes enforcing our boundary.
    local.push(scopedTools.presentAs('native'))
    local.push(scopedTools.restrict({ allow: [] }))
    for (const name of LISP_TOOLS) {
      const definition = { name, description: description(name), modelFacing: true,
        parameters: schema(name), output: { schema: {}, render: (_: unknown, result: unknown) => [{ type: 'text', text: renderResult(result) }] },
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
  const guide = await readFile(fileURLToPath(new URL('../../../skills/kiokuko-lisp/SKILL.md', import.meta.url)), 'utf8')
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
        if (action === 'enable') { register(binding.agent); result = await manager.enable(binding.owner) }
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
  return ({ lisp_eval: 'Evaluate Common Lisp in this protected session. Use a new operationId for new work. Same ID never re-evaluates. Host changes require proposals; deletions require human approval.',
    lisp_describe: 'Describe bundled Common Lisp APIs.', lisp_inspect: 'Inspect a retained object in the current generation.', lisp_status: 'Read host state and operation outcomes without contacting Lisp.',
    lisp_cancel: 'Stop Lisp and all managed jobs without waiting for evaluation.', lisp_reset: 'Stop a healthy worker and start a new generation. Never use to bypass recovery.' })[name]
}
function schema(name: LispTool): object {
  const properties: Record<string, unknown> = name === 'lisp_status' ? {} : { operationId: { type: 'string', minLength: 1, maxLength: 256 } }
  const required = Object.keys(properties)
  if (name === 'lisp_eval') { Object.assign(properties, { code: { type: 'string', maxLength: 262144 }, inputs: { type: 'array', items: { type: 'string' }, maxItems: 100 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 } }); required.push('code') }
  if (name === 'lisp_describe') properties.symbol = { type: 'string', maxLength: 256 }
  if (name === 'lisp_inspect') { properties.ref = { type: 'string', maxLength: 256 }; required.push('ref') }
  if (name === 'lisp_cancel') { properties.generation = { type: 'string', maxLength: 256 }; required.push('generation') }
  return { type: 'object', properties, required, additionalProperties: false }
}
