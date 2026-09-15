import { applicabilityCompatibility, isFederatedEcosystemCandidate } from '../memory/federated-retrieval.js';
import type { ProjectFingerprint } from '../repository/project-fingerprint.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { readEntry } from '../memory/entries.js';
import { isRetrievableEntry } from '../memory/hybrid-retrieval.js';
import { effectiveRetrievalScope, hasExplicitApplicability } from '../memory/structured-memory.js';
import { entryOriginMatchesWorkspace } from './origin.js';
import { isExternalSkillReference } from '../skills/store.js';
import { isCuratorManagedGlobalMemory } from '../memory/curator-trust.js';
import { contextFeedbackSignals } from './feedback.js';
import { hasActionableMemorySelection, type MemoryUseSignal } from '../akinator/capabilities.js';
import type { ScopedContextItem, ScopedContextResult } from './scoped-broker.js';

export function currentScopedEntry(
  database: SqliteDatabase,
  runWorkspace: string,
  item: Pick<ScopedContextItem, 'entryId' | 'revision' | 'origin'>,
  fingerprint?: ProjectFingerprint,
) {
  const row = database.prepare('SELECT workspace FROM entries WHERE id = ?')
    .get<{ workspace: unknown }>(item.entryId);
  if (row === undefined || typeof row.workspace !== 'string' || row.workspace.length === 0) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Scoped context entry is missing or invalid');
  }
  const entry = readEntry(
    database,
    { workspace: row.workspace, entryId: item.entryId },
    { requireStructuredScope: item.origin !== 'project' },
  );
  if (entry.revision !== item.revision) {
    throw new KiokukoError('CONFLICT', 'Scoped context entry changed after ranking');
  }
  if (!entryOriginMatchesWorkspace({
    origin: item.origin,
    runWorkspace,
    entryWorkspace: entry.workspace,
  })) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Scoped context entry origin is invalid');
  }
  if (item.origin === 'global'
    && (entry.scope.visibility !== 'global' || effectiveRetrievalScope(entry.scope) !== 'global')) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Scoped context global entry scope is invalid');
  }
  if (item.origin === 'ecosystem'
    && (!Object.hasOwn(entry.scope, 'retrievalScope')
      || effectiveRetrievalScope(entry.scope) !== 'ecosystem'
      || !hasExplicitApplicability(entry.scope))) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Scoped context ecosystem entry scope is invalid');
  }
  if (!isRetrievableEntry(database, entry)) {
    throw new KiokukoError('CONFLICT', 'Scoped context entry is no longer retrievable');
  }
  if (entry.status === 'superseded') {
    throw new KiokukoError('CONFLICT', 'Scoped context entry is no longer retrievable');
  }
  if (item.origin === 'ecosystem' && (!isFederatedEcosystemCandidate(database, entry)
    || fingerprint !== undefined && applicabilityCompatibility(entry, fingerprint).incompatible)) {
    throw new KiokukoError('CONFLICT', 'Scoped ecosystem applicability changed');
  }
  return entry;
}

function capabilityGatedScopedItems(
  database: SqliteDatabase,
  runWorkspace: string,
  scopedContext: ScopedContextResult,
): ScopedContextItem[] {
  return scopedContext.items.filter((item) => {
    const entry = currentScopedEntry(database, runWorkspace, item);
    return !isExternalSkillReference(entry) && !isCuratorManagedGlobalMemory(entry);
  });
}

export function scopedMemoryUseSignal(
  database: SqliteDatabase,
  runWorkspace: string,
  scopedContext: ScopedContextResult,
): MemoryUseSignal {
  const items = capabilityGatedScopedItems(database, runWorkspace, scopedContext);
  if (hasActionableMemorySelection(items)) return 'actionable';
  return items.some((item) => contextFeedbackSignals(database, item.entryId)
      .some((signal) => signal.verdict === 'helpful'))
    ? 'actionable'
    : 'none';
}

export function assertScopedMemoryUseSignal(
  database: SqliteDatabase,
  runWorkspace: string,
  scopedContext: ScopedContextResult,
  expected: MemoryUseSignal,
): void {
  if (scopedMemoryUseSignal(database, runWorkspace, scopedContext) !== expected) {
    throw new KiokukoError('CONFLICT', 'Scoped memory capability decision changed before context persistence');
  }
}

