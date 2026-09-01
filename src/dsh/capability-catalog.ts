import { KiokukoError } from '../errors.js'
import { canonicalContentHash, compareCanonicalStrings } from '../serialization/validate.js'
import { STANDARD_SKILL_MANIFESTS } from '../setup/standard-skills.js'

export const DSH_CAPABILITY_CATALOG_VERSION = 1 as const

export interface DshCapabilityDescriptor {
  readonly kind: 'skill' | 'mcp_tool'
  readonly name: string
  readonly description?: string
}

export interface DshCapabilityCatalog {
  readonly version: typeof DSH_CAPABILITY_CATALOG_VERSION
  readonly complete: true
  readonly skills: readonly DshCapabilityDescriptor[]
  readonly tools: readonly DshCapabilityDescriptor[]
  readonly digest: string
}

export type DshCapabilitySnapshot =
  | readonly unknown[]
  | { readonly skills: readonly unknown[]; readonly tools: readonly unknown[] }

function conflict(message: string): never {
  throw new KiokukoError('CONFLICT', message)
}

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function descriptor(kind: 'skill' | 'mcp_tool', value: unknown): DshCapabilityDescriptor {
  if (!isRecord(value)) validation('Capability descriptor must be a plain object')
  const allowed = new Set(['kind', 'name', 'description', 'source', 'provider', 'rank', 'locator', 'resourceBase', 'invocation', 'parameters', 'inputSchema', 'output'])
  if (Object.keys(value).some((key) => !allowed.has(key))) validation('Capability descriptor contains an unknown field')
  if (value.kind !== undefined && value.kind !== kind) conflict('Capability descriptor kind differs from its snapshot lane')
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.trim() !== value.name || value.name.length > 300 || /[\p{Cc}\p{Cf}]/u.test(value.name)) {
    validation('Capability descriptor name is invalid')
  }
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 2_000 || /[\p{Cc}\p{Cf}]/u.test(value.description))) {
    validation('Capability descriptor description is invalid')
  }
  return Object.freeze({
    kind,
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
  })
}

function expectedSkillOrder(): readonly string[] {
  return STANDARD_SKILL_MANIFESTS.map((manifest) => manifest.name)
}

function assertUnique(descriptors: readonly DshCapabilityDescriptor[]): void {
  const seen = new Set<string>()
  for (const item of descriptors) {
    const key = `${item.kind}\u0000${item.name}`
    if (seen.has(key)) conflict(`Duplicate capability descriptor: ${item.kind}/${item.name}`)
    seen.add(key)
  }
}

function assertStableOrder(skills: readonly DshCapabilityDescriptor[], tools: readonly DshCapabilityDescriptor[]): void {
  const mandatory = expectedSkillOrder()
  if (skills.length < mandatory.length || mandatory.some((name, index) => skills[index]?.name !== name)) {
    conflict('Mandatory bundled Skill catalog is incomplete or reordered')
  }
  const extras = skills.slice(mandatory.length).map((item) => item.name)
  if (extras.some((name, index) => index > 0 && compareCanonicalStrings(extras[index - 1]!, name) > 0)) {
    conflict('Additional Skill catalog entries are reordered')
  }
  if (tools.some((item, index) => index > 0 && compareCanonicalStrings(tools[index - 1]!.name, item.name) > 0)) {
    conflict('Tool catalog entries are reordered')
  }
}

function digestInput(skills: readonly DshCapabilityDescriptor[], tools: readonly DshCapabilityDescriptor[]): object {
  return { version: DSH_CAPABILITY_CATALOG_VERSION, skills, tools }
}

export function dshCapabilityCatalogDigest(catalog: Pick<DshCapabilityCatalog, 'skills' | 'tools'>): string {
  return canonicalContentHash(digestInput(catalog.skills, catalog.tools))
}

/** Convert one complete dsh skill/tool snapshot into a bound, immutable catalog. */
export function createDshCapabilityCatalog(snapshot: DshCapabilitySnapshot): DshCapabilityCatalog {
  const lanes = Array.isArray(snapshot)
    ? snapshot.every((item) => isRecord(item) && (item.kind === undefined || item.kind === 'skill' || item.kind === 'mcp_tool'))
      ? { skills: snapshot.filter((item) => isRecord(item) && (item.kind === undefined || item.kind === 'skill')), tools: snapshot.filter((item) => isRecord(item) && item.kind === 'mcp_tool') }
      : null
    : isRecord(snapshot) && Array.isArray(snapshot.skills) && Array.isArray(snapshot.tools)
      ? snapshot
      : null
  if (lanes === null) validation('Capability snapshot must contain complete skill and tool lanes')
  const skills = lanes.skills.map((item) => descriptor('skill', item))
  const tools = lanes.tools.map((item) => descriptor('mcp_tool', item))
  assertUnique([...skills, ...tools])
  assertStableOrder(skills, tools)
  const catalog = {
    version: DSH_CAPABILITY_CATALOG_VERSION,
    complete: true as const,
    skills: Object.freeze(skills),
    tools: Object.freeze(tools),
    digest: dshCapabilityCatalogDigest({ skills, tools }),
  }
  return Object.freeze(catalog)
}

/** Reject partial, stale, disposed, tampered, or reordered catalogs before side effects. */
export function assertCompleteDshCapabilityCatalog(value: unknown): asserts value is DshCapabilityCatalog {
  if (!isRecord(value) || value.version !== DSH_CAPABILITY_CATALOG_VERSION || value.complete !== true
    || !Array.isArray(value.skills) || !Array.isArray(value.tools)
    || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.digest)) {
    conflict('Capability catalog is incomplete or unavailable')
  }
  const rebuilt = createDshCapabilityCatalog({ skills: value.skills, tools: value.tools })
  if (rebuilt.digest !== value.digest) conflict('Capability catalog digest changed')
}

export function assertDshCapabilityCatalogStable(expected: DshCapabilityCatalog, current: unknown): void {
  assertCompleteDshCapabilityCatalog(current)
  if (current.digest !== expected.digest) conflict('Capability catalog changed during the dsh turn')
}
