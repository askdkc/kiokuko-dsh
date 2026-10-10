import { createRequire, findPackageJSON } from 'node:module'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// The npm distribution owns these bundled libraries. Keep its SDK types behind
// this narrow boundary so consumers need no independently published scoped SDK.
export interface Manifest {
  schema_version: string
  run_id: string
  agenticreplay_version: string
  ended_at?: string
  counts?: { events: number; blobs: number }
  integrity?: { events_sha256: string; blob_count: number }
}
export interface TraceEvent {
  seq: number
  ts: string
  mono_us: number
  turn: number
  type: string
  actor: string
  attrs?: Record<string, unknown>
  payload?: unknown
  causes?: number[]
}
export interface EventInit {
  type: 'run.start' | 'run.end' | 'model.request' | 'model.response' | 'tool.call' | 'tool.result' | 'note' | 'error'
  actor: 'harness' | 'model' | 'tool'
  causes?: number[]
  attrs?: Record<string, unknown>
  payload?: Record<string, unknown>
  occurredAt?: Date
}
export interface TraceWriter {
  readonly runDir: string
  append(event: EventInit): Promise<TraceEvent>
  close(): Promise<Manifest>
}
export type CreateTraceWriter = (runsDir: string, init: {
  runId?: string; adapter: { id: string }; argv: string[]; cwd: string
  agenticreplayVersion: string; envAllowlist?: string[]
}) => Promise<TraceWriter>
export interface CoreLibrary {
  TraceWriter: { create: CreateTraceWriter }
  TraceReader: { open(runDir: string): Promise<{ events(): Promise<TraceEvent[]> }> }
  ensureRunsDir(root: string): Promise<string>
}
export interface SchemaLibrary {
  assertManifest(value: unknown): asserts value is Manifest
  assertEvent(value: unknown): asserts value is TraceEvent
  isBlobRef(value: unknown): value is { $blob: string; bytes: number }
}
export interface ViewerLibrary {
  buildTimeline(events: TraceEvent[]): Record<string, unknown>[]
  exportTraceHtml(runDir: string, output: string, options?: {
    maxBlobBytes?: number; maxInlineChars?: number
  }): Promise<{ bytes: number }>
}
interface Libraries { core: CoreLibrary; schema: SchemaLibrary; viewer: ViewerLibrary }

/** Resolve from the distribution that declares/bundles the SDK, never a global installation. */
function distributionRequire() {
  return createRequire(import.meta.resolve('agenticreplay'))
}
export async function loadAgenticReplayLibrary<K extends keyof Libraries>(name: K): Promise<Libraries[K]> {
  const entry = distributionRequire().resolve(`@agenticreplay/${name}`)
  return import(pathToFileURL(entry).href) as Promise<Libraries[K]>
}
export async function installedAgenticReplayCoreVersion(): Promise<string> {
  const owner = distributionRequire()
  const path = findPackageJSON('@agenticreplay/core', owner.resolve('@agenticreplay/core'))
  if (!path) throw new Error('AgenticReplay core package metadata unavailable')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  if (manifest.name !== '@agenticreplay/core' || typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('Invalid AgenticReplay core package metadata')
  }
  return manifest.version
}
