/** Development evidence only. This report never authorizes a production worker. */
export interface ProbeCheck {
  readonly id: string
  readonly status: 'passed' | 'failed' | 'unavailable' | 'unverified'
  readonly detail: string
}

export interface P0Report {
  readonly schemaVersion: 1
  readonly phase: 'P0'
  readonly platform: string
  readonly architecture: string
  readonly kernel: string
  readonly node: string
  readonly sbcl: string
  readonly backend: string
  readonly checks: readonly ProbeCheck[]
  readonly readyForP1: false
}

/** A primitive probe passing is not evidence of the whole protection contract. */
export function unverifiedRequirements(): ProbeCheck[] {
  return [
    ['aggregate-memory', 'Worker and descendant aggregate memory limit has no verified backend.'],
    ['aggregate-cpu', 'Worker and descendant CPU allocation limit has no verified backend.'],
    ['aggregate-tasks', 'Worker and descendant thread/process limit has no verified backend.'],
    ['scratch-quota', 'No verified fixed-capacity scratch filesystem is mounted by this prototype.'],
    ['global-reservations', 'Cross-session resource admission and reservations are not implemented.'],
    ['process-isolation', 'Signal/ptrace/IPC isolation and complete descendant ownership are unverified.'],
    ['crash-cleanup', 'Host-crash ownership recovery and descendant termination are unverified.'],
    ['dsh-all-paths', 'Protection admission, child/PTC paths, registry changes and unload fencing require native DSH proof.'],
    ['platform-matrix', 'Both OS implementations and all four OS/CPU combinations require separate evidence.'],
  ].map(([id, detail]) => ({ id: id!, status: 'unverified', detail: detail! }))
}

export function formatP0Report(report: P0Report): string {
  return [
    'Common Lisp P0: BLOCKED — 保護機能の実装工程には進めません。',
    `${report.platform}/${report.architecture}; kernel ${report.kernel}; ${report.sbcl}`,
    `候補 backend: ${report.backend}`,
    ...report.checks.map(check => `${check.status.toUpperCase()} ${check.id}: ${check.detail}`),
    '次の操作: 未達能力の強制方式と実プロセス証拠を揃えて再検査してください。',
    'この開発用検査は Lisp ツールの登録・実データの変更・設定変更を行いません。',
  ].join('\n')
}

export function parseNativeObservations(output: string): readonly Record<string, number>[] {
  const lines = output.trim().split('\n')
  if (lines.length !== 2) throw new Error('Expected observations from exactly one parent and one child')
  const fields = ['child', 'readInput', 'writeInput', 'readPrivate', 'writeScratch', 'tcp', 'udp', 'unix', 'unexpectedFds']
  return lines.map((line, index) => {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native observation')
    const row = value as Record<string, number>
    if (Object.keys(row).length !== fields.length || fields.some(field => !Number.isSafeInteger(row[field]) || row[field]! < 0)
      || row.child !== index) throw new Error('Invalid native observation fields')
    return row
  })
}

/** EPERM/EACCES are denials; ECONNREFUSED/ENOENT are not isolation evidence. */
export function classifyIsolation(baseline: readonly Record<string, number>[], confined: readonly Record<string, number>[]): ProbeCheck[] {
  return [
    ['filesystem-sample', ['readInput', 'writeInput', 'readPrivate', 'writeScratch']],
    ['network-sample', ['tcp', 'udp', 'unix']],
    ['fd-sample', ['unexpectedFds']],
  ].map(([id, names]) => {
    const fields = names as string[]
    const zeroFields = new Set(['readInput', 'writeScratch', 'unexpectedFds'])
    const validControl = baseline.length === 2 && baseline.every(row => fields.every(field => row[field] === 0))
    const isolated = confined.length === 2 && confined.every(row => fields.every(field =>
      zeroFields.has(field) ? row[field] === 0 : row[field] === 1 || row[field] === 13))
    return {
      id: id as string,
      status: !validControl ? 'unverified' : isolated ? 'passed' : 'failed',
      detail: !validControl ? 'Unconfined positive control did not succeed; do not count denial as protection.'
        : isolated ? 'Bounded fixture probes passed in parent and one child; not complete isolation evidence.'
          : 'At least one expected denial or permitted operation failed in the candidate sandbox.',
    }
  })
}
