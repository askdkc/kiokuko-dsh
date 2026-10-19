import type { IntentAssessment } from './intent-assessment.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SqliteDatabase } from '../../db/adapter.js'
import { withImmediateTransaction, withDeferredReadTransaction } from '../../db/transaction.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import type { RequestIntentContext, RequestIntentDecision } from './request-intent.js'
import { requestIntentMessageRefs } from './message-refs.js'
import { dshTurnRequestId } from '../intake-profile-resolver.js'
import { requestIntentDiagnosticId } from './diagnostic-correlation.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const id = z.string().regex(/^dgn_[a-f0-9]{32}$/u)
const nativeId = z.string().min(1).max(256).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value))
const revision = z.number().int().nonnegative()
export const DiagnosticBinding = z.object({ runId: nativeId, sessionId: nativeId, repositoryDigest: digest,
  revision, generation: revision, sourceEpoch: z.number().int().positive(),
  workflowRevision: revision.optional(), goalRevision: revision.optional(), scopeRevision: revision.optional() }).strict()
export type DiagnosticBinding = z.infer<typeof DiagnosticBinding>
export const DiagnosticAttempt = z.object({ origin: z.enum(['intake','provider']), requestRef: digest,
  sessionId: nativeId.optional(), turn: revision.optional(), inputDigest: digest, contextDigest: digest.optional(),
  binding: DiagnosticBinding.optional(), policyRef: digest, referenceDigests: z.array(digest).max(32).default([]),
  purpose: z.enum(['akinator','request-intent','skills','enno-check','lisp','memory-reuse','compaction','model-handoff','answer-review','model-routing','intent-semantic-match']) }).strict()
export type DiagnosticAttempt = z.input<typeof DiagnosticAttempt>
export const DIAGNOSTIC_REASONS = ['observed','resolved','unresolved','native_unowned','clarification_required','target_unknown','scope_unknown',
  'transition_required','question_unavailable','context_changed','answer_queued','resume_observed','receipt_observed','continuation_observed',
  'assessment_disabled','assessment_consistent','assessment_clarify','assessment_unavailable','provider_completed','provider_fallback','provider_cancelled','evaluation_failed'] as const
export const DiagnosticEvent = z.object({ kind: z.enum(['reference','extraction','semantic_match','detector','route','admission','task_resume','question','answer','resume','provider','choice','receipt','continuation']),
  status: z.enum(['observed','not_run','waiting','queued','blocked']), reason: z.enum(DIAGNOSTIC_REASONS),
  parentEventId: digest.optional(), referenceDigest: digest.optional(), targetSessionId: nativeId.optional(),
  binding: DiagnosticBinding.optional(),
  relation: z.enum(['new','same_scope_continuation','scope_change','unknown']).optional(),
  action: z.enum(['answer','research','verify','change','operate','unknown']).optional(),
  changeScope: z.enum(['implementation','document','unknown']).optional(),
  source: z.enum(['decision-provider','main-model','unresolved']).optional(),
  provider: z.enum(['typesafe','nimble','laya-coreml']).optional(), modelRef: digest.optional(), policyRef: digest.optional(),
  detectorVersionRef: digest.optional(), providerRevisionRef: digest.optional(), elapsedMs: revision.optional(), cacheHit: z.boolean().optional(),
  providerDispatched:z.boolean().optional(),
  semanticVerdict:z.enum(['supported','contradicted','insufficient','unavailable']).optional(),
  assessmentInputDigest:digest.optional(),assessmentOutputDigest:digest.optional(),
  judge:z.object({state:z.enum(['available','unavailable']),inputDigest:digest.optional(),outputDigest:digest.optional(),binaryHash:digest.optional(),
    version:z.literal('kiokuko-fd-v1'),complete:z.boolean().optional(),status:z.enum(['entailed','refuted','undetermined','inconsistent','resource_limit']).optional(),
    unavailableReason:z.enum(['unsupported_platform','artifact_unavailable','artifact_mismatch','invalid_input','cancelled','timeout','process_failed','output_limit','malformed_response']).optional()}).strict().optional(),
  selected: revision.optional(), abstained: revision.optional(), measured: revision.optional(),
  choice: z.object({ questionRef:digest,choiceRef:digest,topProbability:z.number().finite().min(0).max(1),runnerUpProbability:z.number().finite().min(0).max(1),
    margin:z.number().finite().min(-1).max(1),confidence:z.number().finite().min(0).max(1),gate:z.enum(['confidence','probability_margin']),
    acceptance:z.object({minConfidence:z.number().finite().optional(),minProbability:z.number().finite().optional(),minMargin:z.number().finite().optional()}).strict(),
    status:z.enum(['selected','abstained']),failedChecks:z.array(z.enum(['confidence','probability','margin'])).max(3) }).strict().optional(),
  fallback: z.enum(['DECISION_UNAVAILABLE','DECISION_AUTH','DECISION_TIMEOUT','DECISION_CANCELLED','DECISION_INVALID_INPUT','DECISION_UNSUPPORTED','DECISION_TOO_LARGE','DECISION_MALFORMED_RESPONSE','other']).optional(),
  resultRef: z.object({ requestId: nativeId, inputDigest: digest }).strict().optional(),
  nextDecisionId:id.optional(), receiptId: digest.optional(), continuationId: digest.optional(), evaluationDecisionId:id.optional() }).strict()
