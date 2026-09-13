import type { TaskProfile } from './types.js';
import type { FieldResolution, ProfileMemoryCandidate, ProbeConfig } from './memory-probe-types.js';

/** Decide only from validated canonical candidates; scores order suggestions, never confer authority. */
export function resolveProfileMemory(input: {
  profile: TaskProfile; candidates: readonly ProfileMemoryCandidate[];
  complete: boolean; config: ProbeConfig;
}): FieldResolution[] {
  if (input.profile.taskType === 'chat' || input.config.mode === 'off') return [];
  const resolutions: FieldResolution[] = [];
  const ordered = [...input.candidates].sort((a, b) => b.rankingScore - a.rankingScore
    || b.evidence.observedAt.localeCompare(a.evidence.observedAt)
    || a.evidence.runId.localeCompare(b.evidence.runId));
  const targets = new Set(ordered.map(c => c.profile.target).filter(v => v !== null));
  for (const field of ['taskType', 'target', 'expected'] as const) {
    if (input.profile[field] !== null) continue;
    const seen = new Set<string>();
    for (const candidate of ordered) {
      const value = candidate.profile[field];
      const source = candidate.sources[field];
      if (value === null || value.length > 1024 || !source || source === 'memory' || seen.has(value)) continue;
      const adopt = field === 'target' && (input.config.mode === 'resolve' || input.config.mode === 'shadow')
        && input.complete && targets.size === 1 && candidate.exactTarget && candidate.completed
        && (source === 'user_answer' || source === 'client_supplied');
      resolutions.push({ field, value, decision: adopt ? 'adopt' : 'suggest',
        rankingScore: candidate.rankingScore,
        reasons: [adopt ? 'verified-current-target' : field === 'expected' ? 'previous-example-only' : 'confirmation-required'],
        evidence: [{ ...candidate.evidence, originalSource: source }],
      });
      seen.add(value);
      if (seen.size === input.config.maxHintsPerField) break;
    }
  }
  return resolutions;
}
