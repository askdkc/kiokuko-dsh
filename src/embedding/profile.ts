import { createHash } from 'node:crypto';
import { canonicalJson } from '../serialization/validate.js';
import { requireEnabledEmbeddingConfig } from './config.js';
import type {
  EmbeddingConfig,
  EmbeddingProfile,
  EmbeddingProfileIdentity,
  EnabledEmbeddingConfig,
  LocalEmbeddingProfile,
  LocalEmbeddingProfileIdentity,
} from './types.js';
import type { LocalEmbeddingPreset } from './presets/manifest.js';
import { presetManifestHash } from './presets/manifest.js';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function endpointFingerprint(endpoint: string): string {
  return sha256(endpoint);
}

export function embeddingProfileId(identity: EmbeddingProfileIdentity | LocalEmbeddingProfileIdentity): string {
  return sha256(canonicalJson(identity));
}

export function localEmbeddingProfileId(identity: LocalEmbeddingProfileIdentity): string {
  return sha256(canonicalJson(identity));
}

export function createEmbeddingProfileIdentity(config: EnabledEmbeddingConfig): EmbeddingProfileIdentity {
  return {
    schemaVersion: 1,
    providerKind: config.provider,
    endpointFingerprint: endpointFingerprint(config.baseUrl),
    model: config.model,
    dimensions: config.dimensions,
    distanceMetric: 'cosine',
    documentTemplateVersion: 1,
    queryTemplateVersion: 1,
    distanceCeiling: config.distanceCeiling,
  };
}

export function createEmbeddingProfile(config: EmbeddingConfig): EmbeddingProfile {
  const enabled = requireEnabledEmbeddingConfig(config);
  const identity = createEmbeddingProfileIdentity(enabled);
  return Object.freeze({ profileId: embeddingProfileId(identity), identity: Object.freeze(identity) });
}

export function createLocalEmbeddingProfileIdentity(
  preset: LocalEmbeddingPreset,
  inferenceEngineVersion = preset.transformersJsVersion,
): LocalEmbeddingProfileIdentity {
  return {
    schemaVersion: 2,
    providerKind: 'local-transformers',
    presetId: preset.id,
    sourceModel: preset.sourceModel,
    artifactRepository: preset.artifactRepository,
    modelRevision: preset.revision,
    artifactManifestHash: presetManifestHash(preset),
    inferenceEngine: 'transformers-js',
    inferenceEngineVersion,
    dtype: preset.dtype,
    pooling: preset.pooling,
    normalize: preset.normalize,
    maximumTokens: preset.maximumTokens,
    dimensions: preset.dimensions,
    distanceMetric: preset.distanceMetric,
    distanceCeiling: preset.distanceCeiling,
    inputContract: preset.inputContract,
    documentTemplateVersion: 2,
    queryTemplateVersion: 2,
    queryPrefix: preset.queryPrefix,
    documentPrefix: preset.documentPrefix,
  };
}

export function createLocalEmbeddingProfile(
  preset: LocalEmbeddingPreset,
  inferenceEngineVersion = preset.transformersJsVersion,
): LocalEmbeddingProfile {
  const identity = createLocalEmbeddingProfileIdentity(preset, inferenceEngineVersion);
  return Object.freeze({
    profileId: localEmbeddingProfileId(identity),
    identity: Object.freeze(identity),
  });
}