export type DiagnosticEvent = z.input<typeof DiagnosticEvent>
export type DiagnosticRuntime = { withDatabase<T>(operation: (db: SqliteDatabase) => T): Promise<T> }
class DiagnosticConflict extends Error { constructor(readonly code: 'stale_binding'|'causal_conflict') { super(code) } }
const losses = new WeakMap<object, number>()
export function diagnosticId(): string { return `dgn_${randomUUID().replaceAll('-','')}` }
export function diagnosticEventId(decisionId: string, key: unknown): string { return canonicalContentHash([decisionId,key]) }

/** Current source epoch follows the same rule as task-source-history/finalization. */
export function captureDiagnosticBinding(db: SqliteDatabase, runId: string, sessionId: string): DiagnosticBinding {
  const row = db.prepare('SELECT task_revision,task_generation,task_owner_session_id,dsh_session_id,task_repository_root FROM ledger_runs WHERE run_id=?').get(runId)
  if (!row || (row.task_owner_session_id ?? row.dsh_session_id) !== sessionId) throw new DiagnosticConflict('stale_binding')
  const epoch = db.prepare('SELECT COALESCE(MAX(source_epoch),0)+1 AS n FROM dsh_task_source_history WHERE run_id=?').get(runId)!.n as number
  const workflow = db.prepare('SELECT snapshot_json FROM dsh_coding_workflows WHERE run_id=?').get(runId)
  // Workflow storage is read through its documented column projection below; no Goal prose is copied.
  const value = workflow ? JSON.parse(String(workflow.snapshot_json)) : undefined
  return DiagnosticBinding.parse({ runId, sessionId, repositoryDigest: canonicalContentHash(row.task_repository_root),
    revision: row.task_revision, generation: row.task_generation, sourceEpoch: epoch,
    ...(value ? { workflowRevision: value.revision, scopeRevision: value.scopeVersion,
      ...(value.definition?.goal?.revision===undefined ? {} : {goalRevision:value.definition.goal.revision}) } : {}) })
}
function validateBinding(db: SqliteDatabase, binding: DiagnosticBinding): void {
  const current = captureDiagnosticBinding(db,binding.runId,binding.sessionId)
  for (const key of Object.keys(binding) as (keyof DiagnosticBinding)[]) if (binding[key] !== current[key]) throw new DiagnosticConflict('stale_binding')
}
export function createDiagnosticAttempt(db: SqliteDatabase, decisionId: string, raw: DiagnosticAttempt): void {
  withImmediateTransaction(db,()=>{
  id.parse(decisionId); const value = DiagnosticAttempt.parse(raw), hash = canonicalContentHash(value)
  if(value.binding && value.sessionId!==value.binding.sessionId)throw new DiagnosticConflict('causal_conflict')
  const existing = db.prepare('SELECT document_digest FROM dsh_diagnostic_attempts WHERE decision_id=?').get(decisionId)
  if (existing) { if (existing.document_digest !== hash) throw new DiagnosticConflict('causal_conflict'); return }
  if (value.binding) validateBinding(db,value.binding)
  db.prepare(`INSERT INTO dsh_diagnostic_attempts VALUES(?,?,?,?,?,?,?,?,?)`).run(decisionId,value.requestRef,value.sessionId ?? null,
    value.turn ?? null,value.binding?.runId ?? null,value.inputDigest,JSON.stringify(value),hash,new Date().toISOString())
  })
}
/** Serialize sequence allocation and validate causality inside the caller's managed transaction. */
export function appendDiagnosticEvent(db: SqliteDatabase, decisionId: string, eventId: string, raw: DiagnosticEvent): number {
  return withImmediateTransaction(db, () => {
    id.parse(decisionId);digest.parse(eventId);const value = DiagnosticEvent.parse(raw), hash = canonicalContentHash(value)
    const duplicate = db.prepare('SELECT decision_id,document_digest,sequence FROM dsh_diagnostic_events WHERE event_id=?').get(eventId)
    if (duplicate) {
      if (duplicate.decision_id !== decisionId || duplicate.document_digest !== hash) throw new DiagnosticConflict('causal_conflict')
      return duplicate.sequence as number
    }
    const attempt = db.prepare('SELECT document_json FROM dsh_diagnostic_attempts WHERE decision_id=?').get(decisionId)
    if (!attempt) throw new DiagnosticConflict('causal_conflict')
    const owner = DiagnosticAttempt.parse(JSON.parse(String(attempt.document_json)))
    if(value.kind==='admission' && (!value.binding || value.binding.sessionId!==owner.sessionId || value.targetSessionId!==owner.sessionId)) throw new DiagnosticConflict('causal_conflict')
    if(value.evaluationDecisionId && !db.prepare("SELECT 1 FROM dsh_diagnostic_attempts WHERE decision_id=? AND request_ref=? AND json_extract(document_json,'$.origin')='provider'")
      .get(value.evaluationDecisionId,owner.requestRef)) throw new DiagnosticConflict('causal_conflict')
    if(value.binding && !['admission','task_resume','resume','receipt','continuation'].includes(value.kind) && owner.binding
      && canonicalContentHash(owner.binding)!==canonicalContentHash(value.binding)) throw new DiagnosticConflict('causal_conflict')
    if (value.binding) validateBinding(db,value.binding)
    else if (owner.binding) validateBinding(db,owner.binding)
    if(['resume','task_resume'].includes(value.kind) && owner.binding) {
      const admitted=value.binding && db.prepare("SELECT 1 FROM dsh_diagnostic_events WHERE decision_id=? AND kind='admission' AND json_extract(document_json,'$.binding.runId')=?").get(decisionId,value.binding.runId)
      if(!value.binding || value.binding.runId!==owner.binding.runId && !admitted || value.binding.sessionId!==value.targetSessionId
        || value.binding.runId===owner.binding.runId && value.binding.sourceEpoch<owner.binding.sourceEpoch) throw new DiagnosticConflict('causal_conflict')
    }
    if (value.parentEventId) {
      const parent = db.prepare('SELECT kind FROM dsh_diagnostic_events WHERE decision_id=? AND event_id=?').get(decisionId,value.parentEventId)
      if (!parent || value.kind === 'answer' && parent.kind !== 'question' || value.kind === 'resume' && parent.kind !== 'answer') throw new DiagnosticConflict('causal_conflict')
    } else if (value.kind === 'answer' || value.kind === 'resume') throw new DiagnosticConflict('causal_conflict')
    if(value.kind==='answer' && db.prepare("SELECT 1 FROM dsh_diagnostic_events WHERE decision_id=? AND kind='answer' AND parent_event_id=?").get(decisionId,value.parentEventId!)) throw new DiagnosticConflict('causal_conflict')
    if(value.nextDecisionId) {
      const next=db.prepare('SELECT document_json FROM dsh_diagnostic_attempts WHERE decision_id=?').get(value.nextDecisionId)
      const answer=value.parentEventId&&db.prepare("SELECT reference_digest FROM dsh_diagnostic_events WHERE event_id=? AND decision_id=? AND kind='answer'").get(value.parentEventId,decisionId)
      if(value.kind!=='resume'||!next||!answer||value.nextDecisionId===decisionId)throw new DiagnosticConflict('causal_conflict')
      const resumed=DiagnosticAttempt.parse(JSON.parse(String(next.document_json)))
      if(resumed.sessionId!==owner.sessionId||resumed.sessionId!==value.targetSessionId||resumed.turn===undefined||owner.turn===undefined||resumed.turn<=owner.turn
        ||!resumed.referenceDigests.includes(String(answer.reference_digest)))throw new DiagnosticConflict('causal_conflict')
    }
    if(value.resultRef && (owner.requestRef!==canonicalContentHash(value.resultRef.requestId) || owner.inputDigest!==value.resultRef.inputDigest)) throw new DiagnosticConflict('causal_conflict')
    if (value.resultRef && !db.prepare('SELECT 1 FROM dsh_decision_results WHERE request_id=? AND input_digest=?')
      .get(value.resultRef.requestId,value.resultRef.inputDigest)) throw new DiagnosticConflict('causal_conflict')
    if (value.receiptId) {
      const receipt = db.prepare('SELECT run_id,dsh_session_id,native_turn FROM dsh_turn_receipts WHERE receipt_id=?').get(value.receiptId)
      const admitted=db.prepare("SELECT 1 FROM dsh_diagnostic_events WHERE decision_id=? AND kind='admission' AND json_extract(document_json,'$.binding.runId')=?").get(decisionId,String(receipt?.run_id ?? ''))
      if (!receipt || receipt.run_id !== owner.binding?.runId && !admitted || receipt.dsh_session_id !== value.targetSessionId || receipt.native_turn!==owner.turn) throw new DiagnosticConflict('causal_conflict')
    }
    if (value.continuationId && !db.prepare('SELECT 1 FROM dsh_continuation_outbox WHERE continuation_id=? AND receipt_id=? AND dsh_session_id=?')
      .get(value.continuationId,value.receiptId ?? '',value.targetSessionId ?? '')) throw new DiagnosticConflict('causal_conflict')
    const next = db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM dsh_diagnostic_events WHERE decision_id=?').get(decisionId)!.n as number
    db.prepare('INSERT INTO dsh_diagnostic_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(eventId,decisionId,next,value.kind,
      value.parentEventId ?? null,value.referenceDigest ?? null,value.targetSessionId ?? null,JSON.stringify(value),hash,new Date().toISOString())
    return next
  })
}
/** No raw exception is retained. A failed savepoint cannot alter the authoritative operation. */
export function bestEffortDiagnostic(db: SqliteDatabase, scopeRef: string, operation: () => void): boolean {
  try { withImmediateTransaction(db,operation); return true }
  catch (error) {
    losses.set(db,(losses.get(db) ?? 0)+1)
    try { withImmediateTransaction(db, () => db.prepare('INSERT INTO dsh_diagnostic_gaps VALUES(?,?,?,?)')
      .run(randomUUID(),canonicalContentHash(scopeRef),error instanceof DiagnosticConflict ? error.code : 'recording_failed',new Date().toISOString())) } catch { /* DB-wide failure is visible through volatileLosses. */ }
    return false
  }
}
export async function observeDiagnostic(runtime: DiagnosticRuntime, scope: string, operation: (db: SqliteDatabase) => void): Promise<void> {
  try { await runtime.withDatabase(db => bestEffortDiagnostic(db,scope,() => operation(db))) }
  catch { losses.set(runtime,(losses.get(runtime) ?? 0)+1) }
}
export function diagnosticRuntimeLosses(runtime:DiagnosticRuntime):number { return losses.get(runtime) ?? 0 }

