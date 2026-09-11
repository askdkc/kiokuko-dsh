import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { TextDecoder } from 'node:util'

const ZSTD_MAGIC = 0xFD2FB528
const INFORMATIONAL_TYPES = new Set(['kiokuko/evolution-observation', 'kiokuko/completion-report',
  'kiokuko/execution-status', 'kiokuko/deep-report', 'kiokuko/deep-status'])
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function decodeSessionLog(buffer, maxOutputLength) {
  const scan = scanZstdFrames(buffer)
  if (scan.frames.length === 0) throw new Error('session log has no complete Zstandard frames')
  if (scan.tornStart !== undefined) throw new Error('session log has an incomplete final Zstandard frame')
  let remaining = maxOutputLength
  return Buffer.concat(scan.frames.map(({ start, end }) => {
    try {
      if (remaining !== undefined && remaining <= 0) throw new Error('expanded session log exceeds compatibility limit')
      const result = zstdDecompressSync(buffer.subarray(start, end), remaining === undefined ? {} : { maxOutputLength: remaining })
      if (remaining !== undefined) remaining -= result.length
      return result
    } catch (error) {
      throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation`, { cause: error })
    }
  }))
}

function parseJsonl(plaintext) {
  if (plaintext.length === 0 || plaintext[plaintext.length - 1] !== 0x0A) {
    throw new Error('session log must end with a newline')
  }
  const text = fatalUtf8Decoder.decode(plaintext)
  const lines = text.slice(0, -1).split('\n')
  if (lines.length === 0 || lines.some(line => line.length === 0)) {
    throw new Error('session log contains an empty JSONL record')
  }
  const records = lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`session log JSONL record ${index} is malformed`, { cause: error })
    }
  })
  return { lines, records }
}

function encodeSessionLog(plaintext) {
  const newline = plaintext.indexOf(0x0A)
  if (newline < 0) throw new Error('session log has no header line')
  const headerFrame = zstdCompressSync(plaintext.subarray(0, newline + 1), {
    params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
  })
  const body = plaintext.subarray(newline + 1)
  if (body.length === 0) return headerFrame
  const bodyFrame = zstdCompressSync(body, {
    params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 },
  })
  return Buffer.concat([headerFrame, bodyFrame])
}
function repairInformationalRecord(value) {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
  if (!INFORMATIONAL_TYPES.has(record?.type)) return value
  if (Object.hasOwn(record, 'ignorable') && record.ignorable !== true) {
    throw new Error('refusing to replace an invalid ignorable marker')
  }
  if (Object.hasOwn(record, 'surfaceOp') || Object.hasOwn(record, 'sourceEventSeqs')) {
    throw new Error('refusing to mark a surface-changing event ignorable')
  }
  return record.ignorable === true ? value : { ...record, ignorable: true }
}

export { decodeSessionLog, parseJsonl, encodeSessionLog, repairInformationalRecord }
