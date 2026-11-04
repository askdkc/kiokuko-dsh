import type { Connection } from '../contracts.js'

/**
 * The largest Infron listing this reader accepts. The live gateway answered
 * about 0.8 MB for 530 models, and the adapter's own listing reader caps the
 * same endpoint at 4 MB, so this ceiling holds the same boundary while still
 * leaving headroom for the listing to grow.
 */
const MAX_LISTING_BYTES = 4 * 1024 * 1024

interface ListingEntry {
  id?: unknown
  input_modalities?: unknown
  architecture?: unknown
}

/** The standard listing reply this gateway serves. */
interface ListingReply {
  data?: unknown
}

/** Distinct non-empty modality names of one listing row, or `undefined`. */
function modalities(entry: ListingEntry): readonly string[] | undefined {
  // Infron uses the top-level field; Hermes/Nous uses OpenRouter's
  // architecture field. Keep an explicit top-level declaration authoritative.
  const architecture = entry.architecture
  const input = entry.input_modalities ?? (
    architecture !== null && typeof architecture === 'object' && !Array.isArray(architecture)
      ? (architecture as Record<string, unknown>).input_modalities
      : undefined
  )
  if (!Array.isArray(input)) return undefined
  const names = input.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  return names.length ? [...new Set(names)] : undefined
}

/** Drain a refused or unusable reply so the socket is not left open. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/**
 * Read input modalities from Infron and Hermes/Nous model listings.
 *
 * The installed adapter's discovery reports ids, names and capacities for
 * endpoints it ships no catalog entry for, so an image-capable gateway model
 * otherwise adopts as text-only and rejects every later image request. This
 * second bounded read of the protocol's own listing supplies the missing
 * modality fact for the ids the connection refresh adopts.
 *
 * The read stays advisory: every refusal, error or unreadable reply yields an
 * empty map, and model discovery remains the request whose failure the
 * refresh reports. Caller cancellation propagates so a shutdown does not
 * outlive the refresh that requested the read.
 */
export async function infronModalities(
  c: Connection,
  key: string | undefined,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const empty: ReadonlyMap<string, readonly string[]> = new Map()
  try {
    const url = `${c.baseURL.replace(/\/+$/, '')}/models`,
      headers = new Headers({ accept: 'application/json' })
    if (key) headers.set('authorization', `Bearer ${key}`)
    const response = await fetch(url, { headers, signal })
    if (!response.ok) {
      await discard(response)
      return empty
    }
    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > MAX_LISTING_BYTES) {
      await discard(response)
      return empty
    }
    if (response.body === null) return empty
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_LISTING_BYTES) {
        await reader.cancel()
        return empty
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const listing = JSON.parse(new TextDecoder().decode(bytes)) as ListingReply | null
    // The standard `data` array is the shape this gateway serves; plain rows
    // that withhold the field stay absent so restored capability facts come
    // only from the endpoint that publishes them.
    if (listing === null || typeof listing !== 'object' || !Array.isArray(listing.data))
      return empty
    const map = new Map<string, readonly string[]>()
    for (const raw of listing.data) {
      if (raw === null || typeof raw !== 'object') continue
      const entry = raw as ListingEntry
      if (typeof entry.id !== 'string' || entry.id.length === 0) continue
      const names = modalities(entry)
      if (names) map.set(entry.id, names)
    }
    return map
  } catch (error: unknown) {
    // A hung listing keeps refreshing responsive through the caller's timeout;
    // only caller cancellation escapes this containment.
    if (signal.aborted) throw error
    return empty
  }
}
