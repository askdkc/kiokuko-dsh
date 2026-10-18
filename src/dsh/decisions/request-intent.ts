import { z } from 'zod'
import { canonicalContentHash } from '../../serialization/validate.js'
import type { TaskType } from '../../akinator/types.js'
import { DecisionError, type DecisionBatch } from './contracts.js'
import type { DecisionService } from './service.js'
import { TaskSnapshotSchema, TASK_OPERATIONS, validateTaskOperation, type TaskOperation } from '../task-state.js'

export const REQUEST_INTENT_POLICY_VERSION = 'request-intent-task-state-v3'
export const MAX_REQUEST_INTENT_BYTES = 32 * 1024

export const RequestRelationship = z.enum(['new', 'same_scope_continuation', 'scope_change', 'unknown'])
export const RequestAction = z.enum(['answer', 'research', 'verify', 'change', 'operate', 'unknown'])
export const RequestChangeScope = z.enum(['implementation', 'document', 'unknown'])
export type RequestRelationship = z.infer<typeof RequestRelationship>
export type RequestAction = z.infer<typeof RequestAction>
export type RequestChangeScope = z.infer<typeof RequestChangeScope>

const safeId = z.string().min(1).max(256).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value))
const boundedText = z.string().min(1).max(8192)
const messageReference = z.object({ id: safeId, digest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
const proposalReference = z.object({
  id: safeId,
  revision: z.number().int().min(0).nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  text: boundedText,
  field: z.enum(['readPaths', 'writePaths', 'excludedPaths', 'constraints', 'completion']).optional(),
}).strict()
const activeGoal = z.object({
  runId: safeId,
  workflowRevision: z.number().int().min(1).optional(),
  goalId: safeId.optional(),
  goalRevision: z.number().int().min(1).optional(),
  scopeRevision: z.number().int().min(1).optional(),
  ideal: boundedText.optional(),
  target: boundedText.optional(),
  outOfScope: z.array(boundedText).max(32).default([]),
  constraints: z.array(boundedText).max(32).default([]),
}).strict()

export const RequestIntentContextSchema = z.object({
  /** Exact current user request. No transcript or other session is accepted. */
  task: z.string().min(1).max(16_384),
  messageRefs: z.array(messageReference).min(1).max(16),
  activeGoal: activeGoal.optional(),
  /** SQLite task identity and revision, independent of an implementation-only Goal. */
  activeTask: TaskSnapshotSchema.optional(),
  proposals: z.array(proposalReference).max(8).default([]),
}).strict().superRefine((value, context) => {
  if (new Set(value.messageRefs.map(item => item.id)).size !== value.messageRefs.length) {
    context.addIssue({ code: 'custom', path: ['messageRefs'], message: 'Message references must be unique' })
  }
  if (new Set(value.proposals.map(item => item.id)).size !== value.proposals.length) {
    context.addIssue({ code: 'custom', path: ['proposals'], message: 'Proposal references must be unique' })
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_REQUEST_INTENT_BYTES) {
    context.addIssue({ code: 'custom', message: 'Request intent context exceeds its byte limit' })
  }
})
export type RequestIntentContext = z.infer<typeof RequestIntentContextSchema>

/** Bind exact current user messages; injected/plugin messages are never candidates. */
export function requestIntentMessageRefs(messages: readonly unknown[], task: string): RequestIntentContext['messageRefs'] {
  const refs = messages.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const message = value as Record<string, unknown>
    const source = message.source && typeof message.source === 'object' && !Array.isArray(message.source)
      ? message.source as Record<string, unknown> : undefined
    if (message.role !== 'user' || source !== undefined && source.kind !== 'user') return []
    const id = typeof message.id === 'string' && message.id.length > 0 ? message.id : `message:${canonicalContentHash(message)}`
    return [{ id, digest: canonicalContentHash(message) }]
  })
  if (refs.length) return refs.slice(-16)
  return [{ id: `input:${canonicalContentHash(task)}`, digest: canonicalContentHash(task) }]
}

