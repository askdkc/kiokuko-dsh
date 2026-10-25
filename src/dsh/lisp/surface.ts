import { createLispHostDispatch } from './host-tool-dispatch.js'
import { ManagedDispatchDenied } from '../managed-operation-runner.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { isCodingWorkflowTool } from '../coding-workflow/host.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { rememberLispImplementation, isLispConversation, rootLispAdmission, withLispNativeCommand, isLispNativeCommand, type LispNativeCommands } from '../lisp-tool-identity.js'
import { assertProtocolRoute } from '../guardrail/service.js'
import { isOwnedExecutionCall } from '../owned-execution.js'
import { CodeIntelligenceAdapterV1 } from './code-intelligence.js'
import { mountApprovalPolicy } from './approval-settings.js'
import type { ApprovalQuestions } from './approval.js'
import type { SemanticCompactionCoordinator } from '../semantic-compaction/coordinator.js'
import { renderHistoryResult } from './model-result.js'
import { dshTurnRequestId } from '../intake-profile-resolver.js'
import { TASK_PREPARE_TOOL } from '../on-demand-intake.js'
import type { DecisionService } from '../decisions/service.js'
import { DecisionError } from '../decisions/contracts.js'
import type { Context } from '@deepseek-ai/cordis'
import type { DshSkillPrompts } from '../skill-prompts.js'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { DshCoreRuntime as DshRuntime } from '../core-runtime.js'
import type { DshNativeCommandDefinition } from '../commands.js'
import type { DshUserQuestions } from '../user-interaction.js'
import { LispManager } from './manager.js'
import { LispStore } from './store.js'
import { HotCallInput, HotContractInput, HotDeactivateInput, HotInstallInput, HotStatusInput } from './hot-contracts.js'
import { LispCodingPreparation } from './coding-preparation.js'
import { askLispCodingQuestion } from '../coding-question.js'
import { createLispCodingChoice, LISP_CODING_SERVICE, type LispCodingInput } from './coding-choice.js'
import { sessionCodingWorkflow } from '../coding-workflow/store.js'
import { overrideCodingChoice } from '../coding-workflow/service.js'
import { LISP_ASSEMBLY_SERVICE, type LispAssemblyService } from './request-surface.js'
import { mountLispHttp } from './http.js'
import { createLispCiAdapter } from './ci.js'
import { createLispPackageAdapter } from './packages.js'
import { withTaskAuthority } from '../task-authority-context.js'
import { TASK_AUTHORITY, type TaskLease } from '../task-state.js'
import { createLispMemoryVerification } from './memory-verification.js'
import { isSavedLispResultRead } from '../memory-application.js'
import { attachmentInput, type LispAttachmentSession, type LispAttachmentStore } from './attachment-input.js'
import { HttpTypeSafeClient } from '../typesafe/client.js'
import { typeSafeCredentials } from '../typesafe/command.js'
import { LISP_TOOLS, failure, fail, identifier, renderResult, type LispConfiguration, type LispOwner, type LispTool } from './contracts.js'

interface Session extends LispAttachmentSession { id: string; header: { cwd: string; parentSession?: string } }
interface Agent { id: string; status?: string; session: Session; ctx: { get(name: string, strict?: boolean): any }; inject?: (message: unknown) => void }
interface Tools { register(definition: any): () => void; guard(fn: (execution: any) => string | undefined): () => void; get(name: string, scope?: unknown): any; schemas(scope?: unknown): { name: string; description: string; parameters: unknown }[]; modeFor?(scope:unknown):string; presentAs?(mode: 'native'): () => void; setExecutor?: unknown; restrict(options: { allow: string[] }): () => void; execute(execution: unknown): Promise<unknown> }
interface ExecutionFence { protect(sessionId: string): void; release(sessionId: string): void }
interface ExecutionFences { attach(request: { id: string; tools: readonly string[]; check(execution: any): string | undefined; beforeStep(agent: Agent): Promise<boolean> }): ExecutionFence }
interface Fence { sessions: Map<string, string>; controller?: LispManager; prepareAgent?: (agent: Agent) => Promise<boolean>; definitions: Map<string, object>; stopped: boolean; executionMode: 'development'|'protected'; protocolBridge?: (execution: any) => boolean }
const fenceKey = Symbol.for('kiokuko.lisp.host-fence.v1')
const PROTOCOL_OWNED_TOOLS = ['kioku_read', 'kioku_write', 'kioku_edit', 'kioku_exec', 'kioku_result'] as const
const PROTOCOL_OWNED_EFFECTS = new Set<string>(['kioku_write', 'kioku_edit', 'kioku_exec'])
const LISP_READ_TOOLS = ['read', 'glob', 'grep', 'skill', 'observation_read'] as const
// Keep host-owned review, questions and Plan approval reachable while Lisp blocks native effects.
// Pin its implementation just like reads; its own run/session checks still apply.
const LISP_NATIVE_TOOLS = [...LISP_READ_TOOLS, TASK_PREPARE_TOOL, 'correction_check', 'task_memory_review', 'task_completion', 'coding_workflow', 'coding_workflow_apply', 'coding_workflow_blocker', 'ask_user_question', 'exit_plan_mode'] as const

/** Keep admitted inherited tools without naming agent-owned tools in restrict(). */
function restrictInheritedTools(tools: Tools, scopedTools: Tools, agent: Agent, names: string[]): () => void {
  // DSH restricts inherited tools (global + preset ancestors), but rejects
  // names registered on the agent itself. Its global get() cannot distinguish
  // those cases. An empty mask exposes only own registrations through the
  // public lookup API; remove it synchronously before installing the real mask.
  const restore = scopedTools.restrict({ allow: [] })
  let inherited: string[]
  try { inherited = names.filter(name => !tools.get(name, agent)) }
  finally { restore() }
  return scopedTools.restrict({ allow: inherited })
}

function text(value: unknown): string {
  const result = value as { state?: string; enabled?: boolean; ok?: boolean; message?: string; recovery?: string; error?: { message?: string; recovery?: string }; operations?: { id: string; state: string }[] }
  const hot = value as { tools?: { name: string; revision: number; bundleRef: string | null }[]; hot?: { tools: { name: string; revision: number; bundleRef: string | null }[] } }
  const shared = hot.tools ?? hot.hot?.tools
  const phase = (value as {codingPreparation?:{phase:string}}).codingPreparation?.phase
  const preparationText = phase && ({selected:'Lisp を選択（先行試作は任意）',cancelled:'取消済み・作業を保持',unavailable:'質問を利用できません',choice_pending:'Lisp の選択待ち',prototype_required:'試作待ち（未検証）',result_pending:'試作結果の確認待ち（未検証）',reviewed:'試作結果を確認済み（タスクの検証は別）',declined:'通常ツールを使用',failed:'試作失敗・自動再試行停止'} as Record<string,string>)[phase]
  if (result.message) return `${result.message}\n${result.recovery ?? ''}`
  return `Lisp: ${result.state ?? (result.ok ? '処理完了' : '状態不明')}\n${preparationText ? `試作: ${preparationText}\n` : ''}${result.error?.message ?? ''}\n${result.error?.recovery ?? result.recovery ?? ''}\n${result.operations?.map(o => `${o.id}: ${o.state}`).join('\n') ?? ''}\n${shared ? `共有関数（表示中）: ${shared.length}\n${shared.map(t => `${t.name}: 版 ${t.revision} / ${t.bundleRef ? '有効' : '無効'}`).join('\n')}` : ''}`.trim()
}
export const ToolInput = z.object({ operationId: identifier.optional(), code: z.string().max(262144).optional(), inputs: z.array(z.string().max(4096)).max(100).optional(),
  prototype: z.boolean().optional(), name: z.string().max(64).optional(), description: z.string().max(1000).optional(), source: z.string().max(262144).optional(),
  inputSchema: z.unknown().optional(), outputSchema: z.unknown().optional(), dependencies: z.unknown().optional(), examples: z.unknown().optional(), firstInput: z.unknown().optional(),
  properties: z.unknown().optional(), contractRef: z.uuid().optional(), expectedContractRef: z.uuid().nullable().optional(), expectedRevision: z.number().int().nonnegative().optional(),
  contractOffset: z.number().int().nonnegative().optional(),
  toolRef: z.string().uuid().optional(), input: z.unknown().optional(), inputRef: z.string().uuid().optional(), fields: z.unknown().optional(),
  paths: z.array(z.string().min(1).max(4096)).max(100).optional(), format: z.enum(['text', 'json']).optional(),
  resultRef: z.string().uuid().optional(), baseRef: z.string().uuid().optional(), candidateRef: z.string().uuid().optional(),
  verificationRef: identifier.optional(), leftRef: z.string().uuid().optional(), rightRef: z.string().uuid().optional(),
  target: z.enum(['typecheck', 'lisp', 'test', 'build', 'package', 'vendor']).optional(), script: z.string().max(256).optional(),
  timeoutMs: z.number().int().min(100).max(600000).optional(), symbol: z.string().max(256).optional(), ref: identifier.optional(), generation: identifier.optional(),
  resultOperationId: identifier.optional(), section: z.enum(['result', 'value', 'stdout', 'stderr', 'changes']).optional(),
  pointer: z.string().max(1024).optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(2000).optional() }).strict()

