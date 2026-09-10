import { randomUUID } from 'node:crypto'
import { DeepStateSchema, type DeepState } from './core/contracts.js'
import type { DeepIntent } from './store.js'
export function initialDeepState(intent: DeepIntent, runId: string, context: string): DeepState {
  return DeepStateSchema.parse({ protocolVersion: 1, runId, startId: intent.startId, workspace: intent.workspace, sessionId: intent.sessionId, rootPath: intent.rootPath,
    revision: 0, requirementRevision: 1, ownerEpoch: 0, ownerId: null, leaseUntil: 0, phase: 'ready', task: intent.task, constraints: [], context, reason: '', configuration: intent.configuration,
    usage: { jobs: 0, requests: 0, tokens: 0, reservedTokens: 0, estimated: true, activeMs: 0, activeSince: null }, pendingInputs: [],
    nodes: [{ id: randomUUID(), parentId: null, revision: 1, question: intent.task, requirementIds: ['request'], acceptanceCriteria: [intent.task], assumptions: [], dependencies: [], depth: 0,
      replans: 0, status: 'planning', activeAttemptId: null, candidate: null, proposal: null, reason: '', receipt: null }],
  })
}
