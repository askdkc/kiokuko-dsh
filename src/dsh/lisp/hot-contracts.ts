import { z } from 'zod'
import { fail } from './contracts.js'
import { CallInput, DefineInput, validateSchema, validateValue } from './task-tools.js'

export const HotName = DefineInput.shape.name
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1)
export const HotContractInput = DefineInput.pick({ name: true, description: true, inputSchema: true, outputSchema: true }).extend({
  properties: z.array(z.object({ input: z.unknown(), expected: z.unknown() }).strict()).min(1).max(32),
  expectedContractRef: z.uuid().nullable().default(null),
}).strict()
export const HotInstallInput = DefineInput.pick({ name: true, source: true, dependencies: true }).extend({
  contractRef: z.uuid(), expectedRevision: Revision,
}).strict()
export const HotCallInput = z.object({ name: HotName, input: z.unknown().optional(), inputRef: z.uuid().optional(),
  fields: CallInput.shape.fields }).strict().refine(v => (v.input !== undefined) !== (v.inputRef !== undefined), 'Provide exactly one input or inputRef')
export const HotDeactivateInput = z.object({ name: HotName, expectedRevision: Revision }).strict()
export const HotStatusInput = z.object({ name: HotName.optional(), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  contractOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict()
  .refine(v => v.contractOffset === undefined || v.name !== undefined, 'contractOffset requires name')
  .refine(v => v.name === undefined || v.offset === 0, 'Named inspection cannot use a list offset')
export const HotBundle = DefineInput.pick({ name: true, source: true, inputSchema: true, outputSchema: true }).extend({ contractRef: z.uuid() }).strict()
export type HotContract = z.infer<typeof HotContractInput>
export type Bundle = z.infer<typeof HotBundle>

/** Validate JSON without silently dropping undefined, executing toJSON, or accepting cycles. */
export function boundedJson(value: unknown, maxBytes: number): string {
  const seen = new Set<object>(); let nodes = 0
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 100000 || depth > 24) fail('HOT_JSON_LIMIT', 'JSONが大きすぎるか、深すぎます。')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item)
    if (!item || typeof item !== 'object' || seen.has(item)) fail('HOT_JSON_INVALID', '有限のJSONデータが必要です。')
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('HOT_JSON_INVALID', 'JSON objectが必要です。')
    seen.add(item)
    const array = Array.isArray(item)
    const keys = array ? Array.from({ length: item.length }, (_, i) => String(i)) : Object.keys(item)
    const parts = keys.map(key => {
      const property = Object.getOwnPropertyDescriptor(item, key)
      if (!property || !('value' in property)) fail('HOT_JSON_INVALID', 'Accessorは使用できません。')
      return `${array ? '' : `${JSON.stringify(key)}:`}${visit(property.value, depth + 1)}`
    })
    seen.delete(item)
    return array ? `[${parts.join(',')}]` : `{${parts.join(',')}}`
  }
  const text = visit(value, 0)
  if (Buffer.byteLength(text) > maxBytes) fail('HOT_JSON_LIMIT', 'JSONが保存・表示上限を超えています。')
  return text
}

export function parseHotContract(value: unknown): HotContract {
  const parsed = HotContractInput.parse(value)
  const contract = HotContractInput.parse(JSON.parse(boundedJson(parsed, 65536)))
  validateSchema(contract.inputSchema); validateSchema(contract.outputSchema)
  for (const property of contract.properties) {
    validateValue(contract.inputSchema, property.input); validateValue(contract.outputSchema, property.expected)
  }
  return contract
}

export function parseHotBundle(value: unknown): Bundle {
  const bundle = HotBundle.parse(value)
  if (Buffer.byteLength(bundle.source) > 262144) fail('HOT_SOURCE_LIMIT', '依存関数を含むコードが256 KiBを超えています。')
  validateSchema(bundle.inputSchema); validateSchema(bundle.outputSchema)
  return HotBundle.parse(JSON.parse(boundedJson(bundle, 1048576)))
}
