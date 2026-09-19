import { TypeSafeError } from './contracts.js'

export const TYPESAFE_CREDENTIAL = 'TYPESAFE_API_KEY'
export interface CredentialInfo { configured: boolean; source?: string; writable: boolean }
/** Optional DSH seam; no credential file or provider implementation belongs to Kiokuko. */
export interface TypeSafeCredentialProvider {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
  describe(ref: string): Promise<CredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}
export function validTypeSafeKey(value: string): boolean { return value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value) && !/["'`\\]/.test(value) }
export class TypeSafeCredentials {
  constructor(private readonly provider: () => TypeSafeCredentialProvider | undefined,
    private readonly environment: () => string | undefined = () => process.env[TYPESAFE_CREDENTIAL]) {}
  async resolve(): Promise<string> {
    let value: string | undefined
    try { const provider = this.provider(); value = provider ? (await provider.resolve(TYPESAFE_CREDENTIAL))?.value : this.environment() }
    catch { throw new TypeSafeError('CREDENTIAL_UNAVAILABLE') }
    if (!value) throw new TypeSafeError('MISSING_CREDENTIAL')
    if (!validTypeSafeKey(value)) throw new TypeSafeError('INVALID_KEY')
    return value
  }
  async status(): Promise<CredentialInfo> {
    try {
      const provider = this.provider()
      if (!provider) return { configured: Boolean(this.environment()), ...(this.environment() ? { source: 'env' } : {}), writable: false }
      const info = await provider.describe(TYPESAFE_CREDENTIAL)
      // Provider metadata is display-only. Unknown source names never become diagnostic text.
      const source = ['env', 'file', 'project-env', 'user-env'].includes(info.source ?? '') ? info.source : info.source ? 'provider' : undefined
      return { configured: info.configured === true, writable: info.writable === true, ...(source ? { source } : {}) }
    } catch { throw new TypeSafeError('CREDENTIAL_UNAVAILABLE') }
  }
  async change(value: string | undefined, signal: AbortSignal): Promise<void> {
    if (value !== undefined && !validTypeSafeKey(value)) throw new TypeSafeError('INVALID_KEY')
    const provider = this.provider()
    if (!provider) throw new TypeSafeError('STORAGE_UNAVAILABLE')
    try {
      if (!(await provider.describe(TYPESAFE_CREDENTIAL)).writable) throw new TypeSafeError('READ_ONLY')
      if (signal.aborted) throw new TypeSafeError('CANCELLED')
      if (value === undefined) await provider.unset(TYPESAFE_CREDENTIAL)
      else await provider.set(TYPESAFE_CREDENTIAL, value)
    } catch (error) { throw error instanceof TypeSafeError ? error : new TypeSafeError('STORAGE_FAILED') }
  }
}
