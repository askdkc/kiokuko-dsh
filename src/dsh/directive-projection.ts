import type { EnnoNextAction, EnnoOdunoState, RoleDirective } from '../enno-oduno/types.js'
import { modelFacingInputSchema, type JsonSchema } from '../model-tools/registry.js'
import type { DshModelFacingOperation } from './tools.js'

const MODEL_OPERATION_BY_NEXT_ACTION: Readonly<Partial<Record<EnnoNextAction, DshModelFacingOperation>>> = Object.freeze({
  submit_ideal: 'enno_ideal_submit',
  submit_plan: 'enno_plan_submit',
  execute_work_unit: 'enno_work_report',
  submit_final_review: 'enno_finish',
  submit_meditation: 'enno_meditation_submit',
})

const EMPTY_MODEL_SCHEMA: JsonSchema = Object.freeze({
  type: 'object',
  properties: Object.freeze({}),
  required: Object.freeze([]),
  additionalProperties: false,
})

/** Return the model-facing operation owned by a current Enno action. */
export function modelFacingOperationForNextAction(nextAction: EnnoNextAction): DshModelFacingOperation | undefined {
  return MODEL_OPERATION_BY_NEXT_ACTION[nextAction]
}

/** Project an authoritative Enno state onto the DSH model boundary. */
export function projectDshDirective(state: Pick<EnnoOdunoState, 'nextAction' | 'directive'>): RoleDirective | null {
  if (state.directive === null) return null
  const operation = modelFacingOperationForNextAction(state.nextAction)
  return {
    ...state.directive,
    reportSchema: operation === undefined ? EMPTY_MODEL_SCHEMA : modelFacingInputSchema(operation),
  }
}
