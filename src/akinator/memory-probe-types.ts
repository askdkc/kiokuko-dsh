import { z } from 'zod';
import type { TaskProfile } from './types.js';

export const AkinatorMemoryConfig = z.object({
  mode: z.enum(['off', 'shadow', 'suggest', 'resolve']).default('off'),
  maxCandidates: z.number().int().min(1).max(64).default(64),
  maxHintsPerField: z.number().int().min(1).max(3).default(3),
  maxElapsedMs: z.number().int().min(1).max(1000).default(50),
}).strict();
export type ProbeConfig = z.infer<typeof AkinatorMemoryConfig>;
export type ProbeMode = ProbeConfig['mode'];
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const ProfileEvidenceSchema = z.object({
  sessionId: id, runId: id, workspace: z.string().min(1).max(16384), repositoryId: id,
  profileHash: hash, sourceMapHash: hash, snapshotHash: hash,
  originalSource: z.enum(['inferred', 'client_supplied', 'user_answer', 'memory']),
  observedAt: z.iso.datetime(),
}).strict();
export type ProfileEvidenceRef = z.infer<typeof ProfileEvidenceSchema>;
export const FieldResolutionSchema = z.object({
  field: z.enum(['taskType', 'target', 'expected', 'constraints']),
  decision: z.enum(['keep_current', 'adopt', 'suggest', 'reject']),
  value: z.string().min(1).max(1024).nullable(),
  rankingScore: z.number().finite().min(0).max(100),
  reasons: z.array(z.string().min(1).max(64)).max(8),
  evidence: z.array(ProfileEvidenceSchema).max(1),
}).strict();
export type FieldResolution = z.infer<typeof FieldResolutionSchema>;
export const MemoryProbeResultSchema = z.object({
  policyVersion: z.literal('profile-memory-v1'), mode: z.enum(['off', 'shadow', 'suggest', 'resolve']),
  status: z.enum(['skipped', 'complete', 'incomplete', 'unavailable']),
  coverage: z.enum(['complete', 'partial']),
  resolutions: z.array(FieldResolutionSchema).max(12),
  scannedCandidates: z.number().int().min(0).max(64),
  expandedProfiles: z.number().int().min(0).max(64),
  queryCount: z.number().int().min(0).max(4),
  elapsedMs: z.number().finite().min(0),
  truncated: z.boolean(),
}).strict();
export type MemoryProbeResult = z.infer<typeof MemoryProbeResultSchema>;
export interface ProfileMemoryCandidate {
  profile: TaskProfile;
  evidence: ProfileEvidenceRef;
  sources: Partial<Record<keyof TaskProfile, ProfileEvidenceRef['originalSource']>>;
  completed: boolean;
  exactTarget: boolean;
  rankingScore: number;
}
export interface ProfileMemoryHint {
  field: keyof TaskProfile;
  value: string;
  source: { runId: string; observedAt: string };
}
