import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SqliteDatabase } from '../db/adapter.js';
import type { EntryRecord } from '../memory/entries.js';
import type { Episode } from '../memory/evolution/contracts.js';
import { digest } from '../memory/evolution/contracts.js';
import { findSecret } from '../memory/secrets.js';
import { KiokukoError } from '../errors.js';

export const MEMORY_PROJECTION_VERSION = 1 as const;
export const MemoryProjectionReceipt = z.object({
  version: z.literal(MEMORY_PROJECTION_VERSION),
  selectedFields: z.array(z.enum(['title', 'summary', 'body', 'episode-manifest'])).min(1).max(4),
  sourceRevision: z.number().int().positive(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  textDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  characters: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
}).strict();
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

export function projectMemoryEntry(database: SqliteDatabase, entry: EntryRecord): {
  title: string; summary: string | null; bodyPreview: string; projection: MemoryProjectionReceipt;
} | null {
  if (redactDshSourceText([entry.title, entry.summary ?? '', entry.body].join('\n')) === null) return null;
  let bodyPreview = entry.body;
  let summary = entry.summary;
  let manifestDigest: string | null = null;
  let derived = false;
  if (entry.provenance.type === 'memory-evolution') {
    const row = database.prepare('SELECT manifest_json,input_digest,kind,algorithm FROM memory_derivations WHERE entry_id=? AND revision=?')
      .get<{ manifest_json: string; input_digest: string; kind: string; algorithm: string }>(entry.id, entry.revision);
    if (!row) throw new KiokukoError('INTEGRITY_ERROR', 'Memory projection requires its bound derivation');
    const episodes = JSON.parse(row.manifest_json) as Episode[];
    if (!Array.isArray(episodes) || episodes.length < 1 || episodes.length > 6 || digest({ version: row.algorithm, kind: row.kind, episodes }) !== row.input_digest) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Memory projection manifest is invalid');
    }
    // All source conditions remain attached to their own observations. A union of
    // conditions must never be presented as unconditional permission to use a fix.
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
    summary = null;
    manifestDigest = row.input_digest;
    derived = true;
  }
  const fields = { title: entry.title, summary, bodyPreview };
  const text = renderMemoryFields(fields);
  if (text === null) return null;
  const selectedFields: MemoryProjectionReceipt['selectedFields'] = [];
  const seen = new Set<string>();
  for (const [key, value] of [['title', entry.title], ['summary', summary], [derived ? 'episode-manifest' : 'body', bodyPreview]] as const) {
    if (value && !seen.has(value)) { seen.add(value); selectedFields.push(key); }
  }
  return { ...fields, projection: { version: MEMORY_PROJECTION_VERSION, selectedFields, sourceRevision: entry.revision,
    sourceDigest: entry.contentHash, manifestDigest, textDigest: memoryTextDigest(text), characters: Array.from(text).length, bytes: Buffer.byteLength(text) } };
}

export function assertMemoryProjection(item: { title: string; summary: string | null; bodyPreview: string; projection?: MemoryProjectionReceipt }): void {
  if (item.projection === undefined) return; // Historical v6 and non-delivery messages.
  const receipt = MemoryProjectionReceipt.parse(item.projection);
  const text = renderMemoryFields(item);
  if (text === null || receipt.textDigest !== memoryTextDigest(text) || receipt.characters !== Array.from(text).length || receipt.bytes !== Buffer.byteLength(text)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Memory projection differs from its delivery receipt');
  }
}
