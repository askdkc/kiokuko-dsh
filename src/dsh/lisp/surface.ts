import { contextRoot } from '../context-root.js'
import { lispWorkflowAccess, isLispWorkflowDiagnostic } from './workflow-access.js'
import { NativeChildOwnership } from './native-child-ownership.js'
import { createLispHostDispatch, lispHostToolWasNotDispatched } from './host-tool-dispatch.js'
import { formatLispStatus, type LispStatusView } from './status-text.js'
import { ManagedDispatchDenied, managedAdmissionDenied, currentManagedOperation, observeManagedResult } from '../managed-operation-runner.js'
import { ManagedOperationJournal } from '../managed-operation-journal.js'
import { nativeStopReceipt } from './native-stop-receipt.js'
import { withNativeForegroundOnly } from './native-foreground.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { isCodingWorkflowTool } from '../coding-workflow/host.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { rememberLispImplementation, isLispConversation, rootLispAdmission, withRootLispAdmission, withLispNativeCommand, withLispOwnedCommand, isLispNativeCommand, isLispNativeCommandFence, type LispNativeCommands } from '../lisp-tool-identity.js'
import { assertProtocolRoute } from '../guardrail/service.js'
import { isOwnedExecutionCall } from '../owned-execution.js'
import { CodeIntelligenceAdapterV1 } from './code-intelligence.js'
import { mountApprovalPolicy } from './approval-settings.js'
import type { ApprovalQuestions } from './approval.js'
import type { SemanticCompactionCoordinator } from '../semantic-compaction/coordinator.js'
import { handoffRange } from '../model-handoff.js'
import { renderHistoryResult } from './model-result.js'
import { isDeepStrictEqual } from 'node:util'
import { savedPageVersion, savedResultVersion, type SavedResultPage } from './inspection.js'
import type { InspectionReceipt } from './prototype-review.js'
import { dshTurnRequestId } from '../intake-profile-resolver.js'
import { TASK_PREPARE_TOOL } from '../on-demand-intake.js'
import { REQUEST_SOURCE_TOOL } from '../request-sources.js'
import type { DecisionService } from '../decisions/service.js'
import { DecisionError } from '../decisions/contracts.js'
import type { Context } from '@deepseek-ai/cordis'
import type { DshSkillPrompts } from '../skill-prompts.js'
import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { DshCoreRuntime as DshRuntime } from '../core-runtime.js'
import type { DshNativeCommandDefinition } from '../commands.js'
import type { DshUserQuestions } from '../user-interaction.js'
import { LispManager } from './manager.js'
import { LispStore } from './store.js'
import { HotCallInput, HotContractInput, HotDeactivateInput, HotInstallInput, HotStatusInput } from './hot-contracts.js'
import { LispCodingPreparation, type PreparationObservation } from './coding-preparation.js'
import { askLispCodingQuestion } from '../coding-question.js'
import { createLispCodingChoice, LISP_CODING_SERVICE, type LispCodingInput } from './coding-choice.js'
import { sessionCodingWorkflow } from '../coding-workflow/store.js'
import { overrideCodingChoice } from '../coding-workflow/service.js'
import { LISP_ASSEMBLY_SERVICE, type LispAssemblyService } from './request-surface.js'
import { mountLispHttp } from './http.js'
import { createLispCiAdapter } from './ci.js'
import { createLispPackageAdapter } from './packages.js'
import { withTaskAuthority } from '../task-authority-context.js'
import {isNativeSubagent} from '../native-subagent.js'
import { TASK_AUTHORITY, type TaskLease } from '../task-state.js'
import { createLispMemoryVerification } from './memory-verification.js'
import { isSavedLispResultRead } from '../memory-application.js'
import { attachmentInput, type LispAttachmentSession, type LispAttachmentStore } from './attachment-input.js'
import { HttpTypeSafeClient } from '../typesafe/client.js'
import { typeSafeCredentials } from '../typesafe/command.js'
import { LISP_TOOLS, LispError, failure, fail, identifier, renderResult, type LispConfiguration, type LispOwner, type LispTool } from './contracts.js'

interface Session extends LispAttachmentSession { id: string; header: { cwd: string; parentSession?: string } }
interface Agent { id: string; status?: string; session: Session; ctx: { get(name: string, strict?: boolean): any }; inject?: (message: unknown) => void }
interface Tools { register(definition: any, options?: {when: () => boolean}): () => void; guard(fn: (execution: any) => string | undefined): () => void; get(name: string, scope?: unknown, toolSet?: unknown): any; schemas(scope?: unknown, toolSet?: unknown): { name: string; description: string; parameters: unknown }[]; modeFor?(scope:unknown):string; presentAs?(mode: 'native'): () => void; setExecutor?: unknown; restrict(options: { allow: string[] }): () => void; execute(execution: unknown): Promise<unknown> }
interface ExecutionFence { protect(sessionId: string): void; release(sessionId: string): void }
interface ExecutionFences { attach(request: { id: string; tools: readonly string[]; check(execution: any): string | undefined; beforeStep(agent: Agent): Promise<boolean> }): ExecutionFence }
interface Fence { sessions: Map<string, string>; controller?: LispManager; prepareAgent?: (agent: Agent) => Promise<boolean>; definitions: Map<string, object>; stopped: boolean; executionMode: 'development'|'protected'; protocolBridge?: (execution: any) => boolean; diagnosticOnly?: WeakSet<Agent> }
const fenceKey = Symbol.for('kiokuko.lisp.host-fence.v1')
const PROTOCOL_OWNED_TOOLS = ['kioku_read', 'kioku_write', 'kioku_edit', 'kioku_exec', 'kioku_result'] as const
const PROTOCOL_OWNED_EFFECTS = new Set<string>(['kioku_write', 'kioku_edit', 'kioku_exec'])
const LISP_READ_TOOLS = [
  'read',
  'read_image',
  'job_output',
  'job_list',
  'list_subagent_models',
  'glob',
  'grep',
  'skill',
  'observation_read',
  REQUEST_SOURCE_TOOL,
] as const
const NATIVE_SHELL_TOOLS = new Set(['bash', 'zsh', 'pwsh'])
// Keep host-owned review, questions and Plan approval reachable while Lisp blocks native effects.
// Pin its implementation just like reads; its own run/session checks still apply.
const LISP_NATIVE_TOOLS = [
  ...LISP_READ_TOOLS,
  'todo_write',
  TASK_PREPARE_TOOL,
  'task_operation',
  'correction_check',
  'task_memory_review',
  'task_completion',
  'coding_workflow',
  'coding_workflow_apply',
  'coding_workflow_blocker',
  'ask_user_question',
  'exit_plan_mode',
] as const

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
  if (value && typeof value === 'object' && 'enabled' in value) return formatLispStatus(value as LispStatusView)
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
  targetOperationId: identifier.optional(), ticket: identifier.optional(), restartId: identifier.optional(), arguments: z.array(z.unknown()).max(16).optional(),
  reasonCode: z.string().min(1).max(256).optional(), objective: z.string().max(4000).optional(), constraints: z.array(z.string().max(1000)).max(32).optional(),
  changedFiles: z.array(z.string().max(4096)).max(100).optional(), completed: z.array(z.string().max(2000)).max(100).optional(),
  pending: z.array(z.string().max(2000)).max(100).optional(), evidenceIds: z.array(z.string().max(256)).max(100).optional(),
  uncertainEffects: z.array(z.string().max(2000)).max(100).optional(), nextSteps: z.array(z.string().max(2000)).max(100).optional(),
  resultOperationId: identifier.optional(), managedOperationId: identifier.optional(), expectedGeneration: identifier.nullable().optional(), section: z.enum(['result', 'value', 'stdout', 'stderr', 'changes']).optional(),
  pointer: z.string().max(1024).optional(),
  offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(2000).optional() }).strict()

