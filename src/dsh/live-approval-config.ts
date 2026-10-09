import Schema from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import type { Context } from '@deepseek-ai/cordis'
import type { z } from 'zod'
type ApprovalMode = 'ask' | 'auto'

export const APPROVAL_CONFIG_SERVICE = 'kiokukoLispApprovalConfig'
export interface ApprovalConfigSource { namespace: string; path: string[]; mode(): ApprovalMode }

/** The native Loader owns live references; business validation remains in Zod. */
export function nativeApprovalConfig<T extends z.ZodObject>(schema: T, path = ['lisp', 'approvalMode']) {
  const fields = Object.fromEntries(Object.keys(schema.shape).map(key => [key, Schema.any()]))
  let live = Schema.union([Schema.const('ask'), Schema.const('auto')]).default('auto').volatile() as Schema
  for (const key of [...path].reverse()) live = Schema.object({ [key]: live })
  const native = Schema.object({ ...fields, ...live.dict })
  return Object.assign(native, { parse: schema.parse.bind(schema), safeParse: schema.safeParse.bind(schema) })
}

/** Strip only the trusted native reference before passing values to Zod. */
export function bindApprovalConfig<T>(ctx: Context, input: T, path = ['lisp', 'approvalMode']): T {
  const valueAt = (value: unknown, keys: string[]): any => keys.reduce((node: any, key) => node?.[key], value)
  const reference = valueAt(input, path)
  if (!isVolatile(reference)) return input
  const namespace = (ctx.fiber as unknown as { entry?: { options: { id: string } } }).entry?.options.id
  if (namespace) ctx.provide(APPROVAL_CONFIG_SERVICE, { namespace, path, mode: () => reference.get() as ApprovalMode } satisfies ApprovalConfigSource)
  const replace = (node: any, keys: string[]): any => keys.length ? { ...node, [keys[0]!]: replace(node?.[keys[0]!], keys.slice(1)) } : reference.get()
  return replace(input, path)
}
