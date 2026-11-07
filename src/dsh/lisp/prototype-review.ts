import type { SavedResultPage } from './inspection.js'

export type InspectionReceipt = { page: SavedResultPage; version: string }
type Range = { start: number; end: number }

/** Coverage of the full serialized result, in Unicode code points. */
export class PrototypeReview {
  private ranges: Range[] = []
  private totalCharacters: number | null = null
  private issue?: 'inspection_failed' | 'invalid_page' | 'result_version_mismatch'

  constructor(readonly operationId: string, readonly version: string) {}

  invalidate(): void {
    this.ranges = []
    this.totalCharacters = null
    this.issue = 'result_version_mismatch'
  }

  record(receipt: InspectionReceipt | undefined, requestedOffset: unknown): boolean {
    if (!receipt) {
      this.issue = 'inspection_failed'
      return false
    }
    if (receipt.version !== this.version) {
      this.invalidate()
      return false
    }
    const { ok, state, resultOperationId, section, pointer, offset, data, totalCharacters, nextOffset } = receipt.page
    const end = offset + (typeof data === 'string' ? Array.from(data).length : 0)
    if (ok !== true || state !== 'SUCCEEDED' || resultOperationId !== this.operationId || section !== 'result' || pointer !== undefined
      || offset !== requestedOffset || !Number.isSafeInteger(offset) || offset < 0
      || typeof data !== 'string' || !Number.isSafeInteger(totalCharacters) || totalCharacters < end
      || (end === offset && totalCharacters !== 0) || nextOffset !== (end === totalCharacters ? null : end)
      || (this.totalCharacters !== null && this.totalCharacters !== totalCharacters)) {
      this.issue = 'invalid_page'
      return false
    }
    this.totalCharacters = totalCharacters
    delete this.issue
    const range = { start: offset, end }
    let first = 0
    while (first < this.ranges.length && this.ranges[first]!.end < range.start) first++
    let after = first
    while (after < this.ranges.length && this.ranges[after]!.start <= range.end) {
      const previous = this.ranges[after++]!
      range.start = Math.min(range.start, previous.start)
      range.end = Math.max(range.end, previous.end)
    }
    this.ranges.splice(first, after - first, range)
    return range.start === 0 && range.end === totalCharacters
  }

  status() {
    const first = this.ranges[0]
    const endSeen = this.ranges.at(-1)?.end === this.totalCharacters
    const firstMissingOffset = first?.start === 0 ? first.end : 0
    return {
      issue: this.issue ?? (endSeen ? 'missing_ranges' : 'end_unseen'),
      totalCharacters: this.totalCharacters,
      firstMissingOffset,
      endSeen,
    }
  }
}
