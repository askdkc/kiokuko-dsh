import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { autoGlobalizationInstalled, enqueueAutoGlobalRecheck } from './auto-global-queue.js';
export { autoGlobalizationInstalled, enqueueAutoGlobalRecheck } from './auto-global-queue.js';
import { canonicalContentHash, type JsonObject } from '../serialization/validate.js';
import type { ProjectFingerprint } from '../repository/project-fingerprint.js';
import { applicabilityCompatibility } from './applicability-compatibility.js';
import { readEntry, recordEntryInTransaction, type EntryRecord } from './entries.js';
import { autoCuratorProjection } from './curator.js';
import { CURATOR_DRAFT_VERSION } from './curator-trust.js';
import { hasExplicitApplicability } from './structured-memory.js';
import { analyzePortability, containsProjectSpecificData } from './portability.js';
import { findSecretInValue } from './secrets.js';
import { isExternalSkillReference } from '../skills/store.js';
import { capturePolicy } from './capture-policy.js';
import { ensureGlobalWorkspace, GLOBAL_WORKSPACE } from './workspaces.js';

export const AUTO_GLOBAL_ALGORITHM = 'auto-curator-v1';

interface Receipt extends Record<string, unknown> {
  entry_id: string; entry_revision: number; run_id: string; root_run_id: string;
  workspace: string; repository_id: string; session_id: string; delivery_id: string;
  generation: number; epoch: number; review_hash: string; source_digest: string;
  execution_call_id: string; result_hash: string; fingerprint_json: string;
  completed_at: string; receipt_digest: string;
}

interface ProjectionRow extends Record<string, unknown> {
  entry_id: string; entry_revision: number; algorithm: string; global_entry_id: string;
  source_content_hash: string; evidence_digest: string; state: string; reason: string | null;
}

export interface AutoGlobalDecision {
  kind: 'eligible' | 'insufficient_evidence' | 'blocked';
  reason: string;
  supportRunIds: string[];
  evidenceDigest?: string;
}

function adverseFeedback(db: SqliteDatabase, entryId: string, revision: number): boolean {
  return !!db.prepare(`SELECT 1 FROM context_feedback cf
    JOIN context_delivery_entries de ON de.delivery_id=cf.delivery_id AND de.entry_id=cf.entry_id
    WHERE cf.entry_id=? AND de.entry_revision=? AND cf.verdict IN ('irrelevant','stale','conflicting') LIMIT 1`)
    .get(entryId, revision);
}

function contradicted(db: SqliteDatabase, entryId: string, revision: number): boolean {
  const rows = db.prepare(`SELECT review_json FROM task_memory_reviews
    WHERE entry_id=? AND entry_revision=?`).all<{review_json:string}>(entryId, revision);
  return rows.some(row => {
    const review: unknown = JSON.parse(row.review_json);
    return !!review && typeof review === 'object' && (review as {decision?:unknown}).decision === 'contradicted';
  });
}

function receiptValid(db: SqliteDatabase, receipt: Receipt): boolean {
  const { receipt_digest: expected, ...fields } = receipt;
  if (canonicalContentHash(fields) !== expected) return false;
  const run = db.prepare('SELECT status,workspace,dsh_session_id,ended_at FROM ledger_runs WHERE run_id=?')
    .get<{status:string;workspace:string;dsh_session_id:string;ended_at:string|null}>(receipt.run_id);
  if (run?.status !== 'completed' || run.workspace !== receipt.workspace || run.dsh_session_id !== receipt.session_id
    || run.ended_at !== receipt.completed_at) return false;
  if (capturePolicy(db, receipt.workspace, receipt.session_id).mode !== 'allowed') return false;
  const review = db.prepare(`SELECT review_json FROM task_memory_reviews WHERE run_id=? AND generation=? AND entry_id=?
    AND entry_revision=? AND request_hash=? AND source_digest=?`).get<{review_json:string}>(receipt.run_id,
      receipt.generation, receipt.entry_id, receipt.entry_revision, receipt.review_hash, receipt.source_digest);
  if (!review || (JSON.parse(review.review_json) as {decision?:unknown}).decision !== 'adopted') return false;
  const delivery = db.prepare(`SELECT 1 FROM context_deliveries cd JOIN context_delivery_entries de
    ON de.delivery_id=cd.delivery_id WHERE cd.delivery_id=? AND cd.run_id=? AND de.entry_id=? AND de.entry_revision=?`)
    .get(receipt.delivery_id, receipt.run_id, receipt.entry_id, receipt.entry_revision);
  const execution = db.prepare(`SELECT result_hash,outcome FROM task_memory_executions WHERE run_id=? AND call_id=?
    AND generation=? AND epoch=? AND source_digest=?`).get<{result_hash:string;outcome:string}>(
      receipt.run_id, receipt.execution_call_id, receipt.generation, receipt.epoch, receipt.source_digest);
  const binding = db.prepare('SELECT delivery_id,generation,epoch,fingerprint_json FROM task_memory_bindings WHERE run_id=?')
    .get<{delivery_id:string;generation:number;epoch:number;fingerprint_json:string|null}>(receipt.run_id);
  return !!delivery && execution?.outcome === 'passed' && execution.result_hash === receipt.result_hash
    && binding?.delivery_id === receipt.delivery_id && binding.generation === receipt.generation && binding.epoch === receipt.epoch
    && binding.fingerprint_json === receipt.fingerprint_json;
}

