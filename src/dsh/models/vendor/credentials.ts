/**
 * Auth-owned credential persistence, structurally compatible with pi stores, over
 * one JSON document, one credential per provider id.
 *
 * Writes are atomic (temp file + rename) with 0700 directory / 0600 file
 * permissions best-effort on every platform. All mutations go through
 * {@link CredentialFile.modify}, which serializes read-modify-write cycles
 * across processes — pi-ai runs its OAuth refresh *inside* `modify`, so the
 * exclusion keeps concurrent requests from double-refreshing a rotated
 * token. The file is the single source of truth;
 * nothing here ever logs token material, and {@link CredentialFile.describe}
 * reports only non-secret metadata for status surfaces.
 *
 * @module dsh-auth/credentials
 */

import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { StoredCredential, CredentialInfo } from './auth-contract.js'
export type { StoredOAuthCredential, StoredApiKeyCredential } from './auth-contract.js'

/** On-disk document shape. */
interface CredentialsDocument {
  version: 1
  providers: Record<string, StoredCredential>
}

/** Narrow an unknown parsed value into a stored credential, or reject it. */
export function asStoredCredential(value: unknown): StoredCredential | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record['type'] === 'api_key') {
    return typeof record['key'] === 'string' && record['key'].length > 0
      ? value as Extract<StoredCredential, { type: 'api_key' }>
      : undefined
  }
  if (record['type'] !== 'oauth') return undefined
  if (typeof record['access'] !== 'string' || typeof record['refresh'] !== 'string') return undefined
  if (typeof record['expires'] !== 'number' || !Number.isFinite(record['expires'])) return undefined
  return value as Extract<StoredCredential, { type: 'oauth' }>
}

/** Default credential file location: `$DSH_HOME/dsh-auth/credentials.json` (or `~/.dsh/…`). */
export function defaultCredentialsFile(): string {
  const override = process.env['DSH_AUTH_CREDENTIALS']
  if (override !== undefined && override !== '') return override
  const root = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(root, 'dsh-auth', 'credentials.json')
}

const EMPTY_DOCUMENT: CredentialsDocument = { version: 1, providers: {} }

/**
 * The credential file. IO failures throw (loud, naming the path) rather than
 * degrading to an empty store: silently treating a corrupt or unreadable
 * credential file as "signed out everywhere" would strand every route behind
 * a fresh login for no reason.
 */
export class CredentialFile {
  readonly path: string
  /** Serialize all updates in this process; the file lock covers other processes. */
  private chainTail: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  /** The stored credential for one provider, possibly expired. */
  async read(providerId: string): Promise<StoredCredential | undefined> {
    return (await this.load()).providers[providerId]
  }

  /** Stored credential metadata without resolving or exposing secrets. */
  async list(): Promise<readonly CredentialInfo[]> {
    const document = await this.load()
    return Object.entries(document.providers).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }))
  }

  /**
   * Serialized read-modify-write for one provider. `fn` sees the current
   * credential; returning a new credential persists it, returning
   * `undefined` leaves the entry unchanged. Resolves with the post-write
   * credential. Rejections from `fn` propagate without touching the file.
   */
  async modify(
    providerId: string,
    fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
  ): Promise<StoredCredential | undefined> {
    return this.withLock(async () => {
      const document = await this.load()
      const current = document.providers[providerId]
      const replacement = await fn(current)
      if (replacement === undefined || replacement === current) return current
      if (asStoredCredential(replacement) === undefined) {
        throw new Error(`dsh-auth: refusing to store an invalid credential for "${providerId}"`)
      }
      await this.save({ ...document, providers: { ...document.providers, [providerId]: replacement } })
      return replacement
    })
  }

  /** Remove one provider's credential (logout). */
  async delete(providerId: string): Promise<void> {
    await this.withLock(async () => {
      const document = await this.load()
      if (!(providerId in document.providers)) return
      const providers = { ...document.providers }
      delete providers[providerId]
      await this.save({ ...document, providers })
    })
  }

  /** Non-secret metadata for every stored credential, for status surfaces. */
  async describe(): Promise<readonly { provider: string; credentialKind: 'oauth-token' | 'api-key'; expiresAt: number | undefined; expired: boolean }[]> {
    const document = await this.load()
    const now = Date.now()
    return Object.entries(document.providers).map(([provider, credential]) => {
      const expiresAt = credential.type === 'oauth' && provider !== 'openrouter'
        && credential.expires < 8_640_000_000_000_000
        ? credential.expires
        : undefined
      return {
        provider,
        credentialKind: credential.type === 'api_key' || provider === 'openrouter' ? 'api-key' as const : 'oauth-token' as const,
        expiresAt,
        expired: expiresAt !== undefined && expiresAt <= now,
      }
    })
  }

  /** Hold a process-wide lock through reread, refresh/mutation, and atomic save. */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.chainTail
    let releaseLocal!: () => void
    this.chainTail = new Promise<void>(resolve => { releaseLocal = resolve })
    await previous
    const lockPath = `${this.path}.lock`
    const deadline = Date.now() + 120_000
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      while (true) {
        try {
          mkdirSync(lockPath, { mode: 0o700 })
          break
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error
          if (Date.now() >= deadline) {
            throw new Error(`dsh-auth: timed out waiting for credential file lock ${lockPath}`)
          }
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      try {
        return await operation()
      } finally {
        rmdirSync(lockPath)
      }
    } finally {
      releaseLocal()
    }
  }

  private async load(): Promise<CredentialsDocument> {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        return EMPTY_DOCUMENT
      }
      throw new Error(`dsh-auth: cannot read credential file ${this.path}: ${String(error)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error: unknown) {
      throw new Error(
        `dsh-auth: credential file ${this.path} is not valid JSON ; `
        + 'fix or remove the file by hand — it will not be overwritten silently',
      )
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`dsh-auth: credential file ${this.path} has an unexpected shape; fix or remove it by hand`)
    }
    const record = parsed as Record<string, unknown>
    if (record['version'] !== 1 || typeof record['providers'] !== 'object'
      || record['providers'] === null || Array.isArray(record['providers'])) {
      throw new Error(`dsh-auth: credential file ${this.path} has an unexpected shape; fix or remove it by hand`)
    }
    const providers: Record<string, StoredCredential> = Object.create(null)
    for (const [provider, value] of Object.entries(record['providers'] as Record<string, unknown>)) {
      const credential = asStoredCredential(value)
      if (credential === undefined) {
        throw new Error(
          `dsh-auth: credential file ${this.path} holds an invalid entry for "${provider}"; fix or remove it by hand`,
        )
      }
      providers[provider] = credential
    }
    return { version: 1, providers }
  }

  private async save(document: CredentialsDocument): Promise<void> {
    const text = JSON.stringify(document, null, 2) + '\n'
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${Math.random().toString(36).slice(2)}.tmp`)
    try {
      writeFileSync(temporary, text, { mode: 0o600 })
      renameSync(temporary, this.path)
    } catch (error: unknown) {
      throw new Error(`dsh-auth: cannot write credential file ${this.path}: ${String(error)}`)
    }
  }
}
