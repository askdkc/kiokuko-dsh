import type { RoutableAgent } from './model-routing.js'

export interface NativeSchema { readonly name: string; readonly description?: string; readonly parameters?: unknown }
interface Definition extends NativeSchema { readonly execute: unknown; readonly [key: string]: unknown }
interface Registry {
  schemas(scope: object): readonly NativeSchema[]
  get(name: string, scope?: object): Definition | undefined
  register(definition: Definition): () => void
  restrict(filter: { deny: string[] }): () => void
}

interface CatalogView { order: readonly string[]; registry: Registry; originals: ReadonlyMap<string, { schema: NativeSchema; definition: Definition }> }
const catalogs = new WeakMap<object, CatalogView>()

/** Intake binds installed capabilities, independently of the current model presentation. */
export function stableNativeToolCapabilities(schemas: readonly NativeSchema[], agent: object): readonly NativeSchema[] {
  const catalog = catalogs.get(agent)
  if (!catalog) return schemas
  const result = new Map<string, NativeSchema>(schemas.map(schema => [schema.name, schema]))
  for (const [name, original] of catalog.originals) {
    const global = catalog.registry.get(name)
    const scoped = catalog.registry.get(name, agent)
    if (global === original.definition && (!scoped || scoped.execute === original.definition.execute)) result.set(name, original.schema)
  }
  const order = new Set([...catalog.order, ...result.keys()])
  return [...order].flatMap(name => { const schema = result.get(name); return schema ? [schema] : [] })
}

/** Per-Agent views built before admission; never replace the host's executor. */
export function createNativeToolSurface(agent: RoutableAgent, owned: ReadonlyMap<string, { readonly execute: unknown }>) {
  let releases: (() => void)[] = []
  const reset = (): void => {
    catalogs.delete(agent)
    const pending = releases.splice(0).reverse()
    for (const release of pending) release()
  }
  const prepare = (project: (schemas: readonly NativeSchema[]) => readonly NativeSchema[], suppressAll = false): void => {
    reset()
    const tools = (agent.ctx as { get?(name: string, strict?: boolean): unknown } | undefined)?.get?.('tools', false) as Registry | undefined
    if (!tools?.schemas || !tools.get || !tools.register || !tools.restrict) throw new Error('Native scoped tool admission is unavailable')
    const original = tools.schemas(agent)
    const projected = suppressAll ? [] : project(original)
    if (projected === original) return
    const selected = new Map(projected.map(schema => [schema.name, schema]))
    const definitions = new Map<string, Definition>()
    for (const schema of original) {
      const expected = owned.get(schema.name)
      if (!expected && !suppressAll) continue
      const actual = tools.get(schema.name, agent)
      if (!actual || expected && actual.execute !== expected.execute) throw new Error('Native tool ownership changed before admission')
      definitions.set(schema.name, actual)
    }
    if (!definitions.size) return
    catalogs.set(agent, { order: original.map(schema => schema.name), registry: tools, originals: new Map([...definitions].map(([name, definition]) => [name, { definition, schema: original.find(schema => schema.name === name)! }])) })
    try {
      releases.push(tools.restrict({ deny: [...definitions.keys()] }))
      for (const [name, definition] of definitions) {
        const schema = selected.get(name)
        if (schema) releases.push(tools.register({ ...definition, ...schema }))
      }
    } catch (error) {
      reset()
      throw error
    }
  }
  return { prepare, dispose: reset }
}
