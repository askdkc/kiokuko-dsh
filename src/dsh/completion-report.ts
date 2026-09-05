import type { DshRuntime } from './runtime.js'
import type { DshLogEvent } from './session-memory-finalizer.js'
import type { EnnoRunSnapshot } from '../enno-oduno/types.js'
import { readEnnoSnapshot } from '../enno-oduno/store.js'
import { canonicalContentHash } from '../serialization/validate.js'

export const DSH_COMPLETION_REPORT_EVENT = 'kiokuko/completion-report'

interface ReportSession {
  readonly id: string
  snapshotEvents(): readonly DshLogEvent[]
  append(type: string, data: unknown, options: { ignorable: true }): { seq: number }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Recorded facts only; a missing model response is never interpreted as failed implementation. */
export function completionReportText(snapshot: EnnoRunSnapshot, evidenceSummary?: string): string {
  const ja = snapshot.userFacingLanguage === 'ja'
  const done = snapshot.status === 'completed'
  const heading = ja ? (done ? '依頼された作業は完了しました。' : '作業は未完了のまま停止しました。')
    : (done ? 'The requested work is complete.' : 'Work stopped before completion.')
  const lines = [heading, '', ja ? '記録済みの作業結果:' : 'Recorded work results:']
  for (const unit of snapshot.workUnits) {
    lines.push(`- ${unit.workUnit.objective}: ${unit.status}${unit.result?.summary ? ` — ${unit.result.summary}` : ''}`)
    if (unit.result?.changedPaths.length) lines.push(`  ${unit.result.changedPaths.join(', ')}`)
  }
  lines.push('', ja ? '最終検証:' : 'Final verification:')
  for (const check of snapshot.finalEvidence) lines.push(`- ${check.verifier.id}: ${check.status}`)
  if (!snapshot.finalEvidence.length) lines.push(ja ? '- 記録なし。検証成功とは判定していません。' : '- No recorded results; verification success is not assumed.')
  if (evidenceSummary) lines.push('', evidenceSummary)
  if (snapshot.blocker) lines.push('', snapshot.blocker)
  if (snapshot.meditation) lines.push('', snapshot.meditation.summary)
  lines.push('', ja ? '最終回答が表示されなかったため、ホストの記録から結果を表示しています。' : 'The final response was missing; this report is provided from host records.')
  return lines.join('\n').slice(0, 32_768)
}

/** Flush-before-ack outbox. Native event identity makes crash replay harmless. */
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
      SELECT report.run_id AS runId, report.native_turn AS nativeTurn,
        contract.workspace, contract.orchestration_session_id AS orchestrationId
      FROM dsh_completion_reports AS report JOIN enno_contracts AS contract ON contract.run_id = report.run_id
      WHERE report.dsh_session_id = ? AND report.status = 'pending' ORDER BY report.native_turn
    `).all<{ runId: string; nativeTurn: number; workspace: string; orchestrationId: string }>(session.id))
    for (const item of pending) {
      const id = canonicalContentHash({ runId: item.runId, kind: DSH_COMPLETION_REPORT_EVENT })
      const events = session.snapshotEvents()
      const resultIndex = events.findIndex(event => event.type === 'tool/result' && record(event.data)?.turn === item.nativeTurn
        && JSON.stringify(event.data).includes('ennoOduno'))
      let delivered = events.find(event => event.type === DSH_COMPLETION_REPORT_EVENT && record(event.data)?.reportId === id)
      if (!delivered && resultIndex >= 0) delivered = events.slice(resultIndex + 1).find(event => {
        const data = record(event.data)
        const message = record(data?.message)
        return event.type === 'assistant/message' && data?.turn === item.nativeTurn && data?.interrupted !== true
          && Array.isArray(message?.content) && message.content.some(block => {
            const value = record(block)
            return value?.type === 'text' && typeof value.text === 'string' && value.text.trim().length > 0
          })
      })
      let seq = delivered?.seq
      if (seq === undefined) {
        const snapshot = await this.runtime.withDatabase(database => readEnnoSnapshot(database, item))
        let evidenceSummary: string | undefined
        try {
          evidenceSummary = await this.runtime.withDatabase(database => {
            const rows = database.prepare('SELECT evidence_json AS json FROM dsh_execution_evidence WHERE run_id = ? ORDER BY rowid DESC LIMIT 16')
              .all<{ json: string }>(item.runId)
            if (!rows.length) return undefined
            const heading = snapshot.userFacingLanguage === 'ja'
              ? '補助証拠の提示範囲（理解・正しさ・文書全体の確認を保証するものではありません）:'
              : 'Auxiliary evidence presentation (not proof of understanding, correctness, or whole-document coverage):'
            return [heading, ...rows.map(row => {
              const evidence = JSON.parse(row.json)
              return `- ${evidence.operation.paths.join(', ')} ${JSON.stringify(evidence.operation.range)}: ${evidence.presentation ?? 'unknown'}`
            })].join('\n')
          })
        } catch { evidenceSummary = 'Auxiliary evidence: unknown. Recorded verification results remain authoritative.' }
        // Re-read after the DB await: another native callback may have published the same report.
        const replay = session.snapshotEvents().find(event => event.type === DSH_COMPLETION_REPORT_EVENT && record(event.data)?.reportId === id)
        seq = replay?.seq ?? session.append(DSH_COMPLETION_REPORT_EVENT, {
          reportId: id, text: completionReportText(snapshot, evidenceSummary), source: { kind: 'plugin', plugin: 'kiokuko-dsh' },
        }, { ignorable: true }).seq
      }
      await this.flush(session)
      await this.runtime.withDatabase(database => {
        database.prepare(`UPDATE dsh_completion_reports SET status = 'delivered', delivered_seq = ? WHERE run_id = ?`)
          .run(seq, item.runId)
      })
    }
  }
}
