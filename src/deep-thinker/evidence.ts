import { createHash } from 'node:crypto'
import { canonicalContentHash } from '../serialization/validate.js'
import type { AgentReply, DeepArtifact, DeepState, GoalNode } from './core/contracts.js'
import { readDeepFile } from './read-port.js'

export function currentArtifacts(state: DeepState, artifacts: readonly DeepArtifact[]): DeepArtifact[] {
  return artifacts.filter(a => a.runId === state.runId && a.requirementRevision === state.requirementRevision
    && state.nodes.some(n => n.id === a.nodeId && n.revision === a.nodeRevision && n.status !== 'superseded'))
}
export function inputArtifacts(state: DeepState, node: GoalNode, artifacts: readonly DeepArtifact[]): DeepArtifact[] {
  const references = new Set([
    ...(node.candidate?.evidence ?? []),
    ...state.nodes.filter(n => n.parentId === node.id || node.dependencies.includes(n.id)).flatMap(n => n.candidate?.evidence ?? []),
  ].map(ref => ref.artifactId))
  return currentArtifacts(state, artifacts).filter(a => a.nodeId === node.id || references.has(a.id))
}
export async function changedSources(root: string, artifacts: readonly DeepArtifact[]): Promise<string[]> {
  const changed: string[] = [], checked = new Map<string, string | undefined>()
  for (const artifact of artifacts) {
    if (!checked.has(artifact.path)) {
      try { checked.set(artifact.path, (await readDeepFile(root, artifact.path)).sourceDigest) }
      catch { checked.set(artifact.path, undefined) }
    }
    if (checked.get(artifact.path) !== artifact.sourceDigest || createHash('sha256').update(artifact.content).digest('hex') !== artifact.digest) changed.push(artifact.nodeId)
  }
  return [...new Set(changed)]
}
/** A receipt records checks performed. Semantic correctness remains a critic assessment. */
export function evidenceReceipt(reply: AgentReply, candidate: GoalNode['candidate'], artifacts: readonly DeepArtifact[], inputDigest: string): NonNullable<GoalNode['receipt']> {
  const references = [...('evidence' in reply ? reply.evidence : []), ...(candidate?.evidence ?? [])]
  for (const reference of references) {
    const source = artifacts.find(a => a.id === reference.artifactId)
    if (!source) throw new Error('Worker cited an artifact outside its current input and reads')
    if (reference.quote && !source.content.includes(reference.quote)) throw new Error('Quoted evidence does not match the recorded read result')
  }
  return { inputDigest, evidenceDigest: canonicalContentHash(references.map(ref => artifacts.find(a => a.id === ref.artifactId)!)), verifierVersion: 1,
    assessment: references.length ? 'source-supported' : 'analytical' }
}
