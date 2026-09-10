import type { AgentReply, DeepState, GoalNode, PlannerReply, DeepRole } from './contracts.js'

/** Edges point from a waiting node to its prerequisites, including its children. */
export function assertAcyclic(nodes: readonly Pick<GoalNode, 'id' | 'parentId' | 'dependencies'>[]): void {
  const byId = new Map(nodes.map(node => [node.id, node]))
  if (byId.size !== nodes.length) throw new Error('Duplicate node identity')
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Problem graph contains a cycle')
    if (visited.has(id)) return
    const node = byId.get(id)
    if (!node) throw new Error('Problem graph contains an undefined reference')
    visiting.add(id)
    for (const dependency of [...node.dependencies, ...nodes.filter(child => child.parentId === id).map(child => child.id)]) visit(dependency)
    visiting.delete(id); visited.add(id)
  }
  for (const node of nodes) { if (node.parentId && !byId.has(node.parentId)) throw new Error('Undefined parent'); visit(node.id) }
}

export function validateDecomposition(state: DeepState, parent: GoalNode, reply: Extract<PlannerReply, { kind: 'decompose' }>): void {
  const budget = state.configuration.budget
  if (parent.depth >= budget.maxDepth || reply.children.length > budget.maxChildrenPerNode || state.nodes.length + reply.children.length > budget.maxNodes) throw new Error('Decomposition budget exhausted')
  const keys = new Set(reply.children.map(child => child.key))
  if (keys.size !== reply.children.length) throw new Error('Duplicate child key')
  const covered = new Set<string>()
  for (const child of reply.children) {
    if (!child.requirementIds.every(id => parent.requirementIds.includes(id))) throw new Error('Child changed parent requirements')
    child.requirementIds.forEach(id => covered.add(id))
    if (child.dependsOn.some(id => !keys.has(id))) throw new Error('Undefined dependency')
    if (child.question.trim() === parent.question.trim()) throw new Error('Decomposition repeated the parent question')
  }
  if (parent.requirementIds.some(id => !covered.has(id))) throw new Error('Decomposition omitted a required obligation')
  assertAcyclic(reply.children.map(child => ({ id: child.key, parentId: null, dependencies: child.dependsOn })))
}

export function nextRole(node: GoalNode): DeepRole | undefined {
  if (node.activeAttemptId) return undefined
  switch (node.status) {
    case 'planning': return 'planner'
    case 'ready': return 'solver'
    case 'verifying-plan': case 'verifying': return 'critic'
    case 'composing': return 'synthesizer'
    default: return undefined
  }
}

/** Propagate only settled prerequisite states; parents never occupy an execution slot. */
export function advanceGraph(state: DeepState): void {
  let changed = true
  while (changed) {
    changed = false
    for (const node of state.nodes) {
      if (node.activeAttemptId || ['accepted', 'unresolved', 'superseded'].includes(node.status)) continue
      const dependencies = node.dependencies.map(id => state.nodes.find(n => n.id === id)!)
      const children = state.nodes.filter(n => n.parentId === node.id && n.status !== 'superseded')
      if ([...dependencies, ...children].some(n => n.status === 'unresolved')) {
        node.status = 'unresolved'; node.reason = 'A required prerequisite remains unresolved'; changed = true
      } else if (node.status === 'waiting-children' && children.length && children.every(n => n.status === 'accepted')) {
        node.status = 'composing'; changed = true
      }
    }
  }
}

export function runnableNodes(state: DeepState): GoalNode[] {
  return state.nodes.filter(node => nextRole(node) !== undefined && node.dependencies.every(id => state.nodes.find(n => n.id === id)?.status === 'accepted'))
}

