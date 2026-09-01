import { createHash } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { KiokukoError } from '../errors.js';
import { canonicalJson, canonicalTagOrder, type JsonObject, type EntryKind } from '../serialization/validate.js';
import { findSecret } from '../memory/secrets.js';
import { validateApplicability, validateSignals } from '../memory/structured-memory.js';
import type { EmbeddingDocument } from './types.js';

export const EMBEDDING_DOCUMENT_TEMPLATE_VERSION = 1 as const;
export const EMBEDDING_DOCUMENT_TEMPLATE_VERSION_V2 = 2 as const;
export const EMBEDDING_INPUT_CONTRACT = 'e5-query-passage-v1' as const;
export const MAX_EMBEDDING_DOCUMENT_BYTES = 32 * 1024;
export const BODY_TRUNCATION_MARKER = '[body truncated]' as const;

export interface EmbeddingDocumentInput {
  readonly kind: EntryKind;
  readonly title: string;
  readonly summary: string | null;
  readonly body: string;
  readonly tags: readonly string[];
  readonly scope: JsonObject;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function invalid(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function normalizeText(value: string, field: string): string {
  const normalized = value.normalize('NFKC').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) invalid(`${field} contains a forbidden control character`);
  return normalized;
}

function normalizedTagList(tags: readonly string[]): string[] {
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.trim().length === 0 || tag.length > 200) invalid('Embedding document tags are invalid');
  }
  return canonicalTagOrder(tags.map((tag) => normalizeText(tag, 'tag')));
}

function structuredScope(scope: JsonObject): { applicability: JsonObject; signals: JsonObject } {
  const candidate = scope as Record<string, unknown>;
  if (candidate.schemaVersion !== 2 && candidate.schemaVersion !== 3) return { applicability: {}, signals: {} };
  const applicability = candidate.applicability === undefined ? {} : validateApplicability(candidate.applicability);
  const signals = candidate.signals === undefined ? {} : validateSignals(candidate.signals);
  return {
    applicability: applicability as unknown as JsonObject,
    signals: signals as unknown as JsonObject,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const bytes = encoder.encode(value);
  let end = Math.min(bytes.byteLength, maxBytes);
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}

function documentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildEmbeddingDocument(input: EmbeddingDocumentInput): EmbeddingDocument {
  if (input.kind !== 'fact' && input.kind !== 'decision' && input.kind !== 'lesson' && input.kind !== 'preference' && input.kind !== 'reference') {
    invalid('Embedding document kind is invalid');
  }
  const title = normalizeText(input.title, 'title').trim();
  const summary = input.summary === null ? '' : normalizeText(input.summary, 'summary').trim();
  const body = normalizeText(input.body, 'body');
  const tags = normalizedTagList(input.tags);
  const { applicability, signals } = structuredScope(input.scope);
  const metadataText = [
    'kiokuko-memory-v1',
    `kind: ${input.kind}`,
    `title: ${title}`,
    `summary: ${summary}`,
    'tags:',
    ...tags.map((tag) => `- ${tag}`),
    'applicability:',
    canonicalJson(applicability),
    'signals:',
    canonicalJson(signals),
    'body:',
  ].join('\n') + '\n';
  const metadataBytes = encoder.encode(metadataText);
  if (metadataBytes.byteLength >= MAX_EMBEDDING_DOCUMENT_BYTES) {
    invalid('Embedding document metadata exceeds the byte limit');
  }

  const bodyBytes = encoder.encode(body);
  let text = metadataText + body;
  let truncated = false;
  if (metadataBytes.byteLength + bodyBytes.byteLength > MAX_EMBEDDING_DOCUMENT_BYTES) {
    const marker = `\n${BODY_TRUNCATION_MARKER}`;
    const markerBytes = encoder.encode(marker);
    const available = MAX_EMBEDDING_DOCUMENT_BYTES - metadataBytes.byteLength - markerBytes.byteLength;
    if (available < 0) invalid('Embedding document metadata exceeds the byte limit');
    text = metadataText + truncateUtf8(body, available) + marker;
    truncated = true;
  }

  const bytes = encoder.encode(text);
  const secretFinding = findSecret(text);
  if (secretFinding !== undefined) {
    throw new KiokukoError('SECURITY_REJECTION', 'Embedding document resembles a secret and was not sent');
  }
  return Object.freeze({ text, bytes, documentHash: documentHash(bytes), truncated });
}

/** Build the provider-neutral v2 memory representation for E5 models. */
export function buildCanonicalEmbeddingDocument(input: EmbeddingDocumentInput): EmbeddingDocument {
  const document = buildEmbeddingDocument(input);
  const text = document.text.replace(/^kiokuko-memory-v1\n/u, 'kiokuko-memory-v2\n');
  const bytes = encoder.encode(text);
  return Object.freeze({
    text,
    bytes,
    documentHash: documentHash(bytes),
    truncated: document.truncated,
  });
}

export function renderEmbeddingProviderInput(canonicalText: string, prefix = 'passage: '): string {
  if (typeof canonicalText !== 'string' || canonicalText.length === 0 || prefix !== 'passage: ') {
    invalid('Embedding provider document input is invalid');
  }
  return `${prefix}${canonicalText}`;
}
