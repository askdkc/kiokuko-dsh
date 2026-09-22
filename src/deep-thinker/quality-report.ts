import type { DeepState, GoalNode, QualityJob, QualityNode } from './core/contracts.js'
const phases: Record<QualityJob['phase'], string> = { plan:'判定項目の作成', 'plan-review':'要求との照合', 'draft-a':'案の作成（1/2）', 'draft-b':'案の作成（2/2）', compare:'候補の比較', repair:'追加調査・修正', synthesize:'候補の統合', compose:'子の結果を合成', 'final-review':'再検証' }
const verdicts = { supported: '支持', contradicted: '矛盾あり', unresolved: '未解決' }
const agreements = { agreement: '一致', contradiction: '矛盾', complementary: '相補的', unknown: '判定不能' }
export function qualityStatus(state: DeepState): string {
  const pending=state.nodes.filter(n=>n.quality&&!['accepted','unresolved','superseded'].includes(n.status))
  return `品質重視（実験） · ${[...new Set(pending.map(n=>n.status==='waiting-children'?'子の結果を待機':phases[n.quality!.phase]))].join(' / ')||'処理終了'}`
}
function reviewFor(node: GoalNode) {
  return node.status === 'accepted' && node.receipt?.verifierVersion === 2 ? node.receipt.review : node.quality!.review
}

function candidateLabel(quality: QualityNode, id: string): string {
  return `案${quality.candidates.findIndex(candidate => candidate.id === id) + 1} (${id})`
}

function textPrefix(text: string, limit: number): string {
  const end = /[\uD800-\uDBFF]/u.test(text[limit - 1] ?? '') ? limit - 1 : limit
  return text.slice(0, end)
}

function issueRecords(node: GoalNode) {
  const review = reviewFor(node)
  const records = node.quality!.issues.map(issue => ({ ...issue, resolution: review?.resolutions.find(r => r.issueId === issue.id) }))
  // A new finding can reopen the same issue; do not display its old resolution as current.
  return [
    ...records.filter(issue => !review?.issues.some(current => current.checkId === issue.checkId && current.text === issue.text)),
    ...(review?.issues ?? []).map(issue => ({ ...issue, resolution: undefined })),
  ]
}

/** Keep the selection and unresolved state before potentially large answers and details. */
export function qualitySummaryLines(state: DeepState, unresolvedCount: number): string[] {
  const root = state.nodes[0]!, q = root.quality!, review = reviewFor(root)
  const nodes = state.nodes.filter(node => node.quality && node.status !== 'superseded')
  const issues = nodes.flatMap(issueRecords).filter(issue => issue.resolution?.status !== 'resolved').length
  const selected = root.status === 'accepted' && root.receipt?.verifierVersion === 2 ? root.receipt.selectedCandidateId : null
  // Only the visible summary is shortened; the full reason remains in the detailed report and receipt.
  const reason = review?.reason ?? (root.reason || '比較・検証はまだ完了していません。')
  const shortReason = reason.length > 1_024 ? `${textPrefix(reason, 1_024)}…（理由の続きは詳細）` : reason
  return ['', '比較の要約（分析評価。品質や独立性の証明ではありません）',
    `採用: ${selected ? candidateLabel(q, selected) : 'なし（検証未完了）'}`,
    `判定理由: ${shortReason}`,
    `修正・統合の枠: ${nodes.some(node => node.quality!.correctionUsed) ? '使用済み（未完了を含む）' : '未使用'}`,
    `未解決・制限: ${unresolvedCount}件 / 未解決の指摘: ${issues}件`]
}

export function qualityReportLines(state: DeepState): string[] {
  const lines = ['', '比較・修正の記録（項目ごとの分析評価。品質や独立性の証明ではありません）']
  for (const node of state.nodes.filter(n => n.quality && n.status !== 'superseded')) {
    const q = node.quality!, review = reviewFor(node)
    const selected = node.status === 'accepted' && node.receipt?.verifierVersion === 2 ? node.receipt.selectedCandidateId : null
    lines.push(`- ${node.question}: 候補${q.candidates.length}案、修正・統合の枠${q.correctionUsed ? '使用済み（未完了を含む）' : '未使用'}`)
    for (const candidate of q.candidates) {
      lines.push(`  ${candidateLabel(q, candidate.id)} [${selected === candidate.id ? '採用' : selected ? '未選択' : '未受理'}]: ${candidate.model.provider} / ${candidate.model.model}`)
    }
    if (selected) lines.push(`  採用: ${candidateLabel(q, selected)} — ${review!.reason}`)
    else if (review) lines.push(`  判定: ${review.reason}`)
    for (const check of q.checks) {
      lines.push(`  検証項目: ${check.text} (${check.requirementId})`)
      const agreement = review?.agreement.find(item => item.checkId === check.id)
      lines.push(`    候補間の評価: ${agreement ? `${agreements[agreement.kind]} — ${agreement.reason}` : '未評価'}`)
      for (const candidate of q.candidates) {
        const evaluation = review?.evaluations.find(item => item.checkId === check.id && item.candidateId === candidate.id)
        lines.push(`    ${candidateLabel(q, candidate.id)}: ${evaluation ? `${verdicts[evaluation.verdict]} — ${evaluation.reason}` : '未評価'}`)
      }
    }
    for (const issue of issueRecords(node)) {
      lines.push(`  ${issue.resolution?.status === 'resolved' ? '解消と評価' : '未解決'}: ${issue.text}${issue.resolution ? ` — ${issue.resolution.reason}` : ''}`)
    }
  }
  return lines
}

/** The persisted structured report stays complete; this bound applies only to display text. */
export function boundedQualityReport(text: string): string {
  const limit = 131_072
  if (text.length <= limit) return text
  const marker = '\n\n（表示上限のため以降の本文・詳細を省略しました。保存済みの構造化記録は保持しています。）'
  return textPrefix(text, limit - marker.length) + marker
}
