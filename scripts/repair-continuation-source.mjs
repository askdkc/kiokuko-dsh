import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TextDecoder } from 'node:util'

const ZSTD_MAGIC = 0xFD2FB528
const CONTINUATION_FORMS = new Set(['continuation', 'loop-recovery'])
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

function decodeSessionLog(buffer) {
  const scan = scanZstdFrames(buffer)
  if (scan.frames.length === 0) throw new Error('session log has no complete Zstandard frames')
  if (scan.tornStart !== undefined) throw new Error('session log has an incomplete final Zstandard frame')
  return Buffer.concat(scan.frames.map(({ start, end }) => {
    try {
      return zstdDecompressSync(buffer.subarray(start, end))
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

function objectRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function repairedSource(value) {
  const source = objectRecord(value)
  if (source?.kind !== 'plugin' || source.plugin !== 'kiokuko-dsh') return undefined
  if (!Object.hasOwn(source, 'deliveryId') && !CONTINUATION_FORMS.has(source.form)) return undefined
  const repaired = { ...source, form: 'instructions' }
  delete repaired.deliveryId
  return repaired
}

function repairRecord(value) {
  const record = objectRecord(value)
  const data = objectRecord(record?.data)
  if (record?.type === 'user/message') {
    const source = repairedSource(data?.source)
    return source === undefined ? value : { ...record, data: { ...data, source } }
  }
  if (record?.type !== 'agent/inbox/spliced' || !Array.isArray(data?.inserted)) return value
  let changed = false
  const inserted = data.inserted.map((candidate) => {
    const message = objectRecord(candidate)
    const source = repairedSource(message?.source)
    if (source === undefined) return candidate
    changed = true
    return { ...message, source }
  })
  return changed ? { ...record, data: { ...data, inserted } } : value
}

function validateCatalog(catalog, records) {
  const header = records[0]
  if (header === undefined) throw new Error('session log has no header record')
  if (typeof catalog?.createRestore === 'function') {
    const restore = catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
    for (const row of records.slice(1)) restore.decodeRow(row)
    restore.finish()
    return
  }
  if (typeof catalog?.decodeRecoverableArtifact === 'function' && typeof catalog?.migrate === 'function') {
    const decoded = catalog.decodeRecoverableArtifact(header, records.slice(1))
    catalog.migrate(decoded)
    return
  }
  throw new Error('Unsupported session-format catalog API: expected createRestore or decodeRecoverableArtifact and migrate')
}

function catalogCandidates(configured) {
  const candidates = []
  if (configured !== undefined) {
    const path = resolve(configured)
    candidates.push(
      extname(path) === '.js' || extname(path) === '.mjs' ? path : join(path, 'lib/index.js'),
      join(path, '@deepseek-ai/dsh-session-format-catalog/lib/index.js'),
      join(path, 'packages/session/session-format-catalog/lib/index.js'),
    )
  }
  const packageRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT
  if (packageRoot !== undefined) {
    candidates.push(join(resolve(packageRoot), '@deepseek-ai/dsh-session-format-catalog/lib/index.js'))
  }
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  candidates.push(resolve(repositoryRoot, '..', 'deepseek-harness/packages/session/session-format-catalog/lib/index.js'))
  return [...new Set(candidates)]
}

async function loadCatalog(configured) {
  const errors = []
  try {
    const module = await import('@deepseek-ai/dsh-session-format-catalog')
    if (module.sessionFormatCatalog !== undefined) return module.sessionFormatCatalog
  } catch (error) {
    errors.push(error)
  }
  for (const candidate of catalogCandidates(configured ?? process.env.KIOKUKO_SESSION_FORMAT_CATALOG)) {
    if (!existsSync(candidate)) continue
    try {
      const module = await import(pathToFileURL(candidate).href)
      if (module.sessionFormatCatalog !== undefined) return module.sessionFormatCatalog
      errors.push(new Error(`catalog module has no sessionFormatCatalog export: ${candidate}`))
    } catch (error) {
      errors.push(error)
    }
  }
  const reason = errors.at(-1)
  throw new Error(
    'Unable to load @deepseek-ai/dsh-session-format-catalog; set KIOKUKO_SESSION_FORMAT_CATALOG or --catalog to a built catalog module',
    { cause: reason },
  )
}

function requireRegularFile(path, label) {
  const status = lstatSync(path)
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  return status
}

function ensureBackup(path, original) {
  const backup = `${path}.bak`
  if (existsSync(backup)) {
    requireRegularFile(backup, 'session backup')
    if (!readFileSync(backup).equals(original)) throw new Error(`existing session backup does not match ${path}`)
    return backup
  }
  copyFileSync(path, backup, fsConstants.COPYFILE_EXCL)
  if (!readFileSync(backup).equals(original)) throw new Error('session backup changed during creation')
  return backup
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

async function repair(path, catalog) {
  const original = readFileSync(path)
  const plaintext = decodeSessionLog(original)
  const parsed = parseJsonl(plaintext)
  let changedRecords = 0
  const repairedRecords = parsed.records.map((record) => {
    const repaired = repairRecord(record)
    if (repaired !== record) changedRecords += 1
    return repaired
  })
  const outputLines = repairedRecords.map((record, index) => (
    record === parsed.records[index] ? parsed.lines[index] : JSON.stringify(record)
  ))
  const repairedPlaintext = Buffer.from(`${outputLines.join('\n')}\n`, 'utf8')
  validateCatalog(catalog, repairedRecords)
  if (changedRecords === 0) return { changedRecords: 0, backup: undefined }

  if (!readFileSync(path).equals(original)) throw new Error('session log changed during repair preparation')
  const backup = ensureBackup(path, original)
  const temporary = `${path}.new`
  if (existsSync(temporary)) throw new Error(`temporary repair output already exists: ${temporary}`)
  try {
    const mode = lstatSync(path).mode & 0o777
    writeFileSync(temporary, encodeSessionLog(repairedPlaintext), { mode })
    renameSync(temporary, path)
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary)
    throw error
  }
  return { changedRecords, backup }
}

function parseArguments(args) {
  if (args.length === 0 || args[0] === '--help') {
    throw new Error('Usage: node scripts/repair-continuation-source.mjs <session.jsonl.zstd> [--catalog <module-or-package-root>]')
  }
  const path = resolve(args[0])
  let catalog
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== '--catalog' || typeof args[index + 1] !== 'string') throw new Error('unknown or incomplete repair option')
    catalog = args[index + 1]
    index += 1
  }
  return { path, catalog }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  requireRegularFile(options.path, 'session log')
  const catalog = await loadCatalog(options.catalog)
  const result = await repair(options.path, catalog)
  if (result.changedRecords === 0) {
    console.log(`No legacy continuation sources found in ${options.path}`)
  } else {
    console.log(`Repaired ${result.changedRecords} session record(s) in ${options.path}; backup: ${result.backup}`)
  }
}

export { decodeSessionLog, parseJsonl }

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
