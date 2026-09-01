import { TextDecoder } from 'node:util';
import { parseStrictJson } from '../setup/strict-json.js';
import { findSecret } from '../memory/secrets.js';
import { KiokukoError } from '../errors.js';
import { normalizeEmbeddingBaseUrl, requireEnabledEmbeddingConfig } from './config.js';
import { createEmbeddingProfileIdentity } from './profile.js';
import { normalizeVector } from './vector.js';
import { EmbeddingProviderError } from './provider.js';
import type { EmbeddingProvider, EmbeddingProfileIdentity, EnabledEmbeddingConfig } from './types.js';

export const MAX_EMBEDDING_PROVIDER_INPUTS = 64;
export const MAX_EMBEDDING_PROVIDER_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_EMBEDDING_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_EMBEDDING_PROVIDER_RETRIES = 2;
export const MAX_EMBEDDING_PROVIDER_RETRY_DELAY_MS = 5_000;

const INVALID_UNICODE = /[\p{Cs}\uFFFD]/u;
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface OpenAICompatibleEmbeddingProviderOptions {
  readonly config: EnabledEmbeddingConfig;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly retryDelayMs?: number;
  readonly sleepImpl?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface ProviderResponseItem {
  readonly embedding: unknown;
  readonly index: unknown;
  readonly object?: unknown;
}

interface ProviderResponse {
  readonly data: unknown;
  readonly model: unknown;
  readonly object?: unknown;
}

function invalidResponse(): never {
  throw new EmbeddingProviderError('invalid_response', false);
}

function requestInvalid(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) requestInvalid(`${label} is invalid`);
  return value;
}

function endpointUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/u, '');
  url.pathname = `${path}/embeddings`;
  return url;
}

function validateInputs(inputs: readonly string[], batchSize: number): string[] {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > Math.min(MAX_EMBEDDING_PROVIDER_INPUTS, batchSize)) {
    requestInvalid('Embedding provider input count is invalid');
  }
  const copied = [...inputs];
  for (const input of copied) {
    if (typeof input !== 'string' || input.length === 0 || INVALID_CONTROL.test(input) || INVALID_UNICODE.test(input)) {
      requestInvalid('Embedding provider input is invalid');
    }
    if (findSecret(input) !== undefined) throw new EmbeddingProviderError('secret_blocked', false);
  }
  return copied;
}

function requestBody(config: EnabledEmbeddingConfig, inputs: readonly string[]): string {
  const body = JSON.stringify({
    input: [...inputs],
    model: config.model,
    encoding_format: 'float',
  });
  if (Buffer.byteLength(body, 'utf8') > MAX_EMBEDDING_PROVIDER_REQUEST_BYTES) {
    requestInvalid('Embedding provider request exceeds the byte limit');
  }
  return body;
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (value === null || !/^\d+$/u.test(value)) return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return null;
  return Math.min(MAX_EMBEDDING_PROVIDER_RETRY_DELAY_MS, seconds * 1_000);
}

function statusFailure(response: Response): EmbeddingProviderError {
  if (response.status === 429) return new EmbeddingProviderError('rate_limited', true, retryAfterMs(response));
  if (response.status === 408 || response.status === 425) return new EmbeddingProviderError('timeout', true);
  if (response.status >= 500 && response.status <= 599) return new EmbeddingProviderError('provider_unavailable', true);
  return new EmbeddingProviderError('provider_unavailable', false);
}

async function cancelResponse(response: Response): Promise<void> {
  if (response.body === null) return;
  try {
    await response.body.cancel();
  } catch {
    // The response is already being discarded; the public failure remains bounded.
  }
}

async function readResponseText(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type');
  if (contentType === null || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/iu.test(contentType)) invalidResponse();
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && !/^\d+$/u.test(contentLength)) invalidResponse();
  const declared = contentLength === null ? null : Number(contentLength);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared > MAX_EMBEDDING_PROVIDER_RESPONSE_BYTES)) invalidResponse();

  const reader = response.body?.getReader();
  if (reader === undefined) {
    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new EmbeddingProviderError('provider_unavailable', true);
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_EMBEDDING_PROVIDER_RESPONSE_BYTES || INVALID_UNICODE.test(body)) invalidResponse();
    return body;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch {
      throw new EmbeddingProviderError('provider_unavailable', true);
    }
    if (next.done) break;
    if (next.value === undefined) invalidResponse();
    const chunk = Buffer.from(next.value);
    size += chunk.byteLength;
    if (size > MAX_EMBEDDING_PROVIDER_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the bounded validation failure if cancellation itself fails.
      }
      invalidResponse();
    }
    chunks.push(chunk);
  }
  let body: string;
  try {
    body = decoder.decode(Buffer.concat(chunks));
  } catch {
    invalidResponse();
  }
  if (INVALID_UNICODE.test(body)) invalidResponse();
  return body;
}

