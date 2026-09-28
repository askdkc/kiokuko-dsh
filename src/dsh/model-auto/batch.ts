import type { DecisionBatch } from '../decisions/contracts.js'
import type { ModelBinding } from '../model-configuration.js'
import type { ModelAutoRouteId } from './contracts.js'

/** The same classification contract is used by native routing and its evaluation. */
export function buildModelRoutingBatch(input: {
  task: string
  taskType?: string | undefined
  attachmentTypes?: readonly string[] | undefined
  routes: readonly { id: ModelAutoRouteId; binding: ModelBinding }[]
}): DecisionBatch {
  const state = { task: input.task, taskType: input.taskType ?? null, attachmentTypes: input.attachmentTypes ?? [] }
  return { purpose: 'model-routing', contractVersion: 'typed-decisions-v1', state,
    questions: [{ id: 'model-route', type: 'choice',
      instructions: 'Choose one route for this complete task. luna-low: small precise edit or extraction; luna-medium: ordinary work with clear steps; luna-high: diagnosis or interacting constraints; sol-high: uncertain design, broad impact, or careful verification. Choose retain when evidence is insufficient. Never infer authorization or change the task.',
      choices: [...input.routes.map(route => ({ id: route.id, description: `${route.binding.model} / ${route.binding.reasoningEffort}` })),
        { id: 'retain', description: 'Keep the current model when no candidate is justified.' }], abstainId: 'retain' }] }
}