export function createRequestIntentContext(input: {
  readonly task: string
  readonly messageRefs: RequestIntentContext['messageRefs']
  readonly activeGoal?: RequestIntentContext['activeGoal']
  readonly activeTask?: RequestIntentContext['activeTask']
  readonly proposals?: RequestIntentContext['proposals']
}): RequestIntentContext | undefined {
  // Request-scoped diagnostics are not new task authority and must not invalidate their own retry context.
  const { unresolved: _unresolved, ...activeTask } = input.activeTask ?? {}
  const parsed = RequestIntentContextSchema.safeParse({ task: input.task, messageRefs: input.messageRefs,
    ...(input.activeGoal === undefined ? {} : { activeGoal: input.activeGoal }),
    ...(input.activeTask === undefined ? {} : { activeTask }), proposals: input.proposals ?? [] })
  return parsed.success ? parsed.data : undefined
}

export const RequestIntentSubmissionSchema = z.object({
  relation: RequestRelationship,
  action: RequestAction,
  /** Missing legacy values normalize to unknown and can never authorize a change. */
  changeScope: RequestChangeScope.optional(),
  /** An advisory operation candidate, never execution authority or completion proof. */
  taskOperation: z.enum(TASK_OPERATIONS).optional(),
  /** Exact opaque references supplied in the current host context. */
  evidenceRefs: z.array(safeId).min(1).max(32),
}).strict().superRefine((value, context) => {
  if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length) {
    context.addIssue({ code: 'custom', path: ['evidenceRefs'], message: 'Evidence references must be unique' })
  }
})
export type RequestIntentSubmission = z.infer<typeof RequestIntentSubmissionSchema>

export interface RequestIntentEvidence {
  readonly requestDigest: string
  readonly messageRefs: readonly { readonly id: string; readonly digest: string }[]
  readonly runId?: string
  readonly workflowRevision?: number
  readonly goalRevision?: number
  readonly scopeRevision?: number
  readonly taskId?: string
  readonly taskRevision?: number
  readonly taskGeneration?: number
  readonly proposalRefs: readonly { readonly id: string; readonly revision: number | null; readonly digest: string }[]
}

export interface RequestIntentDecision {
  readonly relation: RequestRelationship
  readonly action: RequestAction
  readonly changeScope: RequestChangeScope
  readonly source: 'decision-provider' | 'main-model' | 'unresolved'
  readonly policyVersion: string
  readonly evidence: RequestIntentEvidence
  readonly providerSent: boolean
  readonly unresolvedReason?: string
  readonly taskOperation?: TaskOperation
}

export interface RequestIntentInterpretation {
  readonly context: RequestIntentContext
  readonly decision: RequestIntentDecision
}

const relationshipChoices = [
  { id: 'new', description: 'A new task, not a continuation or revision of the active Goal or listed proposals.' },
  { id: 'same_scope_continuation', description: 'Continue, inspect, verify, or finish the current source-bound conversation or active task without changing its target, exclusions, or requirements. A formal Goal is optional.' },
  { id: 'scope_change', description: 'Change the active Goal, target, exclusions, requirements, or adopt proposals that expand or alter its scope.' },
  { id: 'unknown', description: 'The current message does not establish its relationship to the active Goal or proposals.' },
] as const
const actionChoices = [
  { id: 'answer', description: 'Answer, explain, or discuss; no tool-backed work is requested.' },
  { id: 'research', description: 'Inspect sources or gather information without changing project state.' },
  { id: 'verify', description: 'Inspect behavior, run or review checks, or establish whether something works.' },
  { id: 'change', description: 'Modify code, files, configuration, or another project artifact.' },
  { id: 'operate', description: 'Perform deployment, restart, installation, or other system/service operation.' },
  { id: 'unknown', description: 'The requested action or target is ambiguous, or not supported by the current evidence. Multiple compatible requested actions alone are not ambiguity.' },
] as const
const changeScopeChoices = [
  { id: 'implementation', description: 'The requested artifact change affects code, tests, runtime behavior, or configuration behavior. If documentation is changed together with implementation, choose implementation.' },
  { id: 'document', description: 'The requested change is prose-only documentation and does not change code, tests, or behavior configuration.' },
  { id: 'unknown', description: 'The requested artifact scope cannot be determined from the current request and supplied Goal/proposal references.' },
] as const