function parseProviderResponse(value: unknown, config: EnabledEmbeddingConfig, expectedCount: number): readonly Float32Array[] {
  if (!isRecord(value)) invalidResponse();
  const allowedRootKeys = new Set(['object', 'data', 'model', 'usage']);
  if (Object.keys(value).some((key) => !allowedRootKeys.has(key))
    || !Object.prototype.hasOwnProperty.call(value, 'data')
    || !Object.prototype.hasOwnProperty.call(value, 'model')) invalidResponse();
  const response = value as unknown as ProviderResponse;
  if (response.object !== undefined && response.object !== 'list') invalidResponse();
  if (response.model !== config.model || !Array.isArray(response.data) || response.data.length !== expectedCount) invalidResponse();

  const vectors = new Array<Float32Array>(expectedCount);
  const seen = new Set<number>();
  for (const itemValue of response.data) {
    if (!isRecord(itemValue)) invalidResponse();
    const allowedItemKeys = new Set(['object', 'embedding', 'index']);
    if (Object.keys(itemValue).some((key) => !allowedItemKeys.has(key))
      || !Object.prototype.hasOwnProperty.call(itemValue, 'embedding')
      || !Object.prototype.hasOwnProperty.call(itemValue, 'index')) invalidResponse();
    const item = itemValue as unknown as ProviderResponseItem;
    if (item.object !== undefined && item.object !== 'embedding') invalidResponse();
    if (typeof item.index !== 'number' || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= expectedCount || seen.has(item.index)) invalidResponse();
    if (!Array.isArray(item.embedding) || item.embedding.length !== config.dimensions) {
      throw new EmbeddingProviderError('dimension_mismatch', false);
    }
    for (const valueAtIndex of item.embedding) {
      if (typeof valueAtIndex !== 'number' || !Number.isFinite(valueAtIndex)) invalidResponse();
    }
    let vector: Float32Array;
    try {
      vector = normalizeVector(item.embedding, config.dimensions);
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'VALIDATION_ERROR') {
        throw new EmbeddingProviderError('dimension_mismatch', false);
      }
      throw error;
    }
    seen.add(item.index);
    vectors[item.index] = vector;
  }
  if (seen.size !== expectedCount || vectors.some((vector) => vector === undefined)) invalidResponse();
  return Object.freeze(vectors);
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new EmbeddingProviderError('timeout', false));
    };
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    if (signal === undefined) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new EmbeddingProviderError('timeout', false));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function retryDelay(attempt: number, configuredDelayMs: number, retryAfter: number | null): number {
  const exponential = configuredDelayMs * (2 ** attempt);
  return Math.min(MAX_EMBEDDING_PROVIDER_RETRY_DELAY_MS, retryAfter ?? exponential);
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly profile: EmbeddingProfileIdentity;
  readonly #endpoint: URL;
  readonly #config: EnabledEmbeddingConfig;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  readonly #sleepImpl: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: OpenAICompatibleEmbeddingProviderOptions) {
    const config = requireEnabledEmbeddingConfig(options.config);
    const baseUrl = normalizeEmbeddingBaseUrl(config.baseUrl, config.allowRemote);
    this.#config = Object.freeze({ ...config, baseUrl });
    this.profile = createEmbeddingProfileIdentity(this.#config);
    this.#endpoint = endpointUrl(baseUrl);
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? config.timeoutMs, 100, 120_000, 'Embedding provider timeout');
    this.#maxRetries = boundedInteger(options.maxRetries ?? DEFAULT_EMBEDDING_PROVIDER_RETRIES, 0, 3, 'Embedding provider retries');
    this.#retryDelayMs = boundedInteger(options.retryDelayMs ?? 100, 0, MAX_EMBEDDING_PROVIDER_RETRY_DELAY_MS, 'Embedding provider retry delay');
    this.#sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  async embed(inputs: readonly string[], options: { signal?: AbortSignal } = {}): Promise<readonly Float32Array[]> {
    const normalizedInputs = validateInputs(inputs, this.#config.batchSize);
    const body = requestBody(this.#config, normalizedInputs);
    if (options.signal?.aborted) throw new EmbeddingProviderError('timeout', false);

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      let timedOut = false;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (options.signal?.aborted) controller.abort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.#timeoutMs);
      try {
        let response: Response;
        try {
          response = await this.#fetchImpl(this.#endpoint, {
            method: 'POST',
            redirect: 'manual',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              ...(this.#config.apiKey === undefined ? {} : { authorization: `Bearer ${this.#config.apiKey}` }),
            },
            body,
            signal: controller.signal,
          });
        } catch {
          throw timedOut || options.signal?.aborted === true
            ? new EmbeddingProviderError('timeout', timedOut)
            : new EmbeddingProviderError('provider_unavailable', true);
        }
        if (response.status !== 200) {
          const failure = statusFailure(response);
          await cancelResponse(response);
          throw failure;
        }
        const responseText = await readResponseText(response);
        let parsed: unknown;
        try {
          parsed = parseStrictJson(
            responseText,
            { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
            'Embedding provider response is invalid',
          );
        } catch {
          invalidResponse();
        }
        return parseProviderResponse(parsed, this.#config, normalizedInputs.length);
      } catch (error) {
        const classified = error instanceof EmbeddingProviderError
          ? error
          : error instanceof KiokukoError && error.code === 'VALIDATION_ERROR'
            ? new EmbeddingProviderError('invalid_response', false)
            : new EmbeddingProviderError('provider_unavailable', true);
        const failure = timedOut
          ? new EmbeddingProviderError('timeout', true)
          : options.signal?.aborted === true
            ? new EmbeddingProviderError('timeout', false)
            : classified;
        if (!failure.retryable || attempt >= this.#maxRetries || options.signal?.aborted) throw failure;
        const delay = retryDelay(attempt, this.#retryDelayMs, failure.retryAfterMs);
        await this.#sleepImpl(delay, options.signal);
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
    }
    throw new EmbeddingProviderError('provider_unavailable', false);
  }
}

export { OpenAICompatibleEmbeddingProvider as OpenAICompatibleProvider };