/** The fence belongs to the host root, so plugin unload cannot restore bash access. */
export async function mountLispSurface(ctx: Context, runtime: DshRuntime, config: LispConfiguration, skillPrompts?: DshSkillPrompts, decisions?: DecisionService, semanticCompaction?: SemanticCompactionCoordinator): Promise<{ stop(): void; dispose(): Promise<void>; manager: LispManager }> {
  const root = (ctx.root ?? ctx) as unknown as Context & { [fenceKey]?: Fence }
  const tools = root.get('tools', false) as Tools | undefined
  const agents = root.get('agents', false) as { get(id: string): Agent | undefined } | undefined
  const sessions = root.get('sessions', false) as { get(id: string): Session | undefined } | undefined
  const commands = ctx.get('commands', false) as { register(definition: DshNativeCommandDefinition): () => void } | undefined
  if (!tools || !agents || !sessions || !commands) fail('HOST_CAPABILITY_MISSING', 'Lisp には DSH のツール・セッション・コマンドサービスが必要です。')
  const dispatchHostTool = await createLispHostDispatch(ctx, tools)
  const questions = ctx.get('userQuestions', false) as DshUserQuestions | undefined
  const approvalPolicy = mountApprovalPolicy(ctx, config.approvalMode, (agentId, expected) => {
    const agent = agents.get(agentId)
    const bound = fence
    if (!agent || expected && (agent.session.id !== expected.sessionId || realpathSync(agent.session.header.cwd) !== expected.root) || sessions.get(agent.session.id) !== agent.session || !bound || bound.stopped ||
      bound.sessions.get(agent.session.id) !== realpathSync(agent.session.header.cwd))
      fail('SESSION_MISMATCH', 'Lisp approval session identity changed.')
  })
  const development=config.executionMode==='development'
  // Registry visibility is not permission: only this host-minted call scope may
  // cross the protected fence, through the pinned real owned implementation.
  type PinnedOwned = Readonly<{ definition: any; execute: unknown }>
  const protocolBridgeScope = new AsyncLocalStorage<{ agent: Agent; name: string; callId: string; pinned: PinnedOwned }>()
  const protocolDefinitions = new Map<string, PinnedOwned>()
  const ownerQuestions: ApprovalQuestions = { executionMode:config.executionMode, approvalPolicy, ask: request => {
    approvalPolicy.validate(request.agent!.id)
    return questions?.ask({ ...request, agent: agents.get(request.agent!.id)! }) ?? Promise.reject(new Error('Question UI unavailable'))
  } }
  const databasePath = await runtime.withDatabase(db => db.filePath)
  const store = new LispStore(fn => runtime.withDatabase(db => fn(db)))
  const typesafe = new HttpTypeSafeClient(typeSafeCredentials(ctx))
  let ownerForOwned:(binding:LispOwner)=>{signal:AbortSignal}
  const ownedCall = async(owner:LispOwner,name:string,args:Record<string,unknown>,signal?:AbortSignal,callId?:string, taskLease?:TaskLease):Promise<any> => {
    const agent=agents.get(owner.agentId)
    if(!agent||agent.session.id!==owner.sessionId||sessions.get(owner.sessionId)!==agent.session||realpathSync(agent.session.header.cwd)!==owner.root)fail('SESSION_MISMATCH','Owned tool caller changed.')
    const binding=ownerForOwned(owner)
    const execute = () => dispatchHostTool({callId:callId??`lisp-owned-${crypto.randomUUID()}`,name,arguments:args,agent,parent:Symbol('lisp-owned'),signal:signal?AbortSignal.any([binding.signal,signal]):binding.signal,
      ...(taskLease ? { [TASK_AUTHORITY]: taskLease } : {})})
    const result=await (taskLease ? withTaskAuthority(taskLease, execute) : execute()) as any
    if(result.isError)fail('OWNED_EXECUTION_FAILED',JSON.stringify(result.content))
    return result.value
  }
  const authorizeEffect = async (owner: LispOwner): Promise<void> => { await manager.taskAuthority.authorizeEffect(owner) }
  const packageAdapter = createLispPackageAdapter(ownerQuestions, undefined, undefined, authorizeEffect)
  const memoryVerification = createLispMemoryVerification(runtime, {
    authorizePublication: (db, owner) => manager.taskAuthority.authorizeEffectPublication(db, owner),
  })
  const manager = new LispManager({ store, config,
    codeSession: (binding, context) => {
      const agent = agents.get(binding.agentId)
      if (!agent) fail('CODE_STALE_SCOPE', 'Code caller is missing.')
      const agentContext = agent.ctx
      const assertCurrent = () => {
        const current = ownerForOwned(binding)
        if (fence?.stopped || current.signal.aborted || agents.get(binding.agentId) !== agent || sessions.get(binding.sessionId) !== agent.session || agent.ctx !== agentContext || agent.session.id !== binding.sessionId || realpathSync(agent.session.header.cwd) !== binding.root || context.signal.aborted)
          fail('CODE_STALE_SCOPE', 'Code caller, workspace or scope changed.')
      }
      assertCurrent()
      return new CodeIntelligenceAdapterV1({ owner: binding, workspaceRoot: binding.root, scope: agentContext, context: agentContext, assertCurrent }, () => agentContext.get('codeIntelligence', false))
    },
    toolCatalog:owner=>['lisp_status','kioku_read','kioku_write','kioku_edit','kioku_remove','kioku_exec','kioku_result'].flatMap(name=>{
      const tool=tools.get(name,agents.get(owner.agentId))
      return tool?[{name,parameters:tool.parameters,adapterVersion:2}]:[]
    }),
    ...(skillPrompts ? { skillPrompts } : {}),
    dataRoot: join(dirname(databasePath), 'lisp'), protectedRoots: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
    ...(ownerQuestions ? { questions: ownerQuestions } : {}),
    packagesCall: async (owner, request, signal) => {
      const agent = agents.get(owner.agentId)
      if (!agent || agent.session.id !== owner.sessionId || sessions.get(owner.sessionId) !== agent.session || realpathSync(agent.session.header.cwd) !== owner.root)
        fail('SESSION_MISMATCH', 'Package session identity changed.')
      signal.throwIfAborted()
      const result = await packageAdapter(owner, request, signal)
      if (agents.get(owner.agentId) !== agent || sessions.get(owner.sessionId) !== agent.session || realpathSync(agent.session.header.cwd) !== owner.root)
        fail('SESSION_MISMATCH', 'Package session identity changed during approval or execution.')
      return result
    },
    ciCall: async (owner, request, signal, scratchRoot) => {
      // Fixed CI inventory/log reads do not claim a task execution lease.
      // Sending them through kioku_exec would classify those reads as work.
      if(!development || request.kind !== 'verify'){await memoryVerification.beforeCall(owner,request);return createLispCiAdapter(ownerQuestions, undefined, authorizeEffect)(owner,request,signal,scratchRoot)}
      const ciAdapter=createLispCiAdapter(ownerQuestions,async(file,args,options)=>{
        const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'"
        const value=await ownedCall(owner,'kioku_exec',{command:[file,...args].map(quote).join(' '),cwd:options.cwd,timeoutMs:options.timeoutMs},options.signal,undefined,
          request.kind === 'verify' ? await manager.taskAuthority.authorizeEffect(owner) : undefined)
        return {code:value.exitCode??1,stdout:value.output??'',stderr:'',receipt:value.receipt}
      }, authorizeEffect)
      return ciAdapter(owner,request,signal,scratchRoot)
    },
    verifiedCall: memoryVerification.afterEval,
    decisionCall: async (owner, method, args, context) => {
      const agent = agents.get(owner.agentId)
      if (!agent || agent.session.id !== owner.sessionId || sessions.get(owner.sessionId) !== agent.session || realpathSync(agent.session.header.cwd) !== owner.root) fail('SESSION_MISMATCH', 'Decision session identity changed.')
      context.signal.throwIfAborted()
      if (!decisions) throw new DecisionError('UNAVAILABLE')
      if (method === 'decisions-status') return decisions.status()
      const events = agent.session.snapshotEvents?.() as readonly { type?: string; data?: { turn?: number } }[] | undefined
      const turn = events?.filter(e => e.type === 'turn/start').at(-1)?.data?.turn
      if (!Number.isSafeInteger(turn)) fail('SESSION_MISMATCH', 'Decision request has no native turn identity.')
      return decisions.evaluate(dshTurnRequestId({ dshSessionId: owner.sessionId, turn: turn! }), args, context.signal)
    },
    typesafeCall: async (owner, method, args, context) => {
      const agent = agents.get(owner.agentId)
      if (!agent || agent.session.id !== owner.sessionId || sessions.get(owner.sessionId) !== agent.session || realpathSync(agent.session.header.cwd) !== owner.root) fail('SESSION_MISMATCH', 'TypeSafe のセッションを確認できません。')
      context.signal.throwIfAborted()
      return method === 'typesafe-status' ? typesafe.status() : typesafe.evaluate(args, context.signal)
    },
    attachmentInput: (owner, path, signal) => {
      const agent = agents.get(owner.agentId)
      if (!agent || agent.session.id !== owner.sessionId || sessions.get(owner.sessionId) !== agent.session || realpathSync(agent.session.header.cwd) !== owner.root) fail('SESSION_MISMATCH', '添付入力のセッションを確認できません。')
      return attachmentInput(agent.session, agent.ctx.get('attachments', false) as LispAttachmentStore | undefined, path, signal)
    },
    toolCall: async (owner, name, args, signal,callId,taskLease) => {
      const agent = agents.get(owner.agentId)
      if (!agent || agent.session.id !== owner.sessionId || sessions.get(owner.sessionId) !== agent.session || realpathSync(agent.session.header.cwd) !== owner.root) fail('SESSION_MISMATCH', 'ホスト呼び出しの主体を確認できません。')
      if (development) return ownedCall(owner,name,args,signal,callId,taskLease)
      if ((PROTOCOL_OWNED_TOOLS as readonly string[]).includes(name)) {
        const effect = PROTOCOL_OWNED_EFFECTS.has(name)
        if (effect && (!taskLease || !callId)) fail('TASK_REQUIRED', 'Protected owned effects require the original task lease and call identity.')
        await runtime.withDatabase(db => {
          const workflow = sessionCodingWorkflow(db, owner.sessionId)
          if (!workflow?.protocol || workflow.repositoryRoot !== owner.root || taskLease && workflow.runId !== taskLease.taskId)
            fail('PROTOCOL_ROUTE_REQUIRED', 'This protected owned bridge requires the exact enrolled task.')
          // The owned service performs phase/file/command checks again at each
          // effect boundary. Read/cancel receipts remain available after stop.
          if (effect) assertProtocolRoute(db, taskLease!, name, true)
        })
        const pinned = protocolDefinitions.get(`${agent.id}:${name}`)
        if (!pinned || tools.get(name, agent) !== pinned.definition || tools.get(name, agent)?.execute !== pinned.execute)
          fail('PROTOCOL_ROUTE_REQUIRED', 'The pinned owned implementation is unavailable or changed.')
        const id = callId ?? `lisp-owned-result-${randomUUID()}`
        return protocolBridgeScope.run({ agent, name, callId: id, pinned },
          () => ownedCall(owner, name, args, signal, id, taskLease))
      }
      const execute = () => dispatchHostTool({callId:`lisp-host-${crypto.randomUUID()}`,name,arguments:args,agent,parent:Symbol('lisp-host-read'),signal:signal??new AbortController().signal,
        ...(taskLease ? { [TASK_AUTHORITY]: taskLease } : {})})
      return taskLease ? withTaskAuthority(taskLease, execute) : execute()
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
  // CLI mediates a root-owned denial without granting a plugin root effects.
  // Other DSH hosts retain their existing persistent root fence.
  const hostFences = ctx.get('executionFences', false) as ExecutionFences | undefined
  let hostFence: ExecutionFence | undefined
  let fence = hostFences ? undefined : root[fenceKey]
  if (!fence) {
    fence = { sessions: new Map(), definitions: new Map(), stopped: true, executionMode:config.executionMode }
    const persistent = fence
    const check = (execution: any): string | undefined => {
      const agent = execution.agent as Agent | undefined
      const scope = scopeSession(agent, persistent)
      if (!scope) return hostFences || LISP_TOOLS.includes(execution.name) ? 'このセッションでは Lisp が無効または起動中です。' : undefined
      if (persistent.executionMode==='development' && !LISP_TOOLS.includes(execution.name)) return undefined
      if (persistent.executionMode === 'protected' && execution.name === 'run_code') return 'Protected Lisp requires the native DSH tool executor. Select native execution in the DSH profile, or disable protected Lisp; the PTC program was not executed.'
      if (persistent.stopped || !persistent.controller) return persistent.executionMode==='development' ? 'Lisp は停止中です。通常ツールは利用できます。' : 'Lisp の保護が継続中です。プラグインを戻し /kioku-lisp status で確認してください。'
      if (!agent || agents.get(agent.id) !== agent || sessions.get(agent.session.id) !== agent.session) return 'Lisp のセッションを確認できません。'
      if (agent.session.id !== scope) return '保護中の子セッションでは任意ツールを実行できません。親セッションの Lisp を使用してください。'
      if (persistent.protocolBridge?.(execution)) return undefined
      // Goal preparation temporarily removes Lisp registrations. Keep this
      // plugin's actual controls reachable without admitting same-name replacements.
      if (['coding_workflow', 'coding_workflow_apply', 'coding_workflow_blocker'].includes(execution.name)
        && isCodingWorkflowTool(tools.get(execution.name, agent))) return undefined
      const registered = persistent.definitions.get(`${agent.id}:${execution.name}`)
      if (registered && tools.get(execution.name, agent)?.execute === (registered as { execute: unknown }).execute) return undefined
      return 'Lisp 保護中は Lisp ツールと DSH の読み取り・検索・スキル読み込み・質問・計画提出を使えます。変更は Lisp 経由で行い、削除・既存ファイルの置換には利用者の確認が必要です。'
    }
    const prepare = async (agent: Agent): Promise<boolean> => {
      const scope = scopeSession(agent, persistent)
      if (!scope) return !hostFences
      if(persistent.executionMode==='protected'){if(persistent.stopped||!persistent.controller||scope!==agent.session.id)return false;return await persistent.prepareAgent?.(agent)===true}
      if (persistent.stopped || !persistent.controller || scope !== agent.session.id) return true
      try { await persistent.prepareAgent?.(agent) } catch { /* Lisp diagnostics remain available; ordinary tools proceed. */ }
      return true
    }
    if (hostFences) hostFence = hostFences.attach({ id: 'kiokuko.lisp.v1', tools: LISP_TOOLS, check, beforeStep: prepare })
    else {
      root[fenceKey] = fence
      tools.guard(check)
      root.on('agent/pre-step' as never, (async (payload: { agent: Agent }, next: () => Promise<unknown>) =>
        await prepare(payload.agent) ? next() : { kind: 'reject' }) as never, { prepend: true, global: true })
    }
  }
  if (fence.controller && !fence.stopped) fail('HOST_CONFLICT', 'Lisp プラグインが既に接続されています。')
  for (const saved of await runtime.withDatabase(db => db.prepare('SELECT session_id,root_path FROM dsh_lisp_sessions WHERE enabled=1').all<{session_id:string;root_path:string}>())) {
    hostFence?.protect(saved.session_id)
    fence.sessions.set(saved.session_id, saved.root_path)
  }
  await manager.start()
  fence.executionMode=config.executionMode
  fence.sessions = manager.enabled; fence.controller = manager; fence.stopped = false
  fence.protocolBridge = execution => {
    const active = protocolBridgeScope.getStore()
    return Boolean(active && active.agent === execution.agent && active.name === execution.name && active.callId === execution.callId
      && protocolDefinitions.get(`${active.agent.id}:${active.name}`) === active.pinned
      && tools.get(active.name, active.agent) === active.pinned.definition
      && tools.get(active.name, active.agent)?.execute === active.pinned.execute && isOwnedExecutionCall(execution))
  }
  const disposers: (() => void)[] = []
  if (semanticCompaction) for (const tool of ['lisp_eval', 'lisp_inspect']) disposers.push(semanticCompaction.registerProjector(tool, renderHistoryResult))
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
  ownerForOwned=(binding:LispOwner)=>owner(agents.get(binding.agentId))
  const approvalText = () => `Lisp execution mode: ${config.executionMode}; approval mode: ${approvalPolicy.mode()} (entire profile). ` + (!development
    ? 'Explicit protected compatibility mode uses its existing sandbox and approval policy. Native development tools remain independently available. '+(approvalPolicy.mode()==='auto'?'Do not ask permission to submit, resubmit, run verification or apply changes already covered by auto policy.':'') : approvalPolicy.mode() === 'auto'
    ? 'Routine Lisp/project development is authorized. Source/data deletion and durable user DB mutation still require concrete confirmation. Cancellation, refusal and unknown outcomes remain authoritative.'
    : 'Routine Lisp/project development and verification are authorized without a dialog. Source/data deletion and durable user DB mutation require concrete confirmation. This legacy setting does not restrict ordinary tools.')
  const guide = skillPrompts ? await skillPrompts.require('kiokuko-lisp') : await readFile(fileURLToPath(new URL('../../../skills/kiokuko-lisp/SKILL.md', import.meta.url)), 'utf8')
  // Native DSH assembles prompts BEFORE agent/pre-step. Register a live provider
  // now so activation, restored sessions and the next step see the current mode.
  const policyPrompt = ctx.get('systemPrompt', false) as { section(input: unknown): () => void } | undefined
  if (policyPrompt) disposers.push(policyPrompt.section({ name: 'kiokuko:lisp-approval', order: -89999,
    text: ({agent}: {agent?: Agent}) => agent && manager.enabled.has(agent.session.id) ? approvalText() : '' }))
  // Keep enabled-mode guidance available even when a completed Goal releases
  // its scoped registrations before a new request is admitted. No authority or
  // process recovery is granted by this prompt provider.
  if (policyPrompt) disposers.push(policyPrompt.section({ name: 'kiokuko:lisp', order: -90000,
    text: ({agent}: {agent?: Agent}) => agent && manager.enabled.has(agent.session.id) ? guide : '' }))
  const registeredAgents = new WeakSet<object>()
  const agentDisposers = new Map<string, (() => void)[]>()
  const boundAgents = new Map<string, Agent>()
  const inventoryReaders = new Map<string, () => ReturnType<Tools['schemas']>>()
  const runtimePrompts = new Map<string, () => void>()
  const unregister = (agent: Agent) => {
    if (boundAgents.get(agent.id) !== agent) return
    runtimePrompts.get(agent.id)?.(); runtimePrompts.delete(agent.id); boundAgents.delete(agent.id)
    for (const dispose of agentDisposers.get(agent.id)?.reverse() ?? []) dispose()
    agentDisposers.delete(agent.id); registeredAgents.delete(agent)
    for (const name of [...LISP_TOOLS, ...LISP_NATIVE_TOOLS]) fence!.definitions.delete(`${agent.id}:${name}`)
    for (const name of PROTOCOL_OWNED_TOOLS) protocolDefinitions.delete(`${agent.id}:${name}`)
  }
  disposers.push(() => { for (const dispose of runtimePrompts.values()) dispose(); runtimePrompts.clear(); boundAgents.clear(); for (const list of agentDisposers.values()) for (const dispose of list.reverse()) dispose(); agentDisposers.clear(); fence!.definitions.clear(); protocolDefinitions.clear() })
  const register = (agent: Agent) => {
    if (registeredAgents.has(agent)) return
    if (boundAgents.has(agent.id)) unregister(boundAgents.get(agent.id)!)
    boundAgents.set(agent.id, agent)
    const local: (() => void)[] = []
    agentDisposers.set(agent.id, local)
    const scopedTools = agent.ctx.get('tools') as Tools
    // Current hosts own native/PTC selection for the Agent's lifetime. Preserve
    // that selection. Protected scopes retain their monotonic registry guards;
    // reserved PTC transport is denied before its program can execute.
    if (typeof scopedTools.setExecutor !== 'function' && scopedTools.modeFor?.(agent) !== 'native') {
      if (typeof scopedTools.presentAs !== 'function') fail('HOST_CAPABILITY_MISSING', 'The host cannot select scoped native execution.')
      local.push(scopedTools.presentAs('native'))
    }
    // Retain the host's existing read and memory-review capabilities, including agent-local preset
    // tools. Pin their implementations so a later same-name registration cannot
    // acquire permission. Dispatch still traverses every native DSH policy/guard.
    const nativeTools: string[] = []
    for (const name of LISP_NATIVE_TOOLS) {
      const definition = tools.get(name, agent)
      if (definition) { fence!.definitions.set(`${agent.id}:${name}`, definition); nativeTools.push(name) }
    }
    if(!development) {
      for (const name of PROTOCOL_OWNED_TOOLS) {
        const definition = tools.get(name, agent)
        if (definition) { protocolDefinitions.set(`${agent.id}:${name}`, Object.freeze({ definition, execute: definition.execute })); nativeTools.push(name) }
      }
      let release = restrictInheritedTools(tools, scopedTools, agent, nativeTools)
      // Inventory binding must see installed definitions, independently of this
      // plugin's protected presentation. Lift only our mask synchronously, never
      // across an await, and retain all other host/preset restrictions.
      inventoryReaders.set(agent.id, () => {
        release()
        try { return tools.schemas(agent) }
        finally { release = restrictInheritedTools(tools, scopedTools, agent,
          nativeTools.filter(name => tools.get(name, agent) === (fence!.definitions.get(`${agent.id}:${name}`) ?? protocolDefinitions.get(`${agent.id}:${name}`)?.definition))) }
      })
      local.push(() => { inventoryReaders.delete(agent.id); release() })
    }
    // Lisp and owned/native tools coexist. A worker failure does not restrict
    // the inherited development surface.
    for (const name of LISP_TOOLS) {
      const definition = { name, get description() { return `${description(name)} Current Lisp approval mode: ${approvalPolicy.mode()} (profile).` }, modelFacing: true,
        parameters: lispToolSchema(name), output: { schema: {}, render: (_: unknown, result: unknown) => [{ type: 'text', text: renderResult(result) }] },
        execute: async (args: unknown, execution: { agent?: Agent; signal?: AbortSignal; callId?: string; rootCallId?: string; token?: symbol; toolSet?: unknown }) => {
          try {
            const binding = owner(execution.agent), parsed = ToolInput.parse(args)
            const codingRequest = preparation.binding(binding.agent)
            const admission = development ? rootLispAdmission(execution) : undefined
            const agentSession = binding.agent.session, agentContext = binding.agent.ctx
            const bash = admission ? tools.get('bash', binding.agent) : undefined
            const pinned = bash ? { definition: bash, execute: bash.execute } : undefined
            let prototypeProcessFailed = false
            const nativeCommands: LispNativeCommands | undefined = admission ? {
              assertCurrent() {
                const current = owner(execution.agent)
                if (!admission.current() || binding.signal.aborted || execution.signal?.aborted || current.signal !== binding.signal
                  || current.owner.root !== binding.owner.root || binding.agent.session !== agentSession || binding.agent.ctx !== agentContext)
                  fail('STALE_NATIVE_COMMAND', 'Native Lisp caller, turn or arguments changed.')
              },
              async run(input, signal) {
                this.assertCurrent()
                if (!pinned) fail('HOST_ADAPTER_UNAVAILABLE', 'The native Bash tool is unavailable.')
                if (tools.get('bash', binding.agent) !== pinned.definition || tools.get('bash', binding.agent)?.execute !== pinned.execute)
                  fail('STALE_NATIVE_COMMAND', 'Native Bash implementation changed.')
                const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
                const child = { name: 'bash', callId: `lisp-native-${randomUUID()}`, agent: binding.agent, parent: execution.token ?? Symbol('lisp-native-command'),
                  ...(execution.rootCallId ?? execution.callId ? { rootCallId: execution.rootCallId ?? execution.callId } : {}),
                  ...(execution.toolSet ? { toolSet: execution.toolSet } : {}),
                  arguments: { command: [input.program, ...input.argv].map(quote).join(' '), description: 'Run the requested Lisp command through native Bash',
                    workdir: input.directory ?? binding.owner.root, timeoutMs: input.timeoutMs }, signal: AbortSignal.any([binding.signal, signal]) }
                const commandAdmission = { current: () => {
                  try { this.assertCurrent(); return true } catch { return false }
                } }
                // Observe the registry's exact dispatch stage, not an error string:
                // policy rejection returns before tools/execute is reached.
                let dispatchStarted = false
                const removeDispatchWitness = (ctx as any).on('tools/execute', (execution: any, next: () => Promise<unknown>) => {
                  if (execution.callId === child.callId && execution.agent === child.agent && execution.parent === child.parent && execution.name === child.name) {
                    // Recheck the existing exact-call capability before allowing
                    // the dispatch continuation. Mutated arguments/owners never
                    // enter the pinned body and are a known admission denial.
                    if (!isLispNativeCommand(execution, pinned.execute)) throw new ManagedDispatchDenied('Host rejected tool before dispatch.')
                    dispatchStarted = true
                  }
                  return next()
                }, {global:true, prepend:true})
                let result: any
                try { result = await withLispNativeCommand(child, pinned.execute, commandAdmission, () => dispatchHostTool(child)) }
                finally { removeDispatchWitness() }
                if (result.isError) {
                  if (!dispatchStarted) throw new ManagedDispatchDenied('Host rejected tool before dispatch.')
                  fail('NATIVE_COMMAND_UNCONFIRMED', 'Native command did not return a confirmed result; inspect its host receipt before retrying.')
                }
                const value = result.value
                if (value.kind === 'background' || value.kind === 'promoted') {
                  const jobs = ctx.get('jobs', false) as any
                  if (!jobs) fail('STOP_UNCONFIRMED', `Native job ${value.jobId} requires cancellation.`)
                  jobs.kill(value.jobId, binding.agent.id, 'Lisp foreground deadline')
                  const terminal = await jobs.wait(value.jobId, 5000, binding.agent.id)
                  if (['running', 'stopping'].includes(terminal.status)) fail('STOP_UNCONFIRMED', `Native job ${value.jobId} has not stopped.`)
                  jobs.remove(value.jobId, binding.agent.id)
                  prototypeProcessFailed = true
                  return { code: null, stdout: value.output ?? '', stderr: '', timedOut: true, receipt: { route: 'native', processStopped: true } }
                }
                this.assertCurrent()
                if (value.exitCode !== 0 || value.timedOut) prototypeProcessFailed = true
                return { code: value.exitCode, stdout: value.stdout?.text ?? '', stderr: value.stderr?.text ?? '',
                  timedOut: value.timedOut, sandbox: value.sandbox, receipt: { route: 'native', callId: child.callId, processStopped: true } }
              },
            } : undefined
            if(development && !admission && (ctx.get('planMode',false) as any)?.get(binding.agent)?.active && !['lisp_status','lisp_hot_status','lisp_inspect','lisp_cancel'].includes(name))fail('PLAN_ACTIVE','Plan 中の Lisp 実行・変更はできません。実装指示またはPlan承認後に実行してください。')
            if (name === 'lisp_cancel' && !await manager.isTaskMode(binding.owner)) { identifier.parse(parsed.operationId); identifier.parse(parsed.generation) }
            if (name !== 'lisp_status' && name !== 'lisp_hot_status' && !isSavedLispResultRead({ name, arguments: parsed, parent: undefined }))
              parsed.operationId = await store.bind(binding.owner, identifier.parse(execution.callId), identifier.parse(parsed.operationId), { name, input: parsed, ...(parsed.prototype === true ? {codingRequest} : {}) })
            const result = await manager.execute(binding.owner, name, parsed, execution.signal ? AbortSignal.any([binding.signal, execution.signal]) : binding.signal, nativeCommands)
            const outcome = parsed.prototype && prototypeProcessFailed ? { ...result as object, ok:false, code:'LISP_PROTOTYPE_PROCESS_FAILED', message:'A managed process failed or timed out; this is not successful prototype evidence.' } : result
            preparation.observed(binding.agent, name, parsed, outcome, codingRequest)
            return name === 'lisp_status' ? { ...outcome as object, codingPreparation:preparation.status(binding.agent) } : outcome
          }
          catch (error) { return failure(error) }
        } }
      rememberLispImplementation(definition.execute)
      fence!.definitions.set(`${agent.id}:${name}`, definition)
      local.push(scopedTools.register(definition))
    }
    registeredAgents.add(agent)
    const prompt = agent.ctx.get('systemPrompt', false) as { section(input: unknown): () => void } | undefined
    if (prompt) {
      local.push(prompt.section({ name: 'kiokuko:lisp', order: -90000, text: guide }))
      if (!policyPrompt) local.push(prompt.section({ name: 'kiokuko:lisp-approval', order: -89999, text: approvalText }))
    }
  }
  const modeOnly = <T>(binding: ReturnType<typeof owner>, run: () => Promise<T>): Promise<T> => {
    const agentContext = binding.agent.ctx
    return manager.taskAuthority.run(binding.owner, run, {
      assertCurrent() {
        const current = owner(binding.agent)
        if (binding.signal.aborted || current.signal.aborted || current.agent !== binding.agent || binding.agent.ctx !== agentContext
          || current.owner.sessionId !== binding.owner.sessionId || current.owner.agentId !== binding.owner.agentId || current.owner.root !== binding.owner.root)
          fail('SESSION_MISMATCH', 'Lisp mode owner changed.')
      },
      async run() { return fail('CAPABILITY_DENIED', 'Mode control cannot execute a command.') },
    })
  }
  const recover = async (binding: ReturnType<typeof owner>, signal?: AbortSignal) => {
    const restart = () => manager.recover(binding.owner, signal)
    return await manager.canRecoverWorkerWithoutTask(binding.owner) ? modeOnly(binding, restart) : restart()
  }
  fence.prepareAgent = async candidate => {
    const binding = owner(candidate)
    const workflow=await runtime.withDatabase(db=>sessionCodingWorkflow(db,binding.owner.sessionId))
    if(workflow&&(!development||workflow.protocol||!isLispConversation(candidate))&&(workflow.choice.state!=='yes'||['preparing','awaiting_lisp_choice','cancelled','superseded'].includes(workflow.state))){unregister(binding.agent);return true}
    runtimePrompts.get(candidate.id)?.(); runtimePrompts.delete(candidate.id)
    manager.setAgentBusy(binding.owner, true)
    if (await manager.isTaskMode(binding.owner)) {
      binding.signal.throwIfAborted()
      register(binding.agent)
      return true
    }
    const prepare = () => manager.prepare(binding.owner)
    const status = await (development && isLispConversation(candidate) ? modeOnly(binding, prepare) : prepare()) as { state: string; generation?: string; resumed?: boolean }
    binding.signal.throwIfAborted()
    register(binding.agent)
    const prompt = binding.agent.ctx.get('systemPrompt', false) as { section(input: unknown): () => void } | undefined
    if (prompt) { const previous = runtimePrompts.get(candidate.id); const remove = prompt.section({ name: 'kiokuko:lisp-runtime', order: -89999,
      text: `Current Lisp generation: ${status.generation ?? 'none'}. State: ${status.state}.` + (status.resumed
        ? ' Lisp was automatically restarted after normal suspension. Definitions, variables and object references from older generations are gone. Recreate needed helpers; never replay completed file or process effects. Compare the generation of previous tool results before reusing state.' : '') }); runtimePrompts.set(candidate.id, () => { previous?.(); remove() }) }
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
  const enable = async (binding: ReturnType<typeof owner>, standalone = false): Promise<unknown> => {
    const wasEnabled = manager.enabled.has(binding.owner.sessionId)
    hostFence?.protect(binding.owner.sessionId)
    try {
      const result = await manager.isTaskMode(binding.owner)
        ? await manager.status(binding.owner)
        : await (standalone && development
          ? modeOnly(binding, () => manager.enable(binding.owner, binding.agent.status !== undefined && binding.agent.status !== 'idle', binding.signal))
          : manager.enable(binding.owner, binding.agent.status !== undefined && binding.agent.status !== 'idle', binding.signal))
      binding.signal.throwIfAborted()
      register(binding.agent)
      return result
    } catch (error) {
      if (!wasEnabled && !manager.enabled.has(binding.owner.sessionId)) hostFence?.release(binding.owner.sessionId)
      // Startup failures retain the admitted fence and diagnostic tools.
      if (!binding.signal.aborted && !wasEnabled && manager.enabled.has(binding.owner.sessionId)) register(binding.agent)
      throw error
    }
  }
  // A manual command is a session preference; a task's yes is not a future task's answer.
  const manualMode = (candidate: LispCodingInput['agent'], remember = false) => store.manualMode(owner(candidate).owner, remember)
  const preparation = new LispCodingPreparation({
    identity: candidate => { const binding = owner(candidate); return { sessionId: binding.owner.sessionId, root: binding.owner.root } },
    enabled: candidate => manager.enabled.has(owner(candidate).owner.sessionId),
    selected: candidate => manualMode(candidate),
    activate: async candidate => { await enable(owner(candidate), true) },
    deactivate: async candidate => { const binding=owner(candidate); if(manager.enabled.has(binding.owner.sessionId))await manager.disable(binding.owner);else await store.decline(binding.owner);unregister(binding.agent);hostFence?.release(binding.owner.sessionId) },
    choose: async input => {
      const binding = owner(input.agent), questionId = `lisp-early-${dshTurnRequestId({dshSessionId: binding.owner.sessionId, turn: input.turn})}-${canonicalContentHash(input.task).slice(0,16)}`
      return askLispCodingQuestion(questions, { agent: binding.agent, signal: input.signal, questions: [{
        id: questionId, header: '実装の準備', question: 'この実装に Lisp モードを使いますか？',
        detail: `依頼: ${input.task}\n計算・変換には Lisp を推奨しますが、通常開発では先行試作を強制しません。通常の権限と Stop は引き続き適用されます。取消・Skip はこの実装試行を中止し、作業を保持します。`,
        options: ['使う', '使わない', '取消・作業を保持'].map(label => ({label})),
      }] })
    },
  })
  disposers.push((ctx as any).on('tools/pre-execute', async (execution: any, next: () => Promise<unknown>) => {
    if (execution.agent) { const reason = preparation.denial(execution.agent, execution.name, execution.arguments, execution.parent); if (reason) return {kind:'deny', reason} }
    return next()
  }, {global:true, prepend:true}))
  if (config.enabled) disposers.push((ctx as any).provide(LISP_CODING_SERVICE, { ...createLispCodingChoice({ optional:development,
    ...(questions ? { questions } : {}),
    enabled: candidate => manager.enabled.has(owner(candidate).owner.sessionId),
    decided: async candidate => {
      const binding = owner(candidate), saved = await store.session(binding.owner.sessionId)
      if (saved && saved.root_path !== binding.owner.root) fail('SCOPE_CONFLICT', 'セッションの作業場所が変わっています。')
      return saved !== undefined
    },
    decline: async candidate => {const binding=owner(candidate);if(manager.enabled.has(binding.owner.sessionId))await manager.disable(binding.owner);else await store.decline(binding.owner);unregister(binding.agent);hostFence?.release(binding.owner.sessionId)},
    enable: async candidate => {
      const result = await enable(owner(candidate)) as { state?: string }
      if (!['READY', 'EVALUATING', 'TASK_READY'].includes(result.state ?? '')) fail('RECOVERY_REQUIRED', 'Lisp の起動・復旧が必要です。/kioku-lisp status で状態を確認してください。')
    },
  }), manualSelected: (agent: LispCodingInput['agent']) => manualMode(agent), prepareNative: (input: LispCodingInput) => preparation.prepare(input), choiceFor: (agent: LispCodingInput['agent'], task: string) => preparation.choiceFor(agent, task),
    cancelled: (agent: LispCodingInput['agent'], task: string) => preparation.cancelled(agent,task),
    answered: (agent: LispCodingInput['agent'], task: string, choice:'yes'|'no', answerRef:string) => preparation.answered(agent,task,choice,answerRef) }))
  const requestSurface: LispAssemblyService = {
    capabilities: LISP_TOOLS.map(name => ({ name, description: description(name) })),
    inventory: candidate => inventoryReaders.get(candidate.id)?.() ?? tools.schemas(candidate),
    async stopTask(candidate) {
      const binding = owner(candidate)
      if (!manager.enabled.has(binding.owner.sessionId)) return
      await manager.disposeSession(binding.owner.sessionId)
      const current = owner(candidate)
      if (current.agent !== binding.agent || current.owner.root !== binding.owner.root)
        fail('SESSION_MISMATCH', 'Lisp の停止中にセッションが変わりました。')
    },
    async taskJobsIdle(candidate) {
      try {
        const binding = owner(candidate), session = binding.agent.session
        const idle = await manager.taskJobsIdle(binding.owner)
        const current = owner(candidate)
        return idle && !fence!.stopped && !binding.signal.aborted && current.agent === binding.agent
          && current.agent.session === session && current.signal === binding.signal
          && current.owner.sessionId === binding.owner.sessionId && current.owner.agentId === binding.owner.agentId
          && current.owner.root === binding.owner.root
      } catch { return false }
    },
    taskJobsIdleSync(candidate) {
      try {
        const binding = owner(candidate), session = binding.agent.session
        const idle = manager.taskJobsIdle(binding.owner)
        const current = owner(candidate)
        return idle && !fence!.stopped && !binding.signal.aborted && current.agent === binding.agent
          && current.agent.session === session && current.signal === binding.signal
          && current.owner.sessionId === binding.owner.sessionId && current.owner.agentId === binding.owner.agentId
          && current.owner.root === binding.owner.root
      } catch { return false }
    },
    async project(candidate, assembly) {
      const binding = owner(candidate)
      const workflow = await runtime.withDatabase(db => sessionCodingWorkflow(db, binding.owner.sessionId))
      if (workflow && (!development || workflow.protocol || !isLispConversation(candidate)) && (workflow.choice.state !== 'yes' || ['preparing', 'awaiting_lisp_choice', 'cancelled', 'superseded', 'completed'].includes(workflow.state))) {
        unregister(binding.agent)
        const surface = assembly as typeof assembly & { tools?: { name: string }[] }
        return { ...assembly, tools: surface.tools?.filter(tool => !LISP_TOOLS.includes(tool.name as LispTool)) ?? [] }
      }
      if (!manager.enabled.has(binding.owner.sessionId)) return { ...assembly, sections: [...assembly.sections, { name:'kiokuko:lisp-coding-preparation', text:JSON.stringify(preparation.status(binding.agent)) }] }
      register(binding.agent)
      // Native DSH snapshots providers before its assembly waterfall. Admission
      // can activate Lisp inside that waterfall: refresh this request, not only
      // the next one. Use native visibility plus the exact guarded definitions.
      const schemas = tools.schemas(binding.agent).filter(schema=>development || fence!.definitions.get(`${candidate.id}:${schema.name}`) === tools.get(schema.name,binding.agent))
      if (!LISP_TOOLS.every(name => schemas.some(schema => schema.name === name))) fail('HOST_CAPABILITY_MISSING', 'Lisp のツール定義を要求へ反映できません。')
      const sections = assembly.sections.filter(section => section.name !== 'kiokuko:lisp')
      sections.splice(Math.max(0, sections.findIndex(section => section.name === 'kiokuko:soul') + 1), 0,
        { name: 'kiokuko:lisp', text: '{{kiokuko_lisp}}' })
      sections.push({ name:'kiokuko:lisp-coding-preparation', text:JSON.stringify(preparation.status(binding.agent)) })
      const projected = { ...assembly, sections, variables: { ...assembly.variables, kiokuko_lisp: guide },
        // Current DSH owns executor schemas and step admission. Do not replace
        // a selected PTC transport with native calls or widen its admitted set.
        ...(typeof tools.setExecutor === 'function' ? {} : { tools: schemas.sort((a, b) => a.name.localeCompare(b.name)) }) }
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
  }, (sessionId, signal) => recover(owner(agents.get(sessionId)), signal)))
  disposers.push(commands.register({ name: 'kioku-lisp', description: 'Common Lisp の開始・状態・停止・復旧', input: { hint: 'approval ask|auto|status | enable | enable-task | status [--json] | cancel | recover | abandon ID | restore ID | disable' },
    handler: async invocation => {
      try {
        const binding = owner(invocation.agent)
        const [action = 'status', argument, ...extra] = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
        if (extra.length || (argument && !['approval', 'status', 'hot', 'diagnostics', 'abandon', 'restore'].includes(action))) fail('INVALID_COMMAND', '使い方: /kioku-lisp enable|enable-task|status|hot [NAME]|diagnostics|cancel|recover|abandon ID|restore ID|disable')
        let result: unknown
        if (action === 'approval') {
          if (argument && !['ask', 'auto', 'status'].includes(argument)) fail('INVALID_COMMAND', 'Use /kioku-lisp approval ask|auto|status')
          if (argument === 'ask' || argument === 'auto') await approvalPolicy.set(argument)
          return { kind: 'success', text: `Lisp approvals: ${approvalPolicy.mode()} · Profile` }
        }
        const routeRef = `human-command:${randomUUID()}:${action}`
        if (['enable', 'enable-task', 'disable'].includes(action)) {
          await runtime.withDatabase(db => {
            const workflow = sessionCodingWorkflow(db, binding.owner.sessionId)
            if (workflow && (action === 'enable-task' || workflow.definition)) overrideCodingChoice(db, { runId: workflow.runId, sessionId: binding.owner.sessionId, repositoryRoot: binding.owner.root },
              action === 'disable' ? 'no' : 'yes', routeRef)
          })
        }
        if (action === 'enable') { result = await enable(binding, true); await manualMode(binding.agent,true); preparation.manual(binding.agent, true, routeRef) }
        else if (action === 'enable-task') {
          const wasEnabled = manager.enabled.has(binding.owner.sessionId)
          hostFence?.protect(binding.owner.sessionId)
          try { result = await manager.enableTask(binding.owner, binding.signal); register(binding.agent); await manualMode(binding.agent,true); preparation.manual(binding.agent, true, routeRef) }
          catch (error) {
            if (!wasEnabled && !manager.enabled.has(binding.owner.sessionId)) hostFence?.release(binding.owner.sessionId)
            throw error
          }
        }
        else if (action === 'disable') { result = await manager.disable(binding.owner); preparation.manual(binding.agent, false, routeRef); unregister(binding.agent); hostFence?.release(binding.owner.sessionId) }
        else if (action === 'cancel') result = await manager.execute(binding.owner, 'lisp_cancel', {})
        else if (action === 'recover') {
          if (manager.enabled.has(binding.owner.sessionId)) register(binding.agent)
          result = await recover(binding, invocation.signal)
        }
        else if (action === 'abandon') result = await manager.abandon(binding.owner, argument ?? '')
        else if (action === 'restore') result = await manager.restore(binding.owner, argument ?? '', invocation.signal)
        else if (action === 'diagnostics') result = await manager.diagnostics(binding.owner, argument === '--json' ? undefined : argument)
        else if (action === 'hot') result = await manager.execute(binding.owner, 'lisp_hot_status', argument && argument !== '--json' ? { name: argument } : {}, binding.signal)
        else if (action === 'status') result = { ...await manager.status(binding.owner) as object, codingPreparation: preparation.status(binding.agent) }
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
  return ({ lisp_eval: 'Evaluate Common Lisp. Prefer Lisp for useful calculations and transformations; ordinary development does not require a preliminary prototype. Explicitly protected coding workflows require prototype:true and saved-result inspection before implementation. In persistent mode, define and reuse cohesive functions in one worker generation; proposals use the current host approval policy. In enable-task mode, each evaluation is a disposable scratch experiment without workspace inputs or proposals. Exact operationId replay never re-evaluates.',
    lisp_hot_contract: 'Authorize immutable schemas through the current host approval policy and finite input/expected cases for a project-shared function. Profile auto-approval or explicit human consent grants approval; model declarations do not. Requires enable-task.',
    lisp_hot_install: 'Validate a candidate against the current approved contract in workers using the selected execution mode, then atomically select it at expectedRevision. Dependency code is snapshotted. Failed checks preserve the active version.',
    lisp_hot_call: 'Call a project-shared function by name, pinning its active immutable version. Input/result refs remain private to this session and agent. Exact operationId replay never executes again.',
    lisp_hot_status: 'Read project-shared function names, revisions and contract refs; paginate with offset. Supply name to inspect approved checks; contractOffset pages their JSON in 2000 Unicode characters. No worker execution.',
    lisp_hot_deactivate: 'Use the current host approval policy to deactivate a project-shared function at expectedRevision. Existing calls and results remain available; new calls stop.',
    lisp_define: 'Save a generated Lisp lambda and exact dependency refs as a reusable task tool. Requires /kioku-lisp enable-task. Compiles in an isolated worker and checks declared examples.',
    lisp_call: 'Run a saved task tool with JSON input or a saved resultRef. Exact retries return the journal result; new calls use isolated workers.',
    lisp_observe: 'Capture explicitly named workspace files as immutable task input, returning a resultRef without sending contents to the model.',
    lisp_stage: 'Turn a generated result into a guarded, immutable workspace change candidate bound to an observed baseRef. No workspace write.',
    lisp_verify: 'Materialize one candidate from frozen observed bytes in private scratch, then run an approved host verifier. The receipt remains bound to that candidate; unknown test reporting is not a pass.',
    lisp_apply: 'Apply one staged candidate through existing host approval. Reject changed evidence, duplicate attempts and unknown effects.',
    lisp_compare: 'Compare two immutable candidates by common base and per-path intent hashes without rerunning either tool or claiming a verifier pass.',
    lisp_describe: 'Describe Lisp APIs or task functions. symbol="kioku.user" lists this worker\'s functions; symbol="kioku.user::name" returns arguments and documentation. No symbol returns the bundled API/verifier map.', lisp_inspect: 'Read a retained object or a page of saved evidence; never executes the original operation.', lisp_status: 'Read current host state and paged operation summaries without contacting Lisp.',
    lisp_cancel: 'Stop Lisp and all managed jobs without waiting for evaluation.', lisp_reset: 'Stop a healthy worker and start a new generation. Never use to bypass recovery.' })[name]
}
export function lispToolSchema(name: LispTool): object {
  const hotSchemas = { lisp_hot_contract: HotContractInput, lisp_hot_install: HotInstallInput,
    lisp_hot_call: HotCallInput, lisp_hot_deactivate: HotDeactivateInput, lisp_hot_status: HotStatusInput }
  if (name in hotSchemas) {
    const schema = hotSchemas[name as keyof typeof hotSchemas]
    // Zod attaches a non-enumerable ~standard validator. Native DSH accepts
    // lossless JSON only; the transport receives the generated JSON schema.
    // Providers may reject Unicode property escapes; execute still validates with identifier.
    const transportSchema = name === 'lisp_hot_status' ? schema : schema.safeExtend({ operationId: z.string().min(1).max(256) })
    return JSON.parse(JSON.stringify(z.toJSONSchema(transportSchema, { io: 'input' }))) as object
  }
  const properties: Record<string, unknown> = name === 'lisp_status' ? {} : { operationId: { type: 'string', minLength: 1, maxLength: 256 } }
  const required = Object.keys(properties)
  if (name === 'lisp_status') properties.offset = { type: 'integer', minimum: 0, description: 'Read the next 10 operation summaries using nextOffset.' }
  if (name === 'lisp_eval') { Object.assign(properties, { prototype: { type:'boolean', description:'Mark the small coding prototype. After success inspect its saved resultOperationId before implementation.' }, code: { type: 'string', maxLength: 262144 }, inputs: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'Workspace-relative files or exact host paths of files uploaded by the user in this session. Copied read-only; other absolute paths are refused.' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 } }); required.push('code') }
  if (name === 'lisp_define') { Object.assign(properties, { name: { type: 'string', maxLength: 64 }, description: { type: 'string', maxLength: 1000 }, source: { type: 'string', maxLength: 262144 }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, dependencies: { type: 'array', items: { type: 'object' }, maxItems: 32 }, examples: { type: 'array', items: { type: 'object' }, maxItems: 10 }, firstInput: {} }); required.push('name', 'description', 'source', 'inputSchema', 'outputSchema') }
  if (name === 'lisp_call') { Object.assign(properties, { toolRef: { type: 'string', format: 'uuid' }, input: {}, inputRef: { type: 'string', format: 'uuid' }, fields: { type: 'array', items: { type: 'string' }, maxItems: 20 } }); required.push('toolRef') }
  if (name === 'lisp_observe') { Object.assign(properties, { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 }, format: { type: 'string', enum: ['text', 'json'] } }); required.push('paths') }
  if (name === 'lisp_stage') { Object.assign(properties, { resultRef: { type: 'string', format: 'uuid' }, baseRef: { type: 'string', format: 'uuid' } }); required.push('resultRef', 'baseRef') }
  if (name === 'lisp_verify') { Object.assign(properties, { candidateRef: { type: 'string', format: 'uuid' }, target: { type: 'string', enum: ['typecheck', 'lisp', 'test', 'build', 'package', 'vendor'] }, script: { type: 'string', maxLength: 256 } }); required.push('candidateRef', 'target') }
  if (name === 'lisp_apply') { Object.assign(properties, { candidateRef: { type: 'string', format: 'uuid' }, verificationRef: { type: 'string', maxLength: 256 } }); required.push('candidateRef') }
  if (name === 'lisp_compare') { Object.assign(properties, { leftRef: { type: 'string', format: 'uuid' }, rightRef: { type: 'string', format: 'uuid' } }); required.push('leftRef', 'rightRef') }
  if (name === 'lisp_describe') { properties.symbol = { type: 'string', maxLength: 256 }; properties.toolRef = { type: 'string', format: 'uuid' } }
  if (name === 'lisp_inspect') Object.assign(properties, {
    ref: { type: 'string', maxLength: 256, description: 'Worker reference; use either ref or resultOperationId.' },
    resultOperationId: { type: 'string', maxLength: 256, description: 'Saved operation from this session and agent. Reads evidence without executing again.' },
    section: { type: 'string', enum: ['result', 'value', 'stdout', 'stderr', 'changes'] },
    pointer: { type: 'string', maxLength: 1024, description: 'With section=result, follow the returned JSON pointer to the exact omitted field.' },
    offset: { type: 'integer', minimum: 0, description: 'Unicode character offset; use the returned nextOffset.' },
    limit: { type: 'integer', minimum: 1, maximum: 2000 },
  })
  if (name === 'lisp_cancel') properties.generation = { type: 'string', maxLength: 256, description: 'Required for a persistent worker; omit in task mode.' }
  return { type: 'object', properties, required, additionalProperties: false }
}