/** Invalidate descendants and all consumers; retain independent evidence for later revalidation. */
export function invalidateNodes(state: DeepState, ids: readonly string[], reason: string): void {
  const invalid = new Set(ids)
  let changed = true
  while (changed) {
    changed = false
    for (const node of state.nodes) {
      if (invalid.has(node.id)) {
        if (node.parentId && !invalid.has(node.parentId)) { invalid.add(node.parentId); changed = true }
      } else if (node.dependencies.some(id => invalid.has(id))) { invalid.add(node.id); changed = true }
    }
  }
  for (const node of state.nodes) if (invalid.has(node.id) && node.status !== 'superseded') {
    node.revision++; node.receipt = null; node.candidate = null; node.activeAttemptId = null; node.reason = reason
    node.status = state.nodes.some(n => n.parentId === node.id && n.status !== 'superseded') ? 'waiting-children' : 'planning'
  }
}

function replan(state: DeepState, node: GoalNode, reason: string): void {
  node.reason = reason
  if (node.replans >= state.configuration.budget.maxReplansPerNode) { node.status = 'unresolved'; return }
  const descendants = new Set([node.id])
  for (let i = 0; i < state.nodes.length; i++) for (const n of state.nodes) if (n.parentId && descendants.has(n.parentId)) descendants.add(n.id)
  for (const n of state.nodes) if (n.id !== node.id && descendants.has(n.id)) { n.status = 'superseded'; n.receipt = null }
  node.replans++; node.revision++; node.status = 'planning'; node.candidate = null; node.proposal = null; node.receipt = null
}

/** Accept a validated role reply only after the effect layer checked evidence and authority. */
export function applyReply(state: DeepState, node: GoalNode, role: DeepRole, reply: AgentReply, childIds: readonly string[]): void {
  if (role === 'planner') {
    if (reply.kind === 'leaf') { node.status = 'ready'; node.reason = reply.reason }
    else if (reply.kind === 'decompose') { validateDecomposition(state, node, reply); node.proposal = reply; node.status = 'verifying-plan' }
    else if (reply.kind === 'blocked') { node.status = 'unresolved'; node.reason = reply.reason }
    else throw new Error('Unexpected planner response')
  } else if (role === 'critic') {
    if (!['supported', 'reconsider', 'unresolved'].includes(reply.kind) || !('requirementIds' in reply)) throw new Error('Unexpected critic response')
    if (node.requirementIds.some(id => !reply.requirementIds.includes(id)) || reply.requirementIds.some(id => !node.requirementIds.includes(id))) throw new Error('Critic omitted or invented an obligation')
    if (reply.kind === 'reconsider') replan(state, node, reply.reason)
    else if (reply.kind === 'unresolved') { node.status = 'unresolved'; node.reason = reply.reason }
    else if (node.status === 'verifying-plan') {
      const proposal = node.proposal
      if (proposal?.kind !== 'decompose') throw new Error('Missing decomposition')
      validateDecomposition(state, node, proposal)
      if (childIds.length !== proposal.children.length) throw new Error('Missing host child identities')
      const mapping = new Map(proposal.children.map((child, i) => [child.key, childIds[i]!]))
      for (const child of proposal.children) state.nodes.push({
        id: mapping.get(child.key)!, parentId: node.id, revision: 1, question: child.question,
        requirementIds: [...child.requirementIds], acceptanceCriteria: [...child.acceptanceCriteria],
        assumptions: [...new Set([...node.assumptions, ...child.assumptions])],
        dependencies: child.dependsOn.map(id => mapping.get(id)!), depth: node.depth + 1, replans: 0,
        status: 'planning', activeAttemptId: null, candidate: null, proposal: null, reason: '', receipt: null,
      })
      node.status = 'waiting-children'; assertAcyclic(state.nodes)
    } else if (node.candidate && !node.candidate.unresolved.length) { node.status = 'accepted'; node.reason = reply.reason }
    else { node.status = 'unresolved'; node.reason = 'The candidate still contains unresolved obligations' }
  } else if (reply.kind === 'candidate') { node.candidate = reply; node.status = 'verifying' }
  else if (role === 'solver' && reply.kind === 'needs-decomposition') replan(state, node, reply.reason)
  else if (reply.kind === 'blocked') { node.status = 'unresolved'; node.reason = reply.reason }
  else throw new Error('Unexpected solution response')
}
