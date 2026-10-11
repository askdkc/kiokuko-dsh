import type { SqliteDatabase } from '../../db/adapter.js'
import { KiokukoError } from '../../errors.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { assessTaskCompletion, bindTaskCriterion, completionSourceDigest, type CompletionAssessment, type CompletionMethod } from '../task-completion.js'
import { completionVerifiers } from '../completion-verifiers.js'
import { executionCommand } from '../execution-command.js'
import { CodingBlockerSchema, CodingDefinitionSchema, type CodingDefinition, type CodingIdentity, type CodingWorkflow } from './contracts.js'
import { assertCodingIdentity, mutateCodingWorkflow, readCodingWorkflow } from './store.js'

const terminal = (value: CodingWorkflow) => ['completed', 'cancelled', 'superseded'].includes(value.state)
const interrupted = new Set<(runId: string) => void>()
export function onCodingInterrupted(listener: (runId: string) => void): () => void {
  interrupted.add(listener)
  return () => { interrupted.delete(listener) }
}
function interruptCoding(runId: string): void { for (const listener of interrupted) listener(runId) }
export function codingCriterionId(value: CodingWorkflow, id: string): string { return `coding:${value.workflowId}:${id}` }
export function codingItems(value: CodingWorkflow, assessment: CompletionAssessment) {
  const satisfied = new Set(assessment.criteria.filter(item => item.state === 'satisfied').map(item => item.criterionId))
  const complete = new Set(value.definition?.items.filter(item => item.criterionIds.every(id => satisfied.has(codingCriterionId(value, id)))).map(item => item.itemId))
  return (value.definition?.items ?? []).map(item => ({ ...item,
    state: value.state === 'cancelled' || value.state === 'superseded' ? 'cancelled' : complete.has(item.itemId) ? 'satisfied'
      : value.blocker?.criterionIds.some(id => item.criterionIds.includes(id)) ? 'blocked'
      : item.dependsOn.every(id => complete.has(id)) ? value.activeItemId === item.itemId ? 'running' : 'ready' : 'pending',
  }))
}
export function codingStatus(db: SqliteDatabase, identity: CodingIdentity) {
  projectEnnoCodingWorkflow(db, identity)
  let value = readCodingWorkflow(db, identity.runId)
  if (!value) return { applicable: false as const }
  assertCodingIdentity(value, identity)
  if (value.blocker?.kind === 'retry_budget') {
    const changed = value.blocker.criterionIds.every(id => {
      const row = db.prepare('SELECT method_json FROM dsh_completion_bindings WHERE run_id=? AND criterion_id=?')
        .get<{ method_json: string }>(value!.runId, codingCriterionId(value!, id))
      const method = row ? JSON.parse(row.method_json) as CompletionMethod : undefined
      return method?.kind === 'native_command' && value!.attempts[id]?.sourceDigest !== completionSourceDigest(db, value!.runId, value!.repositoryRoot, method.sourcePaths)
    })
    if (changed) value = mutateCodingWorkflow(db, identity, `repaired:${value.revision}`, value.revision, {}, current => {
      delete current.blocker; current.state = 'ready'
    })
  }
  const assessment = assessTaskCompletion(db, value.runId)
  return { applicable: true as const, ...value, items: codingItems(value, assessment), assessment }
}

