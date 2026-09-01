import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { readRunIntakeLink } from '../akinator/store.js';
import { KiokukoError } from '../errors.js';
import { canonicalJson } from '../serialization/validate.js';
import {
  CONTEXT_RANKING_COMPONENTS_V2,
  CONTEXT_SELECTION_REASON_ORDER,
} from './ranking.js';
import {
  entryOriginMatchesWorkspace,
  isContextEntryOrigin,
  type ContextEntryOrigin,
} from './origin.js';
import {
  legacyScopedDeliveryId,
  readContextDelivery,
  type ContextDeliveryView,
} from './delivery.js';

export const LEGACY_SCOPED_POLICY_VERSIONS = ['context-ranking-v2', 'context-ranking-v3'] as const;
export const MAX_DELIVERIES = 100_000;
export const MAX_FINDINGS = 100;

export const LEGACY_DELIVERY_INSPECTION_STAGES = [
  'legacy-delivery-row',
  'legacy-delivery-read',
  'legacy-delivery-policy',
  'legacy-delivery-identity',
  'legacy-delivery-run-binding',
  'legacy-delivery-profile-binding',
  'legacy-delivery-entry-revision',
  'legacy-delivery-entry-rank',
  'legacy-delivery-entry-score',
  'legacy-delivery-entry-reasons',
  'legacy-delivery-entry-origin',
  'legacy-delivery-character-range',
] as const;

export type LegacyDeliveryInspectionStage = (typeof LEGACY_DELIVERY_INSPECTION_STAGES)[number];

export interface LegacyDeliveryRow extends SqliteRow {
  delivery_id: unknown;
  run_id: unknown;
  run_workspace: unknown;
  policy_version: unknown;
  score_schema_version: unknown;
}

export interface LegacyDeliveryInspection {
  deliveryId: string;
  runId: string;
  policyVersion: (typeof LEGACY_SCOPED_POLICY_VERSIONS)[number];
}

export interface LegacyDeliveryFinding {
  deliveryId: string;
  runId?: string;
  policyVersion?: string;
  stage: LegacyDeliveryInspectionStage;
  code: string;
}

export interface LegacyDeliveryInspectionReport {
  scanned: number;
  valid: number;
  invalid: number;
  findings: LegacyDeliveryFinding[];
  scanTruncated: boolean;
  findingsTruncated: boolean;
}

interface LegacyDeliveryHeaderRow extends SqliteRow {
  delivery_id: unknown;
  run_id: unknown;
  through_sequence: unknown;
  intake_session_id: unknown;
  task_profile_hash: unknown;
  query_hash: unknown;
  policy_version: unknown;
  char_budget: unknown;
  char_count: unknown;
  truncated: unknown;
  created_at: unknown;
  run_workspace: unknown;
  run_last_sequence: unknown;
  score_schema_version: unknown;
}

interface LegacyDeliveryEntryRow extends SqliteRow {
  delivery_id: unknown;
  entry_id: unknown;
  entry_revision: unknown;
  rank: unknown;
  score_components_json: unknown;
  selection_reason_json: unknown;
  origin_scope: unknown;
  entry_workspace: unknown;
  revision_entry_id: unknown;
  revision_workspace: unknown;
}

interface LegacyDeliveryMetadata {
  deliveryId?: string;
  runId?: string;
  policyVersion?: string;
}

interface LegacyDeliveryRows {
  rows: LegacyDeliveryRow[];
  scanTruncated: boolean;
}

const MAX_IDENTIFIER_BYTES = 256;
const MAX_ITEMS = 100;
const MAX_SCORE_COMPONENT = 1_000_000;
const MAX_CHAR_BUDGET = 100_000;
const MAX_STORED_JSON_BYTES = 1_000_000;

function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !/[\p{C}]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= MAX_IDENTIFIER_BYTES;
}

function safePolicyVersion(value: unknown): value is string {
  return safeIdentifier(value);
}