/** Finite choices preserve both the action and the proposals it refers to. */
export function buildRequestIntentBatch(raw: unknown): DecisionBatch | undefined {
  const parsed = RequestIntentContextSchema.safeParse(raw)
  if (!parsed.success) return undefined
  return {
    purpose: 'request-intent',
    state: {
      currentUserMessage: parsed.data.task,
      currentMessageRefs: parsed.data.messageRefs,
      activeGoal: parsed.data.activeGoal ?? null,
      activeTask: parsed.data.activeTask ?? null,
      referencedProposalCandidates: parsed.data.proposals,
      boundary: 'Use only this exact current request and the supplied active Goal/proposal candidates. Never use another chat, infer a free-text target, or grant execution permission.',
    },
    questions: [
      { id: 'request-relation', instructions: 'Classify the relationship of the current user message to the supplied active Goal and proposals. Respect negation, quotation, actor, and omitted references. An exact continuation phrase is not required. If the intended reference or scope is not established, choose unknown.', choices: [...relationshipChoices], abstainId: 'unknown' },
      { id: 'request-action', instructions: 'Classify the action the user requests now, not a quoted example or an action they forbid. “See whether it works” is verify/research, not a file edit. When explanation or inspection accompanies an explicit edit request, choose change and preserve every requested action and prohibition. Do not turn a verification-only request into an edit. Classification grants no permission. If the action or target is unclear, choose unknown.', choices: [...actionChoices], abstainId: 'unknown' },
      { id: 'request-change-scope', instructions: 'For action=change, classify the exact current requested artifact scope using only the current message and supplied Goal/proposal references. Code, tests, runtime behavior, or behavior configuration is implementation; a request that mixes implementation with documentation is implementation. Prose-only document edits are document. Do not infer scope from an advisory task label, wording style, or whether the message happens to say “write”. For other actions choose unknown.', choices: [...changeScopeChoices], abstainId: 'unknown' },
      ...(parsed.data.activeTask ? [{ id: 'request-task-operation', instructions: 'Propose only a structured state operation clearly requested by the current human message for the exact SQLite task. Do not mutate state, fabricate completion or stop evidence, or infer approval from a keyword. Choose none when no state transition is requested; choose unknown when ambiguous. Terminal resume requires an explicit user operation.',
        choices: [{ id: 'none', description: 'No task state operation is requested.' },
          ...parsed.data.activeTask.allowedOps.map(operation => ({ id: operation, description: `Propose ${operation} for this exact task revision; host validation and evidence still apply.` })),
          { id: 'unknown', description: 'The intended operation or target is uncertain.' }], abstainId: 'unknown' }] : []),
      ...parsed.data.proposals.map((proposal, index) => ({ id: `request-proposal-${index}`,
        instructions: `Does the current user instruction adopt or refer to proposal ${JSON.stringify(proposal.id)}? Interpret omitted Japanese subjects and references such as 全部, それ, 続けて against the supplied context. Quoted or forbidden actions are not approvals.`,
        choices: [{ id: 'selected', description: 'The current request refers to this proposal.' },
          { id: 'not_selected', description: 'This proposal is not referenced by the current request.' },
          { id: 'unknown', description: 'The reference cannot be resolved from the supplied context.' }], abstainId: 'unknown' })),
    ],
  }
}

export function requestIntentReferenceIds(context: RequestIntentContext): string[] {
  const refs = context.messageRefs.map(item => `message:${canonicalContentHash(item)}`)
  if (context.activeGoal) {
    refs.push(`run:${canonicalContentHash(context.activeGoal.runId)}`)
    if (context.activeGoal.workflowRevision !== undefined) refs.push(`workflow:${canonicalContentHash([context.activeGoal.runId, context.activeGoal.workflowRevision])}`)
    if (context.activeGoal.goalRevision !== undefined) refs.push(`goal:${canonicalContentHash([context.activeGoal.runId, context.activeGoal.goalRevision])}`)
    if (context.activeGoal.scopeRevision !== undefined) refs.push(`scope:${canonicalContentHash([context.activeGoal.runId, context.activeGoal.scopeRevision])}`)
  }
  if (context.activeTask) refs.push(`task:${canonicalContentHash([context.activeTask.taskId, context.activeTask.revision, context.activeTask.generation])}`)
  refs.push(...context.proposals.map(item => `proposal:${canonicalContentHash([item.id, item.revision, item.digest])}`))
  return refs
}

