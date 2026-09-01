import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import { canonicalJson } from '../serialization/validate.js';
import type { LocalEmbeddingPreset, LocalEmbeddingPresetFile } from './presets/manifest.js';
import { presetManifestHash } from './presets/manifest.js';

export const MODEL_MANIFEST_FILENAME = 'kiokuko-model-manifest.json';
export const MAX_MODEL_BYTES = 512 * 1024 * 1024;

export interface VerifiedModelManifest {
  readonly schemaVersion: 1;
  readonly presetId: 'local-small';
  readonly repositoryId: string;
  readonly revision: string;
  readonly artifactManifestHash: string;
  readonly files: readonly LocalEmbeddingPresetFile[];
  readonly totalBytes: number;
}

function invalid(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function hashFile(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function validatePresetManifest(preset: LocalEmbeddingPreset): void {
  if (preset.id !== 'local-small' || preset.schemaVersion !== 1
    || preset.sourceModel !== 'intfloat/multilingual-e5-small'
    || preset.artifactRepository !== 'Xenova/multilingual-e5-small'
    || !/^[0-9a-f]{40}$/u.test(preset.revision)
    || preset.dimensions !== 384 || preset.maximumTokens !== 512
    || preset.dtype !== 'q8' || preset.pooling !== 'mean' || preset.normalize !== true
    || preset.distanceMetric !== 'cosine' || preset.distanceCeiling <= 0 || preset.distanceCeiling >= 2
    || preset.inputContract !== 'e5-query-passage-v1' || preset.queryPrefix !== 'query: '
    || preset.documentPrefix !== 'passage: ' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(preset.transformersJsVersion)) {
    invalid('Embedding preset manifest is invalid');
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of preset.files) {
    if (paths.has(file.path) || file.path.length === 0 || file.path.startsWith('/')
      || file.path.split('/').some((part) => part === '' || part === '.' || part === '..')
      || !Number.isSafeInteger(file.size) || file.size <= 0
      || !/^[0-9a-f]{64}$/u.test(file.sha256)) invalid('Embedding preset file manifest is invalid');
    paths.add(file.path);
    totalBytes += file.size;
  }
  if (preset.files.length === 0 || totalBytes > MAX_MODEL_BYTES) invalid('Embedding preset file size is unsupported');
}

export function createModelManifest(preset: LocalEmbeddingPreset): VerifiedModelManifest {
  validatePresetManifest(preset);
  const totalBytes = preset.files.reduce((total, file) => total + file.size, 0);
  return Object.freeze({
    schemaVersion: 1,
    presetId: preset.id,
    repositoryId: preset.artifactRepository,
    revision: preset.revision,
    artifactManifestHash: presetManifestHash(preset),
    files: Object.freeze(preset.files.map((file) => Object.freeze({ ...file }))),
    totalBytes,
  });
}

export function serializeModelManifest(manifest: VerifiedModelManifest): string {
  return `${canonicalJson(manifest)}\n`;
}

export async function verifyModelDirectory(
  directory: string,
  preset: LocalEmbeddingPreset,
): Promise<VerifiedModelManifest> {
  const expected = createModelManifest(preset);
  for (const file of expected.files) {
    const filePath = path.join(directory, file.path);
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new KiokukoError('SECURITY_REJECTION', `Model artifact is not a regular file: ${file.path}`);
    if (stat.size !== file.size) throw new KiokukoError('INTEGRITY_ERROR', `Model artifact size mismatch: ${file.path}`);
    if (hashFile(await readFile(filePath)) !== file.sha256) throw new KiokukoError('SECURITY_REJECTION', `Model artifact hash mismatch: ${file.path}`);
  }
  return expected;
}

export async function assertNoUnexpectedModelFiles(
  directory: string,
  preset: LocalEmbeddingPreset,
): Promise<void> {
  const allowed = new Set([...preset.files.map((file) => file.path), MODEL_MANIFEST_FILENAME]);
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new KiokukoError('SECURITY_REJECTION', `Model directory contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
      else if (!allowed.has(relative)) throw new KiokukoError('SECURITY_REJECTION', `Model directory contains an unexpected file: ${relative}`);
    }
  };
  await walk(directory, '');
}
