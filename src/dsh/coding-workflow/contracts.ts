import type { ProtocolState } from '../guardrail/contracts.js'
import * as z from 'zod/v4'

const text = z.string().trim().min(1).max(4096)
export const CodingId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u)
  .describe('Declaration IDs (goalId/itemId/criterionId) must be unique across the definition; reference arrays reuse those declared IDs.')
const revision = z.number().int().min(1)
export const CodingCriterionSchema = z.object({
  criterionId: CodingId, revision, outcome: text, procedure: text, expected: text,
  evidence: z.enum(['selected_tests', 'output', 'artifact', 'browser', 'enno']),
}).strict()
export const CodingItemSchema = z.object({
  itemId: CodingId, change: text, dependsOn: z.array(CodingId).max(64),
  goalCriterionIds: z.array(CodingId).min(1).max(64), criterionIds: z.array(CodingId).min(1).max(64),
}).strict()
export const CodingGoalSchema = z.object({
  goalId: CodingId, revision, ideal: text, target: text,
  outOfScope: z.array(text).max(32), constraints: z.array(text).max(32), requestBasis: text,
  criterionIds: z.array(CodingId).min(1).max(64),
}).strict()
const definition = z.object({ goal: CodingGoalSchema, items: z.array(CodingItemSchema).min(1).max(64),
  criteria: z.array(CodingCriterionSchema).min(2).max(128) }).strict()
export const CodingDefinitionSchema = definition.superRefine((value, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: 'custom', message })
  const ids = (values: string[]) => {
    const duplicates = [...new Set(values.filter((id, index) => values.indexOf(id) !== index))]
    if (duplicates.length) reject(`Duplicate IDs: ${duplicates.join(', ')}`)
    return new Set(values)
  }
  const criteria = ids(value.criteria.map(item => item.criterionId))
  const items = ids(value.items.map(item => item.itemId))
  ids(value.goal.criterionIds)
  ids([value.goal.goalId, ...items, ...criteria])
  const referenced = new Set(value.goal.criterionIds)
  for (const id of value.goal.criterionIds) {
    if (!criteria.has(id)) reject('Missing Goal criterion')
    if (!value.items.some(item => item.goalCriterionIds.includes(id))) reject('Goal criterion has no implementing item')
  }
  for (const item of value.items) {
    ids(item.dependsOn); ids(item.criterionIds); ids(item.goalCriterionIds)
    for (const id of item.dependsOn) if (!items.has(id)) reject('Missing dependency')
    for (const id of item.goalCriterionIds) if (!value.goal.criterionIds.includes(id)) reject('Unknown Goal criterion')
    for (const id of item.criterionIds) {
      referenced.add(id)
      if (!criteria.has(id)) reject('Missing item criterion')
      if (value.goal.criterionIds.includes(id)) reject('Final Goal check must be separate from item checks')
    }
  }
  if ([...criteria].some(id => !referenced.has(id))) reject('Unreferenced criterion')
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) { reject('Cyclic item dependencies'); return }
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of value.items.find(item => item.itemId === id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id); visited.add(id)
  }
  for (const id of items) visit(id)
})
export type CodingDefinition = z.infer<typeof CodingDefinitionSchema>
export type CodingCriterion = z.infer<typeof CodingCriterionSchema>
export const CODING_MINIMUM_DEFINITION_EXAMPLE: CodingDefinition = {
  goal: { goalId: 'goal-example', revision: 1, ideal: 'The requested outcome is observable.', target: 'one-target',
    outOfScope: [], constraints: [], requestBasis: 'The exact current user request.', criterionIds: ['goal-check'] },
  items: [{ itemId: 'implementation', change: 'Implement the requested behavior.', dependsOn: [],
    goalCriterionIds: ['goal-check'], criterionIds: ['item-check'] }],
  criteria: [
    { criterionId: 'item-check', revision: 1, outcome: 'The requested behavior is implemented',
      procedure: 'Run the focused regression check', expected: 'The asserted behavior passes', evidence: 'selected_tests' },
    { criterionId: 'goal-check', revision: 1, outcome: 'The ordinary user entry works',
      procedure: 'Exercise the real entry point after item checks', expected: 'The requested result is observable', evidence: 'selected_tests' },
  ],
}
export interface CodingIdentity { runId: string; sessionId: string; repositoryRoot: string }
export type CodingState = 'preparing' | 'awaiting_lisp_choice' | 'ready' | 'implementing' | 'verifying_goal' | 'completed' | 'blocked' | 'cancelled' | 'superseded'
export const CodingBlockerSchema = z.object({ criterionIds: z.array(CodingId).max(128),
  kind: z.enum(['input', 'permission', 'environment', 'runtime', 'unknown_effect', 'retry_budget']),
  cause: text, required: text, recovery: z.array(text).max(16), resumeWhen: text,
}).strict()
export type CodingBlocker = z.infer<typeof CodingBlockerSchema>
export interface CodingChoice {
  state: 'pending' | 'yes' | 'no' | 'cancelled'; scopeVersion: number;
  questionId: string; revision: number; answerRef?: string
}
export interface CodingWorkflow extends CodingIdentity {
  workflowId: string; requestId: string; requestDigest: string; request: string;
  revision: number; scopeVersion: number; state: CodingState; definition?: CodingDefinition;
  choice: CodingChoice; retiredIds: string[]; activeItemId?: string; blocker?: CodingBlocker;
  attempts: Record<string, { fingerprint: string; count: number; retryAt: number; sourceDigest?: string }>;
  ennoProjectionDigest?: string;
  protocol?: ProtocolState;
  pendingScopeChange?: { requestDigest: string; evidenceRefs: string[] }
}
export const CODING_WORKFLOW_SERVICE = 'kiokukoCodingWorkflow'
