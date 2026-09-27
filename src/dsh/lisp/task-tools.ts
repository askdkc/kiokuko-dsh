import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { digest, fail, type LispOwner } from './contracts.js'
import { LispStore } from './store.js'

const Schema = z.object({
  type: z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).max(100).optional(),
  items: z.unknown().optional(),
  additionalProperties: z.literal(false).optional(),
}).strict()
export const DefineInput = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), description: z.string().min(1).max(1000),
  source: z.string().min(1).max(262144), inputSchema: Schema, outputSchema: Schema,
  dependencies: z.array(z.object({ binding: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), toolRef: z.uuid() }).strict()).max(32).default([]),
  examples: z.array(z.object({ input: z.unknown(), expected: z.unknown() }).strict()).max(10).default([]),
  firstInput: z.unknown().optional(),
}).strict()
export const CallInput = z.object({ toolRef: z.uuid(), input: z.unknown().optional(), inputRef: z.uuid().optional(),
  fields: z.array(z.string().regex(/^\/[A-Za-z0-9_~/-]{1,256}$/)).max(20).optional() }).strict().refine(v => (v.input === undefined) !== (v.inputRef === undefined), 'Provide exactly one input or inputRef')
export type Definition = z.infer<typeof DefineInput>
export type Call = z.infer<typeof CallInput>
type Shape = z.infer<typeof Schema>

export function selectFields(value: unknown, fields: string[], resultRef: string): Record<string, unknown> {
  const selected: Record<string, unknown> = {}
  for (const pointer of fields) {
    let part: unknown = value
    for (const token of pointer.slice(1).split('/')) {
      const key = token.replaceAll('~1', '/').replaceAll('~0', '~')
      if (part === null || typeof part !== 'object' || !Object.hasOwn(part, key)) { part = undefined; break }
      part = (part as Record<string, unknown>)[key]
    }
    if (part === undefined) selected[pointer] = { missing: true }
    else {
      const bytes = Buffer.byteLength(JSON.stringify(part))
      selected[pointer] = bytes <= 8192 ? part : { omitted: true, bytes, resultRef, pointer }
    }
  }
  return selected
}

/** Validate a deliberately small data-only schema, before any worker is started. */
export function validateValue(schema: Shape, value: unknown, depth = 0): void {
  if (depth > 16) fail('TASK_SCHEMA_LIMIT', 'Schema or value is too deep.')
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (kind !== schema.type && !(schema.type === 'integer' && kind === 'number' && Number.isSafeInteger(value)))
    fail('TASK_SCHEMA_MISMATCH', `Expected ${schema.type}.`)
  if (typeof value === 'number' && !Number.isFinite(value)) fail('TASK_SCHEMA_MISMATCH', 'Non-finite number.')
  if (schema.type === 'object') {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) fail('TASK_SCHEMA_MISMATCH', `Missing ${key}.`)
    for (const [key, item] of Object.entries(record)) {
      const field = schema.properties?.[key]
      if (!field) fail('TASK_SCHEMA_MISMATCH', `Unknown ${key}.`)
      validateValue(Schema.parse(field), item, depth + 1)
    }
  } else if (schema.type === 'array') {
    if (!schema.items) fail('TASK_SCHEMA_INVALID', 'Array schema needs items.')
    if ((value as unknown[]).length > 100_000) fail('TASK_SCHEMA_LIMIT', 'Array too large.')
    for (const item of value as unknown[]) validateValue(Schema.parse(schema.items), item, depth + 1)
  }
}
export function validateSchema(schema: Shape, depth = 0): void {
  if (depth > 16) fail('TASK_SCHEMA_LIMIT', 'Schema is too deep.')
  if (schema.type === 'object') {
    if (!schema.properties || schema.additionalProperties !== false || Object.keys(schema.properties).length > 100) fail('TASK_SCHEMA_INVALID', 'Object needs bounded properties and additionalProperties=false.')
    for (const key of schema.required ?? []) if (!Object.hasOwn(schema.properties, key)) fail('TASK_SCHEMA_INVALID', 'Unknown required field.')
    for (const child of Object.values(schema.properties)) validateSchema(Schema.parse(child), depth + 1)
  } else if (schema.type === 'array') {
    if (!schema.items) fail('TASK_SCHEMA_INVALID', 'Array needs items.')
    validateSchema(Schema.parse(schema.items), depth + 1)
  } else if (schema.properties || schema.items || schema.required) fail('TASK_SCHEMA_INVALID', 'Unexpected schema fields.')
}