/** Current identity is mandatory; proposal references are optional evidence of selection. */
export function requestIntentRequiredReferenceIds(context: RequestIntentContext): string[] {
  return requestIntentReferenceIds(context).filter(reference => !reference.startsWith('proposal:'))
}

function evidenceFor(context: RequestIntentContext, selectedProposalIds: ReadonlySet<string> = new Set()): RequestIntentEvidence {
  const active = context.activeGoal
  return {
    requestDigest: canonicalContentHash(context.task),
    messageRefs: context.messageRefs.map(item => ({ ...item })),
    ...(active ? {
      runId: active.runId,
      ...(active.workflowRevision === undefined ? {} : { workflowRevision: active.workflowRevision }),
      ...(active.goalRevision === undefined ? {} : { goalRevision: active.goalRevision }),
      ...(active.scopeRevision === undefined ? {} : { scopeRevision: active.scopeRevision }),
    } : {}),
    ...(context.activeTask ? { taskId: context.activeTask.taskId, taskRevision: context.activeTask.revision,
      taskGeneration: context.activeTask.generation } : {}),
    proposalRefs: context.proposals.filter(item => selectedProposalIds.has(item.id))
      .map(({ id, revision, digest }) => ({ id, revision, digest })),
  }
}

export function unresolvedRequestIntent(context: RequestIntentContext, reason: string, providerSent = false): RequestIntentDecision {
  return { relation: 'unknown', action: 'unknown', changeScope: 'unknown', source: 'unresolved', policyVersion: REQUEST_INTENT_POLICY_VERSION,
    evidence: evidenceFor(context), providerSent, unresolvedReason: reason }
}

export function requestIntentIsUnresolved(value: RequestIntentDecision | undefined): boolean {
  return value === undefined || value.relation === 'unknown' || value.action === 'unknown'
    || value.action === 'change' && value.changeScope === 'unknown'
}

export type RequestIntentBindingResult = { readonly ok: true; readonly decision: RequestIntentDecision }
  | { readonly ok: false; readonly reason: 'invalid_submission' | 'unresolved_intent' | 'unknown_reference' | 'missing_reference' | 'no_active_goal' | 'invalid_task_operation' }

/** Validate exact current-session evidence before checking whether its Goal supports the selected relation. */
export function validateMainModelRequestIntent(raw: unknown, context: RequestIntentContext): RequestIntentBindingResult {
  const parsed = RequestIntentSubmissionSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'invalid_submission' }
  if (parsed.data.relation === 'unknown' || parsed.data.action === 'unknown') return { ok: false, reason: 'unresolved_intent' }
  const allowed = new Set(requestIntentReferenceIds(context))
  if (parsed.data.evidenceRefs.some(reference => !allowed.has(reference))) return { ok: false, reason: 'unknown_reference' }
  const requiredRefs = requestIntentRequiredReferenceIds(context)
  if (!requiredRefs.every(reference => parsed.data.evidenceRefs.includes(reference))) return { ok: false, reason: 'missing_reference' }
  if (parsed.data.relation === 'scope_change' && !context.activeGoal && !context.activeTask) return { ok: false, reason: 'no_active_goal' }
  if (parsed.data.taskOperation) {
    if (!context.activeTask) return { ok: false, reason: 'invalid_task_operation' }
    try { validateTaskOperation(context.activeTask, { operation: parsed.data.taskOperation,
      operationId: `intent:${canonicalContentHash(context)}`, expectedRevision: context.activeTask.revision,
      expectedGeneration: context.activeTask.generation, reason: 'Advisory interpretation of the current human request', evidence: [], explicit: false }) }
    catch { return { ok: false, reason: 'invalid_task_operation' } }
  }
  const selectedProposalIds = new Set(context.proposals.filter(item => parsed.data.evidenceRefs
    .includes(`proposal:${canonicalContentHash([item.id, item.revision, item.digest])}`)).map(item => item.id))
  const changeScope = parsed.data.action === 'change' ? parsed.data.changeScope ?? 'unknown' : 'unknown'
  return { ok: true, decision: { relation: parsed.data.relation, action: parsed.data.action, changeScope,
    source: 'main-model',
    policyVersion: REQUEST_INTENT_POLICY_VERSION, evidence: evidenceFor(context, selectedProposalIds), providerSent: false,
    ...(parsed.data.taskOperation ? { taskOperation: parsed.data.taskOperation } : {}) } }
}

