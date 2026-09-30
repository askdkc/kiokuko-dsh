import { z } from 'zod';
import { findSecret } from '../secrets.js';
import { canonicalJson } from '../../serialization/validate.js';
import { createHash } from 'node:crypto';
export const INDEX_ALGORITHM = 'index-reasoning-v1';
export const MemoryIndexReasoningConfig = z.object({
    mode: z.enum(['active', 'observe', 'off']).default('active'),
    dailyCalls: z.number().int().min(1).max(8).default(8),
    maxInputBytes: z.number().int().min(1024).max(32768).default(32768),
    maxOutputTokens: z.number().int().min(128).max(2048).default(2048),
    timeoutMs: z.number().int().min(100).max(60000).default(60000),
}).strict();
export type IndexReasoningConfig = z.output<typeof MemoryIndexReasoningConfig>;
export const indexDigest = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex');
export const normalizeEntity = (v: string): string => v.normalize('NFKC').trim().replace(/\s+/gu, ' ');
function entityBoundary(character: string): string {
    const identifier = '\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}\\p{N}_$';
    if (/\p{Script=Han}/u.test(character)) return `[\\p{Script=Han}${identifier}]`;
    if (/\p{Script=Katakana}/u.test(character)) return `[\\p{Script=Katakana}${identifier}]`;
    return `[${identifier}]`;
}
export function entityPresent(text: string, value: string): boolean {
    const normalized = normalizeEntity(value), characters = Array.from(normalized);
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Japanese particles may touch identifiers; SQL still cannot alias SQLite.
    return new RegExp(`(?<!${entityBoundary(characters[0] ?? '')})${escaped}(?!${entityBoundary(characters.at(-1) ?? '')})`, 'u').test(normalizeEntity(text));
}
const text = z.string().trim().min(1).max(2000).refine(v => !findSecret(v) && !/[\p{Cc}\p{Cf}]/u.test(v.replace(/[\n\r\t]/g, '')));
export const IndexSource = z.object({ entryId: z.string().min(1).max(256), revision: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), supportingText: text }).strict();
export const IndexEntity = z.object({ type: z.enum(['path', 'symbol', 'package', 'command', 'error', 'concept']), value: text.pipe(z.string().max(200)) }).strict();
export const IndexDraft = z.object({ role: z.enum(['atomic', 'bridge']), text, applicability: text.nullable(), entities: z.array(IndexEntity).min(1).max(8), sources: z.array(IndexSource).min(1).max(2) }).strict();
export const IndexManifest = IndexDraft.omit({ text: true }).extend({ version: z.literal(1), algorithmVersion: z.literal(INDEX_ALGORITHM), inputDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type IndexDraft = z.infer<typeof IndexDraft>;
export type IndexManifest = z.infer<typeof IndexManifest>;
export const IndexModel = z.object({ provider: z.string().min(1), model: z.string().min(1), contextWindow: z.number().int().positive(), sessionId: z.string().min(1), reasoningEffort: z.string().optional() }).strict();
export type IndexModel = z.infer<typeof IndexModel>;