/** Definitions propose observable work; only host evidence can satisfy it. */
export function proposeCodingWorkflow(db: SqliteDatabase, identity: CodingIdentity, callId: string,
  expectedRevision: number, raw: unknown, revise = false, scopeChanged = false, projected = false): CodingWorkflow {
  if (!projected && db.prepare("SELECT 1 FROM dsh_execution_selections WHERE run_id=? AND json_extract(state_json,'$.mode')='enno'").get(identity.runId))
    throw new KiokukoError('CONFLICT', 'Enno coding Goal comes from its existing ideal and plan; submit those through Enno controls')
  const definition = CodingDefinitionSchema.parse(raw)
  return mutateCodingWorkflow(db, identity, callId, expectedRevision, { action: revise ? 'revise' : 'propose', definition, scopeChanged }, value => {
    if (terminal(value)) throw new KiokukoError('CONFLICT', 'Coding workflow is terminal')
    if (!revise && value.definition) throw new KiokukoError('CONFLICT', 'Use revise for an existing coding Goal')
    if (revise && !value.definition) throw new KiokukoError('CONFLICT', 'No coding Goal to revise')
    const old = value.definition
    if (old) {
      if (old.goal.goalId !== definition.goal.goalId) throw new KiokukoError('CONFLICT', 'Goal identity is stable')
      const changedGoal = canonicalContentHash({ ...old.goal, revision: 0 }) !== canonicalContentHash({ ...definition.goal, revision: 0 })
      if (definition.goal.revision < old.goal.revision || changedGoal && definition.goal.revision <= old.goal.revision)
        throw new KiokukoError('CONFLICT', 'Changed Goal requires a new revision')
      for (const criterion of definition.criteria) {
        const prior = old.criteria.find(item => item.criterionId === criterion.criterionId)
        if (value.retiredIds.includes(criterion.criterionId)) throw new KiokukoError('CONFLICT', 'Retired criterion ID cannot be reused')
        if (prior && (criterion.revision < prior.revision || canonicalContentHash({ ...prior, revision: 0 }) !== canonicalContentHash({ ...criterion, revision: 0 })
          && criterion.revision <= prior.revision)) throw new KiokukoError('CONFLICT', 'Changed criterion requires a new revision')
      }
      for (const item of definition.items) if (value.retiredIds.includes(item.itemId)) throw new KiokukoError('CONFLICT', 'Retired item ID cannot be reused')
      const newIds = new Set([...definition.criteria.map(item => item.criterionId), ...definition.items.map(item => item.itemId)])
      value.retiredIds.push(...[...old.criteria.map(item => item.criterionId), ...old.items.map(item => item.itemId)].filter(id => !newIds.has(id)))
      // A material target/constraint/item change invalidates the task's choice. Reordering preserves it; changed observable behavior requires a new choice.
      const oldScope = scopeDigest(old), newScope = scopeDigest(definition)
      scopeChanged ||= oldScope !== newScope
    }
    value.definition = definition
    delete value.activeItemId; delete value.blocker
    if (scopeChanged) {
      value.scopeVersion++
      value.choice = { state: 'pending', scopeVersion: value.scopeVersion,
        questionId: `coding-lisp-${value.workflowId}-${value.scopeVersion}`, revision: value.choice.revision + 1 }
    }
    value.state = value.choice.state === 'pending' ? 'awaiting_lisp_choice' : 'ready'
  })
}

/** Optional Enno module supplies a projection through the core reader seam. */
export function projectEnnoCodingWorkflow(db: SqliteDatabase, identity: CodingIdentity): void {
  let value = readCodingWorkflow(db, identity.runId)
  if (!value || terminal(value) || !db.prepare("SELECT 1 FROM dsh_execution_selections WHERE run_id=? AND json_extract(state_json,'$.mode')='enno'").get(identity.runId)) return
  const enno = db.prepare('SELECT workspace,orchestration_session_id AS orchestrationId FROM enno_contracts WHERE run_id=?')
    .get<{ workspace:string; orchestrationId:string }>(identity.runId)
  if (!enno) return
  const projection = completionVerifiers().codingProjection?.(db, { runId:identity.runId,...enno })
  if (!projection) return
  const digest = canonicalContentHash(projection.definition)
  if (value.ennoProjectionDigest !== digest) {
    value = proposeCodingWorkflow(db, identity, `enno-definition:${digest}`, value.revision, projection.definition, !!value.definition, false, true)
    value = mutateCodingWorkflow(db, identity, `enno-source:${digest}`, value.revision, { digest }, current=>{ current.ennoProjectionDigest = digest })
  }
  for (const binding of projection.bindings) bindTaskCriterion(db, { runId:identity.runId,
    callId:`enno-check:${digest}:${value.scopeVersion}:${binding.criterionId}:${projection.approved}`, criterionId:codingCriterionId(value,binding.criterionId),
    method:{ kind:'enno_verifier', verifierId:binding.verifierId, ...(binding.workUnitId?{workUnitId:binding.workUnitId}:{}), assertion:'selected_tests_pass' }, approved:projection.approved })
}
function scopeDigest(value: CodingDefinition): string {
  return canonicalContentHash({ ideal: value.goal.ideal, target: value.goal.target, criteria: value.criteria.map(({revision: _revision, ...criterion}) => criterion).sort((a,b)=>a.criterionId.localeCompare(b.criterionId)), constraints: [...value.goal.constraints].sort(), outOfScope: [...value.goal.outOfScope].sort(),
    items: value.items.map(item => ({ itemId: item.itemId, change: item.change, dependsOn: [...item.dependsOn].sort(), criterionIds: [...item.criterionIds].sort(),
      goalCriterionIds: [...item.goalCriterionIds].sort() })).sort((a, b) => a.itemId.localeCompare(b.itemId)) })
}

