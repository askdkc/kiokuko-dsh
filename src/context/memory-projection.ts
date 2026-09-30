import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SqliteDatabase } from '../db/adapter.js';
import type { EntryRecord } from '../memory/entries.js';
import { readEntry } from '../memory/entries.js';
import type { Episode } from '../memory/evolution/contracts.js';
import { digest } from '../memory/evolution/contracts.js';
import { buildReferenceLesson, REFERENCE_PROMOTION_VERSION, renderReferenceLesson } from '../memory/evolution/reference-promotion.js';
import { findSecret } from '../memory/secrets.js';
import { KiokukoError } from '../errors.js';

export const MEMORY_PROJECTION_VERSION = 1 as const;
const MemoryProjectionReceiptBase = {
  selectedFields: z.array(z.enum(['title', 'summary', 'body', 'episode-manifest', 'reference-lesson'])).min(1).max(4),
  sourceRevision: z.number().int().positive(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  textDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  characters: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
}
const ProjectionSource = z.object({ entryId: z.string().min(1).max(256), revision: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
const ProjectionEpisode = z.object({ runId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
  logDigest: z.string().regex(/^[a-f0-9]{64}$/u), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
export const MemoryProjectionReceipt = z.union([
  z.object({ version: z.literal(1), ...MemoryProjectionReceiptBase }).strict(),
  z.object({ version: z.literal(2), ...MemoryProjectionReceiptBase,
    episodes: z.array(ProjectionEpisode).max(6), sources: z.array(ProjectionSource).max(32),
    evidenceReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    referenceReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict(),
]);
export type MemoryProjectionReceipt = z.infer<typeof MemoryProjectionReceipt>;

const INTERNAL_ID = /\b(?:run|entry|delivery|session|work[_-]?unit|orchestration|request)[_-]?(?:id)?\s*[:=]\s*[A-Za-z0-9._:-]{4,}\b/giu;
const LONG_HEX_ID = /\b[0-9a-f]{32,}\b/giu;
const ABSOLUTE_PATH = /(?:^|[\s(])(?:\/(?:Users|private|tmp|var|opt|home)\/[^\s)]+|[A-Za-z]:\\[^\s)]+)/gu;

export function redactDshSourceText(value: string): string | null {
  if (findSecret(value) !== undefined) return null;
  const redacted = value.replace(INTERNAL_ID, '[internal id redacted]').replace(LONG_HEX_ID, '[internal id redacted]')
    .replace(ABSOLUTE_PATH, match => match.startsWith(' ') || match.startsWith('(') ? `${match[0]}[path redacted]` : '[path redacted]').trim();
  return redacted.length > 0 ? redacted : null;
}

/** The sole field deduplication/rendering function for both accounting and injection. */
export function renderMemoryFields(item: { title: string; summary: string | null; bodyPreview: string }): string | null {
  const fields = [item.title, item.summary ?? '', item.bodyPreview].filter(Boolean);
  if (redactDshSourceText(fields.join('\n')) === null) return null;
  return redactDshSourceText([...new Set(fields)].join('\n'));
}

export function memoryTextDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function projectMemoryEntry(database: SqliteDatabase, entry: EntryRecord, options: { includeEvidence?: boolean } = {}): {
  title: string; summary: string | null; bodyPreview: string; projection: MemoryProjectionReceipt;
} | null {
  if (redactDshSourceText([entry.title, entry.summary ?? '', entry.body].join('\n')) === null) return null;
  let bodyPreview = entry.body;
  let summary = entry.summary;
  let manifestDigest: string | null = null;
  let derived = false;
  let episodes: Episode[] = []
  let projectionEpisodes: z.infer<typeof ProjectionEpisode>[] = []
  let projectionSources: z.infer<typeof ProjectionSource>[] = []
  let referenceManifestDigest: string | undefined
  if (entry.provenance.type === 'memory-evolution') {
    const row = database.prepare('SELECT manifest_json,input_digest,kind,algorithm FROM memory_derivations WHERE entry_id=? AND revision=?')
      .get<{ manifest_json: string; input_digest: string; kind: string; algorithm: string }>(entry.id, entry.revision);
    if (!row) throw new KiokukoError('INTEGRITY_ERROR', 'Memory projection requires its bound derivation');
    episodes = JSON.parse(row.manifest_json) as Episode[];
    if (!Array.isArray(episodes) || episodes.length < 1 || episodes.length > 6 || digest({ version: row.algorithm, kind: row.kind, episodes }) !== row.input_digest) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Memory projection manifest is invalid');
    }
    if (row.algorithm === REFERENCE_PROMOTION_VERSION && (row.kind === 'positive' || row.kind === 'avoidance')) {
      const lesson = buildReferenceLesson(episodes, row.kind)
      if (!lesson) throw new KiokukoError('INTEGRITY_ERROR', 'Reference lesson cannot be reconstructed from its evidence')
      bodyPreview = renderReferenceLesson(lesson)
      referenceManifestDigest = row.input_digest
    } else {
      // Legacy observations retain their original per-episode conditions.
      const observations = episodes.map(episode => ({
        applicability: episode.draft.applicability,
        anchors: episode.draft.anchors,
        procedure: episode.draft.procedure,
        verification: episode.draft.verification,
        boundary: episode.draft.boundary,
        unresolved: episode.draft.unresolved,
        avoidance: episode.draft.avoidance === null ? null : {
          trigger: episode.draft.avoidance.trigger, avoid: episode.draft.avoidance.avoid,
          alternative: episode.draft.avoidance.alternative, verification: episode.draft.avoidance.verification,
        },
        observed: { successful: episode.successful, procedureSupported: episode.procedureSupported, recovered: episode.recovered },
      }));
      bodyPreview = `未検証の教訓候補 / Unverified ${row.kind === 'episode' ? 'episode' : 'lesson'}\nEach observation has its own conditions; association is not causal proof.\n${[...new Set(observations.map(value => JSON.stringify(value)))].join('\n')}`;
    }
    if (options.includeEvidence) {
      const sourceMap = new Map<string, { entryId: string; revision: number; hash: string }>()
      for (const source of episodes.flatMap(episode => episode.sources)) {
        const key = `${source.entryId}\u0000${source.revision}\u0000${source.hash}`
        sourceMap.set(key, source)
      }
      const sources = [...sourceMap.values()].sort((left, right) => left.entryId.localeCompare(right.entryId) || left.revision - right.revision)
      projectionEpisodes = episodes.map(episode => ({ runId: episode.runId, sessionId: episode.sessionId, start: episode.start, end: episode.end,
        logDigest: episode.logDigest, evidenceDigest: episode.evidenceDigest }))
      projectionSources = sources
      const citations = sources.map((source, index) => {
        const sourceEntry = readEntry(database, { workspace: entry.workspace, entryId: source.entryId })
        if (sourceEntry.revision !== source.revision || sourceEntry.contentHash !== source.hash) throw new KiokukoError('CONFLICT', 'Memory projection source revision changed')
        const title = redactDshSourceText(sourceEntry.title)
        return `Source ${index + 1}: ${title ?? 'stored source'} (revision ${source.revision}, hash ${source.hash.slice(0, 12)})`
      })
      const episodeReferences = episodes.map((episode, index) => `Episode ${index + 1}: native sequence ${episode.start}-${episode.end}, log ${episode.logDigest.slice(0, 12)}`)
      bodyPreview += `\nEvidence references:\n${[...episodeReferences, ...citations].join('\n')}`
    }
    summary = null;
    manifestDigest = row.input_digest;
    derived = true;
  }
  const fields = { title: entry.title, summary, bodyPreview };
  const text = renderMemoryFields(fields);
  if (text === null) return null;
  const selectedFields: MemoryProjectionReceipt['selectedFields'] = [];
  const seen = new Set<string>();
  const derivedField: MemoryProjectionReceipt['selectedFields'][number] = !derived ? 'body'
    : referenceManifestDigest !== undefined ? 'reference-lesson' : 'episode-manifest'
  for (const [key, value] of [['title', entry.title], ['summary', summary], [derivedField, bodyPreview]] as const) {
    if (value && !seen.has(value)) { seen.add(value); selectedFields.push(key); }
  }
  const base = { selectedFields, sourceRevision: entry.revision,
    sourceDigest: entry.contentHash, manifestDigest, textDigest: memoryTextDigest(text), characters: Array.from(text).length, bytes: Buffer.byteLength(text) }
  const evidenceReceipt = options.includeEvidence ? {
    episodes: projectionEpisodes,
    sources: projectionSources,
    evidenceReceiptDigest: digest({ episodes: projectionEpisodes, sources: projectionSources }),
  } : undefined
  const projection: MemoryProjectionReceipt = evidenceReceipt
    ? { version: 2, ...base, ...evidenceReceipt, ...(referenceManifestDigest ? {
      referenceReceiptDigest: digest({ manifestDigest: referenceManifestDigest, textDigest: memoryTextDigest(text) }),
    } : {}) }
    : { version: MEMORY_PROJECTION_VERSION, ...base }
  return { ...fields, projection };
}

export function assertMemoryProjection(item: { title: string; summary: string | null; bodyPreview: string; projection?: MemoryProjectionReceipt }): void {
  if (item.projection === undefined) return; // Historical v6 and non-delivery messages.
  const receipt = MemoryProjectionReceipt.parse(item.projection);
  const text = renderMemoryFields(item);
  if (text === null || receipt.textDigest !== memoryTextDigest(text) || receipt.characters !== Array.from(text).length || receipt.bytes !== Buffer.byteLength(text)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Memory projection differs from its delivery receipt');
  }
  if (receipt.version === 2 && receipt.evidenceReceiptDigest !== digest({ episodes: receipt.episodes, sources: receipt.sources })) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Memory projection provenance differs from its delivery receipt');
  }
  if (receipt.version === 2 && receipt.referenceReceiptDigest !== undefined
    && receipt.referenceReceiptDigest !== digest({ manifestDigest: receipt.manifestDigest, textDigest: receipt.textDigest })) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Reference lesson projection receipt is invalid');
  }
}
