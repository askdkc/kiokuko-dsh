/** Core-safe operation identities; input schemas live with the optional tools. */
export const MODEL_TOOL_OPERATION_NAMES = [
  'enno_plan_review',
  'enno_plan_submit',
  'enno_ideal_submit',
  'enno_work_report',
  'enno_delegate',
  'enno_finish',
  'enno_meditation_submit',
  'curator_check',
  'memory_checkpoint',
] as const

export type ModelToolOperationName = (typeof MODEL_TOOL_OPERATION_NAMES)[number]