/** Pure policy: each root run and repository identity can contribute only the intended count. */
export function decideAutoGlobalization(input: {
  receipts: readonly Receipt[]; adverse: boolean; hasApplicability: boolean;
  applicabilityMatches: readonly boolean[]; portable: boolean;
}): AutoGlobalDecision {
  if (input.adverse) return { kind: 'blocked', reason: 'adverse_application', supportRunIds: [] };
  if (!input.portable) return { kind: 'blocked', reason: 'project_specific_projection', supportRunIds: [] };
  const selected: Receipt[] = [];
  const rootRuns = new Set<string>();
  for (const [index, receipt] of input.receipts.entries()) {
    if (input.hasApplicability && !input.applicabilityMatches[index]) continue;
    if (rootRuns.has(receipt.root_run_id)) continue;
    rootRuns.add(receipt.root_run_id);
    selected.push(receipt);
  }
  if (selected.length < 3) return { kind: 'insufficient_evidence', reason: 'fewer_than_three_independent_runs', supportRunIds: selected.map(r => r.run_id) };
  if (new Set(selected.map(r => r.repository_id)).size < 2 && !input.hasApplicability) {
    return { kind: 'blocked', reason: 'portability_not_established', supportRunIds: selected.map(r => r.run_id) };
  }
  const used = selected.slice(0, 3);
  return { kind: 'eligible', reason: 'three_observed_applications', supportRunIds: used.map(r => r.run_id),
    evidenceDigest: canonicalContentHash(used.map(r => r.receipt_digest)) };
}

function candidateDecision(db: SqliteDatabase, source: EntryRecord): AutoGlobalDecision {
  const blocked = (reason: string): AutoGlobalDecision => ({ kind: 'blocked', reason, supportRunIds: [] });
  if (source.workspace === GLOBAL_WORKSPACE || source.status !== 'candidate' || isExternalSkillReference(source)) return blocked('invalid_source');
  if (!['lesson','decision','reference'].includes(source.kind)) return blocked('unsupported_kind');
  if (adverseFeedback(db, source.id, source.revision) || contradicted(db, source.id, source.revision)) return blocked('adverse_application');
  const rows = db.prepare(`SELECT * FROM auto_global_application_receipts WHERE entry_id=? AND entry_revision=?
    ORDER BY completed_at,run_id LIMIT 1001`).all<Receipt>(source.id, source.revision);
  if (rows.length > 1000) return blocked('evidence_limit');
  if (rows.some(row => !receiptValid(db, row))) return blocked('invalid_receipt');
  let projection: ReturnType<typeof autoCuratorProjection>;
  try { projection = autoCuratorProjection(source); }
  catch { return blocked('invalid_projection_metadata'); }
  const sourceRepositoryId = db.prepare('SELECT repository_id FROM repositories WHERE workspace=?')
    .get<{repository_id:string}>(source.workspace)?.repository_id;
  if (!sourceRepositoryId) return blocked('source_repository_missing');
  const projected = { ...source, title: projection.draft.title, summary: projection.draft.summary,
    body: projection.draft.body, scope: projection.scope, tags: projection.tags,
    provenance: { type:'auto_curator_globalize', sourceWorkspace:source.workspace, sourceRepositoryId } };
  const scopeValues = (value: unknown): string[] => typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(scopeValues)
      : value && typeof value === 'object' ? Object.values(value).flatMap(scopeValues) : [];
  const scopedDetails = { applicability:projection.scope.applicability, signals:projection.scope.signals };
  if (projection.tags.length > 100 || findSecretInValue({ title: projected.title, summary: projected.summary, body: projected.body,
    scope: projected.scope, tags: projected.tags }) || analyzePortability(projected).projectSpecific
    || scopeValues(scopedDetails).some(value => containsProjectSpecificData(value, source))) return blocked('unsafe_projection');
  const hasApplicability = hasExplicitApplicability(source.scope);
  const matches = rows.map(row => {
    try {
      const fingerprint = JSON.parse(row.fingerprint_json) as ProjectFingerprint;
      return fingerprint.repositoryId === row.repository_id && !applicabilityCompatibility(source, fingerprint).incompatible;
    } catch { return false; }
  });
  return decideAutoGlobalization({ receipts: rows, adverse: false, hasApplicability,
    applicabilityMatches: matches, portable: true });
}