export async function lispFallbackCompactionOutcome(agent: Agent, signal: AbortSignal,
  compaction?: { compactRegion(start:number,end:number,agent:Agent,signal:AbortSignal):Promise<any> }): Promise<Record<string,unknown>> {
  if (!compaction?.compactRegion) return { outcome: 'unavailable' }
  const range = handoffRange(agent.session as any)
  if (!range) return { outcome: 'skipped', reason: 'history_too_short_or_unbalanced' }
  try {
    const result = await compaction.compactRegion(range.start, range.end, agent,
      AbortSignal.any([signal, AbortSignal.timeout(30_000)]))
    return result?.compactionId ? { outcome: 'summarized', compactionId: result.compactionId }
      : { outcome: 'failed', reason: 'missing_compaction_identity' }
  } catch (error) { return { outcome: 'failed', error: failure(error) } }
}

/** The fence belongs to the host root, so plugin unload cannot restore bash access. */
export async function mountLispSurface(ctx: Context, runtime: DshRuntime, config: LispConfiguration, skillPrompts?: DshSkillPrompts, decisions?: DecisionService, semanticCompaction?: SemanticCompactionCoordinator): Promise<{ stop(): void; dispose(): Promise<void>; manager: LispManager }> {
  const root = (contextRoot(ctx)) as unknown as Context & { [fenceKey]?: Fence }
  const tools = root.get('tools', false) as Tools | undefined
  const pluginTools = ctx.get('tools', false) as Tools | undefined
  const agents = root.get('agents', false) as { get(id: string): Agent | undefined;isOwnedBy?(id:string,parent:Agent):boolean } | undefined
  const sessions = root.get('sessions', false) as { get(id: string): Session | undefined } | undefined
  const commands = ctx.get('commands', false) as { register(definition: DshNativeCommandDefinition): () => void } | undefined
  if (!tools || !pluginTools || !agents || !sessions || !commands) fail('HOST_CAPABILITY_MISSING', 'Lisp には DSH のツール・セッション・コマンドサービスが必要です。')
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
  const toolDefinitionIds = new WeakMap<object, string>()
  const definitionId = (definition: object): string => {
    let id = toolDefinitionIds.get(definition)
    if (!id) { id = `tool-v1-${randomUUID()}`; toolDefinitionIds.set(definition, id) }
    return id
  }
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
  const pendingFallbacks = new Map<Agent, Awaited<ReturnType<LispStore['activeFallback']>>>()
  const fallbackPrompts = new Map<Agent, () => void>()
  const installFallbackPrompt = (agent: Agent, fallback: NonNullable<Awaited<ReturnType<LispStore['activeFallback']>>>) => {
    fallbackPrompts.get(agent)?.()
    const prompt = agent.ctx.get('systemPrompt', false) as { section(input: unknown): () => void } | undefined
    if (!prompt) return
    const remove = prompt.section({ name: 'kiokuko:lisp-fallback', order: -89998,
      text: `Lisp execution route was disabled after ${fallback.reasonCode}. Continue this same task with the standard DSH tools. Do not automatically return to Lisp. Host handoff ${fallback.fallbackId}: ${JSON.stringify(fallback.handoff).slice(0, 24000)}` })
    fallbackPrompts.set(agent, remove)
  }
  const typesafe = new HttpTypeSafeClient(typeSafeCredentials(ctx))
  let ownerForOwned:(binding:LispOwner)=>{signal:AbortSignal}
  const ownedCall = async(owner:LispOwner,name:string,args:Record<string,unknown>,signal?:AbortSignal,callId?:string, taskLease?:TaskLease, argv?: readonly string[], operation?: import('../operation-spec.js').OperationSpec):Promise<any> => {
    const agent=agents.get(owner.agentId)
    if(!agent||agent.session.id!==owner.sessionId||sessions.get(owner.sessionId)!==agent.session||realpathSync(agent.session.header.cwd)!==owner.root)fail('SESSION_MISMATCH','Owned tool caller changed.')
    const binding=ownerForOwned(owner)
    const invocation = {callId:callId??`lisp-owned-${crypto.randomUUID()}`,name,arguments:args,agent,parent:Symbol('lisp-owned'),signal:signal?AbortSignal.any([binding.signal,signal]):binding.signal,
      ...(taskLease ? { [TASK_AUTHORITY]: taskLease } : {})}
    const dispatch = () => dispatchHostTool(invocation)
    const execute = () => argv && name === 'kioku_exec' && typeof args.command === 'string'
      ? withLispOwnedCommand(invocation, args.command, argv, dispatch, operation) : dispatch()
    const result=await (taskLease ? withTaskAuthority(taskLease, execute) : execute()) as any
    if (lispHostToolWasNotDispatched(result)) managedAdmissionDenied(new LispError(
      'OWNED_EXECUTION_NOT_DISPATCHED', result.error?.message ?? JSON.stringify(result.content),
      '元の要求とホストの拒否理由を確認してください。この変更は適用されておらず、Lisp の復旧は不要です。',
    ))
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
        const argv = [file, ...args]
        const value=await ownedCall(owner,'kioku_exec',{command:argv.map(quote).join(' '),cwd:options.cwd,timeoutMs:options.timeoutMs},options.signal,undefined,
          request.kind === 'verify' ? await manager.taskAuthority.authorizeEffect(owner) : undefined, argv)
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
    toolCall: async (owner, name, args, signal,callId,taskLease,argv,operation) => {
      const agent = agents.get(owner.agentId)
      if (!agent || agent.session.id !== owner.sessionId || sessions.get(owner.sessionId) !== agent.session || realpathSync(agent.session.header.cwd) !== owner.root) fail('SESSION_MISMATCH', 'ホスト呼び出しの主体を確認できません。')
      if (development) return ownedCall(owner,name,args,signal,callId,taskLease,argv,operation)
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
      if (persistent.executionMode === 'development' && !LISP_TOOLS.includes(execution.name)) {
        if (!NATIVE_SHELL_TOOLS.has(execution.name)) return undefined
        // Selecting Lisp changes the model's execution route, not the native
        // command's permissions. Only the exact host-minted process bridge may
        // use Bash; a nested call or a claimed parent alone is not sufficient.
        if (!persistent.stopped && persistent.controller && agent && agent.session.id === scope
          && agents.get(agent.id) === agent && sessions.get(scope) === agent.session
          && (hostFences ? isLispNativeCommandFence : isLispNativeCommand)(execution, tools.get(execution.name, agent)?.execute)) return undefined
        return 'LISP_ROUTE_REQUIRED: Lisp is enabled for this session. Compose operations through kioku.data/workspace/tools/jobs and bind typed checks with kioku.verify. Direct Bash/zsh/PowerShell calls are disabled. Read/search/Skill tools remain available. Diagnose and recover Lisp first; after a host-observed unrecoverable runtime/API failure, use lisp_fallback to preserve the handoff and continue with standard DSH tools. Stop, cancellation, permission denial and unknown effects are not fallback reasons. The user can explicitly disable Lisp with /kioku-lisp disable.'
      }
      if (persistent.executionMode === 'protected' && execution.name === 'run_code') return 'Protected Lisp requires the native DSH tool executor. Select native execution in the DSH profile, or disable protected Lisp; the PTC program was not executed.'
      if (persistent.stopped || !persistent.controller) return persistent.executionMode==='development' ? 'Lisp は停止中です。通常ツールは利用できます。' : 'Lisp の保護が継続中です。プラグインを戻し /kioku-lisp status で確認してください。'
      if (!agent || agents.get(agent.id) !== agent || sessions.get(agent.session.id) !== agent.session) return 'Lisp のセッションを確認できません。'
      if (agent.session.id !== scope) return '保護中の子セッションでは任意ツールを実行できません。親セッションの Lisp を使用してください。'
      if (persistent.executionMode === 'protected' && persistent.diagnosticOnly?.has(agent)) {
        const name = execution.name as LispTool
        const diagnostic = ['lisp_status', 'lisp_hot_status', 'lisp_recover', 'lisp_cancel'].includes(name) || isSavedLispResultRead(execution)
        if (PROTOCOL_OWNED_EFFECTS.has(name) || LISP_TOOLS.includes(name) && !diagnostic)
          return 'RECOVERY_REQUIRED: inspect lisp_status and the saved receipts before resuming Lisp work.'
      }
      if (persistent.protocolBridge?.(execution)) return undefined
      // Goal preparation temporarily removes Lisp registrations. Keep this
      // plugin's actual controls reachable without admitting same-name replacements.
      if (['coding_workflow', 'coding_workflow_apply', 'coding_workflow_blocker'].includes(execution.name)
        && isCodingWorkflowTool(tools.get(execution.name, agent))) return undefined
      const registered = persistent.definitions.get(`${agent.id}:${execution.name}`)
      if (registered && tools.get(execution.name, agent)?.execute === (registered as { execute: unknown }).execute) return undefined
      return 'Lisp 保護中は Lisp ツールと DSH の読み取り・検索・スキル読み込み・質問・計画提出を使えます。変更は Lisp 経由で行ってください。作業プロジェクト内の削除・既存ファイルの置換に追加の利用者確認は不要です。プロジェクト外の変更には確認が必要です。'
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
      // Reject a route mismatch before native approval UI, then recheck in the
      // monotonic guard so later middleware cannot grant direct shell access.
      root.on('tools/pre-execute' as never, (async (execution: any, next: () => Promise<unknown>) => {
        if (persistent.executionMode === 'development' && NATIVE_SHELL_TOOLS.has(execution.name)) {
          const reason = check(execution)
          if (reason) return { kind: 'deny', reason }
        }
        return next()
      }) as never, { prepend: true, global: true })
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
  const diagnosticOnly = new WeakSet<Agent>(); fence.diagnosticOnly = diagnosticOnly
  fence.sessions = manager.enabled; fence.controller = manager; fence.stopped = false
  fence.protocolBridge = execution => {
    const active = protocolBridgeScope.getStore()
    return Boolean(active && active.agent === execution.agent && active.name === execution.name && active.callId === execution.callId
      && protocolDefinitions.get(`${active.agent.id}:${active.name}`) === active.pinned
      && tools.get(active.name, active.agent) === active.pinned.definition
      && tools.get(active.name, active.agent)?.execute === active.pinned.execute && isOwnedExecutionCall(execution))
  }
  const disposers: (() => void)[] = []
  // Native children compose their preset, not the parent's agent-local tools.
  // Publish restrictable descriptors before child creation. Only an admitted
  // session's local implementations can execute; the persistent guard also
  // rejects these unbound descriptors. Native allow/deny masks remain visible.
  // Registrations belong to this activation, not the host root's lifetime.
  // The independent host fence above still denies effects after plugin unload.
  if (config.enabled) for (const name of LISP_TOOLS) disposers.push(pluginTools.register({
    name, description: description(name), modelFacing: true, parameters: lispToolSchema(name),
    output: { schema: {}, render: (_: unknown, result: unknown) => [{ type: 'text', text: renderResult(result) }] },
    execute: async () => failure(new LispError('LISP_DISABLED', 'This session has no admitted Lisp worker.')),
  }, {when: () => false}))
  if (semanticCompaction) for (const tool of ['lisp_eval', 'lisp_inspect']) disposers.push(semanticCompaction.registerProjector(tool, renderHistoryResult))
  try {
  const sessionBindings = new Map<string, { session: Session; abort: AbortController }>()
  type PreparationCall = { observe: PreparationObservation; inspection?: InspectionReceipt }
  const preparationCalls = new WeakMap<object, PreparationCall>()
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
  const approvalText = () => `Lisp execution mode: ${config.executionMode}; approval mode: ${approvalPolicy.mode()} (entire profile). `
    + 'Changes within the working project directory, including deletion, replacement and project DB updates, need no extra user permission. Outside-project changes require concrete confirmation. Native permissions, protected paths, cancellation and unknown outcomes remain authoritative. '
    + (development ? 'The selected Lisp execution route still applies.' : 'Protected compatibility mode retains its sandbox and non-file approval policy.')
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
  if (policyPrompt) disposers.push(policyPrompt.section({ name: 'kiokuko:lisp-route', order: 90000,
    text: ({agent}: {agent?: Agent}) => agent && manager.enabled.has(agent.session.id)
      ? 'Lisp is ON. Keep state, transformations and orchestration in Lisp. Prefer kioku.test:spec with kioku.verify:bind/run, discover current DSH tools through kioku.tools:list/describe/call, and use kioku.workspace and kioku.jobs for structured effects. kioku.process remains a compatibility adapter. Direct shell calls are rejected. Read/search/Skill and owned file tools remain available. Diagnose and recover failures; only lisp_fallback may switch an unrecoverable Lisp runtime/API failure to standard DSH tools with a durable handoff.' : '' }))
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
  const workflowAccess = async (agent: Agent) => {
    const binding = owner(agent)
    const workflow = await runtime.withDatabase(db => sessionCodingWorkflow(db, binding.owner.sessionId))
    return lispWorkflowAccess(workflow, binding.owner.root, development && isLispConversation(agent))
  }
  const register = (agent: Agent) => {
    if (registeredAgents.has(agent)) return
    if (boundAgents.has(agent.id)) unregister(boundAgents.get(agent.id)!)
    boundAgents.set(agent.id, agent)
    const local: (() => void)[] = []
    agentDisposers.set(agent.id, local)
    const scopedTools = agent.ctx.get('tools') as Tools
    // A child-local registration must not reintroduce capabilities hidden by
    // its native inherited-tool filter. Metadata alone cannot widen its scope.
    const inheritedLisp=isNativeSubagent(agent)?new Set(tools.schemas(agent).map(tool=>tool.name)):undefined
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
      if(inheritedLisp&&!inheritedLisp.has(name))continue
      const definition = { name, get description() { return `${description(name)} Current Lisp approval mode: ${approvalPolicy.mode()} (profile).` }, modelFacing: true,
        parameters: lispToolSchema(name), output: { schema: {}, render: (_: unknown, result: unknown) => [{ type: 'text', text: renderResult(result) }] },
        execute: async (args: unknown, execution: { agent?: Agent; signal?: AbortSignal; callId?: string; rootCallId?: string; token?: symbol; toolSet?: unknown; parent?: unknown }) => {
          try {
            const binding = owner(execution.agent), parsed = ToolInput.parse(args)
            binding.signal.throwIfAborted()
            execution.signal?.throwIfAborted()
            const access = await workflowAccess(binding.agent)
            if (access.visibility === 'hidden' || access.visibility === 'diagnostics' && !isLispWorkflowDiagnostic({name, arguments: parsed, parent: execution.parent}))
              fail('LISP_WORKFLOW_BLOCKED', `Lisp workflow is ${access.state}. ${access.recovery}`)
            const codingRequest = preparation.binding(binding.agent)
            const observe = preparation.track(binding.agent, name, parsed, execution.parent)
            const tracked: PreparationCall | undefined = observe ? { observe } : undefined
            if (tracked) preparationCalls.set(execution, tracked)
            const admission = development ? rootLispAdmission(execution) : undefined
            const agentSession = binding.agent.session, agentContext = binding.agent.ctx
            const bash = admission ? tools.get('bash', binding.agent) : undefined
            const pinned = bash ? { definition: bash, execute: bash.execute } : undefined
            let prototypeProcessFailed = false
            const nativeCommands: LispNativeCommands | undefined = admission ? {
              // Only hosts without Bash use the owned adapter. A scoped
              // restriction on an existing Bash tool must remain a denial.
              processRoute: pinned || tools.get('bash') ? 'native' : 'owned',
              assertCurrent() {
                const current = owner(execution.agent)
                if (!admission.current() || binding.signal.aborted || execution.signal?.aborted || current.signal !== binding.signal
                  || current.owner.root !== binding.owner.root || binding.agent.session !== agentSession || binding.agent.ctx !== agentContext)
                  fail('STALE_NATIVE_COMMAND', 'Native Lisp caller, turn or arguments changed.')
              },
              toolCatalog() {
                this.assertCurrent()
                return tools.schemas(binding.agent, execution.toolSet).flatMap(schema => {
                  if (LISP_TOOLS.includes(schema.name as LispTool) || NATIVE_SHELL_TOOLS.has(schema.name) || schema.name === 'run_code') return []
                  const current = tools.get(schema.name, binding.agent, execution.toolSet)
                  return current ? [{ ...schema, definitionId: definitionId(current), available: true as const }] : []
                })
              },
              async callTool(name, expectedDefinitionId, args, signal) {
                this.assertCurrent()
                if (LISP_TOOLS.includes(name as LispTool) || NATIVE_SHELL_TOOLS.has(name) || name === 'run_code')
                  fail('CAPABILITY_DENIED', 'Recursive Lisp and shell transports are not callable through KIOKU.TOOLS.')
                const current = tools.get(name, binding.agent, execution.toolSet)
                if (!current || definitionId(current) !== expectedDefinitionId)
                  fail('STALE_TOOL_DEFINITION', 'The admitted tool definition changed; refresh AVAILABLE-TOOLS.')
                const child = { name, callId: `lisp-tool-${randomUUID()}`, agent: binding.agent,
                  parent: execution.token ?? Symbol('lisp-connected-tool'),
                  ...(execution.rootCallId ?? execution.callId ? { rootCallId: execution.rootCallId ?? execution.callId } : {}),
                  ...(execution.toolSet ? { toolSet: execution.toolSet } : {}), arguments: args,
                  signal: AbortSignal.any([binding.signal, signal]) }
                const result = await dispatchHostTool(child) as any
                this.assertCurrent()
                if (result?.isError) fail('CONNECTED_TOOL_FAILED', JSON.stringify(result.content).slice(0, 4000))
                return result?.value
              },
              async run(input, signal) {
                this.assertCurrent()
                if (!pinned) managedAdmissionDenied(new LispError('HOST_ADAPTER_UNAVAILABLE', 'The native Bash tool is unavailable.'))
                if (tools.get('bash', binding.agent) !== pinned.definition || tools.get('bash', binding.agent)?.execute !== pinned.execute)
                  fail('STALE_NATIVE_COMMAND', 'Native Bash implementation changed.')
                const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
                const directory = input.directory ?? binding.owner.root
                // Bash resolves relative workdirs against the session. Pin that
                // exact absolute spelling before dispatch so the stop receipt
                // can be compared without guessing path/symlink equivalence.
                const workdir = isAbsolute(directory) ? directory : `${binding.owner.root}/${directory}`
                const child = { name: 'bash', callId: `lisp-native-${randomUUID()}`, agent: binding.agent, parent: execution.token ?? Symbol('lisp-native-command'),
                  ...(execution.rootCallId ?? execution.callId ? { rootCallId: execution.rootCallId ?? execution.callId } : {}),
                  ...(execution.toolSet ? { toolSet: execution.toolSet } : {}),
                  arguments: { command: [input.program, ...input.argv].map(quote).join(' '), description: 'Run the requested Lisp command through native Bash',
                    workdir, timeoutMs: input.timeoutMs }, signal: AbortSignal.any([binding.signal, signal]) }
                const commandAdmission = { current: () => {
                  try { this.assertCurrent(); return true } catch { return false }
                } }
                const managed = currentManagedOperation()
                if (managed) await managed.database(db => {
                  const journal = new ManagedOperationJournal(db)
                  if (managed.kind !== 'process' || journal.readScope(managed.scopeId).sessionId !== binding.owner.sessionId)
                    fail('STALE_NATIVE_COMMAND', 'Native command journal owner changed.')
                  journal.attachOriginalRef(managed.operationId, child.callId)
                })
                // Observe the registry's exact dispatch stage, not an error string:
                // policy rejection returns before tools/execute is reached.
                let dispatchStarted = false
                let invalidDirectory: ManagedDispatchDenied | undefined
                const removeDispatchWitness = (ctx as any).on('tools/execute', async (execution: any, next: () => Promise<unknown>) => {
                  if (execution.callId === child.callId && execution.agent === child.agent && execution.parent === child.parent && execution.name === child.name) {
                    // Recheck the existing exact-call capability before allowing
                    // the dispatch continuation. Mutated arguments/owners never
                    // enter the pinned body and are a known admission denial.
                    if (!isLispNativeCommand(execution, pinned.execute)) throw new ManagedDispatchDenied('Host rejected tool before dispatch.')
                    if (input.directory !== undefined) {
                      const info = await stat(workdir).catch((error: NodeJS.ErrnoException) => {
                        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
                        // Leave other filesystem errors to the native tool.
                        return undefined
                      })
                      if (!isLispNativeCommand(execution, pinned.execute)) throw new ManagedDispatchDenied('Host rejected tool before dispatch.')
                      if (info === null || (info && !info.isDirectory())) {
                        invalidDirectory = new ManagedDispatchDenied('指定した作業ディレクトリがありません。作成済みのディレクトリを指定してください。コマンドは起動していません。')
                        throw invalidDirectory
                      }
                    }
                    dispatchStarted = true
                    const host = binding.agent.ctx ?? ctx
                    return withNativeForegroundOnly(host.get('jobs', false), next)
                  }
                  return next()
                }, {global:true, prepend:true})
                let result: any
                try { result = await withLispNativeCommand(child, pinned.execute, commandAdmission, () => dispatchHostTool(child), [input.program, ...input.argv], input.operation) }
                catch (error) { throw invalidDirectory ?? error }
                finally { removeDispatchWitness() }
                if (invalidDirectory) throw invalidDirectory
                if (result.isError) {
                  if (!dispatchStarted) throw new ManagedDispatchDenied('Host rejected tool before dispatch.')
                  const stopped = nativeStopReceipt(result, { callId: child.callId, rootCallId: child.rootCallId ?? child.callId,
                    ownerId: binding.agent.id, sessionId: binding.owner.sessionId, cwd: child.arguments.workdir })
                  if (stopped && managed) {
                    await observeManagedResult(managed, { receipt: stopped })
                    fail('NATIVE_COMMAND_CANCELLED', 'Native command was cancelled and its managed process range stopped. Earlier effects may remain; no command was retried.')
                  }
                  fail('NATIVE_COMMAND_UNCONFIRMED', 'Native command did not return a confirmed result; inspect its host receipt before retrying.')
                }
                const value = result.value
                if (value.kind === 'background' || value.kind === 'promoted') {
                  const jobs = ctx.get('jobs', false) as any
                  if (jobs) {
                    jobs.kill(value.jobId, binding.agent.id, 'Lisp synchronous execution cannot run in background')
                    await jobs.wait(value.jobId, 5000, binding.agent.id)
                  }
                  fail('STOP_UNCONFIRMED', 'Host violated foreground-only execution; inspect the original call before retrying.')
                }
                const receipt = { route: 'native', callId: child.callId, operationId: child.callId,
                  processStopped: true, ...(value.timedOut ? { state: 'cancelled', cancelled: true } : {}) }
                // Stop may revoke the caller while the original host range is
                // draining. Retain its proof before checking live admission.
                if (value.timedOut && managed) await observeManagedResult(managed, { receipt })
                this.assertCurrent()
                if (value.exitCode !== 0 || value.timedOut) prototypeProcessFailed = true
                return { code: value.exitCode, stdout: value.stdout?.text ?? '', stderr: value.stderr?.text ?? '',
                  ...(value.stdout?.truncated ? { stdoutTruncated: true } : {}), ...(value.stderr?.truncated ? { stderrTruncated: true } : {}),
                  timedOut: value.timedOut, sandbox: value.sandbox, receipt }
              },
            } : undefined
            if((name === 'lisp_recover' || development && !admission) && (ctx.get('planMode',false) as any)?.get(binding.agent)?.active && !['lisp_status','lisp_hot_status','lisp_inspect','lisp_cancel'].includes(name))fail('PLAN_ACTIVE','Plan 中の Lisp 実行・変更はできません。実装指示またはPlan承認後に実行してください。')
            if (name === 'lisp_cancel' && !await manager.isTaskMode(binding.owner)) { identifier.parse(parsed.operationId); identifier.parse(parsed.generation) }
            if (name === 'lisp_fallback') {
              const request = z.object({ operationId: identifier, reasonCode: z.string().min(1).max(256), objective: z.string().min(1).max(4000),
                constraints:z.array(z.string().max(1000)).max(32).default([]),changedFiles:z.array(z.string().max(4096)).max(100).default([]),
                completed:z.array(z.string().max(2000)).max(100).default([]),pending:z.array(z.string().max(2000)).max(100).default([]),
                evidenceIds:z.array(z.string().max(256)).max(100).default([]),uncertainEffects:z.array(z.string().max(2000)).max(100).default([]),
                nextSteps:z.array(z.string().max(2000)).max(100).default([]) }).strict().parse(parsed)
              const result = await modeOnly(binding, () => manager.fallback(binding.owner, { fallbackId: request.operationId,
                reasonCode: request.reasonCode, handoff: { objective:request.objective,constraints:request.constraints,changedFiles:request.changedFiles,
                  completed:request.completed,pending:request.pending,evidenceIds:request.evidenceIds,uncertainEffects:request.uncertainEffects,nextSteps:request.nextSteps } })) as any
              const fallback = await store.activeFallback(binding.owner.sessionId)
              if (fallback) { installFallbackPrompt(binding.agent, fallback); pendingFallbacks.set(binding.agent, fallback) }
              unregister(binding.agent); hostFence?.release(binding.owner.sessionId)
              return result
            }
            if (name !== 'lisp_status' && name !== 'lisp_hot_status' && !isSavedLispResultRead({ name, arguments: parsed, parent: undefined }))
              parsed.operationId = await store.bind(binding.owner, identifier.parse(execution.callId), identifier.parse(parsed.operationId), { name, input: parsed, ...(parsed.prototype === true ? {codingRequest} : {}) })
            const signal = execution.signal ? AbortSignal.any([binding.signal, execution.signal]) : binding.signal
            const result = await manager.execute(binding.owner, name, parsed, signal, nativeCommands)
            const outcome = parsed.prototype && prototypeProcessFailed ? { ...result as object, ok:false, code:'LISP_PROTOTYPE_PROCESS_FAILED', message:'A managed process failed or timed out; this is not successful prototype evidence.' } : result
            if (name === 'lisp_recover' && (outcome as { ok?: boolean; state?: string }).ok === true) diagnosticOnly.delete(binding.agent)
            if (tracked && !signal.aborted && name === 'lisp_inspect' && outcome && typeof outcome === 'object') {
              const version = savedPageVersion(outcome)
              if (version) tracked.inspection = { page: outcome as SavedResultPage, version }
            }
            return name === 'lisp_status' ? {
              ...outcome as object,
              codingPreparation: preparation.status(binding.agent),
              workflowAccess: access,
              ...(diagnosticOnly.has(binding.agent) ? { continuation: {
                effects: 'blocked', next: ['inspect_receipts', 'read', 'search', 'plan', 'recover'],
              } } : {}),
            } : outcome
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
      if (!policyPrompt) local.push(prompt.section({ name: 'kiokuko:lisp', order: -90000, text: guide }))
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
      toolCatalog() { return [] },
      async callTool() { return fail('CAPABILITY_DENIED', 'Mode control cannot call connected tools.') },
      async run() { return fail('CAPABILITY_DENIED', 'Mode control cannot execute a command.') },
    })
  }
  const recover = async (binding: ReturnType<typeof owner>, signal?: AbortSignal, reset = false) => {
    const request = preparation.binding(binding.agent)
    const restart = () => reset ? manager.restart(binding.owner, signal) : manager.recover(binding.owner, signal)
    const result = await (await manager.canRecoverWorkerWithoutTask(binding.owner) ? modeOnly(binding, restart) : restart()) as { state?: string }
    if (!signal?.aborted && (result.state === 'READY' || result.state === 'TASK_READY')) {
      diagnosticOnly.delete(binding.agent)
      preparation.recovered(binding.agent, request)
    }
    return { ...result, codingPreparation: preparation.status(binding.agent) }
  }
  fence.prepareAgent = async candidate => {
    const binding = owner(candidate)
    const previousFallback = await store.activeFallback(binding.owner.sessionId)
    if (previousFallback && !manager.enabled.has(binding.owner.sessionId)) {
      if (pendingFallbacks.get(binding.agent)?.fallbackId === previousFallback.fallbackId) {
        pendingFallbacks.delete(binding.agent)
        const outcome = await lispFallbackCompactionOutcome(binding.agent, binding.signal, root.get('compaction', false))
        await store.updateFallback(previousFallback.fallbackId, outcome.outcome === 'summarized' ? 'compacted' : 'continued', outcome)
      }
      unregister(binding.agent); hostFence?.release(binding.owner.sessionId)
      installFallbackPrompt(binding.agent, previousFallback)
      return true
    }
    const access = await workflowAccess(binding.agent)
    if (access.visibility === 'hidden') { unregister(binding.agent); return true }
    if (access.visibility === 'diagnostics') { register(binding.agent); return true }
    runtimePrompts.get(candidate.id)?.(); runtimePrompts.delete(candidate.id)
    manager.setAgentBusy(binding.owner, true)
    if (await manager.isTaskMode(binding.owner)) {
      binding.signal.throwIfAborted()
      diagnosticOnly.delete(binding.agent)
      register(binding.agent)
      return true
    }
    const prepare = () => manager.prepare(binding.owner, binding.signal, true)
    // Until preparation returns a live worker, only the protected diagnostic
    // route is available. A startup error must not retain earlier readiness.
    diagnosticOnly.add(binding.agent)
    type WorkerStatus = { state: string; generation?: string; resumed?: boolean; preparationError?: string }
    let status: WorkerStatus
    try {
      status = await (development && isLispConversation(candidate) ? modeOnly(binding, prepare) : prepare()) as WorkerStatus
    } catch (error) {
      binding.signal.throwIfAborted()
      if (!(error instanceof LispError) || !['STARTUP_FAILED', 'STARTUP_TIMEOUT', 'WORKER_EXITED', 'STOP_UNCONFIRMED', 'TASK_REQUIRED', 'CODING_CHOICE_PENDING'].includes(error.code))
        throw error
      status = {
        state: error.code === 'CODING_CHOICE_PENDING' ? 'EXECUTION_SELECTION_PENDING' :
          error.code === 'STOP_UNCONFIRMED' || error.code === 'TASK_REQUIRED' ? error.code : 'RECOVERY_REQUIRED',
        preparationError: error.code,
      }
    }
    binding.signal.throwIfAborted()
    if (['READY', 'EVALUATING'].includes(status.state)) diagnosticOnly.delete(binding.agent)
    else diagnosticOnly.add(binding.agent)
    register(binding.agent)
    const prompt = binding.agent.ctx.get('systemPrompt', false) as { section(input: unknown): () => void } | undefined
    if (prompt) { const previous = runtimePrompts.get(candidate.id); const remove = prompt.section({ name: 'kiokuko:lisp-runtime', order: -89999,
      text: `Current Lisp generation: ${status.generation ?? 'none'}. State: ${status.state}.`
        + (diagnosticOnly.has(binding.agent) ? ` ${status.preparationError ?? 'Lisp effects are unavailable'}. Continue permitted independent reading and planning. Inspect the original receipts before recovery. Keep the selected execution route.` : '')
        + (status.resumed
        ? ' Lisp was automatically restarted after normal suspension. Definitions, variables and object references from older generations are gone. Recreate needed helpers; never replay completed file or process effects. Compare the generation of previous tool results before reusing state.' : '') }); runtimePrompts.set(candidate.id, () => { previous?.(); remove() }) }
    // Keep the model and the existing protected dispatch guards available for diagnosis.
    return true
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
    try {
      // A completed child session ends its lifetime; unloading a root chat
      // only detaches its UI and must preserve that chat's idle heap.
      if (attached.some(isNativeSubagent)) await manager.disposeSession(session.id)
      else await manager.stopSessionWork(session.id)
    }
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
    resultVersion: async (candidate, operationId) => {
      const operation = await store.get(owner(candidate).owner, operationId)
      if (operation?.kind === 'lisp_eval' && operation.state === 'SUCCEEDED' && operation.result !== null)
        return savedResultVersion(operation.result)
    },
    selected: candidate => manualMode(candidate),
    activate: async (candidate, signal) => { const binding=owner(candidate); await enable({ ...binding, signal: signal ? AbortSignal.any([binding.signal,signal]) : binding.signal }, true) },
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
  disposers.push((ctx as any).on('tools/execute', (execution: any, next: () => Promise<unknown>) => {
    if (!execution.agent) return next()
    return preparation.dispatch(execution.agent, execution.name, execution.arguments, execution.parent, execution.signal, next)
  }, {global:true}))
  disposers.push((ctx as any).on('tools/result', (execution: any, result: any) => {
    const tracked = preparationCalls.get(execution)
    if (!tracked) return
    preparationCalls.delete(execution)
    const delivered = result.isError === false && !execution.signal?.aborted
    const inspection = delivered && tracked.inspection
    const block = result.content?.length === 1 ? result.content[0] : undefined
    let visible: InspectionReceipt | undefined
    if (inspection && block?.type === 'text' && typeof block.text === 'string') {
      // Only the page that survives final native rendering is evidence.
      try {
        if (isDeepStrictEqual(JSON.parse(block.text), inspection.page)) visible = inspection
      } catch { /* An incomplete or non-JSON projection cannot confirm coverage. */ }
    }
    tracked.observe(delivered ? result.value : undefined, visible)
  }, {global:true}))
  if (config.enabled) disposers.push((ctx as any).provide(LISP_CODING_SERVICE, { ...createLispCodingChoice({ optional:development,
    taskChoice: (agent, task) => preparation.choiceFor(agent, task) !== undefined,
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
  }), manualSelected: (agent: LispCodingInput['agent']) => manualMode(agent), manualOverride: (agent: LispCodingInput['agent']) => preparation.manualOverride(agent), selectTask: (input: LispCodingInput, choice:'yes'|'no', answerRef:string) => preparation.selectTask(input,choice,answerRef), prepareNative: (input: LispCodingInput) => preparation.prepare(input), choiceFor: (agent: LispCodingInput['agent'], task: string) => preparation.choiceFor(agent, task),
    cancelled: (agent: LispCodingInput['agent'], task: string) => preparation.cancelled(agent,task),
    answered: (agent: LispCodingInput['agent'], task: string, choice:'yes'|'no', answerRef:string, scope:string, protectedWorkflow = true) => preparation.answered(agent,task,choice,answerRef,scope,!development || protectedWorkflow) }))
  const subagentRuntime = () => root.get('subagents', false) as { rootOf?(agent: Agent): Agent } | undefined
  const childOwnership = new NativeChildOwnership(root.get('subagents', false) as any, agents)
  disposers.push(() => { childOwnership.dispose(); for (const remove of fallbackPrompts.values()) remove(); fallbackPrompts.clear() })
  const workerRouter = (binding: ReturnType<typeof owner>, creating = false): (() => boolean) => {
    const backend = subagentRuntime()
    const live = (agent: Agent) => agent !== binding.agent && agents.get(agent.id) === agent
      && sessions.get(agent.session.id) === agent.session && manager.enabled.get(agent.session.id) === binding.owner.root
    const activeRoot = () => {
      try { return subagentRuntime()?.rootOf?.(binding.agent) } catch { return undefined }
    }
    const router = activeRoot()
    if (router) return () => live(router) && activeRoot() === router
    // DSH publishes a new activation after agent/created. Only the startup
    // callback can use launch ownership before the runtime can resolve it.
    if (backend?.rootOf && !creating) return () => false
    const parentId = binding.agent.session.header.parentSession, parent = parentId ? agents.get(parentId) : undefined
    return () => !!parent && live(parent)
      && (agents.isOwnedBy ? agents.isOwnedBy(binding.agent.id, parent) : childOwnership.owns(binding.agent, parent))
  }
  const admitWorker = async (candidate: {id:string}, signal?: AbortSignal, phase?: 'creating' | 'published') => {
    const binding = owner(candidate)
    if (!config.enabled || !isNativeSubagent(binding.agent)) return
    if ((await workflowAccess(binding.agent)).visibility !== 'full') return
    const liveParent = workerRouter(binding, phase === 'creating')
    if (!liveParent() || !tools.schemas(binding.agent).some(tool => LISP_TOOLS.includes(tool.name as LispTool))) return
    // The router shares the execution preference, never its process,
    // heap or task lease. Each work session owns a persistent runtime.
    hostFence?.protect(binding.owner.sessionId)
    if (phase === 'published') register(binding.agent)
    try {
      const status = await manager.enableSessionWorker(binding.owner, binding.agent.status === 'running',
        signal ? AbortSignal.any([binding.signal, signal]) : binding.signal) as {state:string}
      owner(candidate)
      if (!liveParent()) {
        await manager.disable(binding.owner)
        fail('SESSION_MISMATCH', 'Worker router ownership changed during startup.')
      }
      if (!['READY','EVALUATING'].includes(status.state)) fail('RECOVERY_REQUIRED', 'The session Lisp worker must be recovered before continuing.')
    } finally {
      if (!binding.signal.aborted && manager.enabled.has(binding.owner.sessionId)) register(binding.agent)
      else if (!manager.enabled.has(binding.owner.sessionId)) hostFence?.release(binding.owner.sessionId)
    }
  }
  const requestSurface: LispAssemblyService = {
    capabilities: LISP_TOOLS.map(name => ({ name, description: description(name) })),
    inventory: candidate => inventoryReaders.get(candidate.id)?.() ?? tools.schemas(candidate),
    async stopTask(candidate) {
      const binding = owner(candidate)
      if (!manager.enabled.has(binding.owner.sessionId)) return
      await manager.stopSessionWork(binding.owner.sessionId)
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
      await admitWorker(candidate)
      const access = await workflowAccess(binding.agent)
      assembly = { ...assembly, sections: [...assembly.sections.filter(section => section.name !== 'kiokuko:lisp-workflow-access'), {name: 'kiokuko:lisp-workflow-access', text: JSON.stringify(access)}] }
      if (access.visibility === 'hidden') {
        unregister(binding.agent)
        const surface = assembly as typeof assembly & { tools?: { name: string }[] }
        return { ...assembly, tools: surface.tools?.filter(tool => !LISP_TOOLS.includes(tool.name as LispTool)) ?? [] }
      }
      if (!manager.enabled.has(binding.owner.sessionId)) {
        const surface = assembly as typeof assembly & { tools?: { name: string }[] }
        return { ...assembly, sections: [...assembly.sections, { name:'kiokuko:lisp-coding-preparation', text:JSON.stringify(preparation.status(binding.agent)) }],
          ...(surface.tools ? {tools:surface.tools.filter(tool=>!LISP_TOOLS.includes(tool.name as LispTool))} : {}) }
      }
      register(binding.agent)
      // Native DSH snapshots providers before its assembly waterfall. Admission
      // can activate Lisp inside that waterfall: refresh this request, not only
      // the next one. Use native visibility plus the exact guarded definitions.
      const schemas = tools.schemas(binding.agent).filter(schema=>development || fence!.definitions.get(`${candidate.id}:${schema.name}`) === tools.get(schema.name,binding.agent))
      // Native scopes may intentionally expose only a subset. Preserve their
      // exact schemas instead of turning one denied capability into a turn gate.
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
  // Bind before DSH captures the first step's executable tool set. Prompt-only
  // registration is too late: the model can see tools that cannot dispatch.
  disposers.push((ctx as any).on('agent/created', async (event: {agent: Agent; signal?: AbortSignal}) => {
    if (isNativeSubagent(event.agent)) { childOwnership.created(event.agent); await admitWorker(event.agent, event.signal, 'creating') }
  }, {global:true}))
  // Cold continuations bypass startActivation. The native runtime publishes
  // their new owner before waking the agent and snapshotting its tools.
  disposers.push((ctx as any).on('subagent/start', (event: {id: string}) => {
    const agent = agents.get(event.id)
    if (agent && isNativeSubagent(agent)) return admitWorker(agent, undefined, 'published')
  }, {global:true}))
  // Native children deliberately bypass parent intake. Give their exact root
  // Lisp dispatch its own command capability after native guards/approvals;
  // never lend the router's task lease or admit arbitrary nested tool calls.
  disposers.push((ctx as any).on('tools/execute', async (execution: any, next: () => Promise<unknown>) => {
    if (!development || execution.parent !== undefined || !execution.agent || !isNativeSubagent(execution.agent)
      || !LISP_TOOLS.includes(execution.name)) return next()
    const binding = owner(execution.agent), liveParent = workerRouter(binding)
    const definition = fence!.definitions.get(`${binding.agent.id}:${execution.name}`) as {execute?:unknown} | undefined
    if (!definition || tools.get(execution.name, binding.agent) !== definition || !await manager.isSessionWorker(binding.owner)) return next()
    const execute = definition.execute, argumentsDigest = canonicalContentHash(execution.arguments), context = binding.agent.ctx
    const name = execution.name, callId = execution.callId, rootCallId = execution.rootCallId
    const current = () => {
      try {
        const now = owner(execution.agent)
        return execution.agent === binding.agent && execution.name === name && execution.callId === callId && execution.rootCallId === rootCallId
          && !execution.signal?.aborted && !binding.signal.aborted && now.signal === binding.signal
          && !fence!.stopped && binding.agent.ctx === context && now.owner.root === binding.owner.root && liveParent() && execution.parent === undefined
          && manager.enabled.get(binding.owner.sessionId) === binding.owner.root
          && tools.get(execution.name, binding.agent) === definition && definition.execute === execute
          && canonicalContentHash(execution.arguments) === argumentsDigest
      } catch { return false }
    }
    if (!current()) fail('SESSION_MISMATCH', 'The worker Lisp dispatch is no longer current.')
    return withRootLispAdmission(execution, current, next)
  }, {global:true}))
  disposers.push(mountLispHttp(ctx, manager, (sessionId, recover) => {
    const agent = agents.get(sessionId)
    const binding = owner(agent)
    if (binding.owner.sessionId !== sessionId) fail('SESSION_MISMATCH', 'セッションが一致しません。')
    if (recover && manager.enabled.has(sessionId)) register(binding.agent)
    return binding.owner
  }, (sessionId, signal, reset) => recover(owner(agents.get(sessionId)), signal, reset)))
  disposers.push(commands.register({ name: 'kioku-lisp', description: 'Common Lisp の開始・状態・停止・復旧', input: { hint: 'approval ask|auto|status | enable | enable-task | status [--json] | diagnostics [ID] | cancel | recover | reset | abandon ID | restore ID | abandon-managed ID 証跡 | disable' },
    handler: async invocation => {
      try {
        const binding = owner(invocation.agent)
        const words = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
        const [action = 'status', argument, ...extra] = words
        // Human reconciliation takes an ID plus free-text evidence, so it owns its own shape.
        const managedEvidence = action === 'abandon-managed' ? words.slice(2).join(' ') : ''
        if (action === 'abandon-managed') {
          if (!argument) fail('INVALID_COMMAND', '使い方: /kioku-lisp abandon-managed 操作ID 照合した内容')
        } else if (extra.length || (argument && !['approval', 'status', 'hot', 'diagnostics', 'abandon', 'restore'].includes(action))) fail('INVALID_COMMAND', '使い方: /kioku-lisp enable|enable-task|status|hot [NAME]|diagnostics|cancel|recover|abandon ID|restore ID|disable')
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
            if (workflow) overrideCodingChoice(db, { runId: workflow.runId, sessionId: binding.owner.sessionId, repositoryRoot: binding.owner.root },
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
        else if (action === 'reset' || action === 'restart') {
          // Keep the existing definitions and visibility: do not unregister,
          // disable, re-register or change the coding choice during reset.
          result = await recover(binding, invocation.signal, true)
        }
        else if (action === 'abandon') result = await manager.abandon(binding.owner, argument ?? '')
        else if (action === 'abandon-managed') result = await manager.abandonManaged(binding.owner, argument ?? '', managedEvidence)
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
  return ({ lisp_eval: 'Evaluate Common Lisp, the selected route for stateful computation and operation composition while Lisp is ON. Prefer kioku.test:spec plus kioku.verify:bind/run for selected checks; use kioku.tools, kioku.workspace and kioku.jobs for structured host operations. kioku.process and kioku.test:node/vitest remain compatibility APIs. Direct native shell calls are rejected. Explicitly saved definitions/data survive host restart; live streams, stacks and handles do not. Ordinary development does not require a preliminary prototype. Exact operationId replay never re-evaluates.',
    lisp_resume: 'Resume the exact live Common Lisp stack returned as AWAITING_RESTART. Supply its targetOperationId, generation, one-use ticket, listed restartId and typed arguments. Expired, stopped, changed-generation and duplicate tickets never execute a restart.',
    lisp_fallback: 'After an observed unrecoverable Lisp runtime/API failure, stop Lisp, persist an exact handoff, attempt history compaction before the next model step, restore the standard DSH tool route, and continue the same task. Never use for Stop, cancellation or permission denial.',
    lisp_hot_contract: 'Authorize immutable schemas through the current host approval policy and finite input/expected cases for a project-shared function. Profile auto-approval or explicit human consent grants approval; model declarations do not. No task-mode switch is needed; publishing still requires current task authority.',
    lisp_hot_install: 'Validate a candidate against the current approved contract in protected scratch, then atomically select it at expectedRevision. Dependency code is snapshotted. Failed checks preserve the active version.',
    lisp_hot_call: 'Call a project-shared function by name, pinning its active immutable version. Input/result refs remain private to this session and agent. Exact operationId replay never executes again.',
    lisp_hot_status: 'Read project-shared function names, revisions and contract refs; paginate with offset. Supply name to inspect approved checks; contractOffset pages their JSON in 2000 Unicode characters. No worker execution.',
    lisp_hot_deactivate: 'Use the current host approval policy to deactivate a project-shared function at expectedRevision. Existing calls and results remain available; new calls stop.',
    lisp_define: 'Save a generated Lisp lambda and exact dependency refs as a reusable task tool. No enable-task switch or Working task is needed. Compile and check examples in protected scratch; schemas do not grant host effects.',
    lisp_call: 'Run a saved task tool with JSON input or a saved resultRef. Reuse only your own protected worker; otherwise use private protected scratch with no repository mount or host RPC. Exact retries return the journal result.',
    lisp_observe: 'Capture explicitly named workspace files as immutable task input, returning a resultRef without sending contents to the model.',
    lisp_stage: 'Turn a generated result into a guarded, immutable workspace change candidate bound to an observed baseRef. No workspace write.',
    lisp_verify: 'Materialize one candidate from frozen observed bytes in private scratch, then run an approved host verifier. The receipt remains bound to that candidate; unknown test reporting is not a pass.',
    lisp_apply: 'Apply one staged candidate through existing host approval. Reject changed evidence, duplicate attempts and unknown effects.',
    lisp_compare: 'Compare two immutable candidates by common base and per-path intent hashes without rerunning either tool or claiming a verifier pass.',
    lisp_describe: 'Describe Lisp APIs or task functions. symbol="kioku.user" lists this worker\'s functions; symbol="kioku.user::name" returns arguments and documentation. No symbol returns the bundled API/verifier map.', lisp_inspect: 'Read a retained object, a saved result page, or a managed operation receipt (managedOperationId). Inspect saved evidence before retrying; journal reads never execute the original operation.', lisp_status: 'Read current host state and paged operation summaries without contacting Lisp.',
    lisp_recover: 'After checking lisp_status and saved receipts, restart a faulted persistent worker using its expectedGeneration (null before startup). Retains original results and never replays code. Does not clear unknown effects, override Stop or unlock the protected prototype budget. Rebuild needed definitions after a new generation.',
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
  if (name === 'lisp_eval') { Object.assign(properties, { prototype: { type:'boolean', description:'Mark the small coding prototype. After success inspect its saved resultOperationId before implementation.' }, code: { type: 'string', maxLength: 262144 }, inputs: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'Workspace-relative files or exact paths of uploads in this session. The worker reads copies in array order. (kioku.files:input 0) returns a path, not the contents. Use (kioku.files:read-text (kioku.files:input 0)) for text. Iterate only over the declared indices, for example (loop for i below 2 collect (kioku.files:read-text (kioku.files:input i))) for two small files.' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 } }); required.push('code') }
  if (name === 'lisp_resume') { Object.assign(properties, {
    targetOperationId: { type: 'string', minLength: 1, maxLength: 256 }, generation: { type: 'string', minLength: 1, maxLength: 256 },
    ticket: { type: 'string', minLength: 1, maxLength: 256 }, restartId: { type: 'string', minLength: 1, maxLength: 256 },
    arguments: { type: 'array', items: {}, maxItems: 16 },
  }); required.push('targetOperationId', 'generation', 'ticket', 'restartId', 'arguments') }
  if (name === 'lisp_fallback') { Object.assign(properties, {
    reasonCode:{type:'string',minLength:1,maxLength:256},objective:{type:'string',minLength:1,maxLength:4000},
    constraints:{type:'array',items:{type:'string',maxLength:1000},maxItems:32},changedFiles:{type:'array',items:{type:'string',maxLength:4096},maxItems:100},
    completed:{type:'array',items:{type:'string',maxLength:2000},maxItems:100},pending:{type:'array',items:{type:'string',maxLength:2000},maxItems:100},
    evidenceIds:{type:'array',items:{type:'string',maxLength:256},maxItems:100},uncertainEffects:{type:'array',items:{type:'string',maxLength:2000},maxItems:100},
    nextSteps:{type:'array',items:{type:'string',maxLength:2000},maxItems:100},
  }); required.push('reasonCode','objective') }
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
    managedOperationId: { type: 'string', maxLength: 256, description: 'Managed operation from this session. Use alone, without ref, resultOperationId or paging arguments.' },
    section: { type: 'string', enum: ['result', 'value', 'stdout', 'stderr', 'changes'] },
    pointer: { type: 'string', maxLength: 1024, description: 'With section=result, follow the returned JSON pointer to the exact omitted field.' },
    offset: { type: 'integer', minimum: 0, description: 'Unicode character offset; use the returned nextOffset.' },
    limit: { type: 'integer', minimum: 1, maximum: 2000 },
  })
  if (name === 'lisp_cancel') properties.generation = { type: 'string', maxLength: 256, description: 'Required for a persistent worker; omit in task mode.' }
  if (name === 'lisp_recover') { properties.expectedGeneration = { anyOf: [{ type: 'string', minLength: 1, maxLength: 256 }, { type: 'null' }] }; required.push('expectedGeneration') }
  return { type: 'object', properties, required, additionalProperties: false }
}