/** Called only after the real host has bound the admitted run. Source interpretation stays immutable. */
export function recordDiagnosticAdmission(db: SqliteDatabase, input: {sessionId:string;turn:number;runId:string;task:string;context?:RequestIntentContext;decision?:RequestIntentDecision}): void {
  bestEffortDiagnostic(db,input.sessionId,()=>{
    const binding=captureDiagnosticBinding(db,input.runId,input.sessionId),inputDigest=canonicalContentHash(input.task)
    let decisionId=db.prepare("SELECT decision_id FROM dsh_diagnostic_attempts WHERE session_id=? AND native_turn=? AND input_digest=? AND json_extract(document_json,'$.origin')='intake' ORDER BY created_at DESC LIMIT 1")
      .get(input.sessionId,input.turn,inputDigest)?.decision_id as string | undefined
    if(!decisionId) {
      decisionId=diagnosticId()
      createDiagnosticAttempt(db,decisionId,{origin:'intake',purpose:'request-intent',sessionId:input.sessionId,turn:input.turn,
        requestRef:canonicalContentHash(dshTurnRequestId({dshSessionId:input.sessionId,turn:input.turn})),inputDigest,binding,
        policyRef:canonicalContentHash(input.decision?.policyVersion ?? 'native-intake-v1'),contextDigest:canonicalContentHash(input.context ?? null),
        referenceDigests:input.context?.messageRefs.map(ref=>canonicalContentHash(ref.id)) ?? []})
      appendDiagnosticEvent(db,decisionId,diagnosticEventId(decisionId,'reference'),{kind:'reference',status:'observed',reason:'observed'})
      const evaluationId=requestIntentDiagnosticId(input.decision)
      if(input.decision) appendDiagnosticEvent(db,decisionId,diagnosticEventId(decisionId,'extraction'),{kind:'extraction',status:'observed',reason:input.decision.source==='unresolved'?'unresolved':'resolved',
        relation:input.decision.relation,action:input.decision.action,changeScope:input.decision.changeScope,source:input.decision.source,
        ...(evaluationId && db.prepare('SELECT 1 FROM dsh_diagnostic_attempts WHERE decision_id=?').get(evaluationId)?{evaluationDecisionId:evaluationId}:{})})
    }
    appendDiagnosticEvent(db,decisionId,diagnosticEventId(decisionId,['admission',binding]),{kind:'admission',status:'observed',reason:'observed',binding,targetSessionId:input.sessionId})
  })
}
/** Same managed transaction as the authoritative state transition. Never creates a correctness label. */
export function recordDiagnosticTaskResume(db: SqliteDatabase, runId:string,sessionId:string,operationId:string):void {
  bestEffortDiagnostic(db,runId,()=>{
    const binding=captureDiagnosticBinding(db,runId,sessionId)
    const attempts=db.prepare(`SELECT DISTINCT a.decision_id FROM dsh_diagnostic_attempts a LEFT JOIN dsh_diagnostic_events e ON e.decision_id=a.decision_id
      WHERE a.run_id=? OR (e.kind='admission' AND json_extract(e.document_json,'$.binding.runId')=?)`).all(runId,runId)
    for(const row of attempts) {
      const decisionId=String(row.decision_id)
      const answer=db.prepare("SELECT event_id FROM dsh_diagnostic_events WHERE decision_id=? AND kind='answer' ORDER BY sequence DESC LIMIT 1").get(decisionId)
      appendDiagnosticEvent(db,decisionId,diagnosticEventId(decisionId,['task-resume',canonicalContentHash(operationId)]),{kind:answer?'resume':'task_resume',status:'observed',reason:'resume_observed',
        ...(answer?{parentEventId:String(answer.event_id)}:{}),binding,targetSessionId:sessionId})
    }
  })
}
/** The receipt/outbox already exists. Savepoint failure is advisory; outer rollback also rolls back diagnostics. */
export function recordDiagnosticTurn(db:SqliteDatabase,receiptId:string):void {
  bestEffortDiagnostic(db,receiptId,()=>{
    const receipt=db.prepare('SELECT run_id,dsh_session_id,native_turn FROM dsh_turn_receipts WHERE receipt_id=?').get(receiptId)
    if(!receipt)throw new DiagnosticConflict('causal_conflict')
    const attempts=db.prepare(`SELECT DISTINCT a.decision_id FROM dsh_diagnostic_attempts a LEFT JOIN dsh_diagnostic_events e ON e.decision_id=a.decision_id
      WHERE a.session_id=? AND a.native_turn=? AND (a.run_id=? OR (e.kind='admission' AND json_extract(e.document_json,'$.binding.runId')=?))`)
      .all(String(receipt.dsh_session_id),Number(receipt.native_turn),String(receipt.run_id),String(receipt.run_id))
    for(const row of attempts) {
      const decisionId=String(row.decision_id),binding=captureDiagnosticBinding(db,String(receipt.run_id),String(receipt.dsh_session_id))
      appendDiagnosticEvent(db,decisionId,diagnosticEventId(decisionId,['receipt',receiptId]),{kind:'receipt',status:'observed',reason:'receipt_observed',receiptId,targetSessionId:String(receipt.dsh_session_id),binding})
      for(const outbox of db.prepare('SELECT continuation_id FROM dsh_continuation_outbox WHERE receipt_id=?').all(receiptId))
        appendDiagnosticEvent(db,decisionId,diagnosticEventId(decisionId,['continuation',outbox.continuation_id]),{kind:'continuation',status:'observed',reason:'continuation_observed',receiptId,continuationId:String(outbox.continuation_id),targetSessionId:String(receipt.dsh_session_id),binding})
    }
  })
}
/** Runs after the existing Enno receipt trigger, inside its authoritative transaction. */
export function recordDiagnosticEnnoCommit(db:SqliteDatabase,runId:string,operation:string,key:string):void {
  bestEffortDiagnostic(db,runId,()=>{
    const intent=db.prepare('SELECT receipt_id FROM dsh_turn_intents WHERE run_id=? AND operation=? AND idempotency_key=?').get(runId,operation,key)
    if(intent)recordDiagnosticTurn(db,String(intent.receipt_id))
  })
}