function projectionFor(db: SqliteDatabase, entryId: string): ProjectionRow | undefined {
  return db.prepare('SELECT * FROM auto_global_projections WHERE global_entry_id=?').get<ProjectionRow>(entryId);
}

function projectionEvidenceValid(db: SqliteDatabase, source: EntryRecord, mapping: ProjectionRow, provenance: Record<string, unknown>): boolean {
  const runIds = provenance.supportRunIds;
  if (!Array.isArray(runIds) || runIds.length !== 3 || new Set(runIds).size !== 3
    || runIds.some(id => typeof id !== 'string')) return false;
  const receipts = runIds.map(runId => db.prepare(`SELECT * FROM auto_global_application_receipts
    WHERE entry_id=? AND entry_revision=? AND run_id=?`).get<Receipt>(source.id, source.revision, runId));
  if (receipts.some(receipt => !receipt || !receiptValid(db, receipt))) return false;
  const pinned = receipts as Receipt[];
  const matches = pinned.map(receipt => {
    try {
      const fingerprint = JSON.parse(receipt.fingerprint_json) as ProjectFingerprint;
      return fingerprint.repositoryId === receipt.repository_id && !applicabilityCompatibility(source, fingerprint).incompatible;
    } catch { return false; }
  });
  const decision = decideAutoGlobalization({ receipts:pinned, adverse:false,
    hasApplicability:hasExplicitApplicability(source.scope), applicabilityMatches:matches, portable:true });
  return decision.kind === 'eligible' && decision.evidenceDigest === mapping.evidence_digest;
}

/** The read gate is authoritative even when a worker has not processed a stale mapping. */
export function autoGlobalProjectionActive(db: SqliteDatabase, entry: EntryRecord): boolean {
  if ((entry.provenance as Record<string, unknown>).type !== 'auto_curator_globalize') return true;
  if (!autoGlobalizationInstalled(db)) return false;
  const mapping = projectionFor(db, entry.id);
  if (!mapping || mapping.state !== 'active' || mapping.algorithm !== AUTO_GLOBAL_ALGORITHM || entry.status !== 'verified'
    || entry.trustLevel !== 'source_verified' || entry.revision !== 1) return false;
  const provenance = entry.provenance as Record<string, unknown>;
  if (provenance.sourceRevision !== mapping.entry_revision || provenance.sourceContentHash !== mapping.source_content_hash
    || provenance.evidenceDigest !== mapping.evidence_digest || provenance.algorithmVersion !== mapping.algorithm
    || provenance.reference !== `${mapping.entry_id}@${mapping.entry_revision}#${mapping.algorithm}`) return false;
  const sourceWorkspace = provenance.sourceWorkspace;
  if (typeof sourceWorkspace !== 'string') return false;
  try {
    const source = readEntry(db, { workspace: sourceWorkspace, entryId: mapping.entry_id });
    return source.status === 'candidate' && source.revision === mapping.entry_revision
      && source.contentHash === mapping.source_content_hash
      && projectionEvidenceValid(db, source, mapping, provenance)
      && !adverseFeedback(db, source.id, source.revision) && !contradicted(db, source.id, source.revision)
      && !adverseFeedback(db, entry.id, entry.revision) && !contradicted(db, entry.id, entry.revision);
  } catch { return false; }
}

