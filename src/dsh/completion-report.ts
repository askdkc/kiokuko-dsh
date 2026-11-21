import type { DshRuntime } from './runtime.js'
import type { DshLogEvent } from './session-memory-finalizer.js'
import type { SqliteDatabase } from '../db/adapter.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { saveSessionNotice } from './plugin-records.js'
import { assessTaskCompletion, taskCompletionBlocksClose } from './task-completion.js'

export const DSH_COMPLETION_REPORT_EVENT = 'kiokuko/completion-report'

interface ReportSession {
  readonly id: string
  readonly header?: { readonly cwd?: string }
  snapshotEvents(): readonly DshLogEvent[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** The ledger terminal state and the purpose verification are separate findings. */
export type CompletionReportResult = 'completed' | 'stopped' | 'blocked' | 'unverified'
export type CompletionPurposeVerification = 'verified' | 'unverified' | 'unresolved' | 'unavailable'
export type CompletionRecoveryClose = 'completed' | 'failed' | 'cancelled'

export interface CompletionRecoveryFacts {
  /** Exact ledger state of the reported run; undefined means it could not be read. */
  readonly runStatus: string | undefined
  /** `dsh_turn_receipts.next_action` of the receipt that requested this report. */
  readonly nextAction: string | null | undefined
  /** End reason of the reported native turn, only when exactly one boundary exists. */
  readonly endReason: string | undefined
  readonly verification: CompletionPurposeVerification
}

export interface CompletionRecoveryDecision {
  readonly result: CompletionReportResult
  /** The only ledger transition this recovery may perform; absent means "leave it alone". */
  readonly close?: CompletionRecoveryClose
  readonly detail: string
}

/**
 * Pure recovery judgement from already-collected facts. It never reads the ledger,
 * flushes history, writes a notice or changes a status; callers own those effects.
 */
export function decideCompletionRecovery(facts: CompletionRecoveryFacts): CompletionRecoveryDecision {
  switch (facts.runStatus) {
    case undefined: return { result: 'unverified', detail: 'ledger_run_missing' }
    case 'completed':
      // A recorded terminal cannot prove this turn completed when its own end disagrees.
      return facts.endReason === undefined || facts.endReason === 'completed'
        ? { result: 'completed', detail: 'ledger_terminal' }
        : { result: 'unverified', detail: 'ledger_contradiction' }
    case 'failed': case 'cancelled': case 'interrupted':
      return { result: 'stopped', detail: `ledger_${facts.runStatus}` }
    case 'active': break
    default: return { result: 'unverified', detail: `ledger_${facts.runStatus}` }
  }
  // A blocker report intentionally keeps the run open for the user to resume.
  if (facts.nextAction === 'report_blocker') return { result: 'blocked', detail: 'reported_blocker' }
  if (facts.nextAction !== 'complete') return { result: 'unverified', detail: 'next_action_missing' }
  switch (facts.endReason) {
    case 'completed':
      // Closing still requires the acceptance evidence of this exact request.
      if (facts.verification === 'unresolved') return { result: 'unverified', detail: 'required_evidence_unresolved' }
      if (facts.verification === 'unavailable') return { result: 'unverified', detail: 'completion_unavailable' }
      return { result: 'completed', detail: 'native_turn_completed', close: 'completed' }
    case 'aborted': return { result: 'stopped', detail: 'native_turn_aborted', close: 'cancelled' }
    case 'error': return { result: 'stopped', detail: 'native_turn_error', close: 'failed' }
    case 'max-tokens': return { result: 'stopped', detail: 'native_turn_max_tokens' }
    case 'blocked': return { result: 'stopped', detail: 'native_turn_blocked' }
    default: return { result: 'unverified', detail: 'native_turn_end_missing' }
  }
}

/** Read-only ledger facts for one report. Unknown evidence is never treated as verified. */
export function readCompletionRecoveryFacts(
  database: SqliteDatabase,
  input: {
    readonly runId: string
    readonly nextAction: string | null | undefined
    readonly endReason: string | undefined
  },
): CompletionRecoveryFacts {
  const runStatus = database.prepare('SELECT status FROM ledger_runs WHERE run_id = ?')
    .get<{ status: string }>(input.runId)?.status
  let verification: CompletionPurposeVerification = 'unavailable'
  if (runStatus !== undefined) {
    try {
      const assessment = assessTaskCompletion(database, input.runId)
      verification = assessment.verified ? 'verified'
        : taskCompletionBlocksClose(assessment) ? 'unresolved' : 'unverified'
    } catch {
      verification = 'unavailable'
    }
  }
  return {
    runStatus,
    nextAction: input.nextAction,
    endReason: input.endReason,
    verification,
  }
}

/** One exact native turn end; a missing or ambiguous boundary stays unavailable. */
export function dshTurnEndBoundary(
  events: readonly DshLogEvent[],
  turn: number,
): { readonly seq: number; readonly reason: string | undefined } | undefined {
  const matches = events.filter(event => event.type === 'turn/end' && record(event.data)?.turn === turn)
  if (matches.length !== 1) return undefined
  const reason = record(record(matches[0]!.data)?.reason)?.kind
  return {
    seq: matches[0]!.seq,
    reason: typeof reason === 'string' ? reason : undefined,
  }
}

const MISSING_RESPONSE_NOTE = 'The final response was missing; this report is provided from host records.'

/** A non-completed native turn end, phrased as why the reported turn stopped. */
function stopReasonPhrase(reason: string | undefined): string | undefined {
  switch (reason) {
    case 'aborted': return 'was interrupted'
    case 'error': return 'ended with an error'
    case 'max-tokens': return 'ended at its token limit'
    case 'blocked': return 'ended blocked'
    default: return undefined
  }
}

function terminalLines(facts: CompletionRecoveryFacts): string {
  switch (facts.runStatus) {
    case 'completed': {
      const contradiction = stopReasonPhrase(facts.endReason)
      return contradiction === undefined
        ? 'The ledger records this run as completed. That is the ledger terminal state, not a fresh verification of the requested outcome.'
        : `The ledger records this run as completed, but its final native turn ${contradiction}; the evidence is contradictory and completion is unverified.`
    }
    case 'failed': case 'cancelled': case 'interrupted':
      return `The ledger records this run as ${facts.runStatus}; it stopped before completion.`
    case 'active': {
      if (facts.nextAction === 'report_blocker')
        return 'The host reported a blocker; this run remains active and completion is unverified.'
      const stopped = stopReasonPhrase(facts.endReason)
      if (stopped !== undefined) return `The run stopped before completion: its final native turn ${stopped}.`
      return facts.endReason === 'completed'
        ? 'The ledger still records this run as active. Its final native turn ended as completed, but this report does not record the run as completed.'
        : 'The ledger still records this run as active and no end of its final native turn is recorded; completion is unverified.'
    }
    case 'intake':
      return 'The run is still in intake; completion is unverified.'
    default:
      return 'The ledger state could not be read; completion is unverified.'
  }
}

function verificationLine(verification: CompletionPurposeVerification): string {
  switch (verification) {
    case 'verified': return 'Purpose verification: the requested outcome was verified by acceptance evidence tied to this request.'
    case 'unresolved': return 'Purpose verification: required acceptance evidence for this request is still unresolved.'
    case 'unverified': return 'Purpose verification: no acceptance evidence tied to this request was observed.'
    default: return 'Purpose verification: acceptance evidence could not be read.'
  }
}

/** A fallback report from host records when the final response never appeared. */
export function completionReportText(input: {
  readonly runId: string
  readonly facts: CompletionRecoveryFacts
  readonly evidenceSummary?: string
}): string {
  const lines = [terminalLines(input.facts), verificationLine(input.facts.verification)]
  if (input.evidenceSummary) lines.push('', input.evidenceSummary)
  lines.push('', MISSING_RESPONSE_NOTE)
  return `Run ${input.runId}: 《${input.facts.runStatus ?? 'unknown'}》\n${lines.join('\n')}`.slice(0, 32_768)
}

/** Save the notice and flush native history before settling the outbox. Stable IDs deduplicate crash replay. */
export class DshCompletionReporter {
  readonly #active = new Map<string, Promise<void>>()
  constructor(private readonly runtime: Pick<DshRuntime, 'withDatabase'>, private readonly flush: (session: object) => PromiseLike<unknown>) {}

  deliver(session: ReportSession): Promise<void> {
    const existing = this.#active.get(session.id)
    if (existing) return existing
    const done = this.#deliver(session).finally(() => this.#active.delete(session.id))
    this.#active.set(session.id, done)
    return done
  }

  async #deliver(session: ReportSession): Promise<void> {
    const pending = await this.runtime.withDatabase(database => database.prepare(`
      SELECT report.run_id AS runId, report.native_turn AS nativeTurn, receipt.next_action AS nextAction
      FROM dsh_completion_reports AS report
      JOIN dsh_turn_receipts AS receipt ON receipt.receipt_id = report.receipt_id
      WHERE report.dsh_session_id = ? AND report.status = 'pending' ORDER BY report.native_turn
    `).all<{ runId: string; nativeTurn: number; nextAction: string | null }>(session.id))
    for (const item of pending) {
      const id = canonicalContentHash({ runId: item.runId, kind: DSH_COMPLETION_REPORT_EVENT })
      const events = session.snapshotEvents()
      let delivered = events.find(event => event.type === DSH_COMPLETION_REPORT_EVENT && record(event.data)?.reportId === id)
      let seq = delivered?.seq
      const stored = await this.runtime.withDatabase(db => db.prepare('SELECT anchor_seq AS seq FROM dsh_session_notices WHERE id=? AND dsh_session_id=?')
        .get<{ seq: number }>(id, session.id))
      seq ??= stored?.seq
      if (seq === undefined) {
        let evidenceSummary: string | undefined
        try {
          evidenceSummary = await this.runtime.withDatabase(database => {
            const rows = database.prepare('SELECT evidence_json AS json FROM dsh_execution_evidence WHERE run_id = ? ORDER BY rowid DESC LIMIT 16')
              .all<{ json: string }>(item.runId)
            if (!rows.length) return undefined
            const heading = 'Auxiliary evidence presentation (not proof of understanding, correctness, or whole-document coverage):'
            return [heading, ...rows.map(row => {
              const evidence = JSON.parse(row.json)
              return `- ${evidence.operation.paths.join(', ')} ${JSON.stringify(evidence.operation.range)}: ${evidence.presentation ?? 'unknown'}`
            })].join('\n')
          })
        } catch { evidenceSummary = 'Auxiliary evidence: unknown.' }
        // Re-read after the DB await: another native callback may have published the same report.
        const replay = session.snapshotEvents().find(event => event.type === DSH_COMPLETION_REPORT_EVENT && record(event.data)?.reportId === id)
        seq = replay?.seq ?? session.snapshotEvents().at(-1)?.seq ?? 0
        if (!replay) {
          if (!session.header?.cwd) throw new Error('Report requires the exact Session workspace')
          const end = dshTurnEndBoundary(session.snapshotEvents(), item.nativeTurn)
          const facts = await this.runtime.withDatabase(database => readCompletionRecoveryFacts(database, {
            runId: item.runId, nextAction: item.nextAction, endReason: end?.reason,
          }))
          const reportText = completionReportText({
            runId: item.runId, facts,
            ...(evidenceSummary === undefined ? {} : { evidenceSummary }),
          })
          await this.runtime.withDatabase(db => saveSessionNotice(db, { id, runId: item.runId, sessionId: session.id,
            rootPath: session.header!.cwd!, kind: 'report', text: reportText, anchorSeq: seq! }))
        }
      }
      await this.flush(session)
      await this.runtime.withDatabase(database => {
        database.prepare(`UPDATE dsh_completion_reports SET status = 'delivered', delivered_seq = ? WHERE run_id = ?`)
          .run(seq, item.runId)
      })
    }
  }
}
