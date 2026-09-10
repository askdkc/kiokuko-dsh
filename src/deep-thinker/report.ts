import type { DeepArtifact, DeepState } from './core/contracts.js'
export const DEEP_PHASE_LABELS = { ready: '開始待ち', running: '実行中', paused: '一時停止', answered: '完了', partial: '部分回答', blocked: '停止', failed: '失敗', cancelled: '取消済み' } as const
export function deepStatusText(state: DeepState): string {
  const accepted = state.nodes.filter(n => n.status === 'accepted').length
  return `Deep Thinker — ${state.phase === 'paused' && state.reason === '取消し処理中' ? '取消し処理中' : DEEP_PHASE_LABELS[state.phase]}\n検査済み ${accepted} / 作成済み ${state.nodes.length} 問題 · 実行中 ${state.nodes.filter(n => n.activeAttemptId).length}\nAgentジョブ ${state.usage.jobs}/${state.configuration.budget.maxAgentJobs} · 要求 ${state.usage.requests}/${state.configuration.budget.maxModelRequests}\nトークン ${Math.ceil(state.usage.tokens + state.usage.reservedTokens).toLocaleString()} / ${state.configuration.budget.maxTotalTokens.toLocaleString()}（推定を含む。課金上限の保証ではありません）${state.reason ? `\n${state.reason}` : ''}`
}
/** Reporting consumes no model request and remains available at zero budget. */
export function deepReport(state: DeepState, artifacts: readonly DeepArtifact[]) {
  const root = state.nodes[0]!
  const candidates = root.candidate ? [root] : state.nodes.filter(n => n.status === 'accepted' && n.candidate)
  const evidenceIds = new Set(candidates.flatMap(n => n.candidate!.evidence.map(e => e.artifactId)))
  const lines = [deepStatusText(state), '', ...candidates.map(n => `${n.status === 'accepted' && n.receipt ? '' : '未受理の暫定案（検証未完了）\n'}${n === root ? '' : `${n.question}\n`}${n.candidate!.answer}`)]
  if (!candidates.length) lines.push('検査済みの回答はありません。')
  lines.push('', '根拠・出典（内容照合と分析評価。形式証明ではありません）')
  for (const artifact of artifacts.filter(a => evidenceIds.has(a.id))) lines.push(`- ${artifact.path}:${artifact.startLine}–${artifact.endLine}`)
  if (!evidenceIds.size) lines.push('- 出典に基づく確認なし。分析上の評価です。')
  const assumptions = [...new Set(candidates.flatMap(n => [...n.assumptions, ...n.candidate!.assumptions]))]
  if (assumptions.length) lines.push('', '前提', ...assumptions.map(item => `- ${item}`))
  const unresolved = [...new Set([...state.nodes.filter(n => !['accepted','superseded'].includes(n.status)).map(n => `${n.question}: ${n.reason || '未検証'}`), ...candidates.flatMap(n => n.candidate!.unresolved)])]
  if (unresolved.length) lines.push('', '未解決・反例・制限', ...unresolved.map(item => `- ${item}`))
  return { protocolVersion: 1, reportId: `deep-report:${state.runId}`, runId: state.runId, revision: state.requirementRevision, phase: state.phase, text: lines.join('\n').slice(0, 131_072), summary: candidates.map(n => n.candidate!.answer).join('\n').slice(0, 8_192) }
}