export function autoGlobalApplicable(db: SqliteDatabase, entry: EntryRecord, fingerprint?: ProjectFingerprint): boolean {
  if ((entry.provenance as Record<string, unknown>).type !== 'auto_curator_globalize') return true;
  return autoGlobalProjectionActive(db, entry)
    && (hasExplicitApplicability(entry.scope)
      ? fingerprint !== undefined && !applicabilityCompatibility(entry, fingerprint).incompatible
      : true);
}

function updateQueue(db: SqliteDatabase, entryId: string, revision: number, decision: AutoGlobalDecision, now: string): void {
  db.prepare('UPDATE auto_global_queue SET state=?,reason=?,updated_at=? WHERE entry_id=? AND entry_revision=?')
    .run(decision.kind === 'eligible' ? 'completed' : 'held', decision.kind === 'eligible' ? null : decision.reason, now, entryId, revision);
}

/** Caller owns BEGIN IMMEDIATE; this operation contains no network or model calls. */
export function processNextAutoGlobalizationInTransaction(db: SqliteDatabase, enabled: boolean, now = new Date().toISOString()): boolean {
  if (!autoGlobalizationInstalled(db)) return false;
  const job = db.prepare("SELECT entry_id,entry_revision FROM auto_global_queue WHERE state='pending' ORDER BY updated_at,entry_id LIMIT 1")
    .get<{entry_id:string;entry_revision:number}>();
  if (!job) return false;
  const existing = db.prepare(`SELECT * FROM auto_global_projections WHERE entry_id=? AND entry_revision=? AND algorithm=?`)
    .get<ProjectionRow>(job.entry_id, job.entry_revision, AUTO_GLOBAL_ALGORITHM);
  if (existing) {
    if (existing.state === 'active') {
      let active = false;
      try { active = autoGlobalProjectionActive(db, readEntry(db, { workspace: GLOBAL_WORKSPACE, entryId: existing.global_entry_id })); }
      catch { /* A missing or invalid generated entry cannot stay active. */ }
      if (!active) db.prepare(`UPDATE auto_global_projections SET state='quarantined',reason='source_or_proof_invalid',updated_at=?
        WHERE entry_id=? AND entry_revision=? AND algorithm=? AND state='active'`)
        .run(now, job.entry_id, job.entry_revision, AUTO_GLOBAL_ALGORITHM);
    }
    updateQueue(db, job.entry_id, job.entry_revision, {kind:'eligible',reason:'projection_checked',supportRunIds:[]}, now);
    return true;
  }
  const sourceWorkspace = db.prepare('SELECT workspace FROM entries WHERE id=?').get<{workspace:string}>(job.entry_id)?.workspace;
  if (!sourceWorkspace) {
    updateQueue(db, job.entry_id, job.entry_revision, {kind:'blocked',reason:'source_missing',supportRunIds:[]}, now);
    return true;
  }
  const source = readEntry(db, { workspace: sourceWorkspace, entryId: job.entry_id });
  if (source.revision !== job.entry_revision) {
    updateQueue(db, job.entry_id, job.entry_revision, {kind:'blocked',reason:'source_revision_changed',supportRunIds:[]}, now);
    return true;
  }
  const decision = candidateDecision(db, source);
  if (decision.kind !== 'eligible' || !enabled) {
    updateQueue(db, source.id, source.revision, enabled ? decision : {kind:'blocked',reason:'disabled',supportRunIds:[]}, now);
    return true;
  }
  const manuallyGlobalized = db.prepare(`SELECT 1 FROM entries e JOIN entry_revisions r ON r.entry_id=e.id AND r.revision=e.current_revision
    WHERE e.workspace=? AND e.status<>'superseded' AND json_valid(r.provenance_json)=1
      AND json_extract(r.provenance_json,'$.type')='curator_globalize'
      AND json_extract(r.provenance_json,'$.reference')=? LIMIT 1`).get(
      GLOBAL_WORKSPACE, `${source.id}@${source.revision}#${CURATOR_DRAFT_VERSION}`);
  if (manuallyGlobalized) {
    updateQueue(db, source.id, source.revision, {kind:'blocked',reason:'manual_projection_exists',supportRunIds:[]}, now);
    return true;
  }
  const projection = autoCuratorProjection(source);
  ensureGlobalWorkspace(db, now);
  const provenance: JsonObject = { type:'auto_curator_globalize', reference:`${source.id}@${source.revision}#${AUTO_GLOBAL_ALGORITHM}`,
    sourceWorkspace:source.workspace, sourceRepositoryId: db.prepare('SELECT repository_id FROM repositories WHERE workspace=?')
      .get<{repository_id:string}>(source.workspace)?.repository_id ?? '',
    sourceRevision:source.revision, sourceContentHash:source.contentHash, evidenceDigest:decision.evidenceDigest!,
    supportRunIds:decision.supportRunIds, algorithmVersion:AUTO_GLOBAL_ALGORITHM,
    clientKind:'kiokuko-auto-curator', timestamp:now };
  const global = recordEntryInTransaction(db, { workspace:GLOBAL_WORKSPACE, kind:source.kind, status:'verified',
    title:projection.draft.title, body:projection.draft.body, summary:projection.draft.summary,
    scope:projection.scope, provenance, trustLevel:'source_verified', confidence:Math.min(source.confidence,0.8),
    tags:projection.tags, createdBy:'kiokuko-auto-curator', actor:'kiokuko-auto-curator' }, {now});
  db.prepare(`INSERT INTO auto_global_projections(entry_id,entry_revision,algorithm,global_entry_id,source_content_hash,evidence_digest,state,reason,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'active',NULL,?,?)`).run(source.id,source.revision,AUTO_GLOBAL_ALGORITHM,global.id,source.contentHash,decision.evidenceDigest!,now,now);
  db.prepare(`UPDATE auto_global_projections SET state='replaced',reason='new_revision_projected',updated_at=?
    WHERE entry_id=? AND entry_revision<? AND algorithm=? AND state IN ('active','quarantined')`)
    .run(now,source.id,source.revision,AUTO_GLOBAL_ALGORITHM);
  updateQueue(db, source.id, source.revision, decision, now);
  return true;
}

