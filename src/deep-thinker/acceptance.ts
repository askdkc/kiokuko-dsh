import { applyReply, replan } from './core/graph.js'
import { applyQualityReply } from './core/quality.js'
import { evidenceReceipt } from './evidence.js'
import type { AgentReply, DeepArtifact, DeepJob, DeepState, GoalNode, QualityReply } from './core/contracts.js'

/** Called inside the authority-checked state transaction, for live and recovered results alike. */
export function acceptDeepReply(state: DeepState, node: GoalNode, job: DeepJob, attemptId: string, reply: AgentReply | QualityReply, artifacts: readonly DeepArtifact[], childIds: readonly string[]): void {
  // In quality mode a preceding candidate is not implicitly input to the next independent worker.
  const checked = evidenceReceipt(reply, node.quality ? null : node.candidate, artifacts, job.inputDigest)
  if (node.quality) {
    if (!job.quality || !reply.kind.startsWith('quality-')) throw new Error('Quality response protocol mismatch')
    applyQualityReply(node, reply as QualityReply, job, attemptId, childIds, {
      legacy: (legacy, children) => applyReply(state, node, job.role, legacy, children),
      replan: reason => replan(state, node, reason),
      children: () => state.nodes.filter(n => n.parentId === node.id && n.status !== 'superseded'),
    })
    if (node.status === 'accepted') {
      if (reply.kind !== 'quality-review' || !reply.selectedCandidateId) throw new Error('Quality acceptance requires an explicit selection')
      const receipt = evidenceReceipt(reply, node.candidate, artifacts, job.inputDigest)
      node.receipt = { ...receipt, verifierVersion: 2, selectedCandidateId: reply.selectedCandidateId, poolDigest: job.quality.poolDigest,
        candidates: node.quality.candidates.map(({id,attemptId,model})=>({id,attemptId,model})), review: reply }
    }
  } else {
    if (job.quality || reply.kind.startsWith('quality-')) throw new Error('Legacy response protocol mismatch')
    applyReply(state, node, job.role, reply as AgentReply, childIds)
    if (node.status === 'accepted') node.receipt = checked
  }
  node.activeAttemptId = null
}