/** Validate a main-model interpretation against exact refs from this request and its active session only. */
export function bindMainModelRequestIntent(raw: unknown, context: RequestIntentContext): RequestIntentDecision | undefined {
  const result = validateMainModelRequestIntent(raw, context)
  return result.ok ? result.decision : undefined
}

/** Rebind a prior decision to current host facts before it crosses admission. */
export function rebindRequestIntentDecision(raw: unknown, context: RequestIntentContext): RequestIntentDecision | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as RequestIntentDecision
  if (!RequestRelationship.safeParse(value.relation).success || !RequestAction.safeParse(value.action).success
    || !RequestChangeScope.safeParse(value.changeScope).success
    || !['decision-provider', 'main-model', 'unresolved'].includes(value.source)
    || value.policyVersion !== REQUEST_INTENT_POLICY_VERSION || !value.evidence
    || !Array.isArray(value.evidence.messageRefs) || !Array.isArray(value.evidence.proposalRefs)
    || value.evidence.requestDigest !== canonicalContentHash(context.task)) return undefined
  const refs = requestIntentReferenceIds(context)
  const messagesMatch = value.evidence.messageRefs.length === context.messageRefs.length
    && context.messageRefs.every((item, index) => value.evidence.messageRefs[index]?.id === item.id
      && value.evidence.messageRefs[index]?.digest === item.digest)
  const active = context.activeGoal
  const task = context.activeTask
  if (value.evidence.taskId !== task?.taskId || value.evidence.taskRevision !== task?.revision
    || value.evidence.taskGeneration !== task?.generation) return undefined
  if (!messagesMatch || (active ? value.evidence.runId !== active.runId
    || value.evidence.workflowRevision !== active.workflowRevision || value.evidence.goalRevision !== active.goalRevision
    || value.evidence.scopeRevision !== active.scopeRevision
    : value.evidence.runId !== undefined)) return undefined
  const selected = new Set<string>()
  for (const proposal of value.evidence.proposalRefs) {
    if (!proposal || typeof proposal !== 'object') return undefined
    const current = context.proposals.find(item => item.id === proposal.id && item.revision === proposal.revision && item.digest === proposal.digest)
    if (!current || !refs.includes(`proposal:${canonicalContentHash([proposal.id, proposal.revision, proposal.digest])}`)) return undefined
    selected.add(proposal.id)
  }
  if (value.relation !== 'unknown' && value.action !== 'unknown') {
    const validated = validateMainModelRequestIntent({ relation: value.relation, action: value.action, changeScope: value.changeScope,
      ...(value.taskOperation ? { taskOperation: value.taskOperation } : {}), evidenceRefs: refs.filter(reference => !reference.startsWith('proposal:')
        || context.proposals.some(proposal => selected.has(proposal.id) && reference === `proposal:${canonicalContentHash([proposal.id, proposal.revision, proposal.digest])}`)) }, context)
    if (!validated.ok) return undefined
  }
  return { ...value, evidence: evidenceFor(context, selected) }
}

/** A selected action can advise intake type; it never supplies a target or execution permission. */
export function requestIntentTaskType(decision: RequestIntentDecision | undefined, fallback?: TaskType): TaskType | undefined {
  switch (decision?.action) {
    case 'answer': return 'chat'
    case 'research': return 'research'
    case 'verify': return fallback === 'debug' ? 'debug' : 'review'
    case 'change': return decision?.changeScope === 'implementation'
      ? fallback === 'debug' ? 'debug' : 'build'
      : decision?.changeScope === 'document' ? 'writing' : fallback
    case 'operate': return 'devops'
    default: return fallback
  }
}