/** Trusted, independent adjudication API; never exposed as a model tool or inferred from resume. */
export function reviewDiagnosticStop(db: SqliteDatabase, decisionId: string, verdict: 'false_stop'|'justified_stop', reviewRef: string): void {
  withImmediateTransaction(db,()=>{
  digest.parse(reviewRef); z.enum(['false_stop','justified_stop']).parse(verdict)
  if (!db.prepare("SELECT 1 FROM dsh_diagnostic_events WHERE decision_id=? AND kind='question'").get(decisionId)) throw new DiagnosticConflict('causal_conflict')
  const old = db.prepare('SELECT verdict,review_ref FROM dsh_diagnostic_reviews WHERE decision_id=?').get(decisionId)
  if (old) { if (old.verdict !== verdict || old.review_ref !== reviewRef) throw new DiagnosticConflict('causal_conflict'); return }
  db.prepare('INSERT INTO dsh_diagnostic_reviews VALUES(?,?,?,?)').run(decisionId,verdict,reviewRef,new Date().toISOString())
  })
}
/** SELECT-only. Never backfill, migrate, probe a provider, dispatch or label an outcome. */
export function readDecisionDiagnostics(db: SqliteDatabase, sessionId: string, decisionId?: string) {
  return withDeferredReadTransaction(db,()=>readDecisionDiagnosticsSnapshot(db,sessionId,decisionId))
}
function readDecisionDiagnosticsSnapshot(db: SqliteDatabase, sessionId: string, decisionId?: string) {
  nativeId.parse(sessionId);if (decisionId) id.parse(decisionId)
  const rows = db.prepare(`SELECT DISTINCT a.* FROM dsh_diagnostic_attempts a LEFT JOIN dsh_diagnostic_events e ON e.decision_id=a.decision_id
    WHERE (a.session_id=? OR e.target_session_id=?) AND (? IS NULL OR a.decision_id=?) ORDER BY a.created_at DESC,a.decision_id LIMIT 100`)
    .all(sessionId,sessionId,decisionId ?? null,decisionId ?? null)
  const attempts = rows.map(row => {
    const document = DiagnosticAttempt.parse(JSON.parse(String(row.document_json)))
    const events = db.prepare('SELECT event_id,sequence,document_json FROM dsh_diagnostic_events WHERE decision_id=? ORDER BY sequence').all(String(row.decision_id))
      .map(event => ({ eventId: event.event_id, sequence: event.sequence, ...DiagnosticEvent.parse(JSON.parse(String(event.document_json))) }))
    const runIds=new Set([document.binding?.runId,...events.filter(e=>e.kind==='admission').map(e=>e.binding?.runId)].filter((run):run is string=>!!run))
    const receipts=[...runIds].flatMap(runId=>db.prepare(`SELECT receipt_id AS receiptId,run_id AS runId,dsh_session_id AS sessionId,native_turn AS turn,outcome_kind AS outcome
      FROM dsh_turn_receipts WHERE run_id=? AND dsh_session_id=? AND native_turn=?`).all(runId,document.sessionId ?? '',document.turn ?? -1))
    const outbox=receipts.flatMap(receipt=>db.prepare(`SELECT continuation_id AS continuationId,receipt_id AS receiptId,dsh_session_id AS targetSessionId,status,observed_seq AS observedSequence
      FROM dsh_continuation_outbox WHERE receipt_id=?`).all(String(receipt.receiptId)))
    const missingReceiptLinks=receipts.filter(r=>!events.some(e=>e.receiptId===r.receiptId && e.kind==='receipt')).length
    const missingContinuationLinks=outbox.filter(r=>!events.some(e=>e.continuationId===r.continuationId)).length
    return { decisionId: row.decision_id, ...document, events,authoritativeLinks:{receipts,outbox},missingReceiptLinks,missingContinuationLinks,
      stages: { extraction: events.find(e=>e.kind==='extraction')?.status ?? 'not_run',
        semanticMatch: events.find(e=>e.kind==='semantic_match')?.status ?? 'not_run', detector: events.find(e=>e.kind==='detector')?.status ?? 'not_run' },
      // Shared request identity is a link, not a claim that these independent evaluations are one attempt.
      providerAttempts: db.prepare("SELECT decision_id,document_json FROM dsh_diagnostic_attempts WHERE request_ref=? AND json_extract(document_json,'$.origin')='provider' ORDER BY created_at DESC LIMIT 20")
        .all(document.requestRef).map(v=>({decisionId:v.decision_id,...DiagnosticAttempt.parse(JSON.parse(String(v.document_json))),
          events:db.prepare('SELECT document_json FROM dsh_diagnostic_events WHERE decision_id=? ORDER BY sequence LIMIT 301').all(String(v.decision_id)).map(e=>DiagnosticEvent.parse(JSON.parse(String(e.document_json))))})) }
  })
  const metrics = db.prepare(`SELECT count(DISTINCT a.decision_id) AS stopped,count(DISTINCT r.decision_id) AS evaluated,
    count(DISTINCT CASE WHEN r.verdict='false_stop' THEN r.decision_id END) AS falseStops FROM dsh_diagnostic_attempts a
    JOIN dsh_diagnostic_events e ON e.decision_id=a.decision_id AND e.kind='question'
    LEFT JOIN dsh_diagnostic_reviews r ON r.decision_id=a.decision_id WHERE a.session_id=?
      OR EXISTS(SELECT 1 FROM dsh_diagnostic_events linked WHERE linked.decision_id=a.decision_id AND linked.target_session_id=?)`).get(sessionId,sessionId)!
  const stopped=Number(metrics.stopped),evaluated=Number(metrics.evaluated),falseStops=Number(metrics.falseStops)
  return { attempts, metrics: { stopped,evaluated,falseStops,falseStopRate:evaluated ? falseStops/evaluated : null,evaluationRate:stopped ? evaluated/stopped : null },
    completeness: { persistedGaps: Number(db.prepare('SELECT count(*) AS n FROM dsh_diagnostic_gaps').get()!.n),volatileLosses:losses.get(db) ?? 0,
      missingReceiptLinks:attempts.reduce((n,a)=>n+a.missingReceiptLinks,0),missingContinuationLinks:attempts.reduce((n,a)=>n+a.missingContinuationLinks,0) }, truncated: rows.length===100 }
}

