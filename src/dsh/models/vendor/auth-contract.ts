/** Auth-owned persistence and interaction contracts; pi routes adapt structurally. */
export interface StoredOAuthCredential { type: 'oauth'; access: string; refresh: string; expires: number; [key: string]: unknown }
export interface StoredApiKeyCredential { type: 'api_key'; key?: string; env?: Record<string, string> }
export type StoredCredential = StoredOAuthCredential | StoredApiKeyCredential
export interface CredentialInfo { providerId: string; type: StoredCredential['type'] }
export interface AuthInteraction {
  signal: AbortSignal
  prompt(prompt: AuthPrompt): Promise<string>
  notify(event: AuthEvent): void
}
export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: 'text' | 'secret' | 'manual_code'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: readonly { id: string; label: string; description?: string }[] }
)
export type AuthEvent =
  | { type: 'info'; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'progress'; message: string }
export interface OAuthFlow {
  name: string; loginLabel?: string
  login(interaction: AuthInteraction, options?: { getDeviceId?: () => string }): Promise<StoredOAuthCredential>
}