export async function classifyRequestIntent(service: DecisionService | undefined, requestId: string, rawContext: unknown,
  signal: AbortSignal): Promise<RequestIntentDecision | undefined> {
  const parsed = RequestIntentContextSchema.safeParse(rawContext)
  if (!parsed.success) return undefined
  const context = parsed.data
  if (!service) return unresolvedRequestIntent(context, 'decision_service_unavailable')
  let providerSent = false
  try {
    const configuration = await service.bind(requestId, signal)
    if (configuration.mode === 'off') return unresolvedRequestIntent(context, 'decision_service_disabled')
    const batch = buildRequestIntentBatch(context)
    if (!batch) return unresolvedRequestIntent(context, 'context_not_usable')
    const outcome = await service.evaluate(requestId, batch, signal, REQUEST_INTENT_POLICY_VERSION, undefined, {
      onProviderDispatch: () => { providerSent = true },
    })
    if (outcome.status !== 'completed') return unresolvedRequestIntent(context, outcome.reason, providerSent)
    const relation = outcome.result.answers.find(answer => answer.id === 'request-relation')
    const action = outcome.result.answers.find(answer => answer.id === 'request-action')
    const changeScopeAnswer = outcome.result.answers.find(answer => answer.id === 'request-change-scope')
    const relationValue = relation?.status === 'selected' && RequestRelationship.safeParse(relation.choiceId).success
      ? relation.choiceId as RequestRelationship : 'unknown'
    const actionValue = action?.status === 'selected' && RequestAction.safeParse(action.choiceId).success
      ? action.choiceId as RequestAction : 'unknown'
    const changeScopeValue = actionValue === 'change' && changeScopeAnswer?.status === 'selected'
      && RequestChangeScope.safeParse(changeScopeAnswer.choiceId).success
      ? changeScopeAnswer.choiceId as RequestChangeScope : 'unknown'
    const selected = new Set<string>()
    let uncertainProposal = false
    for (const [index, proposal] of context.proposals.entries()) {
      const answer = outcome.result.answers.find(answer => answer.id === `request-proposal-${index}`)
      if (answer?.status === 'selected' && answer.choiceId === 'selected') selected.add(proposal.id)
      else if (answer?.status !== 'selected' || answer.choiceId !== 'not_selected') uncertainProposal = true
    }
    const unresolved = relationValue === 'unknown' || actionValue === 'unknown' || actionValue === 'change' && changeScopeValue === 'unknown' || uncertainProposal
    if (uncertainProposal) return unresolvedRequestIntent(context, 'proposal_reference_uncertain', providerSent)
    const taskOperationAnswer = outcome.result.answers.find(answer => answer.id === 'request-task-operation')
    const taskOperation = taskOperationAnswer?.status === 'selected' && (TASK_OPERATIONS as readonly string[]).includes(taskOperationAnswer.choiceId)
      ? taskOperationAnswer.choiceId as TaskOperation : undefined
    // A task operation is a separate advisory candidate, not a prerequisite for
    // ordinary work on an already authorized task. Abstention must not erase
    // independently resolved action/scope or fabricate a lifecycle transition.
    // Keep the diagnostic and fallback source so the main model can resolve it;
    // actual task state, lease, scope and native permission checks still apply.
    const taskOperationUnresolved = !!context.activeTask && (!taskOperationAnswer
      || taskOperationAnswer.status !== 'selected' || taskOperationAnswer.choiceId === 'unknown')
    if (!unresolved) {
      const refs = requestIntentReferenceIds(context).filter(reference => !reference.startsWith('proposal:')
        || context.proposals.some(proposal => selected.has(proposal.id) && reference === `proposal:${canonicalContentHash([proposal.id, proposal.revision, proposal.digest])}`))
      const bound = validateMainModelRequestIntent({ relation: relationValue, action: actionValue, changeScope: changeScopeValue,
        ...(taskOperation ? { taskOperation } : {}), evidenceRefs: refs }, context)
      if (!bound.ok) return unresolvedRequestIntent(context, bound.reason, providerSent)
      return { ...bound.decision, source: taskOperationUnresolved ? 'unresolved' : 'decision-provider', providerSent,
        ...(taskOperationUnresolved ? { unresolvedReason: 'task_operation_unresolved' } : {}) }
    }
    return { relation: relationValue, action: actionValue, changeScope: changeScopeValue, source: unresolved ? 'unresolved' : 'decision-provider',
      policyVersion: REQUEST_INTENT_POLICY_VERSION, evidence: evidenceFor(context, selected), providerSent,
      ...(unresolved ? { unresolvedReason: 'provider_abstained_or_uncertain' } : {}) }
  } catch (error) {
    if (signal.aborted) throw error instanceof DecisionError ? error : new DecisionError('CANCELLED')
    return unresolvedRequestIntent(context, error instanceof DecisionError ? error.code : 'decision_provider_failed', providerSent)
  }
}
