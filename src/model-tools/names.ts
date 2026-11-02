/** Core-safe operation identities; input schemas live with the optional tools. */
export const MODEL_TOOL_OPERATION_NAMES = [
  'curator_check',
  'memory_checkpoint',
] as const

export type ModelToolOperationName = (typeof MODEL_TOOL_OPERATION_NAMES)[number]
