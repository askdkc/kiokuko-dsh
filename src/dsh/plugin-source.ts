/** DSH V4 attributes a message to its producer through source.kind. */
export const KIOKUKO_DSH_SOURCE_KIND = 'plugin:kiokuko-dsh'

function sourceRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Recognize current messages and the released V3 shape before migration. */
export function isKiokukoDshSource(value: unknown): value is Record<string, unknown> {
  const source = sourceRecord(value)
  return source?.kind === KIOKUKO_DSH_SOURCE_KIND
    || (source?.kind === 'plugin' && source.plugin === 'kiokuko-dsh')
}

/** Recognize plugin and runtime snapshots as non-human context across V3 and V4. */
export function isSyntheticContextSource(value: unknown): boolean {
  const kind = sourceRecord(value)?.kind
  return kind === 'plugin' || kind === 'runtime-context'
    || (typeof kind === 'string' && kind.startsWith('plugin:'))
}
