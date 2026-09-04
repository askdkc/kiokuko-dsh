import { canonicalContentHash } from '../serialization/validate.js'
import type { SqliteDatabase } from '../db/adapter.js'
import { KiokukoError } from '../errors.js'
import { kgpDispatch } from './generated/kgp-dispatch.js'

export interface DshInputClaim {
  readonly claimId: string
  readonly dshSessionId: string
  readonly nativeTurn: number
  readonly messages: readonly unknown[]
  readonly providerStarted: boolean
  readonly sideEffectStarted: boolean
  readonly recoveryCount: 0 | 1
  readonly status: 'claimed' | 'consumed' | 'recoverable' | 'recovered' | 'unsafe' | 'degraded'
}

interface ClaimRow extends Record<string, unknown> {
  claimId: string
  dshSessionId: string
  nativeTurn: number
  messagePayload: Uint8Array
  providerStarted: number
  sideEffectStarted: number
  recoveryCount: number
  status: DshInputClaim['status']
}

function sessionId(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', 'claim session identity is invalid')
  }
  return value
}

function turn(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new KiokukoError('VALIDATION_ERROR', 'claim native turn is invalid')
  return value
}

function encode(messages: readonly unknown[]): Uint8Array {
  const serialized = JSON.stringify(messages)
  if (serialized === undefined) throw new KiokukoError('VALIDATION_ERROR', 'native DSH messages are not JSON serializable')
  return Buffer.from(serialized, 'utf8')
}

function decode(payload: Uint8Array): readonly unknown[] {
  const value = JSON.parse(Buffer.from(payload).toString('utf8')) as unknown
  if (!Array.isArray(value)) throw new KiokukoError('INTEGRITY_ERROR', 'stored DSH claim is not a message array')
  return Object.freeze(value)
}

function row(database: SqliteDatabase, id: string, nativeTurn: number): ClaimRow | undefined {
  return database.prepare(`
    SELECT claim_id AS claimId, dsh_session_id AS dshSessionId,
           native_turn AS nativeTurn, message_payload AS messagePayload,
           provider_started AS providerStarted, side_effect_started AS sideEffectStarted,
           recovery_count AS recoveryCount, status
      FROM dsh_input_claim_backups
     WHERE dsh_session_id = ? AND native_turn = ?
  `).get<ClaimRow>(sessionId(id), turn(nativeTurn))
}

function claimFromRow(value: ClaimRow): DshInputClaim {
  if ((value.providerStarted !== 0 && value.providerStarted !== 1)
    || (value.sideEffectStarted !== 0 && value.sideEffectStarted !== 1)
    || (value.recoveryCount !== 0 && value.recoveryCount !== 1)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'stored DSH claim flags are invalid')
  }
  return Object.freeze({
    claimId: value.claimId,
    dshSessionId: value.dshSessionId,
    nativeTurn: value.nativeTurn,
    messages: decode(value.messagePayload),
    providerStarted: value.providerStarted === 1,
    sideEffectStarted: value.sideEffectStarted === 1,
    recoveryCount: value.recoveryCount as 0 | 1,
    status: value.status,
  })
}

/** Store the exact native message array outside the bounded ledger. */
export function backupInputClaimInTransaction(
  database: SqliteDatabase,
  input: { readonly dshSessionId: string; readonly nativeTurn: number; readonly messages: readonly unknown[]; readonly now?: string },
): DshInputClaim {
  const id = sessionId(input.dshSessionId)
  const nativeTurn = turn(input.nativeTurn)
  const payload = encode(input.messages)
  const claimId = canonicalContentHash({ version: 1, dshSessionId: id, nativeTurn })
  const now = input.now ?? new Date().toISOString()
  const existing = row(database, id, nativeTurn)
  if (existing !== undefined) {
    if (existing.claimId !== claimId || !Buffer.from(existing.messagePayload).equals(Buffer.from(payload))) {
      throw new KiokukoError('CONFLICT', 'DSH native turn claim changed after backup')
    }
    return claimFromRow(existing)
  }
  database.prepare(`
    INSERT INTO dsh_input_claim_backups (
      claim_id, dsh_session_id, native_turn, message_payload,
      provider_started, side_effect_started, recovery_count, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 0, 0, 'claimed', ?, ?)
  `).run(claimId, id, nativeTurn, payload, now, now)
  return claimFromRow(row(database, id, nativeTurn)!)
}

export function markClaimProgressInTransaction(
  database: SqliteDatabase,
  input: { readonly dshSessionId: string; readonly nativeTurn: number; readonly providerStarted?: boolean; readonly sideEffectStarted?: boolean; readonly now?: string },
): void {
  const now = input.now ?? new Date().toISOString()
  database.prepare(`
    UPDATE dsh_input_claim_backups
       SET provider_started = max(provider_started, ?),
           side_effect_started = max(side_effect_started, ?),
           status = CASE WHEN ? = 1 OR ? = 1 THEN 'unsafe' ELSE status END,
           updated_at = ?
     WHERE dsh_session_id = ? AND native_turn = ?
  `).run(
    input.providerStarted === true ? 1 : 0,
    input.sideEffectStarted === true ? 1 : 0,
    input.providerStarted === true ? 1 : 0,
    input.sideEffectStarted === true ? 1 : 0,
    now,
    sessionId(input.dshSessionId),
    turn(input.nativeTurn),
  )
}

export function settleInputClaimInTransaction(
  database: SqliteDatabase,
  input: { readonly dshSessionId: string; readonly nativeTurn: number; readonly turnEndedWithError: boolean; readonly now?: string },
): DshInputClaim | undefined {
  const existing = row(database, input.dshSessionId, input.nativeTurn)
  if (existing === undefined) return undefined
  const now = input.now ?? new Date().toISOString()
  const recoverable = input.turnEndedWithError
    && existing.providerStarted === 0
    && existing.sideEffectStarted === 0
    && existing.recoveryCount === 0
  const status: DshInputClaim['status'] = input.turnEndedWithError
    ? recoverable ? 'recoverable' : 'unsafe'
    : 'consumed'
  database.prepare(`
    UPDATE dsh_input_claim_backups SET status = ?, updated_at = ?
     WHERE claim_id = ?
  `).run(status, now, existing.claimId)
  return claimFromRow(row(database, input.dshSessionId, input.nativeTurn)!)
}

/** Claim an eligible recovery exactly once; the caller performs native steer. */
export function takeRecoverableInputClaimInTransaction(
  database: SqliteDatabase,
  dshSessionId: string,
  nativeTurn: number,
  now = new Date().toISOString(),
): DshInputClaim | undefined {
  if (kgpDispatch('claim-recovery-policy', 'claimed-state').action !== 'recover-once') {
    throw new KiokukoError('INTEGRITY_ERROR', 'KGP claim recovery policy is invalid')
  }
  const existing = row(database, dshSessionId, nativeTurn)
  if (existing?.status !== 'recoverable' || existing.recoveryCount !== 0
    || existing.providerStarted !== 0 || existing.sideEffectStarted !== 0) return undefined
  database.prepare(`
    UPDATE dsh_input_claim_backups
       SET status = 'recovered', recovery_count = 1, updated_at = ?
     WHERE claim_id = ? AND status = 'recoverable' AND recovery_count = 0
  `).run(now, existing.claimId)
  const recovered = row(database, dshSessionId, nativeTurn)
  return recovered?.status === 'recovered' ? claimFromRow(recovered) : undefined
}