/** Host-only answer seam. The model-facing tool never accepts these fields. */
export function answerCodingChoice(db: SqliteDatabase, identity: CodingIdentity, input: {
  callId: string; expectedRevision: number; workflowId: string; scopeVersion: number; questionId: string;
  questionRevision: number; answerRef: string; choice: 'yes' | 'no' | 'cancelled'
}): CodingWorkflow {
  return mutateCodingWorkflow(db, identity, input.callId, input.expectedRevision, input, value => {
    if (terminal(value) || value.workflowId !== input.workflowId || value.scopeVersion !== input.scopeVersion
      || value.choice.questionId !== input.questionId || value.choice.revision !== input.questionRevision
      || value.choice.state !== 'pending' || !value.definition || !input.answerRef.trim())
      throw new KiokukoError('CONFLICT', 'Lisp answer does not belong to this pending coding task')
    value.choice = { ...value.choice, state: input.choice, answerRef: input.answerRef }
    value.state = input.choice === 'cancelled' ? 'cancelled' : 'ready'
  })
}
export function nextCodingWork(db: SqliteDatabase, identity: CodingIdentity) {
  const status = codingStatus(db, identity)
  if (!status.applicable) return status
  if (!status.definition) return { ...status, next: 'propose_goal_items_and_criteria' }
  if (status.choice.state === 'pending') return { ...status, next: 'answer_lisp_choice' }
  if (terminal(status)) return { ...status, next: status.state }
  if (status.blocker?.criterionIds.length === 0) return { ...status, next: 'resolve_blocker' }
  const ready = status.items.find(item => item.state === 'ready' || item.state === 'running')
  return { ...status, next: ready ? 'implement_and_verify_item' : status.items.every(item => item.state === 'satisfied') ? 'verify_final_goal' : 'resolve_blocker', item: ready }
}
export function reportCodingBlocker(db: SqliteDatabase, identity: CodingIdentity, callId: string, expectedRevision: number, raw: unknown): CodingWorkflow {
  const blocker = CodingBlockerSchema.parse(raw)
  return mutateCodingWorkflow(db, identity, callId, expectedRevision, { blocker }, value => {
    if (terminal(value)) throw new KiokukoError('CONFLICT', 'Coding workflow is terminal')
    if (blocker.criterionIds.some(id => !value.definition?.criteria.some(item => item.criterionId === id))) throw new KiokukoError('VALIDATION_ERROR', 'Unknown blocked criterion')
    value.blocker = blocker; value.state = 'blocked'
  })
}
export function assertCodingDispatch(db: SqliteDatabase, identity: CodingIdentity, name: string): CodingWorkflow | undefined {
  codingStatus(db, identity)
  const value = readCodingWorkflow(db, identity.runId)
  if (!value) return undefined // Explicit legacy boundary: old tasks retain their contract.
  assertCodingIdentity(value, identity)
  if (terminal(value) || !value.definition || value.choice.state === 'pending') throw new KiokukoError('CONFLICT', 'Define Goal, items and checks, then answer this task’s Lisp choice before implementation')
  if (name.startsWith('lisp_') && value.choice.state !== 'yes') throw new KiokukoError('CONFLICT', 'Lisp is not selected for this coding task')
  if (value.blocker?.kind === 'retry_budget' && ['kioku_write', 'kioku_edit', 'lisp_eval'].includes(name)) return value
  const next = nextCodingWork(db, identity)
  if (!('item' in next) || !next.item) {
    if ('next' in next && next.next === 'verify_final_goal') return value
    throw new KiokukoError('CONFLICT', 'No dependency-ready coding item; resolve the recorded blocker')
  }
  return value
}
export function beginCodingDispatch(db: SqliteDatabase, identity: CodingIdentity, callId: string, name: string): CodingWorkflow | undefined {
  const value = assertCodingDispatch(db, identity, name)
  if (!value) return value
  const next = nextCodingWork(db, identity)
  return mutateCodingWorkflow(db, identity, `dispatch:${callId}`, value.revision, { name, scopeVersion: value.scopeVersion }, current => {
    if ('item' in next && next.item) { current.activeItemId = next.item.itemId; current.state = 'implementing' }
    else current.state = 'verifying_goal'
  }, true)
}
export function synchronizeCodingWorkflow(db: SqliteDatabase, runId: string): CodingWorkflow | undefined {
  const value = readCodingWorkflow(db, runId)
  if (!value || terminal(value) || !value.definition || value.choice.state === 'pending') return value
  const assessment = assessTaskCompletion(db, runId), items = codingItems(value, assessment)
  const enno = db.prepare(`SELECT e.workspace,e.orchestration_session_id AS orchestrationId FROM enno_contracts e
    JOIN dsh_execution_selections s ON s.run_id=e.run_id WHERE e.run_id=? AND json_extract(s.state_json,'$.mode')='enno'`)
    .get<{ workspace:string; orchestrationId:string }>(runId)
  const authorityComplete = !enno || completionVerifiers().codingProjection?.(db, { runId,...enno })?.completed === true
  const state = assessment.verified && authorityComplete ? 'completed' : items.every(item => item.state === 'satisfied') ? 'verifying_goal' : value.blocker ? 'blocked' : value.state
  if (state === value.state) return value
  return mutateCodingWorkflow(db, value, `evidence:${canonicalContentHash({ revision: value.revision, assessment })}`, value.revision, { assessment }, current => { current.state = state })
}
export function stopCodingWorkflow(db: SqliteDatabase, runId: string, state: 'cancelled' | 'superseded'): void {
  const value = readCodingWorkflow(db, runId)
  if (!value || terminal(value)) return
  mutateCodingWorkflow(db, value, `stop:${state}:${value.revision}`, value.revision, { state }, current => { current.state = state; delete current.activeItemId })
  interruptCoding(runId)
}
export function recordCodingAttempt(db: SqliteDatabase, identity: CodingIdentity, callId: string, criterionId: string,
  fingerprint: string, now: number, sourceDigest?: string): CodingWorkflow {
  const value = readCodingWorkflow(db, identity.runId)
  if (!value) throw new KiokukoError('NOT_FOUND', 'No coding workflow')
  return mutateCodingWorkflow(db, identity, callId, value.revision, { criterionId, fingerprint, now }, current => {
    const prior = current.attempts[criterionId]
    if (prior?.fingerprint === fingerprint && now < prior.retryAt) throw new KiokukoError('CONFLICT', 'Unchanged failure is in backoff; inspect or repair its cause')
    const count = prior?.fingerprint === fingerprint ? prior.count + 1 : 1
    current.attempts[criterionId] = { fingerprint, count, retryAt: now + Math.min(60000, 1000 * 2 ** Math.min(count, 6)), ...(sourceDigest ? { sourceDigest } : {}) }
    if (count >= 3) {
      current.blocker = { criterionIds: [criterionId], kind: 'retry_budget', cause: 'Repeated unchanged failure',
        required: 'Repair or inspect the failing condition', recovery: [], resumeWhen: 'The source, environment or failure cause changes' }
      current.state = 'blocked'
    } else if (prior?.fingerprint !== fingerprint && current.blocker?.kind === 'retry_budget') { delete current.blocker; current.state = 'ready' }
  }, true)
}

