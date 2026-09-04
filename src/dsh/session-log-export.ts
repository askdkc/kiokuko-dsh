import { KiokukoError } from '../errors.js'
import type { DshMirroredAttachment, DshSessionLogMirror } from './session-log-mirror.js'

const MAX_ZIP32_BYTES = 0xffff_ffff
const MAX_ZIP_ENTRIES = 32_768
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024

export type DshSessionExportFailureCode =
  | 'session_not_found'
  | 'mirror_catching_up'
  | 'archive_unsafe'
  | 'legacy_log_too_large'
  | 'cache_unavailable'
  | 'export_too_large'

export class DshSessionExportError extends Error {
  constructor(
    readonly status: 404 | 409 | 413 | 503,
    readonly code: DshSessionExportFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'DshSessionExportError'
  }
}

export interface DshSessionExport {
  readonly status: 200
  readonly headers: Readonly<Record<string, string>>
  readonly body: AsyncIterable<Uint8Array>
}

export interface DshSessionLogExportOptions {
  /**
   * If this is a live DSH session, flush its native log and mirror the flushed
   * snapshot before export readiness is evaluated. Cold sessions simply no-op.
   */
  readonly ensureNativeDurable?: (sessionId: string) => PromiseLike<void>
}

function u16(value: number): Uint8Array {
  const result = Buffer.allocUnsafe(2)
  result.writeUInt16LE(value, 0)
  return result
}

function u32(value: number): Uint8Array {
  const result = Buffer.allocUnsafe(4)
  result.writeUInt32LE(value >>> 0, 0)
  return result
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value += 1) {
    let current = value
    for (let bit = 0; bit < 8; bit += 1) current = (current & 1) === 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1
    table[value] = current >>> 0
  }
  return table
})()

function updateCrc(crc: number, bytes: Uint8Array): number {
  let current = crc
  for (const byte of bytes) current = CRC_TABLE[(current ^ byte) & 0xff]! ^ (current >>> 8)
  return current >>> 0
}

function concat(parts: readonly Uint8Array[]): Uint8Array { return Buffer.concat(parts) }

interface ZipInputEntry {
  readonly filename: string
  readonly source: AsyncIterable<Uint8Array>
}

async function* zipEntries(entries: AsyncIterable<ZipInputEntry>): AsyncIterable<Uint8Array> {
  const centralRecords: Uint8Array[] = []
  let centralBytes = 0
  let offset = 0
  let entryCount = 0
  for await (const entry of entries) {
  const filename = entry.filename
  const source = entry.source
  const name = Buffer.from(filename, 'utf8')
  if (name.byteLength === 0 || name.byteLength > 0xffff) throw new DshSessionExportError(413, 'export_too_large', 'export filename is outside ZIP limits')
  entryCount += 1
  if (entryCount > MAX_ZIP_ENTRIES) throw new DshSessionExportError(413, 'export_too_large', 'session export has too many attachment entries')
  const localOffset = offset
  const localHeader = concat([
    u32(0x04034b50), u16(20), u16(0x0808), u16(0), u16(0), u16(0),
    u32(0), u32(0), u32(0), u16(name.byteLength), u16(0), name,
  ])
  yield localHeader
  offset += localHeader.byteLength
  let crc = 0xffff_ffff
  let size = 0
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new KiokukoError('INTEGRITY_ERROR', 'session export yielded a non-byte chunk')
    size += chunk.byteLength
    if (size > MAX_ZIP32_BYTES) throw new DshSessionExportError(413, 'export_too_large', 'session export exceeds bounded ZIP32 size')
    crc = updateCrc(crc, chunk)
    yield chunk
    offset += chunk.byteLength
  }
  crc = (crc ^ 0xffff_ffff) >>> 0
  const descriptor = concat([u32(0x08074b50), u32(crc), u32(size), u32(size)])
  yield descriptor
  offset += descriptor.byteLength
  const central = concat([
    u32(0x02014b50), u16(20), u16(20), u16(0x0808), u16(0), u16(0), u16(0),
    u32(crc), u32(size), u32(size), u16(name.byteLength), u16(0), u16(0), u16(0), u16(0),
    u32(0), u32(localOffset), name,
  ])
  centralBytes += central.byteLength
  if (centralBytes > MAX_CENTRAL_DIRECTORY_BYTES) throw new DshSessionExportError(413, 'export_too_large', 'session export central directory exceeds the memory bound')
  centralRecords.push(central)
  if (offset > MAX_ZIP32_BYTES) throw new DshSessionExportError(413, 'export_too_large', 'session export exceeds bounded ZIP32 size')
  }
  const centralOffset = offset
  for (const central of centralRecords) yield central
  yield concat([
    u32(0x06054b50), u16(0), u16(0), u16(entryCount), u16(entryCount),
    u32(centralBytes), u32(centralOffset), u16(0),
  ])
}

