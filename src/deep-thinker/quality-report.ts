import type { DeepState, QualityJob } from './core/contracts.js'
const phases: Record<QualityJob['phase'], string> = { plan:'判定項目の作成', 'plan-review':'要求との照合', 'draft-a':'案の作成（1/2）', 'draft-b':'案の作成（2/2）', compare:'候補の比較', repair:'追加調査・修正', synthesize:'候補の統合', compose:'子の結果を合成', 'final-review':'再検証' }
export function qualityStatus(state: DeepState): string {
  const pending=state.nodes.filter(n=>n.quality&&!['accepted','unresolved','superseded'].includes(n.status))
  return `品質重視（実験） · ${[...new Set(pending.map(n=>n.status==='waiting-children'?'子の結果を待機':phases[n.quality!.phase]))].join(' / ')||'処理終了'}`
}
export function qualityReportLines(state: DeepState): string[] {
  const lines=['','比較・修正の記録（項目ごとの分析評価。品質や独立性の証明ではありません）']
  for(const node of state.nodes.filter(n=>n.quality&&n.status!=='superseded')) {
    const q=node.quality!
    lines.push(`- ${node.question}: 候補${q.candidates.length}案、修正・統合の枠${q.correctionUsed?'使用済み（未完了を含む）':'未使用'}`)
    for(const candidate of q.candidates) lines.push(`  ${candidate.id}: ${candidate.model.provider} / ${candidate.model.model}`)
    if(node.receipt?.verifierVersion===2) lines.push(`  採用: ${node.receipt.selectedCandidateId} — ${node.receipt.review.reason}`)
    else if(q.review) lines.push(`  判定: ${q.review.reason}`)
    for(const issue of q.issues) {
      const resolution=q.review?.resolutions.find(r=>r.issueId===issue.id)
      lines.push(`  ${resolution?.status==='resolved'?'解消と評価':'未解決'}: ${issue.text}${resolution?` — ${resolution.reason}`:''}`)
    }
    if(q.review) for(const issue of q.review.issues) if(!q.issues.some(previous=>previous.checkId===issue.checkId&&previous.text===issue.text)) lines.push(`  指摘: ${issue.text}`)
  }
  return lines
}
