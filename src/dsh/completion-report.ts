import type { DshRuntime } from './runtime.js'
import type { DshLogEvent } from './session-memory-finalizer.js'
import type { EnnoRunSnapshot } from '../enno-oduno/types.js'
import { readEnnoSnapshot } from '../enno-oduno/store.js'
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

/** Project recorded verifier facts only. Explanations cannot modify this outcome. */
export function completionVerificationReport(snapshot: Pick<EnnoRunSnapshot, 'contract' | 'finalEvidence' | 'finalEvidenceReady'>) {
  const checks = snapshot.finalEvidence.map(check => {
    const counts = check.tapSummary
    const failed = check.status !== 'passed' || check.signal !== null
      || check.exitCode !== null && check.exitCode !== 0 || !!counts && (counts.fail > 0 || counts.cancelled > 0)
    const incomplete = check.skipped === true || check.changedDuringVerification === true
      || !!counts && (counts.skipped > 0 || counts.todo > 0)
    return { id: check.verifier.id, recordedStatus: check.status,
      outcome: failed ? 'failed' as const : incomplete ? 'unverified' as const : 'passed' as const,
      exitCode: check.exitCode, signal: check.signal, ...(counts ? { counts: { ...counts } } : {}) }
  })
  const required = snapshot.contract.finalVerifiers
  const missing = required.filter(spec => {
    const matches = snapshot.finalEvidence.filter(check => check.verifier.id === spec.id)
    return matches.length !== 1 || canonicalContentHash(matches[0]!.verifier) !== canonicalContentHash(spec)
  }).map(spec => spec.id)
  const complete = snapshot.finalEvidenceReady && required.length > 0 && missing.length === 0
    && checks.length === required.length
  return { schema: 'completion-verification-v1' as const,
    status: checks.some(check => check.outcome === 'failed') ? 'failed' as const
      : complete && checks.every(check => check.outcome === 'passed') ? 'passed' as const : 'unverified' as const,
    scope: 'recorded_final_verifiers' as const, fresh: snapshot.finalEvidenceReady,
    checks, missingVerifierIds: missing, explanations: 'unverified' as const,
    otherEnvironments: 'unverified' as const, deployedRuntime: 'unverified' as const }
}

/** A task's recorded completion, verifier measurements and explanatory prose are independent. */
export function completionReportText(snapshot: EnnoRunSnapshot, evidenceSummary?: string): string {
  const ja = snapshot.userFacingLanguage === 'ja'
  const verification = completionVerificationReport(snapshot)
  const done = snapshot.status === 'completed'
  const heading = !done ? (ja ? '作業は未完了のまま停止しました。' : 'Work stopped before completion.')
    : verification.status === 'passed' ? (ja ? '記録された作業と最終チェックは完了しました。' : 'The recorded work and final checks are complete.')
      : verification.status === 'failed' ? (ja ? '作業完了の記録はありますが、検証は失敗しています。' : 'Work is recorded as complete, but verification failed.')
        : (ja ? '作業完了の記録はあります。検証は未確認です。' : 'Work is recorded as complete; verification is unverified.')
  // Keep the safety-relevant status before bounded, potentially long model prose.
  const lines = [heading, '', `${ja ? '実測された検証' : 'Observed verification'}: ${verification.status}`,
    ja ? '別環境と稼働中runtime: 未検証。この記録のチェックからは推定しません。'
      : 'Other environments and deployed runtime: unverified. Not inferred from these checks.']
  for (const check of verification.checks) {
    lines.push(`- ${check.id}: ${check.outcome}${check.recordedStatus !== check.outcome ? ` (recorded status: ${check.recordedStatus})` : ''}`)
    if (check.counts) lines.push(`  tests=${check.counts.tests}, pass=${check.counts.pass}, fail=${check.counts.fail}, cancelled=${check.counts.cancelled}, skipped=${check.counts.skipped}, todo=${check.counts.todo}`)
  }
  if (!verification.checks.length) lines.push(ja ? '- 記録なし。検証成功とは判定していません。' : '- No recorded results; verification success is not assumed.')
  if (!verification.fresh) lines.push(ja ? '- 現在の最終検証としての鮮度は未確認です。' : '- Freshness as current final verification is unconfirmed.')
  if (verification.missingVerifierIds.length) lines.push(`${ja ? '未確認の必須チェック' : 'Unverified required checks'}: ${verification.missingVerifierIds.join(', ')}`)
  lines.push('', ja ? '記録済みの作業状態（検証成功の証明ではありません）:' : 'Recorded work states (not verification proof):')
  const explanations: string[] = []
  for (const unit of snapshot.workUnits) {
    lines.push(`- ${unit.workUnit.objective}: ${unit.status}`)
    if (unit.result?.changedPaths.length) lines.push(`  ${unit.result.changedPaths.join(', ')}`)
    if (unit.result?.summary) explanations.push(unit.result.summary)
  }
  if (snapshot.blocker) explanations.push(snapshot.blocker)
  if (snapshot.meditation) explanations.push(snapshot.meditation.summary)
  if (explanations.length) lines.push('', ja ? '報告された説明（未検証。証拠や確定した原因ではありません）:' : 'Unverified explanations (not evidence or established causes):', ...explanations)
  if (evidenceSummary) lines.push('', evidenceSummary)
  lines.push('', ja ? '最終回答が表示されなかったため、ホストの記録から結果を表示しています。' : 'The final response was missing; this report is provided from host records.')
  return lines.join('\n').slice(0, 32_768)
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
      SELECT report.run_id AS runId, report.native_turn AS nativeTurn,
        contract.workspace, contract.orchestration_session_id AS orchestrationId,
        receipt.next_action AS nextAction
      FROM dsh_completion_reports AS report JOIN enno_contracts AS contract ON contract.run_id = report.run_id
      JOIN dsh_turn_receipts AS receipt ON receipt.receipt_id = report.receipt_id
      WHERE report.dsh_session_id = ? AND report.status = 'pending' ORDER BY report.native_turn
    `).all<{ runId: string; nativeTurn: number; workspace: string; orchestrationId: string; nextAction: string | null }>(session.id))
    for (const item of pending) {
      const id = canonicalContentHash({ runId: item.runId, kind: DSH_COMPLETION_REPORT_EVENT })
      const events = session.snapshotEvents()
      // Text after a nonterminal work report cannot acknowledge a later,
      // host-only verification failure that the model has never received.
      const resultIndex = item.nextAction === 'complete' || item.nextAction === 'report_blocker'
        ? events.findIndex(event => event.type === 'tool/result' && record(event.data)?.turn === item.nativeTurn
          && JSON.stringify(event.data).includes('ennoOduno')) : -1
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
      const stored = await this.runtime.withDatabase(db => db.prepare('SELECT anchor_seq AS seq FROM dsh_session_notices WHERE id=? AND dsh_session_id=?')
        .get<{ seq: number }>(id, session.id))
      seq ??= stored?.seq
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
        seq = replay?.seq ?? session.snapshotEvents().at(-1)?.seq ?? 0
        if (!replay) {
          if (!session.header?.cwd) throw new Error('Report requires the exact Session workspace')
          await this.runtime.withDatabase(db => saveSessionNotice(db, { id, runId: item.runId, sessionId: session.id,
            rootPath: session.header!.cwd!, kind: 'report', text: completionReportText(snapshot, evidenceSummary), anchorSeq: seq! }))
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
