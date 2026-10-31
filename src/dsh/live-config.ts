import Schema from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import type { Context } from '@deepseek-ai/cordis'
import type { z } from 'zod'
import { STARTUP_DEFAULTS_SERVICE, type StartupDefaults, type StartupMode } from './startup-defaults.js'
import type { DecisionConfiguration } from './decisions/config.js'

export const APPROVAL_CONFIG_SERVICE = 'kiokukoLispApprovalConfig'
export const DECISION_PROVIDER_SERVICE = 'kiokukoDecisionProvider'
export type ApprovalMode = 'ask' | 'auto'
export interface ApprovalConfigSource { namespace: string; path: string[]; mode(): ApprovalMode }
export interface DecisionProviderSource { configured(): DecisionConfiguration['provider'] }

/** One leaf the native settings form may edit without replacing the section. */
export interface LivePath { readonly path: readonly string[]; readonly schema: Schema }

const leaf = (values: readonly string[], fallback: string) =>
  Schema.union(values.map(value => Schema.const(value))).default(fallback).volatile() as Schema

export const LISP_APPROVAL_PATH: LivePath = { path: ['lisp', 'approvalMode'], schema: leaf(['ask', 'auto'], 'ask') }
export const STARTUP_DECISION_PATH: LivePath = { path: ['startupDefaults', 'decision'], schema: leaf(['ask', 'on', 'off'], 'ask') }
export const STARTUP_LISP_PATH: LivePath = { path: ['startupDefaults', 'lisp'], schema: leaf(['ask', 'on', 'off'], 'ask') }
export const DECISION_PROVIDER_PATH: LivePath = { path: ['typedDecisions', 'provider'], schema: leaf(['typesafe', 'nimble', 'laya-coreml', 'openai'], 'typesafe') }
export const KIOKUKO_LIVE_PATHS: readonly LivePath[] = [LISP_APPROVAL_PATH, STARTUP_DECISION_PATH, STARTUP_LISP_PATH, DECISION_PROVIDER_PATH]

interface TreeNode { leaf?: Schema; children?: Record<string, TreeNode> }

function grow(paths: readonly LivePath[]): TreeNode {
  const root: TreeNode = {}
  for (const { path, schema } of paths) {
    let node = root
    for (const key of path.slice(0, -1)) {
      node.children ??= {}
      node = node.children[key] ??= {}
    }
    const last = path[path.length - 1]!
    if (node.children?.[last] !== undefined) throw new Error(`Conflicting live settings path: ${path.join('.')}`)
    node.children ??= {}
    node.children[last] = { leaf: schema }
  }
  return root
}

function toSchema(node: TreeNode): Record<string, Schema> {
  return Object.fromEntries(Object.entries(node.children ?? {}).map(([key, child]) =>
    [key, child.leaf ?? Schema.object(toSchema(child))]))
}

/**
 * The native Loader owns live references; business validation remains in Zod.
 * Every declared leaf is editable from the plugin's own settings form while the
 * rest of the section is preserved.
 */
export function nativeLiveConfig<T extends z.ZodObject>(schema: T, paths: readonly LivePath[] = KIOKUKO_LIVE_PATHS) {
  const fields = Object.fromEntries(Object.keys(schema.shape).map(key => [key, Schema.any()]))
  const native = Schema.object({ ...fields, ...toSchema(grow(paths)) })
  return Object.assign(native, { parse: schema.parse.bind(schema), safeParse: schema.safeParse.bind(schema) })
}

const valueAt = (value: unknown, keys: readonly string[]): any => keys.reduce((node: any, key) => node?.[key], value)

function replaceAt(node: any, keys: readonly string[], value: unknown): any {
  return keys.length === 0 ? value : { ...node, [keys[0]!]: replaceAt(node?.[keys[0]!], keys.slice(1), value) }
}

/**
 * Replace trusted native references with their current values before business
 * validation, and publish the live sources for running components.
 */
export function bindLiveConfig<T>(ctx: Context, input: T, paths: readonly LivePath[] = KIOKUKO_LIVE_PATHS): T {
  const read = (path: readonly string[]): any => {
    const reference = valueAt(input, path)
    return isVolatile(reference) ? reference.get() : reference
  }
  let bound: unknown = input
  for (const { path } of paths) if (isVolatile(valueAt(input, path))) bound = replaceAt(bound, path, read(path))
  const namespace = (ctx.fiber as unknown as { entry?: { options: { id: string } } }).entry?.options.id
  if (namespace) {
    ctx.provide(APPROVAL_CONFIG_SERVICE, { namespace, path: [...LISP_APPROVAL_PATH.path],
      mode: () => read(LISP_APPROVAL_PATH.path) as ApprovalMode } satisfies ApprovalConfigSource)
    ctx.provide(STARTUP_DEFAULTS_SERVICE, {
      decision: () => read(STARTUP_DECISION_PATH.path) as StartupMode,
      lisp: () => read(STARTUP_LISP_PATH.path) as StartupMode,
    })
    ctx.provide(DECISION_PROVIDER_SERVICE, {
      configured: () => read(DECISION_PROVIDER_PATH.path) as DecisionConfiguration['provider'],
    } satisfies DecisionProviderSource)
  }
  return bound as T
}

/** Defaults for a new task, preferring the live profile value over the parsed one. */
export function readStartupDefaults(ctx: { get(name: string, strict?: false): unknown }, fallback: StartupDefaults): StartupDefaults {
  const source = ctx.get(STARTUP_DEFAULTS_SERVICE, false) as
    { decision(): StartupMode; lisp(): StartupMode } | undefined
  return source ? { decision: source.decision(), lisp: source.lisp() } : fallback
}