export function autoGlobalizationStatus(db: SqliteDatabase, entryId: string, revision: number) {
  if (!autoGlobalizationInstalled(db)) return { supported:false as const };
  const rows = db.prepare('SELECT * FROM auto_global_application_receipts WHERE entry_id=? AND entry_revision=? LIMIT 1001')
    .all<Receipt>(entryId,revision);
  const receipts = rows.length > 1000 ? 0 : new Set(rows.filter(row => receiptValid(db,row)).map(row => row.root_run_id)).size;
  const queue = db.prepare('SELECT state,reason FROM auto_global_queue WHERE entry_id=? AND entry_revision=?')
    .get<{state:string;reason:string|null}>(entryId,revision);
  const projection = db.prepare('SELECT global_entry_id,state,reason FROM auto_global_projections WHERE entry_id=? AND entry_revision=? AND algorithm=?')
    .get<{global_entry_id:string;state:string;reason:string|null}>(entryId,revision,AUTO_GLOBAL_ALGORITHM);
  return { supported:true as const, successfulRuns:receipts, state:queue?.state ?? 'not_queued',
    reason:queue?.reason ?? projection?.reason ?? null, globalEntryId:projection?.global_entry_id ?? null,
    projectionState:projection?.state ?? null };
}

/** A single SQLite write lock owns evaluation, insertion and completion; crashes roll back all three. */
export class AutoGlobalizationWorker {
  #drain: Promise<void> | undefined;
  #closed = false;
  #rerunRequested = false;
  constructor(readonly runtime: { withDatabase<T>(operation:(db:SqliteDatabase)=>T):Promise<T> }, readonly enabled: boolean) {}
  kick(): void {
    if (this.#closed) return;
    if (this.#drain) { this.#rerunRequested = true; return; }
    this.#drain = this.#run().finally(() => {
      this.#drain = undefined;
      if (this.#rerunRequested && !this.#closed) { this.#rerunRequested = false; this.kick(); }
    });
    void this.#drain.catch(() => { /* pending row remains for a later kick or startup */ });
  }
  async #run(): Promise<void> {
    if (this.enabled) await this.runtime.withDatabase(db => withImmediateTransaction(db, () => {
      if (autoGlobalizationInstalled(db)) db.prepare(`UPDATE auto_global_queue SET state='pending',reason=NULL
        WHERE state='held' AND reason='disabled'`).run();
    }));
    while (!this.#closed && await this.runtime.withDatabase(db => withImmediateTransaction(db,
      () => processNextAutoGlobalizationInTransaction(db, this.enabled)))) { /* drain */ }
  }
  async whenIdle(): Promise<void> { while (this.#drain) { const drain = this.#drain; await drain; await Promise.resolve(); } }
  async dispose(): Promise<void> { this.#closed = true; await this.whenIdle(); }
}