/** Check the actual child command at the shared process boundary, before spawn. */
export function assertCodingCommandRetry(db: SqliteDatabase, identity: CodingIdentity, command: string): void {
  const workflow = readCodingWorkflow(db, identity.runId)
  if (!workflow?.definition) return
  assertCodingIdentity(workflow, identity)
  const rows = db.prepare('SELECT criterion_id,method_json FROM dsh_completion_bindings WHERE run_id=? AND approved=1')
    .all<{ criterion_id: string; method_json: string }>(identity.runId)
  for (const row of rows) {
    const method = JSON.parse(row.method_json) as CompletionMethod
    if (method.kind !== 'native_command' || executionCommand(method.command) !== executionCommand(command)) continue
    const id = row.criterion_id.slice(`coding:${workflow.workflowId}:`.length), attempt = workflow.attempts[id]
    if (!attempt || attempt.sourceDigest !== completionSourceDigest(db, identity.runId, identity.repositoryRoot, method.sourcePaths)) continue
    if (attempt.count >= 3 || Date.now() < attempt.retryAt) throw new KiokukoError('CONFLICT', 'Unchanged verification failure needs inspection or repair before retrying')
  }
}

export function clearCodingRuntimeBlocker(db: SqliteDatabase, identity: CodingIdentity): void {
  const value = readCodingWorkflow(db, identity.runId)
  if (!value || value.blocker?.kind !== 'runtime' || terminal(value)) return
  mutateCodingWorkflow(db, identity, `runtime-ready:${value.revision}`, value.revision, {}, current => {
    delete current.blocker; current.state = 'ready'
  })
}

/** Only the host command handler calls this after an explicit human route change. */
export function overrideCodingChoice(db: SqliteDatabase, identity: CodingIdentity, choice: 'yes' | 'no', answerRef: string): CodingWorkflow | undefined {
  const value = readCodingWorkflow(db, identity.runId)
  if (!value) return
  if (terminal(value) || !value.definition || !answerRef.trim()) throw new KiokukoError('CONFLICT', 'Define this task’s Goal before changing its Lisp route')
  if (db.prepare("SELECT 1 FROM dsh_owned_operations WHERE run_id=? AND state='started'").get(identity.runId)
    || db.prepare("SELECT 1 FROM dsh_lisp_operations WHERE session_id=? AND state IN ('RUNNING','EVALUATING','ADMITTED')").get(identity.sessionId))
    throw new KiokukoError('CONFLICT', 'Cancel or collect current operations before changing this task’s route')
  return mutateCodingWorkflow(db, identity, answerRef, value.revision, { choice }, current => {
    current.scopeVersion++
    current.choice = { state: choice, scopeVersion: current.scopeVersion, revision: current.choice.revision + 1,
      questionId: `coding-lisp-${current.workflowId}-${current.scopeVersion}`, answerRef }
    delete current.blocker; delete current.activeItemId; current.state = 'ready'
  })
}
