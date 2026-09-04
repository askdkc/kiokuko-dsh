import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SqliteDatabase } from '../db/adapter.js'
import { openConnection } from '../db/connection.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { KiokukoError } from '../errors.js'
import { getDshSessionCachePath, type DshPathEnvironment } from './paths.js'
import type { DshLogEvent, DshSessionEventSource, DshSessionLogSnapshot, DshSessionQuery } from './session-memory-finalizer.js'
import type { DshRuntime } from './runtime.js'
import type { DshPromptCacheLayout } from './prompt-cache.js'

export type DshSessionCacheHealth = 'healthy' | 'catching_up' | 'degraded' | 'blocked_legacy' | 'archive_unsafe'

export interface DshMirrorCheckpoint {
  readonly sessionId: string
  readonly observedThrough: number
  readonly mirroredThrough: number
  readonly nativeDurableThrough: number
  readonly confirmedThrough: number
  readonly health: DshSessionCacheHealth
  readonly error?: { readonly code: string; readonly message: string }
}

export interface DshMirrorEventSession extends DshSessionEventSource {
  readonly id: string
  readonly header?: { readonly createdAt?: number; readonly cwd?: string }
}

export interface DshSessionLogMirrorOptions extends DshPathEnvironment {
  readonly runtime: Pick<DshRuntime, 'withDatabase'>
  readonly databasePath?: string
  readonly attachmentDirectory?: string
  readonly readAttachment?: (ref: DshImageAttachmentRef, signal?: AbortSignal) => Promise<{
    readonly ref: DshImageAttachmentRef
    readonly data: Uint8Array
  }>
  readonly now?: () => string
  readonly openDatabase?: (path: string) => SqliteDatabase
}

export interface DshImageAttachmentRef {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

export interface DshMirroredAttachment {
  readonly attachmentId: string
  readonly mediaType: DshImageAttachmentRef['mediaType']
  readonly byteCount: number
  readonly digest: string
  readonly name?: string
  readonly archivePath: string
  readonly source: AsyncIterable<Uint8Array>
}

export interface DshSessionExportInspection {
  readonly eventBytes: number
  readonly attachmentBytes: number
  readonly attachmentCount: number
  readonly unresolvedAttachmentCount: number
}

interface WatermarkRow extends Record<string, unknown> {
  observedThrough: number
  mirroredThrough: number
  nativeDurableThrough: number
  health: DshSessionCacheHealth
  lastErrorCode: string | null
  lastErrorMessage: string | null
}

interface EventRow extends Record<string, unknown> {
  seq: number
  eventJson: string
}

interface AttachmentRow extends Record<string, unknown> {
  attachmentId: string
  digest: string
  byteCount: number
  relativePath: string
  mediaType: DshImageAttachmentRef['mediaType']
  displayName: string | null
}

const CACHE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS session_events (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 0),
    event_json TEXT NOT NULL,
    byte_count INTEGER NOT NULL CHECK (byte_count >= 2),
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_session_events_order ON session_events(session_id, seq);
  CREATE TABLE IF NOT EXISTS session_attachments (
    session_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (length(digest) = 64),
    byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
    relative_path TEXT,
    ref_json TEXT NOT NULL,
    media_type TEXT NOT NULL,
    display_name TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'stored', 'failed')),
    last_error TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, attachment_id)
  );
  CREATE TABLE IF NOT EXISTS session_watermarks (
    session_id TEXT PRIMARY KEY,
    observed_through INTEGER NOT NULL DEFAULT -1 CHECK (observed_through >= -1),
    mirrored_through INTEGER NOT NULL DEFAULT -1 CHECK (mirrored_through >= -1),
    native_durable_through INTEGER NOT NULL DEFAULT -1 CHECK (native_durable_through >= -1),
    health TEXT NOT NULL CHECK (health IN ('healthy', 'catching_up', 'degraded', 'blocked_legacy', 'archive_unsafe')),
    last_error_code TEXT,
    last_error_message TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_retention (
    session_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('active', 'waiting_user', 'unfinalized', 'finalized')),
    last_accessed_at TEXT NOT NULL,
    expires_at TEXT,
    byte_count INTEGER NOT NULL DEFAULT 0 CHECK (byte_count >= 0)
  );
  CREATE TABLE IF NOT EXISTS prompt_fragments (
    cache_key TEXT PRIMARY KEY CHECK (length(cache_key) = 64),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning TEXT,
    tool_schema_digest TEXT NOT NULL CHECK (length(tool_schema_digest) = 64),
    memory_revision TEXT NOT NULL,
    phase TEXT NOT NULL,
    fragment_json TEXT NOT NULL,
    byte_count INTEGER NOT NULL CHECK (byte_count >= 2),
    last_accessed_at TEXT NOT NULL
  );