export interface IntakeDiagnosticInput { agent: { session?: { id: string } }; turn: number; messages: readonly unknown[] }
export interface IntakeDiagnosticObservation {
  kind: 'interpretation'|'native_unowned'|'question'|'answer'|'resume'|'assessment'|'assessment_disabled'; assessment?: IntentAssessment; context?: RequestIntentContext; decision?: RequestIntentDecision;
  questionRef?: string; answerRef?: string; reason?: 'target_unknown'|'scope_unknown'|'transition_required'|'clarification_required'|'context_changed'
}
/** References originate in captured native input / host-issued question and followup IDs, never model submissions. */
export function createIntakeDiagnosticSink(runtime: DiagnosticRuntime) {
  const attempts = new WeakMap<object,{id:string;contextDigest:string}>()
  return async (input: IntakeDiagnosticInput, observation: IntakeDiagnosticObservation): Promise<void> => {
    const sessionId=input.agent.session?.id;if (!sessionId) return
    await observeDiagnostic(runtime,sessionId,db=>{
      const context=observation.context,contextDigest=canonicalContentHash(context ?? null)
      let owner=attempts.get(input)
      if (!owner || owner.contextDigest!==contextDigest || !db.prepare('SELECT 1 FROM dsh_diagnostic_attempts WHERE decision_id=?').get(owner.id)) {
        owner={id:diagnosticId(),contextDigest}
        const runId=context?.activeTask?.taskId ?? context?.activeGoal?.runId
        const binding=runId ? captureDiagnosticBinding(db,runId,sessionId) : undefined
        if (binding && context?.activeTask && (binding.revision!==context.activeTask.revision || binding.generation!==context.activeTask.generation)) throw new DiagnosticConflict('stale_binding')
        if(binding && context?.activeGoal)for(const [key,version] of [['workflowRevision',context.activeGoal.workflowRevision],['goalRevision',context.activeGoal.goalRevision],['scopeRevision',context.activeGoal.scopeRevision]] as const)
          if(version!==undefined && binding[key]!==version)throw new DiagnosticConflict('stale_binding')
        createDiagnosticAttempt(db,owner.id,{origin:'intake',purpose:'request-intent',requestRef:canonicalContentHash(dshTurnRequestId({dshSessionId:sessionId,turn:input.turn})),
          sessionId,turn:input.turn,inputDigest:canonicalContentHash(context?.task ?? requestIntentMessageRefs(input.messages,'')),contextDigest,
          ...(binding ? {binding} : {}),policyRef:canonicalContentHash(observation.decision?.policyVersion ?? 'native-intake-v1'),
          referenceDigests:[...(context?.messageRefs ?? requestIntentMessageRefs(input.messages,'')).map(r=>canonicalContentHash(r.id)),...(context?.proposals ?? []).map(r=>canonicalContentHash([r.id,r.revision,r.digest]))]})
        attempts.set(input,owner)
        appendDiagnosticEvent(db,owner.id,diagnosticEventId(owner.id,'reference'),{kind:'reference',status:'observed',reason:'observed'})
      }
      const evaluationId=requestIntentDiagnosticId(observation.decision)
      const eventKey=[observation.kind,observation.questionRef ?? null,observation.answerRef ?? null,observation.decision ?? null,evaluationId ?? null]
      if(observation.kind==='assessment_disabled'){
        for(const kind of ['semantic_match','detector'] as const)appendDiagnosticEvent(db,owner.id,diagnosticEventId(owner.id,['disabled',kind]),{kind,status:'not_run',reason:'assessment_disabled'})
      } else if(observation.kind==='assessment') {
        const a=observation.assessment;if(!a)throw new DiagnosticConflict('causal_conflict')
        const key=['assessment',a.semanticInputDigest,a.semanticOutputDigest??null,a.detector]
        const reason=a.outcome==='consistent'?'assessment_consistent':a.outcome==='clarify'?'assessment_clarify':'assessment_unavailable'
        const semanticId=diagnosticEventId(owner.id,['semantic',key])
        appendDiagnosticEvent(db,owner.id,semanticId,{kind:'semantic_match',status:'observed',reason,
          semanticVerdict:a.semantic,assessmentInputDigest:a.semanticInputDigest,...(a.semanticOutputDigest?{assessmentOutputDigest:a.semanticOutputDigest}:{}),
          ...(a.providerDecisionId&&db.prepare('SELECT 1 FROM dsh_diagnostic_attempts WHERE decision_id=?').get(a.providerDecisionId)?{evaluationDecisionId:a.providerDecisionId}:{})})
        const d=a.detector
        appendDiagnosticEvent(db,owner.id,diagnosticEventId(owner.id,['detector',key]),{kind:'detector',status:'observed',reason,parentEventId:semanticId,elapsedMs:d.elapsedMs,
          judge:d.state==='available'?{state:d.state,version:d.result.version,inputDigest:d.result.inputDigest,outputDigest:d.outputDigest,binaryHash:d.binaryHash,complete:d.result.complete,status:d.result.status}
            :{state:d.state,version:'kiokuko-fd-v1',unavailableReason:d.reason,...(d.inputDigest?{inputDigest:d.inputDigest}:{}),...(d.binaryHash?{binaryHash:d.binaryHash}:{})}})
      } else if (observation.kind==='interpretation' || observation.kind==='native_unowned') {
        const d=observation.decision
        if(d) appendDiagnosticEvent(db,owner.id,diagnosticEventId(owner.id,['extraction',eventKey]),{kind:'extraction',status:'observed',reason:d.source==='unresolved'?'unresolved':'resolved',
          relation:d.relation,action:d.action,changeScope:d.changeScope,source:d.source,
          ...(evaluationId && db.prepare('SELECT 1 FROM dsh_diagnostic_attempts WHERE decision_id=?').get(evaluationId)?{evaluationDecisionId:evaluationId}:{})})
        appendDiagnosticEvent(db,owner.id,diagnosticEventId(owner.id,['route',eventKey]),{kind:'route',status:'observed',reason:observation.kind==='native_unowned'?'native_unowned':d?.source==='unresolved'?'unresolved':'resolved'})
      } else if(observation.kind==='question') {
        if (!observation.questionRef) throw new DiagnosticConflict('causal_conflict')
        appendDiagnosticEvent(db,owner.id,diagnosticEventId(owner.id,['question',observation.questionRef]),{kind:'question',status:'waiting',reason:observation.reason ?? 'clarification_required',referenceDigest:canonicalContentHash(observation.questionRef)})
      } else if(observation.kind==='answer') {
        const parent=db.prepare("SELECT event_id,decision_id FROM dsh_diagnostic_events WHERE kind='question' AND reference_digest=? AND decision_id IN (SELECT decision_id FROM dsh_diagnostic_attempts WHERE session_id=?) ORDER BY created_at DESC LIMIT 1")
          .get(canonicalContentHash(observation.questionRef),sessionId)
        if (!parent || !observation.answerRef) throw new DiagnosticConflict('causal_conflict')
        appendDiagnosticEvent(db,String(parent.decision_id),diagnosticEventId(String(parent.decision_id),['answer',observation.answerRef]),{kind:'answer',status:'queued',reason:'answer_queued',parentEventId:String(parent.event_id),referenceDigest:canonicalContentHash(observation.answerRef)})
      } else {
        for(const message of requestIntentMessageRefs(input.messages,'')) {
          const parent=db.prepare("SELECT e.event_id,e.decision_id,a.session_id FROM dsh_diagnostic_events e JOIN dsh_diagnostic_attempts a ON a.decision_id=e.decision_id WHERE e.kind='answer' AND e.reference_digest=? ORDER BY e.created_at DESC LIMIT 1").get(canonicalContentHash(message.id))
          if (!parent || parent.session_id!==sessionId) continue
          const document=db.prepare('SELECT document_json FROM dsh_diagnostic_attempts WHERE decision_id=?').get(String(parent.decision_id))!
          const previous=DiagnosticAttempt.parse(JSON.parse(String(document.document_json)))
          const binding=previous.binding ? captureDiagnosticBinding(db,previous.binding.runId,sessionId) : undefined
          appendDiagnosticEvent(db,String(parent.decision_id),diagnosticEventId(String(parent.decision_id),['resume',sessionId,input.turn]),{kind:'resume',status:'observed',reason:'resume_observed',parentEventId:String(parent.event_id),targetSessionId:sessionId,nextDecisionId:owner.id,...(binding?{binding}:{})})
        }
      }
    })
  }
}