export interface ToolArtifact extends Omit<Definition, 'firstInput' | 'examples'> { toolRef: string; digest: string; createdAt: string; checks: { compiled: true; examples: 'passed' | 'not-run' } }
/** The existing journal supplies owner binding, immutable IDs and restart persistence. */
export class TaskToolCatalog {
  constructor(private readonly store: LispStore) {}
  async get(owner: LispOwner, ref: string): Promise<ToolArtifact> {
    const row = await this.store.get(owner, z.uuid().parse(ref))
    if (!row || row.kind !== 'task_tool' || row.state !== 'SUCCEEDED' || !row.result) fail('TASK_TOOL_MISSING', 'Task tool is unavailable to this owner.')
    if (Date.now() - Date.parse(row.updated_at) > 30 * 86400_000) fail('TASK_TOOL_EXPIRED', 'Task tool expired.')
    const artifact = JSON.parse(row.payload) as ToolArtifact
    if (artifact.toolRef !== ref || artifact.digest !== digest({ name: artifact.name, description: artifact.description, source: artifact.source,
      inputSchema: artifact.inputSchema, outputSchema: artifact.outputSchema, dependencies: artifact.dependencies })) fail('TASK_TOOL_CORRUPT', 'Task tool manifest changed.')
    return artifact
  }
  async closure(owner: LispOwner, dependencies: Definition['dependencies']): Promise<Map<string, ToolArtifact>> {
    const resolved = new Map<string, ToolArtifact>(), visiting = new Set<string>()
    const visit = async (ref: string, depth: number): Promise<void> => {
      if (depth > 16 || resolved.size > 128) fail('TASK_DEPENDENCY_LIMIT', 'Too many task dependencies.')
      if (visiting.has(ref)) fail('TASK_DEPENDENCY_CYCLE', 'Task dependency cycle.')
      if (resolved.has(ref)) return
      visiting.add(ref)
      const item = await this.get(owner, ref)
      for (const child of item.dependencies) await visit(child.toolRef, depth + 1)
      visiting.delete(ref); resolved.set(ref, item)
    }
    for (const dependency of dependencies) await visit(dependency.toolRef, 0)
    return resolved
  }
  async save(owner: LispOwner, definition: Definition): Promise<ToolArtifact> {
    validateSchema(definition.inputSchema); validateSchema(definition.outputSchema)
    if (new Set(definition.dependencies.map(d => d.binding)).size !== definition.dependencies.length) fail('TASK_DEPENDENCY_DUPLICATE', 'Dependency bindings must be unique.')
    await this.closure(owner, definition.dependencies)
    const { firstInput: _firstInput, examples: _examples, ...manifest } = definition
    const artifact: ToolArtifact = { ...manifest, toolRef: randomUUID(), digest: digest(manifest), createdAt: new Date().toISOString(), checks: { compiled: true, examples: definition.examples.length ? 'passed' : 'not-run' } }
    await this.store.reserve(owner, artifact.toolRef, 'task_tool', artifact.digest, 'host', artifact)
    await this.store.transition(owner, artifact.toolRef, ['RUNNING'], 'SUCCEEDED', { toolRef: artifact.toolRef, checks: artifact.checks })
    return artifact
  }
  /** Only validated identifier bindings become Lisp source; exact refs select bodies. */
  async executable(owner: LispOwner, artifact: Pick<ToolArtifact, 'source' | 'dependencies'>): Promise<string> {
    const closure = await this.closure(owner, artifact.dependencies)
    const expression = (item: Pick<ToolArtifact, 'source' | 'dependencies'>): string => {
      const bindings = item.dependencies.map(dep => {
        const target = closure.get(dep.toolRef)
        if (!target) fail('TASK_DEPENDENCY_MISSING', 'Dependency is unavailable.')
        return `(${dep.binding} (input) (funcall ${expression(target)} input))`
      })
      return bindings.length ? `(lambda (input) (flet (${bindings.join(' ')}) (funcall ${item.source} input)))` : item.source
    }
    return expression(artifact)
  }
}
