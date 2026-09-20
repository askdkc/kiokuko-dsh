import { abortable, readBoundedJson } from '../http-json.js'
import { TYPESAFE_BYTES, TYPESAFE_ENDPOINT, TypeSafeError, parseTypeSafeRequest, parseTypeSafeResponse, type TypeSafeResponse } from './contracts.js'
import type { CredentialInfo, TypeSafeCredentials } from './credentials.js'

export interface TypeSafeClient {
  status(): Promise<CredentialInfo>
  evaluate(input: unknown, signal: AbortSignal): Promise<TypeSafeResponse>
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
      const value = await readBoundedJson(response, combined, TYPESAFE_BYTES, kind => new TypeSafeError(kind === 'large' ? 'RESPONSE_TOO_LARGE' : 'MALFORMED_RESPONSE'))
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
