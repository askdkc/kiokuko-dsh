import { isAbsolute, relative, posix } from 'node:path'
import { canonicalContentHash } from '../serialization/validate.js'
import { findSecret } from '../memory/secrets.js'
import type { EnnoOdunoState, EnnoRole, EnnoStatus } from './types.js'

export interface MemorySignals { errors: string[]; paths: string[]; identifiers: string[] }
export interface EnnoMemoryFocus {
  readonly version: 1
  readonly role: EnnoRole | null
  readonly phase: EnnoStatus
  readonly workUnitObjective: string | null
  readonly targetPaths: string[]
  readonly observedErrorSignals: string[]
  readonly observedIdentifiers: string[]
  readonly constraints: string
  readonly userConstraintDigest: string
  readonly retrievalDomainDigest: string
  readonly rankingFocusDigest: string
}

function wellFormed(value: string): string { return value.replace(/[\uD800-\uDFFF]/gu, '\uFFFD') }
function bounded(value: string): string {
  return Array.from(wellFormed(value.slice(0, 768)).normalize('NFC')).slice(0, 192).join('').trim()
}
export function memoryRelativePath(value: string, root: string): string | undefined {
  if (value.length > 4096 || findSecret(value) !== undefined || value.includes('\\')) return undefined
  const path = posix.normalize(isAbsolute(value) ? relative(root, value) : value.replace(/^\.\//u, ''))
  if (path === '..' || path.startsWith('../') || isAbsolute(path) || path === '.' || /[\p{C}\s]/u.test(path)) return undefined
  return Array.from(path).length <= 192 ? path : undefined
}

/** Only scan fixed windows of known result fields, never stringify/traverse arbitrary output. */
export function extractMemorySignals(result: unknown, root: string): MemorySignals {
  const empty: MemorySignals = { errors: [], paths: [], identifiers: [] }
  if (!result || typeof result !== 'object') return empty
  const r = result as { value?: { exitCode?: unknown; exit_code?: unknown; kind?: unknown; stdout?: unknown; stderr?: unknown;
    timedOut?: unknown; aborted?: unknown; signal?: unknown; spawnFailed?: unknown }; content?: unknown; isError?: unknown }
  const value = r.value, exit = value?.exitCode ?? value?.exit_code
  const interrupted = value?.timedOut === true || value?.aborted === true || value?.spawnFailed === true
    || typeof value?.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/u.test(value.signal)
  if (!value || value.kind === 'background' || !interrupted && (!Number.isSafeInteger(exit) || exit === 0)) return empty
  const strings: string[] = []
  let remaining = 8192
  const take = (source: unknown) => {
    if (typeof source !== 'string' || remaining <= 0) return
    // Slice before encoding, so even multi-megabyte outputs have bounded scan cost.
    const window = source.length > 2048 ? source.slice(0, 1024) + '\n' + source.slice(-1024) : source
    let text = ''; for (const point of wellFormed(window)) {
      const bytes = Buffer.byteLength(point); if (bytes > remaining) break
      text += point; remaining -= bytes
    }
    if (findSecret(text) === undefined) strings.push(text)
  }
  take(value.stderr); take(value.stdout)
  if (Array.isArray(r.content)) for (const block of r.content.slice(0, 8)) {
    if (block?.type === 'text') take(block.text)
  }
  const text = strings.join('\n')
  const errors = [...new Set(text.match(/\b(?:E_[A-Z0-9_]{2,80}|ERR_[A-Z0-9_]{2,80}|SQLITE_[A-Z_]{2,80}|TS\d{3,5}|E[A-Z]{3,30})\b/gu) ?? [])].slice(0, 16)
  const paths = [...new Set((text.match(/(?:\.?\.?\/|\b)[\w@./-]+\.[a-zA-Z0-9]{1,8}\b/gu) ?? [])
    .filter(path => !/@\d/u.test(path)).map(path => memoryRelativePath(path, root)).filter((path): path is string => path !== undefined))].slice(0, 16 - errors.length)
  const identifiers = [...new Set(text.match(/(?:@[a-z0-9_-]+\/)?[a-z][a-z0-9_.-]*@\d+\.\d+(?:\.\d+)?/gu) ?? [])].slice(0, 16 - errors.length - paths.length)
  return { errors, paths, identifiers }
}

export function mergeMemorySignals(previous: MemorySignals, incoming: MemorySignals): MemorySignals {
  let remaining = 16
  const merge = (old: string[], next: string[]) => {
    const values = [...new Set([...old, ...next].map(bounded).filter(Boolean))].slice(-remaining)
    remaining -= values.length
    return remaining < 0 ? [] : values
  }
  const errors = merge(previous.errors, incoming.errors)
  const paths = remaining ? merge(previous.paths, incoming.paths) : []
  const identifiers = remaining ? merge(previous.identifiers, incoming.identifiers) : []
  return { errors, paths, identifiers }
}

/** Semantic identity excludes call IDs, revisions, counters and delivery metadata. */
export function buildEnnoMemoryFocus(input: { state: EnnoOdunoState; root: string; signals: MemorySignals;
  constraints: string; characterBudget: number }): EnnoMemoryFocus {
  const unit = input.state.directive?.workUnit
  const errors = [...input.signals.errors].sort().slice(0, 16)
  const targetPaths = [...new Set([...(unit?.scope ?? []), ...input.signals.paths]
    .map(path => memoryRelativePath(path, input.root)).filter((path): path is string => path !== undefined))].sort().slice(0, 16 - errors.length)
  const identifiers = [...input.signals.identifiers].sort().slice(0, 16 - errors.length - targetPaths.length)
  const objective = unit?.objective ?? null
  const constraints = wellFormed(input.constraints).normalize('NFC').trim()
  const userConstraintDigest = canonicalContentHash(constraints)
  return { version: 1, role: input.state.currentRole, phase: input.state.status,
    workUnitObjective: objective, targetPaths, observedErrorSignals: errors, observedIdentifiers: identifiers,
    constraints, userConstraintDigest,
    retrievalDomainDigest: canonicalContentHash({ objective, targetPaths, errors, identifiers, userConstraintDigest }),
    rankingFocusDigest: canonicalContentHash({ role: input.state.currentRole, phase: input.state.status, budget: input.characterBudget }) }
}
