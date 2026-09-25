import type { DiffReview } from './schema.js'

function prose(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('\r', '').replaceAll('\n', '  \n')
}

export function reviewMarkdown(review: DiffReview): string {
  const lines = [`# Diff レビュー`, '', `- 取得時刻: ${review.snapshot.capturedAt}`, `- 比較対象: ${review.snapshot.mode}`, `- 状態: ${review.state}`, `- 鮮度: ${review.freshness}`, `- 文脈: ${review.context.source} / ${review.context.memory}`]
  if (review.model) lines.push(`- モデル: ${prose(review.model.provider)}/${prose(review.model.model)}`)
  if (review.context.task) lines.push('', '## タスク入力', '', prose(review.context.task))
  if (review.context.reviewInput) lines.push('', '## このレビューの目的（利用者入力）', '', prose(review.context.reviewInput))
  if (review.context.constraints) lines.push('', '制約: ' + prose(review.context.constraints))
  if (review.context.expected) lines.push('期待結果: ' + prose(review.context.expected))
  if (review.context.execution?.length) lines.push('', '## 実行記録', '', ...review.context.execution.map(item => `- ${prose(item.command)}: ${item.status}（今回の差分との一致: ${item.snapshotMatch}）`))
  lines.push('', '## リポジトリの事実', '')
  for (const file of review.snapshot.files) {
    lines.push(`### ${prose(file.displayPath)} (${file.layer}, ${file.kind})`, '')
    if (file.reason) lines.push(`除外・制限: ${file.reason}`, '')
    if (file.patch) {
      const fence = '`'.repeat(Math.max(3, ...[...file.patch.matchAll(/`+/gu)].map(match => match[0].length + 1)))
      lines.push(`${fence}diff`, file.patch, fence, '')
    }
  }
  lines.push('## AI の解釈', '', prose(review.summary ?? '分析なし'), '')
  if (review.analysis) {
    lines.push(`全体リスク: ${review.analysis.overallRisk}`, '')
    for (const [label, values] of [['影響範囲', review.analysis.impact], ['破壊的変更', review.analysis.breakingChanges],
      ['テストの不足', review.analysis.testGaps], ['過去判断との不一致', review.analysis.memoryConflicts], ['仮定', review.analysis.assumptions]] as const) {
      lines.push(`### ${label}`, '', ...(values.length ? values.map(value => `- ${prose(value)}`) : ['- 記録なし']), '')
    }
  }
  for (const claim of review.claims) lines.push(`- ${prose(claim.text)} [根拠: ${claim.evidenceIds.join(', ')}]`)
  lines.push('', '## 未検証・未分析', '')
  for (const id of review.unanalyzedFileIds) lines.push(`- 未分析 fileId: ${id}`)
  for (const error of review.errors) lines.push(`- ${error}`)
  if (!review.unanalyzedFileIds.length && !review.errors.length) lines.push('- 記録なし')
  return lines.join('\n') + '\n'
}
