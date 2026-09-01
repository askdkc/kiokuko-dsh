import { KiokukoError } from '../errors.js';
import type { EmbeddingConfig, EnabledEmbeddingConfig, EmbeddingMode, EmbeddingProviderKind, VectorBackendPreference } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_SIZE = 16;
const MAX_MODEL_LENGTH = 256;
const MAX_API_KEY_LENGTH = 4_096;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export const DEPRECATED_EMBEDDING_ENVIRONMENT_VARIABLES = Object.freeze([
  'KIOKUKO_EMBEDDINGS',
  'KIOKUKO_EMBEDDING_PROVIDER',
  'KIOKUKO_EMBEDDING_BASE_URL',
  'KIOKUKO_EMBEDDING_MODEL',
  'KIOKUKO_EMBEDDING_DIMENSIONS',
  'KIOKUKO_EMBEDDING_DISTANCE_CEILING',
  'KIOKUKO_EMBEDDING_API_KEY',
  'KIOKUKO_EMBEDDING_ALLOW_REMOTE',
  'KIOKUKO_EMBEDDING_TIMEOUT_MS',
  'KIOKUKO_EMBEDDING_BATCH_SIZE',
  'KIOKUKO_VECTOR_BACKEND',
] as const);

/** Report only deprecated setting names; never inspect or return their values. */
export function findDeprecatedEmbeddingEnvironmentVariables(
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return DEPRECATED_EMBEDDING_ENVIRONMENT_VARIABLES.filter((name) => Object.hasOwn(environment, name));
}

function invalid(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function enumValue<T extends string>(value: string | undefined, fallback: T, allowed: readonly T[], field: string): T {
  const selected: T = value === undefined ? fallback : value as T;
  if (!allowed.includes(selected)) invalid(`${field} has an unsupported value`);
  return selected;
}

function boundedText(value: string, field: string, maxLength: number): string {
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length === 0 || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    invalid(`${field} is invalid`);
  }
  return normalized;
}

function optionalText(value: string | undefined, field: string, maxLength: number): string | undefined {
  return value === undefined || value.length === 0 ? undefined : boundedText(value, field, maxLength);
}

function integerValue(value: string | undefined, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) invalid(`${field} must be an integer in the supported range`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid(`${field} must be an integer in the supported range`);
  }
  return parsed;
}

function distanceCeilingValue(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(value)) invalid('KIOKUKO_EMBEDDING_DISTANCE_CEILING is invalid');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 2) {
    invalid('KIOKUKO_EMBEDDING_DISTANCE_CEILING is invalid');
  }
  return parsed;
}

function booleanValue(value: string | undefined, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (value !== 'true' && value !== 'false') invalid(`${field} must be true or false`);
  return value === 'true';
}

/** Normalize and validate an embedding endpoint without retaining credentials. */
export function normalizeEmbeddingBaseUrl(value: string, allowRemote: boolean): string {
  const input = boundedText(value, 'KIOKUKO_EMBEDDING_BASE_URL', 2_048);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    invalid('KIOKUKO_EMBEDDING_BASE_URL must be an absolute URL');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    invalid('KIOKUKO_EMBEDDING_BASE_URL must not contain credentials, query, or fragment data');
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(hostname)) invalid('HTTP embedding endpoints must use a loopback host');
  } else if (url.protocol === 'https:') {
    if (!allowRemote) invalid('HTTPS embedding endpoints require explicit remote opt-in');
  } else {
    invalid('KIOKUKO_EMBEDDING_BASE_URL must use HTTP or HTTPS');
  }
  return url.toString();
}

export function isEnabledEmbeddingConfig(config: EmbeddingConfig): config is EnabledEmbeddingConfig {
  return config.mode !== 'off'
    && config.baseUrl !== undefined
    && config.model !== undefined
    && config.dimensions !== undefined
    && config.distanceCeiling !== undefined;
}

export function requireEnabledEmbeddingConfig(config: EmbeddingConfig): EnabledEmbeddingConfig {
  if (!isEnabledEmbeddingConfig(config)) invalid('Embedding configuration is disabled or incomplete');
  return config;
}

export function parseEmbeddingConfig(environment: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const mode = enumValue<EmbeddingMode>(environment.KIOKUKO_EMBEDDINGS, 'off', ['off', 'optional', 'required'], 'KIOKUKO_EMBEDDINGS');
  const provider = enumValue<EmbeddingProviderKind>(environment.KIOKUKO_EMBEDDING_PROVIDER, 'openai-compatible', ['openai-compatible'], 'KIOKUKO_EMBEDDING_PROVIDER');
  const allowRemote = booleanValue(environment.KIOKUKO_EMBEDDING_ALLOW_REMOTE, false, 'KIOKUKO_EMBEDDING_ALLOW_REMOTE');
  const vectorBackend = enumValue<VectorBackendPreference>(environment.KIOKUKO_VECTOR_BACKEND, 'auto', ['auto', 'javascript', 'sqlite-vec'], 'KIOKUKO_VECTOR_BACKEND');
  const baseUrl = environment.KIOKUKO_EMBEDDING_BASE_URL === undefined
    ? undefined
    : normalizeEmbeddingBaseUrl(environment.KIOKUKO_EMBEDDING_BASE_URL, allowRemote);
  const model = optionalText(environment.KIOKUKO_EMBEDDING_MODEL, 'KIOKUKO_EMBEDDING_MODEL', MAX_MODEL_LENGTH);
  const dimensions = integerValue(environment.KIOKUKO_EMBEDDING_DIMENSIONS, 0, 2, 8_192, 'KIOKUKO_EMBEDDING_DIMENSIONS');
  const configuredDistanceCeiling = distanceCeilingValue(environment.KIOKUKO_EMBEDDING_DISTANCE_CEILING);
  const timeoutMs = integerValue(environment.KIOKUKO_EMBEDDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 120_000, 'KIOKUKO_EMBEDDING_TIMEOUT_MS');
  const batchSize = integerValue(environment.KIOKUKO_EMBEDDING_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, 64, 'KIOKUKO_EMBEDDING_BATCH_SIZE');
  const apiKey = optionalText(environment.KIOKUKO_EMBEDDING_API_KEY, 'KIOKUKO_EMBEDDING_API_KEY', MAX_API_KEY_LENGTH);

  if (mode !== 'off' && (baseUrl === undefined || model === undefined || dimensions === 0 || configuredDistanceCeiling === undefined)) {
    invalid('Enabled embeddings require base URL, model, dimensions, and distance ceiling');
  }

  return {
    mode,
    provider,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
    ...(dimensions === 0 ? {} : { dimensions }),
    ...(configuredDistanceCeiling === undefined ? {} : { distanceCeiling: configuredDistanceCeiling }),
    ...(apiKey === undefined ? {} : { apiKey }),
    allowRemote,
    vectorBackend,
    timeoutMs,
    batchSize,
  };
}
