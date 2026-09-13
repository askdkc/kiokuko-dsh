import { canonicalContentHash } from '../../serialization/validate.js'
import { CandidateSchema, type AgentReply, type DeepJob, type DeepModel, type DeepRole, type GoalNode, type QualityNode, type QualityReply } from './contracts.js'

export function emptyQualityNode(inheritedChecks: QualityNode['checks'] = [], correctionUsed = false): QualityNode {
  return { phase: 'plan', checks: [], inheritedChecks: structuredClone(inheritedChecks), plan: null, correctionUsed, candidates: [], issues: [], review: null, commonArtifactIds: null }
}
export function qualityRole(node: GoalNode): DeepRole {
  switch (node.quality!.phase) {
    case 'plan': return 'planner'
    case 'plan-review': case 'compare': case 'final-review': return 'critic'
    case 'compose': case 'synthesize': return 'synthesizer'
    default: return 'solver'
  }
}
export function qualityModel(node: GoalNode, roles: Record<DeepRole, DeepModel>, alternative?: DeepModel): DeepModel {
  if (node.quality?.phase === 'draft-b') {
    if (!alternative) throw new Error('Quality mode requires an explicitly selected alternative solver')
    return alternative
  }
  return roles[node.quality ? qualityRole(node) : 'solver']
}
export function qualityPoolDigest(node: GoalNode): string {
  const quality = node.quality!
  return canonicalContentHash({ checks: quality.checks, inheritedChecks: quality.inheritedChecks, plan: quality.plan, candidates: quality.candidates,
    issues: quality.issues, review: quality.review, correctionUsed: quality.correctionUsed })
}
/** Identity sets are exact: duplicates are not coverage. */
export function exactQualityIds(actual: readonly string[], expected: readonly string[], label: string): void {
  if (new Set(actual).size !== actual.length || actual.length !== expected.length || actual.some(id => !expected.includes(id))) throw new Error(`Quality ${label} omitted, duplicated or invented an identity`)
}
export function assertQualityJob(node: GoalNode, job: DeepJob): void {
  if (!node.quality || !job.quality || job.nodeId !== node.id || job.nodeRevision !== node.revision || job.role !== qualityRole(node)
    || job.quality.phase !== node.quality.phase || job.quality.poolDigest !== qualityPoolDigest(node)) throw new Error('Quality job phase or candidate set is stale')
}
export function qualityCandidateId(node: GoalNode): string {
  return `${node.id}:v${node.revision}:candidate:${node.quality!.candidates.length + 1}`
}
function baseCandidate(reply: Extract<QualityReply, {kind:'quality-candidate'}>) {
  const { findings: _findings, ...rest } = reply
  return CandidateSchema.parse({ ...rest, kind: 'candidate', evidence: [...rest.evidence, ...reply.findings.flatMap(f => f.evidence)].filter((ref, i, all) => all.findIndex(r => r.artifactId === ref.artifactId && r.quote === ref.quote) === i) })
}
interface Transitions {
  legacy(reply: AgentReply, children: readonly string[]): void
  replan(reason: string): void
  children(): GoalNode[]
}
/** One deterministic, bounded quality transition, shared by live completion and reconciliation. */
export function applyQualityReply(node: GoalNode, reply: QualityReply, job: DeepJob, attemptId: string, childIds: readonly string[], transitions: Transitions): void {
  assertQualityJob(node, job)
  const q = node.quality!, phase = q.phase
  if (reply.kind === 'quality-plan' && phase === 'plan') {
    if (reply.decision === 'blocked') { node.status = 'unresolved'; node.reason = reply.reason; return }
    if (q.inheritedChecks.length) {
      if (reply.checks.length) throw new Error('Inherited quality checks are immutable')
      q.checks = structuredClone(q.inheritedChecks)
    } else {
      exactQualityIds([...new Set(reply.checks.map(c => c.requirementId))], node.requirementIds, 'check requirements')
      exactQualityIds(reply.checks.map(c => c.key), [...new Set(reply.checks.map(c => c.key))], 'check keys')
      q.checks = reply.checks.map((check, index) => ({ ...check, id: `${node.id}:v${node.revision}:check:${index+1}` }))
    }
    if (!q.checks.length) throw new Error('Quality plan has no checks')
    if (reply.decision === 'leaf' && reply.children.length) throw new Error('Leaf plan cannot contain children')
    if (reply.decision === 'decompose') {
      for (const child of reply.children) {
        exactQualityIds(child.checkKeys, [...new Set(child.checkKeys)], 'child check keys')
        if (child.checkKeys.some(key => !q.checks.some(check => check.key === key && child.requirementIds.includes(check.requirementId)))) throw new Error('Child changed quality obligations')
      }
      exactQualityIds([...new Set(reply.children.flatMap(child => child.checkKeys))], q.checks.map(c => c.key), 'decomposition coverage')
      transitions.legacy({ kind: 'decompose', synthesis: reply.synthesis, children: reply.children.map(({checkKeys: _keys, ...child}) => child) }, [])
    } else node.proposal = { kind: 'leaf', reason: reply.reason }
    q.plan = reply; q.phase = 'plan-review'; node.status = 'verifying-plan'; node.reason = reply.reason
    return
  }
  if (reply.kind === 'quality-plan-review' && phase === 'plan-review') {
    exactQualityIds(reply.requirementIds, node.requirementIds, 'plan requirements')
    exactQualityIds(reply.checkIds, q.checks.map(c=>c.id), 'plan checks')
    if (reply.verdict === 'reconsider') { transitions.replan(reply.reason); return }
    if (reply.verdict === 'unresolved') { node.status = 'unresolved'; node.reason = reply.reason; return }
    if (q.plan?.decision === 'leaf') { q.phase = 'draft-a'; node.status = 'ready' }
    else if (q.plan?.decision === 'decompose') {
      transitions.legacy({ kind: 'supported', requirementIds: reply.requirementIds, reason: reply.reason, evidence: reply.evidence }, childIds)
      for (const [index, child] of transitions.children().entries()) {
        const keys = q.plan.children[index]!.checkKeys
        child.quality = emptyQualityNode(q.checks.filter(check => keys.includes(check.key)))
      }
    } else throw new Error('Missing quality plan')
    node.reason = reply.reason
    return
  }
  if (reply.kind === 'quality-candidate' && ['draft-a','draft-b','compose','repair','synthesize'].includes(phase)) {
    exactQualityIds(reply.findings.map(f=>f.checkId), q.checks.map(c=>c.id), 'candidate checks')
    if (job.quality!.candidateId !== qualityCandidateId(node)) throw new Error('Quality candidate identity changed')
    const candidate = baseCandidate(reply)
    q.candidates.push({ id: job.quality!.candidateId!, attemptId, model: structuredClone(job.quality!.model), reply })
    node.candidate = candidate
    if (phase === 'draft-a') { q.phase = 'draft-b'; node.status = 'ready' }
    else { q.phase = ['repair','synthesize'].includes(phase) ? 'final-review' : 'compare'; node.status = 'verifying' }
    return
  }
  if (reply.kind !== 'quality-review' || !['compare','final-review'].includes(phase)) throw new Error('Unexpected quality response for current phase')
  exactQualityIds(reply.requirementIds, node.requirementIds, 'review requirements')
  const pairs = q.candidates.flatMap(c=>q.checks.map(check=>`${c.id}\n${check.id}`))
  exactQualityIds(reply.evaluations.map(e=>`${e.candidateId}\n${e.checkId}`), pairs, 'candidate/check matrix')
  exactQualityIds(reply.agreement.map(e=>e.checkId), q.checks.map(c=>c.id), 'agreement checks')
  exactQualityIds(reply.resolutions.map(r=>r.issueId), q.issues.map(i=>i.id), 'issue resolutions')
  if (reply.issues.some(issue=>!q.checks.some(check=>check.id===issue.checkId))) throw new Error('Issue invented a check')
  if (reply.action !== 'select' && reply.selectedCandidateId !== null) throw new Error('Only selection may identify a winner')
  if (reply.action === 'select') {
    const selected = q.candidates.find(c=>c.id===reply.selectedCandidateId)
    if (!selected || selected.reply.unresolved.length || selected.reply.findings.some(f=>f.unresolved) || reply.issues.length
      || reply.resolutions.some(r=>r.status!=='resolved') || reply.evaluations.some(e=>e.candidateId===selected.id && e.verdict!=='supported')) throw new Error('Quality selection still has unresolved obligations')
    node.candidate = baseCandidate(selected.reply); node.status = 'accepted'
  } else if (reply.action === 'repair' || reply.action === 'synthesize') {
    if (q.correctionUsed || phase === 'final-review') throw new Error('Quality correction budget exhausted')
    if (!reply.issues.length) throw new Error('Correction requires concrete issues')
    q.issues = [...q.issues.filter(issue=>reply.resolutions.find(r=>r.issueId===issue.id)?.status !== 'resolved'), ...reply.issues.map((issue, i)=>({ ...issue, id:`${node.id}:v${node.revision}:issue:${i+1}` }))]
    q.correctionUsed = true; q.phase = reply.action; node.status = reply.action === 'repair' ? 'ready' : 'composing'
  } else if (reply.action === 'replan') {
    q.issues = [...q.issues.filter(issue=>reply.resolutions.find(r=>r.issueId===issue.id)?.status !== 'resolved'), ...reply.issues.map((issue,i)=>({...issue,id:`${node.id}:v${node.revision}:replan-issue:${i+1}`}))]
    q.review = reply; transitions.replan(reply.reason); return
  }
  else node.status = 'unresolved'
  q.review = reply; node.reason = reply.reason
}