function safeDiagnosticString(value: unknown): string | undefined {
  return safeIdentifier(value) ? value : undefined;
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function safeHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function safeStoredJson(value: unknown): unknown | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_STORED_JSON_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return canonicalJson(parsed) === value ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validStoredScore(value: unknown): boolean {
  const parsed = safeStoredJson(value);
  if (!isPlainObject(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length !== CONTEXT_RANKING_COMPONENTS_V2.length
    || CONTEXT_RANKING_COMPONENTS_V2.some((component) => !Object.hasOwn(parsed, component))) return false;
  return CONTEXT_RANKING_COMPONENTS_V2.every((component) => {
    const score = parsed[component];
    return typeof score === 'number'
      && Number.isSafeInteger(score)
      && Number.isFinite(score)
      && score >= -MAX_SCORE_COMPONENT
      && score <= MAX_SCORE_COMPONENT;
  });
}

function validStoredReasons(value: unknown): boolean {
  const parsed = safeStoredJson(value);
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  let previousIndex = -1;
  for (const reason of parsed) {
    if (typeof reason !== 'string') return false;
    const index = CONTEXT_SELECTION_REASON_ORDER.indexOf(reason as (typeof CONTEXT_SELECTION_REASON_ORDER)[number]);
    if (index < 0 || index <= previousIndex) return false;
    previousIndex = index;
  }
  return true;
}

function migrationIntegrity(
  metadata: LegacyDeliveryMetadata,
  stage: LegacyDeliveryInspectionStage,
  causeCode = 'INTEGRITY_ERROR',
): never {
  const details: Record<string, unknown> = { stage, causeCode };
  if (metadata.deliveryId !== undefined) details.deliveryId = metadata.deliveryId;
  if (metadata.runId !== undefined) details.runId = metadata.runId;
  if (metadata.policyVersion !== undefined) details.policyVersion = metadata.policyVersion;
  throw new KiokukoError('INTEGRITY_ERROR', 'Stored legacy context delivery is invalid', details);
}

function errorCode(error: unknown): string {
  if (!(error instanceof KiokukoError)) return 'INTEGRITY_ERROR';
  return safeDiagnosticString(error.details.causeCode) ?? error.code;
}

function metadataFromRow(row: LegacyDeliveryRow): LegacyDeliveryMetadata {
  return {
    ...(safeDiagnosticString(row.delivery_id) === undefined ? {} : { deliveryId: row.delivery_id as string }),
    ...(safeDiagnosticString(row.run_id) === undefined ? {} : { runId: row.run_id as string }),
    ...(safePolicyVersion(row.policy_version) === undefined ? {} : { policyVersion: row.policy_version as string }),
  };
}

function metadataFromHeader(header: LegacyDeliveryHeaderRow): LegacyDeliveryMetadata {
  return {
    ...(safeDiagnosticString(header.delivery_id) === undefined ? {} : { deliveryId: header.delivery_id as string }),
    ...(safeDiagnosticString(header.run_id) === undefined ? {} : { runId: header.run_id as string }),
    ...(safePolicyVersion(header.policy_version) === undefined ? {} : { policyVersion: header.policy_version as string }),
  };
}

function deliveryRows(database: SqliteDatabase): LegacyDeliveryRows {
  const placeholders = LEGACY_SCOPED_POLICY_VERSIONS.map(() => '?').join(', ');
  const rows = database.prepare(`
    SELECT cd.delivery_id, cd.run_id, cd.policy_version, cd.score_schema_version,
           lr.workspace AS run_workspace
      FROM context_deliveries AS cd
      LEFT JOIN ledger_runs AS lr ON lr.run_id = cd.run_id
     WHERE cd.policy_version IN (${placeholders})
     ORDER BY cd.delivery_id ASC
     LIMIT ?
  `).all<LegacyDeliveryRow>(...LEGACY_SCOPED_POLICY_VERSIONS, MAX_DELIVERIES + 1);
  return {
    rows: rows.slice(0, MAX_DELIVERIES),
    scanTruncated: rows.length > MAX_DELIVERIES,
  };
}

function selectLegacyDeliveryHeader(database: SqliteDatabase, deliveryId: string): LegacyDeliveryHeaderRow | undefined {
  return database.prepare(`
    SELECT cd.delivery_id, cd.run_id, cd.through_sequence, cd.intake_session_id,
           cd.task_profile_hash, cd.query_hash, cd.policy_version,
           cd.char_budget, cd.char_count, cd.truncated, cd.created_at,
           cd.score_schema_version, lr.workspace AS run_workspace,
           lr.last_sequence AS run_last_sequence
      FROM context_deliveries AS cd
      LEFT JOIN ledger_runs AS lr ON lr.run_id = cd.run_id
     WHERE cd.delivery_id = ?
  `).get<LegacyDeliveryHeaderRow>(deliveryId);
}

function selectLegacyDeliveryEntries(database: SqliteDatabase, deliveryId: string): LegacyDeliveryEntryRow[] {
  return database.prepare(`
    SELECT cde.delivery_id, cde.entry_id, cde.entry_revision, cde.rank,
           cde.score_components_json, cde.selection_reason_json, cde.origin_scope,
           e.workspace AS entry_workspace, r.entry_id AS revision_entry_id,
           r.workspace AS revision_workspace
      FROM context_delivery_entries AS cde
      LEFT JOIN entry_revisions AS r
        ON r.entry_id = cde.entry_id AND r.revision = cde.entry_revision
      LEFT JOIN entries AS e ON e.id = cde.entry_id
     WHERE cde.delivery_id = ?
     ORDER BY cde.rank ASC, cde.entry_id ASC
  `).all<LegacyDeliveryEntryRow>(deliveryId);
}

function headerStage(
  row: LegacyDeliveryRow,
  header: LegacyDeliveryHeaderRow,
): LegacyDeliveryInspectionStage | undefined {
  if (!safeIdentifier(header.delivery_id)
    || !safeIdentifier(header.run_id)
    || !safeIdentifier(header.run_workspace)
    || header.delivery_id !== row.delivery_id
    || header.run_id !== row.run_id
    || header.run_workspace !== row.run_workspace) return 'legacy-delivery-run-binding';
  if (!LEGACY_SCOPED_POLICY_VERSIONS.includes(header.policy_version as (typeof LEGACY_SCOPED_POLICY_VERSIONS)[number])
    || header.score_schema_version !== 2) return 'legacy-delivery-policy';
  if (!safeInteger(header.run_last_sequence)
    || !safeInteger(header.through_sequence)
    || header.through_sequence > header.run_last_sequence) return 'legacy-delivery-run-binding';
  if (!safeHash(header.task_profile_hash) || !safeHash(header.query_hash)) return 'legacy-delivery-row';
  if (header.intake_session_id !== null && !safeIdentifier(header.intake_session_id)) return 'legacy-delivery-profile-binding';
  if (!safeInteger(header.char_budget, 1) || header.char_budget > MAX_CHAR_BUDGET
    || !safeInteger(header.char_count) || header.char_count > header.char_budget) {
    return 'legacy-delivery-character-range';
  }
  if (header.truncated !== 0 && header.truncated !== 1) return 'legacy-delivery-row';
  if (typeof header.created_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(header.created_at)) return 'legacy-delivery-row';
  return undefined;
}

function legacyBindingIsValid(database: SqliteDatabase, header: LegacyDeliveryHeaderRow): boolean {
  if (!safeIdentifier(header.run_id) || !safeIdentifier(header.run_workspace)) return false;
  if (header.intake_session_id === null) return true;
  try {
    const link = readRunIntakeLink(database, { workspace: header.run_workspace, runId: header.run_id });
    return link.workspace === header.run_workspace && link.sessionId === header.intake_session_id;
  } catch {
    return false;
  }
}

function entryStage(
  database: SqliteDatabase,
  header: LegacyDeliveryHeaderRow,
): LegacyDeliveryInspectionStage | undefined {
  if (!safeIdentifier(header.run_workspace) || !safeIdentifier(header.delivery_id)) {
    return 'legacy-delivery-run-binding';
  }
  const rows = selectLegacyDeliveryEntries(database, header.delivery_id);
  if (rows.length > MAX_ITEMS) return 'legacy-delivery-entry-rank';
  // Migration 009 can remove an invalid entry and its delivery reference.
  // Released deliveries may therefore retain gaps in their historical ranks.
  const allowsRankGaps = LEGACY_SCOPED_POLICY_VERSIONS.includes(
    header.policy_version as (typeof LEGACY_SCOPED_POLICY_VERSIONS)[number],
  );
  let previousRank = 0;
  let expectedRank = 1;
  for (const row of rows) {
    if (row.delivery_id !== header.delivery_id
      || !safeIdentifier(row.entry_id)
      || row.revision_entry_id !== row.entry_id
      || !safeIdentifier(row.entry_workspace)
      || !safeIdentifier(row.revision_workspace)
      || !safeInteger(row.entry_revision, 1)
      || row.revision_workspace !== row.entry_workspace) return 'legacy-delivery-entry-revision';
    const origin = isContextEntryOrigin(row.origin_scope) ? row.origin_scope : undefined;
    if (origin === undefined
      || !entryOriginMatchesWorkspace({
        origin,
        runWorkspace: header.run_workspace,
        entryWorkspace: row.entry_workspace,
      })) return 'legacy-delivery-entry-origin';
    if (!safeInteger(row.rank, 1)
      || (allowsRankGaps ? row.rank <= previousRank : row.rank !== expectedRank)) {
      return 'legacy-delivery-entry-rank';
    }
    previousRank = row.rank;
    expectedRank += 1;
    if (!validStoredScore(row.score_components_json)) return 'legacy-delivery-entry-score';
    if (!validStoredReasons(row.selection_reason_json)) return 'legacy-delivery-entry-reasons';
  }
  return undefined;
}

function diagnosticFailureStage(
  database: SqliteDatabase,
  row: LegacyDeliveryRow,
  header: LegacyDeliveryHeaderRow | undefined,
): LegacyDeliveryInspectionStage {
  const rowMetadata = metadataFromRow(row);
  if (rowMetadata.deliveryId === undefined) return 'legacy-delivery-row';
  if (!safeIdentifier(row.run_id) || !safeIdentifier(row.run_workspace)) return 'legacy-delivery-run-binding';
  if (!LEGACY_SCOPED_POLICY_VERSIONS.includes(row.policy_version as (typeof LEGACY_SCOPED_POLICY_VERSIONS)[number])
    || row.score_schema_version !== 2) return 'legacy-delivery-policy';
  if (header === undefined) return 'legacy-delivery-read';
  const headerFailure = headerStage(row, header);
  if (headerFailure !== undefined) return headerFailure;
  if (!legacyBindingIsValid(database, header)) return 'legacy-delivery-profile-binding';
  const entryFailure = entryStage(database, header);
  if (entryFailure !== undefined) return entryFailure;
  if (!safeIdentifier(header.run_id) || !safeHash(header.query_hash)
    || header.delivery_id !== legacyScopedDeliveryId({ runId: header.run_id, queryHash: header.query_hash })) {
    return 'legacy-delivery-identity';
  }
  return 'legacy-delivery-read';
}

function readLegacyDelivery(database: SqliteDatabase, row: LegacyDeliveryRow): ContextDeliveryView {
  const metadata = metadataFromRow(row);
  if (metadata.deliveryId === undefined) migrationIntegrity(metadata, 'legacy-delivery-row');
  if (!safeIdentifier(row.run_workspace)) migrationIntegrity(metadata, 'legacy-delivery-run-binding');
  const header = selectLegacyDeliveryHeader(database, metadata.deliveryId);
  const preliminaryFailure = header === undefined ? 'legacy-delivery-read' : headerStage(row, header);
  if (preliminaryFailure !== undefined) migrationIntegrity(metadataFromHeader(header ?? row as LegacyDeliveryHeaderRow), preliminaryFailure);
  if (header === undefined || !safeIdentifier(header.run_workspace)) migrationIntegrity(metadata, 'legacy-delivery-run-binding');
  if (!legacyBindingIsValid(database, header)) migrationIntegrity(metadataFromHeader(header), 'legacy-delivery-profile-binding');
  const entryFailure = entryStage(database, header);
  if (entryFailure !== undefined) migrationIntegrity(metadataFromHeader(header), entryFailure);
  if (!safeIdentifier(header.run_id) || !safeHash(header.query_hash)
    || header.delivery_id !== legacyScopedDeliveryId({ runId: header.run_id, queryHash: header.query_hash })) {
    migrationIntegrity(metadataFromHeader(header), 'legacy-delivery-identity');
  }
  try {
    return readContextDelivery(database, { workspace: header.run_workspace, deliveryId: metadata.deliveryId });
  } catch (error) {
    if (!(error instanceof KiokukoError)) throw error;
    migrationIntegrity(
      metadataFromHeader(header),
      diagnosticFailureStage(database, row, header),
      errorCode(error),
    );
  }
}

/** Validate one released v2/v3 delivery using persisted structure only. */
export function inspectLegacyContextDelivery(
  database: SqliteDatabase,
  row: LegacyDeliveryRow,
): LegacyDeliveryInspection {
  const delivery = readLegacyDelivery(database, row);
  if (!LEGACY_SCOPED_POLICY_VERSIONS.includes(delivery.policyVersion as (typeof LEGACY_SCOPED_POLICY_VERSIONS)[number])
    || delivery.scoreSchemaVersion !== 2) {
    migrationIntegrity(metadataFromRow(row), 'legacy-delivery-policy');
  }
  return {
    deliveryId: delivery.deliveryId,
    runId: delivery.runId,
    policyVersion: delivery.policyVersion as (typeof LEGACY_SCOPED_POLICY_VERSIONS)[number],
  };
}

/** Inspect all released v2/v3 deliveries without stopping at the first finding. */
export function inspectLegacyContextDeliveries(database: SqliteDatabase): LegacyDeliveryInspectionReport {
  const loaded = deliveryRows(database);
  let valid = 0;
  let invalid = 0;
  const findings: LegacyDeliveryFinding[] = [];
  for (const row of loaded.rows) {
    try {
      inspectLegacyContextDelivery(database, row);
      valid += 1;
    } catch (error) {
      if (!(error instanceof KiokukoError)) throw error;
      invalid += 1;
      const stage = LEGACY_DELIVERY_INSPECTION_STAGES.includes(error.details.stage as LegacyDeliveryInspectionStage)
        ? error.details.stage as LegacyDeliveryInspectionStage
        : 'legacy-delivery-read';
      const metadata = metadataFromRow(row);
      if (findings.length < MAX_FINDINGS) {
        findings.push({
          deliveryId: metadata.deliveryId ?? '<invalid>',
          ...(metadata.runId === undefined ? {} : { runId: metadata.runId }),
          ...(metadata.policyVersion === undefined ? {} : { policyVersion: metadata.policyVersion }),
          stage,
          code: errorCode(error),
        });
      }
    }
  }
  return {
    scanned: loaded.rows.length,
    valid,
    invalid,
    findings,
    scanTruncated: loaded.scanTruncated,
    findingsTruncated: invalid > findings.length,
  };
}

/** Validate released scoped delivery formats inside the caller-owned migration transaction. */
export function migrateLegacyContextDeliveries(database: SqliteDatabase): void {
  const loaded = deliveryRows(database);
  if (loaded.scanTruncated) migrationIntegrity({}, 'legacy-delivery-row');
  for (const row of loaded.rows) inspectLegacyContextDelivery(database, row);
}
