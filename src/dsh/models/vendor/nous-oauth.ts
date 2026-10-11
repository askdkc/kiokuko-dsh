import type { StoredOAuthCredential } from './credentials.js'
import type { AuthInteraction } from './auth-contract.js'

const PORTAL = 'https://portal.nousresearch.com'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

async function post(path: string, fields: Record<string, string>, signal: AbortSignal, headers: Record<string, string> = {}): Promise<{ response: Response; data: Record<string, unknown> }> {
  let response: Response
  try {
    response = await fetch(`${PORTAL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields),
      signal,
    })
  } catch (error: unknown) {
    if (signal.aborted) {
      if ((signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError') {
        throw new Error('dsh-auth: Nous Portal request timed out')
      }
      throw new Error('dsh-auth: Nous sign-in cancelled')
    }
    throw new Error(`dsh-auth: Nous Portal request failed: ${error instanceof Error ? error.name : 'network error'}`)
  }
  let parsed: unknown
  try { parsed = await response.json() } catch { parsed = undefined }
  return { response, data: object(parsed) ?? {} }
}

function credential(data: Record<string, unknown>): StoredOAuthCredential {
  if (typeof data.access_token !== 'string' || data.access_token.length === 0
    || typeof data.refresh_token !== 'string' || data.refresh_token.length === 0) {
    throw new Error('dsh-auth: Nous Portal returned an incomplete token response')
  }
  const ttl = Number(data.expires_in)
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('dsh-auth: Nous Portal returned an invalid token lifetime')
  return { type: 'oauth', access: data.access_token, refresh: data.refresh_token, expires: Date.now() + ttl * 1000 }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('dsh-auth: Nous sign-in cancelled')); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
    const cancel = (): void => { clearTimeout(timer); reject(new Error('dsh-auth: Nous sign-in cancelled')) }
    signal.addEventListener('abort', cancel, { once: true })
  })
}

export async function loginNous(bridge: AuthInteraction, clientId: string): Promise<StoredOAuthCredential> {
  const requestSignal = (): AbortSignal => AbortSignal.any([bridge.signal, AbortSignal.timeout(15_000)])
  const initial = await post('/api/oauth/device/code', { client_id: clientId, scope: 'inference:invoke' }, requestSignal())
  if (!initial.response.ok) throw new Error(`dsh-auth: Nous device authorization failed (HTTP ${initial.response.status})`)
  const { data } = initial
  if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string'
    || typeof data.verification_uri !== 'string' || typeof data.verification_uri_complete !== 'string') {
    throw new Error('dsh-auth: Nous Portal returned an invalid device authorization response')
  }
  const expiresIn = Number(data.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('dsh-auth: Nous Portal returned an invalid device-code lifetime')
  let interval = Number(data.interval)
  interval = Number.isFinite(interval) && interval > 0 ? Math.min(interval, 30) : 5
  const deadline = Date.now() + expiresIn * 1000
  bridge.notify({ type: 'device_code', userCode: data.user_code, verificationUri: data.verification_uri_complete })
  while (Date.now() < deadline) {
    if (bridge.signal.aborted) throw new Error('dsh-auth: Nous sign-in cancelled')
    const next = await post('/api/oauth/token', {
      grant_type: DEVICE_GRANT, client_id: clientId, device_code: data.device_code,
    }, requestSignal())
    if (next.response.ok) return credential(next.data)
    const code = next.data.error
    if (code === 'authorization_pending') { await delay(interval * 1000, bridge.signal); continue }
    if (code === 'slow_down') { interval = Math.min(interval + 1, 30); await delay(interval * 1000, bridge.signal); continue }
    if (code === 'access_denied') throw new Error('dsh-auth: Nous device authorization was denied')
    if (code === 'expired_token') throw new Error('dsh-auth: Nous device authorization expired; sign in again')
    throw new Error(`dsh-auth: Nous device authorization failed (HTTP ${next.response.status})`)
  }
  throw new Error('dsh-auth: Nous device authorization expired; sign in again')
}

/** Called only while CredentialFile.modify holds the cross-process lock. */
export async function refreshNous(current: StoredOAuthCredential, clientId: string): Promise<StoredOAuthCredential> {
  const result = await post('/api/oauth/token', { grant_type: 'refresh_token', client_id: clientId }, AbortSignal.timeout(15_000), {
    'x-nous-refresh-token': current.refresh,
  })
  if (!result.response.ok) {
    const code = result.data.error
    if (code === 'invalid_grant' || code === 'refresh_token_reused' || result.response.status === 401) {
      throw new Error('dsh-auth: Nous token expired or was revoked; run /auth login nous')
    }
    throw new Error(`dsh-auth: Nous token refresh failed (HTTP ${result.response.status})`)
  }
  return credential(result.data)
}