async function* attachmentManifest(source: AsyncIterable<DshMirroredAttachment>): AsyncIterable<Uint8Array> {
  for await (const attachment of source) {
    yield Buffer.from(`${JSON.stringify({
      attachmentId: attachment.attachmentId,
      mediaType: attachment.mediaType,
      bytes: attachment.byteCount,
      digest: attachment.digest,
      path: attachment.archivePath,
      ...(attachment.name === undefined ? {} : { name: attachment.name }),
    })}\n`, 'utf8')
  }
}

function checkedSessionId(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new DshSessionExportError(404, 'session_not_found', 'session does not exist')
  }
  return value
}

export class DshSessionLogExportService {
  constructor(
    private readonly mirror: Pick<DshSessionLogMirror, 'checkpoint' | 'exportJsonl' | 'inspectExport' | 'streamAttachments'>,
    private readonly options: DshSessionLogExportOptions = {},
  ) {}

  async open(sessionIdValue: string): Promise<DshSessionExport> {
    const sessionId = checkedSessionId(sessionIdValue)
    try {
      await this.options.ensureNativeDurable?.(sessionId)
    } catch (error) {
      if (error instanceof DshSessionExportError) throw error
      if (error instanceof KiokukoError && error.code === 'NOT_FOUND') {
        throw new DshSessionExportError(404, 'session_not_found', 'session does not exist')
      }
      if (error instanceof KiokukoError && error.details?.httpStatus === 413) {
        throw new DshSessionExportError(413, 'legacy_log_too_large', error.message)
      }
      throw new DshSessionExportError(503, 'cache_unavailable', 'the live DSH session log could not be durably flushed for export')
    }
    const checkpoint = await this.mirror.checkpoint(sessionId)
    if (checkpoint.mirroredThrough < 0 && checkpoint.error === undefined) {
      throw new DshSessionExportError(404, 'session_not_found', 'session does not exist')
    }
    if (checkpoint.health === 'archive_unsafe') {
      throw new DshSessionExportError(409, 'archive_unsafe', 'session was archived before its complete log was confirmed')
    }
    if (checkpoint.health === 'catching_up' || checkpoint.confirmedThrough < checkpoint.observedThrough) {
      throw new DshSessionExportError(409, 'mirror_catching_up', 'session log cache is still catching up')
    }
    if (checkpoint.health === 'degraded' || checkpoint.error !== undefined) {
      throw new DshSessionExportError(503, 'cache_unavailable', checkpoint.error?.message ?? 'session log cache is unavailable')
    }
    const inspection = await this.mirror.inspectExport(sessionId)
    if (inspection.unresolvedAttachmentCount > 0) {
      throw new DshSessionExportError(409, 'mirror_catching_up', 'session attachments are still being mirrored')
    }
    if (inspection.attachmentCount + 2 > MAX_ZIP_ENTRIES) {
      throw new DshSessionExportError(413, 'export_too_large', 'session export has too many attachment entries')
    }
    const conservativeSize = BigInt(inspection.eventBytes)
      + BigInt(inspection.attachmentBytes)
      + BigInt(inspection.attachmentCount) * 8192n
      + BigInt(MAX_CENTRAL_DIRECTORY_BYTES)
    if (conservativeSize > BigInt(MAX_ZIP32_BYTES)) {
      throw new DshSessionExportError(413, 'export_too_large', 'session export exceeds bounded ZIP32 size')
    }
    const downloadName = `dsh-session-${encodeURIComponent(sessionId)}.zip`
    const mirror = this.mirror
    const entries = (async function* (): AsyncIterable<ZipInputEntry> {
      yield { filename: `dsh-session-${encodeURIComponent(sessionId)}.jsonl`, source: mirror.exportJsonl(sessionId) }
      yield { filename: 'attachments/manifest.jsonl', source: attachmentManifest(mirror.streamAttachments(sessionId)) }
      for await (const attachment of mirror.streamAttachments(sessionId)) {
        yield { filename: attachment.archivePath, source: attachment.source }
      }
    })()
    return Object.freeze({
      status: 200 as const,
      headers: Object.freeze({
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${downloadName}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      }),
      body: zipEntries(entries),
    })
  }
}

export function dshSessionExportFailure(error: unknown): { readonly status: 404 | 409 | 413 | 503; readonly body: { readonly code: string; readonly message: string } } {
  if (error instanceof DshSessionExportError) return { status: error.status, body: { code: error.code, message: error.message } }
  if (error instanceof KiokukoError && error.details?.httpStatus === 413) {
    return { status: 413, body: { code: 'legacy_log_too_large', message: error.message } }
  }
  return { status: 503, body: { code: 'cache_unavailable', message: 'session export is temporarily unavailable' } }
}
