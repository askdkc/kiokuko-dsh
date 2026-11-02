import type { DshRuntime } from './runtime.js'
import type { DshLogEvent } from './session-memory-finalizer.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { saveSessionNotice } from './plugin-records.js'

export const DSH_COMPLETION_REPORT_EVENT = 'kiokuko/completion-report'

interface ReportSession {
  readonly id: string
  readonly header?: { readonly cwd?: string }
  snapshotEvents(): readonly DshLogEvent[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** A fallback report from host records when the final response never appeared. */
async function completionReportText(runId: string, runStatus: string, evidenceSummary?: string): Promise<string> {
  const done = runStatus === 'completed' || runStatus === 'active'
  const heading = done
    ? 'Work is recorded as complete; this host summary replaces a missing final response.'
    : 'Work stopped before completion; this host summary replaces a missing final response.'
  const lines = [heading]
  if (evidenceSummary) lines.push('', evidenceSummary)
  lines.push('', 'The final response was missing; this report is provided from host records.')
  return `Run ${runId}: 《${runStatus}》\n${lines.join('\n')}`.slice(0, 32_768)
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
      SELECT report.run_id AS runId, report.native_turn AS nativeTurn, run.status
      FROM dsh_completion_reports AS report
      JOIN ledger_runs AS run ON run.run_id = report.run_id
      WHERE report.dsh_session_id = ? AND report.status = 'pending' ORDER BY report.native_turn
    `).all<{ runId: string; nativeTurn: number; status: string }>(session.id))
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
          const reportText = await completionReportText(item.runId, item.status, evidenceSummary)
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
