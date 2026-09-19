import { TYPESAFE_BYTES, TYPESAFE_ENDPOINT, TypeSafeError, parseTypeSafeRequest, parseTypeSafeResponse, type TypeSafeResponse } from './contracts.js'
import type { CredentialInfo, TypeSafeCredentials } from './credentials.js'

export interface TypeSafeClient {
  status(): Promise<CredentialInfo>
  evaluate(input: unknown, signal: AbortSignal): Promise<TypeSafeResponse>
}
/** Race even injected transports/providers that ignore abort; discard their late result. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); signal.throwIfAborted() }
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}
async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > TYPESAFE_BYTES) { void response.body?.cancel().catch(() => {}); throw new TypeSafeError('RESPONSE_TOO_LARGE') }
  if (!response.body) throw new TypeSafeError('MALFORMED_RESPONSE')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0, complete = false
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) { complete = true; break }
      bytes += chunk.value.byteLength
      if (bytes > TYPESAFE_BYTES) throw new TypeSafeError('RESPONSE_TOO_LARGE')
      chunks.push(chunk.value)
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw new TypeSafeError('MALFORMED_RESPONSE') }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock() }
}
/** Fixed endpoint, native fetch, no redirects/retries, and no worker-visible credentials. */
export class HttpTypeSafeClient implements TypeSafeClient {
  constructor(private readonly credentials: TypeSafeCredentials, private readonly request: typeof fetch = fetch) {}
  status(): Promise<CredentialInfo> { return this.credentials.status() }
  async evaluate(input: unknown, signal: AbortSignal): Promise<TypeSafeResponse> {
    const parsed = parseTypeSafeRequest(input)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), parsed.request.timeoutMs)
    const combined = AbortSignal.any([signal, timeout.signal])
    try {
      combined.throwIfAborted()
      const key = await abortable(this.credentials.resolve(), combined)
      combined.throwIfAborted()
      const pending = this.request(TYPESAFE_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: parsed.body, signal: combined, redirect: 'error' })
      void pending.then(response => { if (combined.aborted) void response.body?.cancel().catch(() => {}) }, () => {})
      const response = await abortable(pending, combined)
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new TypeSafeError(response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMIT' : response.status === 422 ? 'INVALID_REQUEST' : 'UNAVAILABLE')
      }
      const value = await readResponse(response, combined)
      combined.throwIfAborted()
      if (JSON.stringify(value).includes(key)) throw new TypeSafeError('MALFORMED_RESPONSE')
      return parseTypeSafeResponse(value, parsed.request)
    } catch (error) {
      if (signal.aborted) throw new TypeSafeError('CANCELLED')
      if (timeout.signal.aborted) throw new TypeSafeError('TIMEOUT')
      throw error instanceof TypeSafeError ? error : new TypeSafeError('UNAVAILABLE')
    } finally { clearTimeout(timer) }
  }
}
