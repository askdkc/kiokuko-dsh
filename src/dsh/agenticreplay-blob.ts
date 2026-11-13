import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { checkPrivatePath, readPrivateFile } from './agenticreplay-security.js'
import { AgenticReplayError } from './agenticreplay-types.js'

const decompress = promisify(gunzip)
const HEADER_ALLOWANCE = 65_536
const MAX_STORED_BYTES = 268_435_456

/** Read one private blob, preferring raw; only absence permits the compressed representation. */
export async function readAgenticReplayBlob(dir: string, ref: { $blob: string; bytes: number }, remainingBytes: number): Promise<Buffer> {
  if (!/^sha256:[0-9a-f]{64}$/u.test(ref.$blob) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0
    || ref.bytes > Number.MAX_SAFE_INTEGER - HEADER_ALLOWANCE) throw new AgenticReplayError('unsafe_blob')
  if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0 || ref.bytes > remainingBytes) {
    throw new AgenticReplayError('timeline_blob_limit')
  }
  const hex = ref.$blob.slice(7)
  await checkPrivatePath(join(dir, 'blobs'), true)
  await checkPrivatePath(join(dir, 'blobs', hex.slice(0, 2)), true)
  const raw = join(dir, 'blobs', hex.slice(0, 2), hex)
  let bytes: Buffer
  try { bytes = await readPrivateFile(raw, ref.bytes) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof AgenticReplayError && error.code === 'read_limit') throw new AgenticReplayError('blob_mismatch')
      throw error
    }
    // The compressed input has a separate bound; header padding must not bypass it.
    const stored = await readPrivateFile(raw + '.gz', Math.min(ref.bytes + HEADER_ALLOWANCE, MAX_STORED_BYTES))
    try { bytes = await decompress(stored, { maxOutputLength: Math.max(1, Math.min(ref.bytes, remainingBytes)) }) }
    catch (error) {
      throw new AgenticReplayError((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
        ? 'blob_mismatch' : 'blob_compression_invalid')
    }
  }
  if (bytes.length !== ref.bytes || createHash('sha256').update(bytes).digest('hex') !== hex) {
    throw new AgenticReplayError('blob_mismatch')
  }
  return bytes
}
