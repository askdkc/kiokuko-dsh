import { KiokukoError } from '../errors.js'

export type DshSurfaceReplacement = { readonly op: 'replace'; readonly start: number; readonly end: number }
  | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }

/** V3 renamed the bounds; preserve raw records/digests while reading either format. */
export function surfaceRange(value: DshSurfaceReplacement): { start: number; end: number } {
  const start = 'startSeq' in value ? value.startSeq : value.start
  const end = 'endSeq' in value ? value.endSeq : value.end
  if (value.op !== 'replace' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new KiokukoError('INTEGRITY_ERROR', 'Invalid DSH surface replacement')
  return { start, end }
}