`

const RETENTION_TTL_MS = 30 * 24 * 60 * 60_000
const RETENTION_MAX_BYTES = 4 * 1024 * 1024 * 1024

function validSessionId(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', 'mirror session identity is invalid')
  }
  return value
}

function validEvent(event: DshLogEvent): DshLogEvent {
  if (typeof event !== 'object' || event === null
    || typeof event.type !== 'string' || event.type.length === 0
    || !Number.isSafeInteger(event.seq) || event.seq < 0
    || !Number.isFinite(event.time)) {
    throw new KiokukoError('VALIDATION_ERROR', 'DSH mirror event is invalid')
  }
  return event
}

const IMAGE_MEDIA_TYPES = new Set<DshImageAttachmentRef['mediaType']>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function imageAttachmentRef(value: unknown): DshImageAttachmentRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.attachmentId !== 'string' || input.attachmentId.length === 0 || input.attachmentId.length > 512) return undefined
  if (typeof input.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(input.mediaType as DshImageAttachmentRef['mediaType'])) return undefined
  if (!Number.isSafeInteger(input.bytes) || (input.bytes as number) < 0) return undefined
  if (!Number.isSafeInteger(input.width) || (input.width as number) < 1) return undefined
  if (!Number.isSafeInteger(input.height) || (input.height as number) < 1) return undefined
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 512 || /[\p{Cc}\p{Cf}]/u.test(input.name))) return undefined
  return Object.freeze({
    attachmentId: input.attachmentId,
    mediaType: input.mediaType as DshImageAttachmentRef['mediaType'],
    bytes: input.bytes as number,
    width: input.width as number,
    height: input.height as number,
    ...(input.name === undefined ? {} : { name: input.name as string }),
  })
}

/** Find durable attachment refs without interpreting any DSH message shape. */
export function dshEventAttachmentRefs(event: DshLogEvent): readonly DshImageAttachmentRef[] {
  const found = new Map<string, DshImageAttachmentRef>()
  const pending: unknown[] = [event.data]
  const visited = new Set<object>()
  let inspected = 0
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null) continue
    if (visited.has(value)) continue
    visited.add(value)
    inspected += 1
    if (inspected > 100_000) throw new KiokukoError('VALIDATION_ERROR', 'DSH event attachment graph is unreasonably large')
    const ref = imageAttachmentRef(value)
    if (ref !== undefined) {
      const existing = found.get(ref.attachmentId)
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(ref)) {
        throw new KiokukoError('INTEGRITY_ERROR', 'DSH attachment identity was reused with different metadata')
      }
      found.set(ref.attachmentId, ref)
    }
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child)
    } else {
      for (const child of Object.values(value as Record<string, unknown>)) pending.push(child)
    }
  }
  return Object.freeze([...found.values()])
}

function boundedError(error: unknown): { code: string; message: string } {
  const object = typeof error === 'object' && error !== null ? error as { code?: unknown } : undefined
  const code = typeof object?.code === 'string' ? object.code.slice(0, 128) : 'SESSION_CACHE_DEGRADED'
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
  return { code, message }
}

function initialCheckpoint(sessionId: string, error?: { code: string; message: string }): DshMirrorCheckpoint {
  return Object.freeze({
    sessionId,
    observedThrough: -1,
    mirroredThrough: -1,
    nativeDurableThrough: -1,
    confirmedThrough: -1,
    health: 'degraded',
    ...(error === undefined ? {} : { error }),
  })
}

/** Advance only across a gap-free prefix. Each row is crossed at most once. */
function contiguousMirroredThrough(database: SqliteDatabase, sessionId: string, current: number): number {
  const next = database.prepare(`
    SELECT seq FROM session_events WHERE session_id = ? AND seq = ?
  `)
  let mirrored = current
  while (next.get<{ seq: number }>(sessionId, mirrored + 1) !== undefined) mirrored += 1
  return mirrored
}

/**
 * Full event cache whose failures are strictly non-vetoing. DSH remains the
 * source of truth; this database exists to make export and post-archive
 * finalization bounded and local.
 */
export class DshSessionLogMirror implements DshSessionQuery {
  readonly #runtime: DshSessionLogMirrorOptions['runtime']
  readonly #databasePath: string
  readonly #attachmentDirectory: string
  readonly #readAttachment: DshSessionLogMirrorOptions['readAttachment']
  readonly #now: () => string
  readonly #openDatabase: (path: string) => SqliteDatabase
  #database: SqliteDatabase | undefined
  #startPromise: Promise<void> | undefined
  #closed = false
  #tail: Promise<void> = Promise.resolve()
  #lastError: unknown

  constructor(options: DshSessionLogMirrorOptions) {
    this.#runtime = options.runtime
    this.#databasePath = options.databasePath ?? getDshSessionCachePath(options)
    this.#attachmentDirectory = options.attachmentDirectory ?? `${this.#databasePath}.attachments`
    this.#readAttachment = options.readAttachment
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#openDatabase = options.openDatabase ?? openConnection
  }

  get databasePath(): string { return this.#databasePath }
  get lastError(): unknown { return this.#lastError }

  async checkpoint(sessionIdValue: string): Promise<DshMirrorCheckpoint> {
    const sessionId = validSessionId(sessionIdValue)
    await this.start()
    await this.#tail
    return this.#checkpoint(sessionId, this.#database === undefined ? boundedError(this.#lastError ?? new Error('session cache database is unavailable')) : undefined)
  }

  /** Best-effort local reconstruction cache; never a provider-response cache. */
  async cachePromptLayout(layout: DshPromptCacheLayout): Promise<boolean> {
    await this.start()
    const database = this.#database
    if (database === undefined) return false
    try {
      database.prepare(`
        INSERT INTO prompt_fragments (
          cache_key, provider, model, reasoning, tool_schema_digest,
          memory_revision, phase, fragment_json, byte_count, last_accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          last_accessed_at = excluded.last_accessed_at
      `).run(
        layout.cacheKey, layout.provider, layout.model, layout.reasoning,
        layout.toolSchemaDigest, layout.memoryRevision, layout.phase,
        layout.fragmentJson, layout.byteCount, this.#now(),
      )
      return true
    } catch (error) {
      this.#lastError = error
      return false
    }
  }

  /** Cache startup is best-effort and can never fail plugin composition. */
  async start(): Promise<void> {
    if (this.#closed || this.#database !== undefined) return
    if (this.#startPromise !== undefined) return this.#startPromise
    this.#startPromise = (async () => {
      let opened: SqliteDatabase | undefined
      try {
        await mkdir(this.#attachmentDirectory, { recursive: true, mode: 0o700 })
        if (this.#closed) return
        opened = this.#openDatabase(this.#databasePath)
        opened.exec(CACHE_SCHEMA)
        const attachmentColumns = new Set(opened.prepare('PRAGMA table_info(session_attachments)')
          .all<{ name: string }>().map(column => column.name))
        if (!attachmentColumns.has('ref_json')) opened.exec(`ALTER TABLE session_attachments ADD COLUMN ref_json TEXT NOT NULL DEFAULT '{}'`)
        if (!attachmentColumns.has('media_type')) opened.exec(`ALTER TABLE session_attachments ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image/png'`)
        if (!attachmentColumns.has('display_name')) opened.exec('ALTER TABLE session_attachments ADD COLUMN display_name TEXT')
        if (!attachmentColumns.has('state')) opened.exec(`ALTER TABLE session_attachments ADD COLUMN state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'stored', 'failed'))`)
        if (!attachmentColumns.has('last_error')) opened.exec('ALTER TABLE session_attachments ADD COLUMN last_error TEXT')
        this.#database = opened
        opened = undefined
        this.#lastError = undefined
      } catch (error) {
        this.#lastError = error
        try { opened?.close() } catch { /* preserve the initialization failure */ }
      } finally {
        // A failed attempt is retryable on the next event/checkpoint. A
        // successful attempt is represented by #database, not this promise.
        this.#startPromise = undefined
      }
    })()
    return this.#startPromise
  }

  async #writeCoreHealth(checkpoint: DshMirrorCheckpoint): Promise<void> {
    try {
      await this.#runtime.withDatabase((database) => withImmediateTransaction(database, () => {
        database.prepare(`
          INSERT INTO dsh_session_cache_health (
            dsh_session_id, observed_through, mirrored_through,
            native_durable_through, health, last_error_code,
            last_error_message, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(dsh_session_id) DO UPDATE SET
            observed_through = max(observed_through, excluded.observed_through),
            mirrored_through = max(mirrored_through, excluded.mirrored_through),
            native_durable_through = max(native_durable_through, excluded.native_durable_through),
            health = excluded.health,
            last_error_code = excluded.last_error_code,
            last_error_message = excluded.last_error_message,
            updated_at = excluded.updated_at
        `).run(
          checkpoint.sessionId,
          checkpoint.observedThrough,
          checkpoint.mirroredThrough,
          checkpoint.nativeDurableThrough,
          checkpoint.health,
          checkpoint.error?.code ?? null,
          checkpoint.error?.message ?? null,
          this.#now(),
        )
      }))
    } catch {
      // Health reporting is itself non-vetoing.
    }
  }

  #readWatermark(sessionId: string): WatermarkRow | undefined {
    return this.#database?.prepare(`
      SELECT observed_through AS observedThrough, mirrored_through AS mirroredThrough,
             native_durable_through AS nativeDurableThrough, health,
             last_error_code AS lastErrorCode, last_error_message AS lastErrorMessage
        FROM session_watermarks WHERE session_id = ?
    `).get<WatermarkRow>(sessionId)
  }

  #checkpoint(sessionId: string, overrideError?: { code: string; message: string }): DshMirrorCheckpoint {
    const row = this.#readWatermark(sessionId)
    if (row === undefined) return initialCheckpoint(sessionId, overrideError)
    const attachmentState = this.#database?.prepare(`
      SELECT
        sum(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
        sum(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM session_attachments WHERE session_id = ?
    `).get<{ pending: number | null; failed: number | null }>(sessionId)
    const error = overrideError ?? (row.lastErrorCode === null
      ? undefined
      : { code: row.lastErrorCode, message: row.lastErrorMessage ?? row.lastErrorCode })
    const failedAttachments = attachmentState?.failed ?? 0
    const pendingAttachments = attachmentState?.pending ?? 0
    const attachmentError = failedAttachments > 0
      ? { code: 'ATTACHMENT_CACHE_FAILED', message: `${failedAttachments} session attachment(s) could not be mirrored` }
      : undefined
    return Object.freeze({
      sessionId,
      observedThrough: row.observedThrough,
      mirroredThrough: row.mirroredThrough,
      nativeDurableThrough: row.nativeDurableThrough,
      confirmedThrough: Math.min(row.mirroredThrough, row.nativeDurableThrough),
      health: error !== undefined || attachmentError !== undefined
        ? 'degraded'
        : pendingAttachments > 0
          ? 'catching_up'
          : row.health,
      ...(error === undefined && attachmentError === undefined ? {} : { error: error ?? attachmentError! }),
    })
  }

  async #degrade(sessionId: string, error: unknown, observedThrough = -1): Promise<DshMirrorCheckpoint> {
    this.#lastError = error
    const bounded = boundedError(error)
    let checkpoint = initialCheckpoint(sessionId, bounded)
    const database = this.#database
    if (database !== undefined) {
      try {
        const now = this.#now()
        database.prepare(`
          INSERT INTO session_watermarks (
            session_id, observed_through, mirrored_through, native_durable_through,
            health, last_error_code, last_error_message, updated_at
          ) VALUES (?, ?, -1, -1, 'degraded', ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            observed_through = max(observed_through, excluded.observed_through),
            health = 'degraded', last_error_code = excluded.last_error_code,
            last_error_message = excluded.last_error_message, updated_at = excluded.updated_at
        `).run(sessionId, observedThrough, bounded.code, bounded.message, now)
        checkpoint = this.#checkpoint(sessionId, bounded)
      } catch {
        // Return the in-memory degradation result.
      }
    }
    await this.#writeCoreHealth(checkpoint)
    return checkpoint
  }

  /** Rebuild only a corrupt derived session; DSH remains the authority. */
  async #resetCorruptSession(sessionId: string): Promise<void> {
    const database = this.#database
    if (database === undefined) return
    const directory = join(this.#attachmentDirectory, createHash('sha256').update(sessionId).digest('hex'))
    await rm(directory, { recursive: true, force: true })
    withImmediateTransaction(database, () => {
      database.prepare('DELETE FROM session_events WHERE session_id = ?').run(sessionId)
      database.prepare('DELETE FROM session_attachments WHERE session_id = ?').run(sessionId)
      database.prepare('DELETE FROM session_watermarks WHERE session_id = ?').run(sessionId)
      database.prepare(`
        UPDATE session_retention
           SET state = 'active', byte_count = 0, expires_at = NULL,
               last_accessed_at = ?
         WHERE session_id = ?
      `).run(this.#now(), sessionId)
    })
  }

  /** Queue one event; callers receive health, never a thrown cache error. */
  async observe(sessionIdValue: string, rawEvent: DshLogEvent): Promise<DshMirrorCheckpoint> {
    let sessionId: string
    let event: DshLogEvent
    try {
      sessionId = validSessionId(sessionIdValue)
      event = validEvent(rawEvent)
    } catch (error) {
      return this.#degrade(String(sessionIdValue).slice(0, 256) || 'invalid-session', error)
    }
    await this.start()
    let result = this.#checkpoint(sessionId)
    const operation = this.#tail.then(async () => {
      const database = this.#database
      if (database === undefined) {
        result = await this.#degrade(sessionId, this.#lastError ?? new Error('session cache database is unavailable'), event.seq)
        return
      }
      try {
        const eventJson = JSON.stringify(event)
        if (eventJson === undefined) throw new KiokukoError('VALIDATION_ERROR', 'DSH event is not JSON serializable')
        const bytes = Buffer.byteLength(eventJson, 'utf8')
        const eventDigest = createHash('sha256').update(eventJson).digest('hex')
        const attachmentRefs = dshEventAttachmentRefs(event)
        const now = this.#now()
        withImmediateTransaction(database, () => {
          const existing = database.prepare(`
            SELECT digest FROM session_events WHERE session_id = ? AND seq = ?
          `).get<{ digest: string }>(sessionId, event.seq)
          if (existing !== undefined && existing.digest !== eventDigest) {
            throw new KiokukoError('INTEGRITY_ERROR', 'DSH event sequence was reused with different content')
          }
          if (existing === undefined) {
            database.prepare(`
              INSERT INTO session_events (session_id, seq, event_json, byte_count, digest, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(sessionId, event.seq, eventJson, bytes, eventDigest, now)
          }
          for (const ref of attachmentRefs) {
            const refJson = JSON.stringify(ref)
            const prior = database.prepare(`
              SELECT ref_json AS refJson FROM session_attachments
               WHERE session_id = ? AND attachment_id = ?
            `).get<{ refJson: string }>(sessionId, ref.attachmentId)
            if (prior !== undefined && prior.refJson !== refJson) {
              throw new KiokukoError('INTEGRITY_ERROR', 'DSH attachment identity was reused with different metadata')
            }
            if (prior === undefined) {
              database.prepare(`
                INSERT INTO session_attachments (
                  session_id, attachment_id, digest, byte_count, relative_path,
                  ref_json, media_type, display_name, state, last_error, created_at
                ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'pending', NULL, ?)
              `).run(sessionId, ref.attachmentId, '0'.repeat(64), ref.bytes, refJson, ref.mediaType, ref.name ?? null, now)
            }
          }
          database.prepare(`
            INSERT INTO session_watermarks (
              session_id, observed_through, mirrored_through, native_durable_through,
              health, last_error_code, last_error_message, updated_at
            ) VALUES (?, ?, -1, -1, 'catching_up', NULL, NULL, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              observed_through = max(observed_through, excluded.observed_through),
              updated_at = excluded.updated_at
          `).run(sessionId, event.seq, now)
          const watermark = database.prepare(`
            SELECT mirrored_through AS mirroredThrough, native_durable_through AS nativeDurableThrough
              FROM session_watermarks WHERE session_id = ?
          `).get<{ mirroredThrough: number; nativeDurableThrough: number }>(sessionId)
          if (watermark === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'DSH mirror watermark disappeared')
          const mirroredThrough = contiguousMirroredThrough(database, sessionId, watermark.mirroredThrough)
          database.prepare(`
            UPDATE session_watermarks
               SET mirrored_through = ?,
                   health = CASE WHEN native_durable_through >= 0 AND ? >= native_durable_through
                                 THEN 'healthy' ELSE 'catching_up' END,
                   last_error_code = NULL, last_error_message = NULL, updated_at = ?
             WHERE session_id = ?
          `).run(mirroredThrough, mirroredThrough, now, sessionId)
          database.prepare(`
            INSERT INTO session_retention (session_id, state, last_accessed_at, expires_at, byte_count)
            VALUES (?, 'active', ?, NULL, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              state = 'active', last_accessed_at = excluded.last_accessed_at,
              byte_count = byte_count + CASE WHEN ? THEN 0 ELSE ? END
          `).run(sessionId, now, bytes, existing === undefined ? 0 : 1, bytes)
        })
        result = this.#checkpoint(sessionId)
        await this.#mirrorPendingAttachments(sessionId, attachmentRefs)
        result = this.#checkpoint(sessionId)
        await this.#writeCoreHealth(result)
      } catch (error) {
        result = await this.#degrade(sessionId, error, event.seq)
      }
    })
    this.#tail = operation.then(() => undefined, () => undefined)
    await operation
    return result
  }

  async #mirrorPendingAttachments(sessionId: string, refs: readonly DshImageAttachmentRef[]): Promise<void> {
    if (refs.length === 0) return
    const database = this.#database
    if (database === undefined) return
    for (const ref of refs) {
      const state = database.prepare(`
        SELECT state FROM session_attachments WHERE session_id = ? AND attachment_id = ?
      `).get<{ state: string }>(sessionId, ref.attachmentId)?.state
      if (state === 'stored') continue
      if (this.#readAttachment === undefined) {
        database.prepare(`
          UPDATE session_attachments SET state = 'failed', last_error = ?
           WHERE session_id = ? AND attachment_id = ?
        `).run('DSH attachment service is unavailable', sessionId, ref.attachmentId)
        continue
      }
      try {
        const stored = await this.#readAttachment(ref)
        const storedRef = imageAttachmentRef(stored.ref)
        if (!(stored.data instanceof Uint8Array) || stored.data.byteLength !== ref.bytes
          || storedRef === undefined || JSON.stringify(storedRef) !== JSON.stringify(ref)) {
          throw new KiokukoError('INTEGRITY_ERROR', 'DSH attachment verified read did not match its durable reference')
        }
        const digest = createHash('sha256').update(stored.data).digest('hex')
        const sessionDirectory = createHash('sha256').update(sessionId).digest('hex')
        const relativePath = join(sessionDirectory, digest)
        const absolutePath = join(this.#attachmentDirectory, relativePath)
        await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 })
        const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`
        await writeFile(temporaryPath, stored.data, { mode: 0o600, flag: 'wx' })
        try {
          await rename(temporaryPath, absolutePath)
        } catch (error) {
          await rm(temporaryPath, { force: true })
          const existing = await stat(absolutePath).catch(() => undefined)
          if (existing?.isFile() !== true || existing.size !== stored.data.byteLength) throw error
        }
        withImmediateTransaction(database, () => {
          const wasStored = database.prepare(`
            SELECT state FROM session_attachments WHERE session_id = ? AND attachment_id = ?
          `).get<{ state: string }>(sessionId, ref.attachmentId)?.state === 'stored'
          database.prepare(`
            UPDATE session_attachments SET digest = ?, relative_path = ?, state = 'stored', last_error = NULL
             WHERE session_id = ? AND attachment_id = ?
          `).run(digest, relativePath, sessionId, ref.attachmentId)
          if (!wasStored) database.prepare(`
            UPDATE session_retention SET byte_count = byte_count + ? WHERE session_id = ?
          `).run(stored.data.byteLength, sessionId)
        })
      } catch (error) {
        const failure = boundedError(error)
        database.prepare(`
          UPDATE session_attachments SET state = 'failed', last_error = ?
           WHERE session_id = ? AND attachment_id = ?
        `).run(failure.message, sessionId, ref.attachmentId)
      }
    }
  }

  /** Called only after the caller's native sessions.flush() has succeeded. */
  async checkpointAfterNativeFlush(session: DshMirrorEventSession): Promise<DshMirrorCheckpoint> {
    const sessionId = validSessionId(session.id)
    await this.start()
    let maximum = -1
    try {
      if (this.#readWatermark(sessionId)?.lastErrorCode === 'INTEGRITY_ERROR') {
        await this.#resetCorruptSession(sessionId)
      }
      for (const event of session.snapshotEvents()) {
        maximum = Math.max(maximum, event.seq)
        await this.observe(sessionId, event)
      }
      await this.#tail
      const database = this.#database
      if (database === undefined) return this.#degrade(sessionId, this.#lastError ?? new Error('session cache database is unavailable'), maximum)
      const now = this.#now()
      withImmediateTransaction(database, () => {
        database.prepare(`
          INSERT INTO session_watermarks (
            session_id, observed_through, mirrored_through, native_durable_through,
            health, last_error_code, last_error_message, updated_at
          ) VALUES (?, ?, -1, ?, 'catching_up', NULL, NULL, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            observed_through = max(observed_through, excluded.observed_through),
            native_durable_through = max(native_durable_through, excluded.native_durable_through),
            health = CASE WHEN max(native_durable_through, excluded.native_durable_through) >= 0
                               AND mirrored_through >= max(native_durable_through, excluded.native_durable_through)
                          THEN 'healthy' ELSE 'catching_up' END,
            last_error_code = NULL, last_error_message = NULL, updated_at = excluded.updated_at
        `).run(sessionId, maximum, maximum, now)
      })
      const checkpoint = this.#checkpoint(sessionId)
      await this.#writeCoreHealth(checkpoint)
      return checkpoint
    } catch (error) {
      return this.#degrade(sessionId, error, maximum)
    }
  }

  /** Bounded compatibility adapter for the existing finalizer. */
  async readSession(sessionIdValue: string): Promise<DshSessionLogSnapshot> {
    const sessionId = validSessionId(sessionIdValue)
    await this.start()
    await this.#tail
    const database = this.#database
    if (database === undefined) throw new KiokukoError('SERVICE_UNAVAILABLE', 'DSH session cache is unavailable')
    const events: DshLogEvent[] = []
    let after = -1
    while (true) {
      const rows = database.prepare(`
        SELECT seq, event_json AS eventJson FROM session_events
         WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 256
      `).all<EventRow>(sessionId, after)
      if (rows.length === 0) break
      for (const row of rows) {
        const event = JSON.parse(row.eventJson) as DshLogEvent
        events.push(event)
        after = row.seq
      }
    }
    if (events.length === 0) throw new KiokukoError('NOT_FOUND', 'DSH session is absent from the local cache')
    return { session: { id: sessionId }, inheritedEventCount: 0, events }
  }

  /** Open a cursor-backed finalizer stream without materializing the log. */
  async streamSession(sessionIdValue: string): Promise<{
    readonly session: DshSessionLogSnapshot['session']
    readonly inheritedEventCount: number
    readonly events: AsyncIterable<DshLogEvent>
  }> {
    const sessionId = validSessionId(sessionIdValue)
    await this.start()
    await this.#tail
    const database = this.#database
    if (database === undefined) throw new KiokukoError('SERVICE_UNAVAILABLE', 'DSH session cache is unavailable')
    const exists = database.prepare('SELECT 1 AS present FROM session_events WHERE session_id = ? LIMIT 1')
      .get<{ present: number }>(sessionId)
    if (exists === undefined) throw new KiokukoError('NOT_FOUND', 'DSH session is absent from the local cache')
    return Object.freeze({
      session: Object.freeze({ id: sessionId }),
      inheritedEventCount: 0,
      events: this.streamEvents(sessionId),
    })
  }

  /** Cursor pages are bounded to 256 rows; event bodies are yielded intact. */
  async *streamEvents(sessionIdValue: string): AsyncIterable<DshLogEvent> {
    const sessionId = validSessionId(sessionIdValue)
    await this.start()
    await this.#tail
    const database = this.#database
    if (database === undefined) throw new KiokukoError('SERVICE_UNAVAILABLE', 'DSH session cache is unavailable')
    let after = -1
    while (true) {
      const rows = database.prepare(`
        SELECT seq, event_json AS eventJson FROM session_events
         WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 256
      `).all<EventRow>(sessionId, after)
      if (rows.length === 0) return
      for (const row of rows) {
        yield JSON.parse(row.eventJson) as DshLogEvent
        after = row.seq
      }
    }
  }

  /** Stream canonical JSONL without constructing the whole session string. */
  async *exportJsonl(sessionIdValue: string): AsyncIterable<Uint8Array> {
    const sessionId = validSessionId(sessionIdValue)
    await this.start()
    await this.#tail
    const database = this.#database
    if (database === undefined) throw new KiokukoError('SERVICE_UNAVAILABLE', 'DSH session cache is unavailable')
    let after = -1
    while (true) {
      const rows = database.prepare(`
        SELECT seq, event_json AS eventJson FROM session_events
         WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 256
      `).all<EventRow>(sessionId, after)
      if (rows.length === 0) return
      for (const row of rows) {
        const bytes = Buffer.from(`${row.eventJson}\n`, 'utf8')
        for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
          yield bytes.subarray(offset, Math.min(offset + 1024 * 1024, bytes.length))
        }
        after = row.seq
      }
    }
  }

  async inspectExport(sessionIdValue: string): Promise<DshSessionExportInspection> {
    const sessionId = validSessionId(sessionIdValue)
    await this.start()
    await this.#tail
    const database = this.#database
    if (database === undefined) throw new KiokukoError('SERVICE_UNAVAILABLE', 'DSH session cache is unavailable')
    const events = database.prepare(`
      SELECT coalesce(sum(byte_count + 1), 0) AS bytes FROM session_events WHERE session_id = ?
    `).get<{ bytes: number }>(sessionId)
    const attachments = database.prepare(`
      SELECT
        coalesce(sum(CASE WHEN state = 'stored' THEN byte_count ELSE 0 END), 0) AS bytes,
        sum(CASE WHEN state = 'stored' THEN 1 ELSE 0 END) AS stored,
        sum(CASE WHEN state <> 'stored' THEN 1 ELSE 0 END) AS unresolved
      FROM session_attachments WHERE session_id = ?
    `).get<{ bytes: number; stored: number | null; unresolved: number | null }>(sessionId)
    return Object.freeze({
      eventBytes: events?.bytes ?? 0,
      attachmentBytes: attachments?.bytes ?? 0,
      attachmentCount: attachments?.stored ?? 0,
      unresolvedAttachmentCount: attachments?.unresolved ?? 0,
    })
  }

  /** Attachment metadata is paged; each payload is streamed from the mirror file. */
  async *streamAttachments(sessionIdValue: string): AsyncIterable<DshMirroredAttachment> {
    const sessionId = validSessionId(sessionIdValue)
    await this.start()
    await this.#tail
    const database = this.#database
    if (database === undefined) throw new KiokukoError('SERVICE_UNAVAILABLE', 'DSH session cache is unavailable')
    let after = ''
    while (true) {
      const rows = database.prepare(`
        SELECT attachment_id AS attachmentId, digest, byte_count AS byteCount,
               relative_path AS relativePath, media_type AS mediaType,
               display_name AS displayName
          FROM session_attachments
         WHERE session_id = ? AND state = 'stored' AND attachment_id > ?
         ORDER BY attachment_id LIMIT 128
      `).all<AttachmentRow>(sessionId, after)
      if (rows.length === 0) return
      for (const row of rows) {
        if (!/^[0-9a-f]{64}\/[0-9a-f]{64}$/u.test(row.relativePath)) {
          throw new KiokukoError('INTEGRITY_ERROR', 'mirrored attachment path is invalid')
        }
        const extension: Record<DshImageAttachmentRef['mediaType'], string> = {
          'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
        }
        const identityDigest = createHash('sha256').update(row.attachmentId).digest('hex').slice(0, 16)
        const archivePath = `attachments/${identityDigest}-${row.digest}.${extension[row.mediaType]}`
        const absolutePath = join(this.#attachmentDirectory, row.relativePath)
        const expectedDigest = row.digest
        const expectedBytes = row.byteCount
        const source = (async function* (): AsyncIterable<Uint8Array> {
          const digest = createHash('sha256')
          let bytes = 0
          for await (const chunk of createReadStream(absolutePath, { highWaterMark: 1024 * 1024 })) {
            const value = chunk as Buffer
            bytes += value.byteLength
            digest.update(value)
            yield value
          }
          if (bytes !== expectedBytes || digest.digest('hex') !== expectedDigest) {
            throw new KiokukoError('INTEGRITY_ERROR', 'mirrored attachment failed export integrity verification')
          }
        })()
        yield Object.freeze({
          attachmentId: row.attachmentId,
          mediaType: row.mediaType,
          byteCount: row.byteCount,
          digest: row.digest,
          ...(row.displayName === null ? {} : { name: row.displayName }),
          archivePath,
          source,
        })
        after = row.attachmentId
      }
    }
  }

  async markFinalized(sessionIdValue: string): Promise<void> {
    const sessionId = validSessionId(sessionIdValue)
    await this.start()
    const database = this.#database
    if (database === undefined) return
    const now = this.#now()
    const expires = new Date(Date.parse(now) + RETENTION_TTL_MS).toISOString()
    try {
      database.prepare(`
        UPDATE session_retention SET state = 'finalized', last_accessed_at = ?, expires_at = ?
         WHERE session_id = ?
      `).run(now, expires, sessionId)
      await this.evictFinalized()
    } catch (error) {
      await this.#degrade(sessionId, error)
    }
  }

  async markUnfinalized(sessionIdValue: string): Promise<void> {
    await this.#markRetentionState(sessionIdValue, 'unfinalized')
  }

  async markWaitingUser(sessionIdValue: string): Promise<void> {
    await this.#markRetentionState(sessionIdValue, 'waiting_user')
  }

  async #markRetentionState(sessionIdValue: string, state: 'waiting_user' | 'unfinalized'): Promise<void> {
    const sessionId = validSessionId(sessionIdValue)
    await this.start()
    const database = this.#database
    if (database === undefined) return
    try {
      database.prepare(`
        INSERT INTO session_retention (session_id, state, last_accessed_at, expires_at, byte_count)
        VALUES (?, ?, ?, NULL, 0)
        ON CONFLICT(session_id) DO UPDATE SET
          state = excluded.state, last_accessed_at = excluded.last_accessed_at, expires_at = NULL
      `).run(sessionId, state, this.#now())
    } catch (error) {
      await this.#degrade(sessionId, error)
    }
  }

  /** Evict only finalized cache rows; active/waiting/unfinalized are immutable here. */
  async evictFinalized(maximumBytes = RETENTION_MAX_BYTES): Promise<readonly string[]> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new KiokukoError('VALIDATION_ERROR', 'retention byte limit is invalid')
    await this.start()
    await this.#tail
    const database = this.#database
    if (database === undefined) return Object.freeze([])
    const removed: string[] = []
    const attachmentDirectories: string[] = []
    try {
      withImmediateTransaction(database, () => {
        const now = this.#now()
        const expired = database.prepare(`
          SELECT session_id AS sessionId FROM session_retention
           WHERE state = 'finalized' AND expires_at IS NOT NULL AND expires_at <= ?
           ORDER BY expires_at, last_accessed_at, session_id
        `).all<{ sessionId: string }>(now)
        const remove = (sessionId: string): void => {
          attachmentDirectories.push(join(this.#attachmentDirectory, createHash('sha256').update(sessionId).digest('hex')))
          database.prepare('DELETE FROM session_events WHERE session_id = ?').run(sessionId)
          database.prepare('DELETE FROM session_attachments WHERE session_id = ?').run(sessionId)
          database.prepare('DELETE FROM session_watermarks WHERE session_id = ?').run(sessionId)
          database.prepare('DELETE FROM session_retention WHERE session_id = ?').run(sessionId)
          removed.push(sessionId)
        }
        for (const row of expired) remove(row.sessionId)
        let total = database.prepare(`SELECT coalesce(sum(byte_count), 0) AS bytes FROM session_retention`).get<{ bytes: number }>()?.bytes ?? 0
        if (total <= maximumBytes) return
        const lru = database.prepare(`
          SELECT session_id AS sessionId, byte_count AS byteCount FROM session_retention
           WHERE state = 'finalized' ORDER BY last_accessed_at, session_id
        `).all<{ sessionId: string; byteCount: number }>()
        for (const row of lru) {
          if (total <= maximumBytes) break
          remove(row.sessionId)
          total -= row.byteCount
        }
      })
      for (const directory of attachmentDirectories) await rm(directory, { recursive: true, force: true })
    } catch (error) {
      this.#lastError = error
    }
    return Object.freeze(removed)
  }

  async markArchived(sessionIdValue: string, terminalEndSeq: number): Promise<DshMirrorCheckpoint> {
    const sessionId = validSessionId(sessionIdValue)
    if (!Number.isSafeInteger(terminalEndSeq) || terminalEndSeq < 0) throw new KiokukoError('VALIDATION_ERROR', 'terminal sequence is invalid')
    await this.start()
    await this.#tail
    const checkpoint = this.#checkpoint(sessionId)
    if (checkpoint.confirmedThrough >= terminalEndSeq) return checkpoint
    const database = this.#database
    if (database !== undefined) {
      try {
        database.prepare(`
          UPDATE session_watermarks SET health = 'archive_unsafe', updated_at = ? WHERE session_id = ?
        `).run(this.#now(), sessionId)
      } catch (error) {
        return this.#degrade(sessionId, error, checkpoint.observedThrough)
      }
    }
    const unsafe = { ...this.#checkpoint(sessionId), health: 'archive_unsafe' as const }
    await this.#writeCoreHealth(unsafe)
    return Object.freeze(unsafe)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#startPromise
    await this.#tail
    try { this.#database?.close() } catch (error) { this.#lastError = error }
    this.#database = undefined
  }
}
