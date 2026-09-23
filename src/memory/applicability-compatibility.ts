import type { EntryRecord } from './entries.js';
import type { ProjectFingerprint } from '../repository/project-fingerprint.js';
import { normalizeSearchSignal } from './retrieval-query.js';
import { satisfiesFrameworkVersion } from '../repository/framework-version.js';

function metadataObject(entry: EntryRecord): Record<string, unknown> {
  return entry.scope as Record<string, unknown>;
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(normalizeSearchSignal) : [];
}

function frameworkValues(value: unknown): Array<{ name: string; version?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item) || typeof (item as { name?: unknown }).name !== 'string') return [];
    const framework = item as { name: string; version?: unknown };
    return [{ name: normalizeSearchSignal(framework.name), ...(typeof framework.version === 'string' ? { version: framework.version } : {}) }];
  });
}

export function applicabilityCompatibility(entry: EntryRecord, fingerprint: ProjectFingerprint): { score: number; reasons: string[]; incompatible: boolean } {
  const applicability = metadataObject(entry).applicability;
  if (typeof applicability !== 'object' || applicability === null || Array.isArray(applicability)) return { score: 0, reasons: ['applicability_unknown'], incompatible: false };
  const value = applicability as Record<string, unknown>;
  let score = 0;
  const reasons: string[] = [];
  let constrainedDimensions = 0;
  let matchedDimensions = 0;
  const exactSet = (expected: string[], actual: string[], weight: number, reason: string): void => {
    if (expected.length === 0) return;
    constrainedDimensions += 1;
    const matches = expected.filter((item) => actual.includes(normalizeSearchSignal(item)));
    if (matches.length > 0) {
      matchedDimensions += 1;
      score += weight;
      reasons.push(reason);
    }
  };
  exactSet(stringValues(value.languages), fingerprint.languages.map(normalizeSearchSignal), 15, 'language_match');
  exactSet(stringValues(value.databases), fingerprint.databases.map(normalizeSearchSignal), 20, 'database_match');
  exactSet(stringValues(value.runtimes), fingerprint.runtimes.map(normalizeSearchSignal), 10, 'runtime_match');
  exactSet(stringValues(value.tools), fingerprint.tools.map(normalizeSearchSignal), 10, 'tool_match');
  // ProjectFingerprint does not currently expose a platform axis. Fail closed
  // instead of allowing a platform-constrained memory through an exact signal.
  exactSet(stringValues(value.platforms), [], 0, 'platform_match');
  const projectFrameworks = fingerprint.frameworks.map((item) => ({ name: normalizeSearchSignal(item.name), version: item.version }));
  const expectedFrameworks = frameworkValues(value.frameworks);
  if (expectedFrameworks.length > 0) {
    constrainedDimensions += 1;
    let frameworkScore = -Infinity;
    let frameworkReason: string | undefined;
    for (const framework of expectedFrameworks) {
      const match = projectFrameworks.find((item) => item.name === framework.name);
      if (!match) continue;
      if (framework.version !== undefined) {
        if (match.version === undefined) continue;
        const compatibility = satisfiesFrameworkVersion(match.version, framework.version);
        if (compatibility !== 'exact' && compatibility !== 'compatible') continue;
        const candidateScore = 35;
        if (candidateScore > frameworkScore) {
          frameworkScore = candidateScore;
          frameworkReason = compatibility === 'exact' ? 'framework_exact_match' : 'framework_match';
        }
      } else if (25 > frameworkScore) {
        frameworkScore = 25;
        frameworkReason = 'framework_match';
      }
    }
    if (frameworkReason !== undefined) {
      matchedDimensions += 1;
      score += frameworkScore;
      reasons.push(frameworkReason);
    }
  }
  if (constrainedDimensions > 0 && matchedDimensions !== constrainedDimensions) {
    return { score: -100, reasons: ['applicability_mismatch'], incompatible: true };
  }
  return { score, reasons: reasons.length > 0 ? reasons : ['applicability_unknown'], incompatible: false };
}

