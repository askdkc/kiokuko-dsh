import { randomUUID } from 'node:crypto'
import { loadedPluginEvidence } from './plugin-evidence.js'
import { runtimeEvidence } from './runtime-evidence.js'
import type { ToolExposureConfig, ToolExposureMetrics } from './tool-exposure.js'

export interface ToolExposureContext {
  agentId: string; sessionId: string | null; runId: string | null; turn: number | null; nativeSeq: number | null
  prepareGeneration: number | null; closed: boolean | null; failed: boolean | null
  taskType: string | null; intakeStatus: string | null; selectionStatus: string | null; policyKnown: boolean
  nativeTurn?: number | null; step?: number | null; policyPhase?: string | null; selectionMode?: string | null
  failure?: Record<string, unknown>
}

/** Deduplicate per observation identity — one warning per (session, turn, reason),
 *  never per step: step and nativeSeq stay in the logged context but are excluded
 *  from the identity key. Retention of distinct keys stays bounded. */
const identityKey = (context: ToolExposureContext): string => JSON.stringify([
  context.agentId, context.sessionId, context.runId, context.turn, context.nativeTurn ?? null,
  context.prepareGeneration, context.closed, context.failed, context.taskType, context.intakeStatus,
  context.selectionStatus, context.policyKnown, context.policyPhase ?? null, context.selectionMode ?? null,
  context.failure === undefined ? null : JSON.stringify(context.failure)])

/** Deduplicate within one binding, not across unrelated sessions, and bound retained keys. */
export function createToolExposureDiagnostics(config: () => ToolExposureConfig,
  output = { warn: (line: string) => console.warn(line), info: (line: string) => console.info(line) }) {
  const seen = new Set<string>(), instanceId = randomUUID()
  let sequence = 0
  const runtime = { ...runtimeEvidence(), ...loadedPluginEvidence }
  const write = (kind: 'fallback' | 'projection', value: Record<string, unknown>, context: ToolExposureContext) => {
    const body = { ...value, context }
    const key = JSON.stringify([kind, value.requestedMode, 'mode' in value ? value.mode ?? null : null,
      'reason' in value ? value.reason ?? null : null, identityKey(context)])
    if (seen.has(key)) return
    if (seen.size >= 512) seen.delete(seen.values().next().value!)
    seen.add(key)
    const diagnostic = JSON.stringify({ ...body, schema: 'kiokuko.tool-exposure.v1', diagnosticId: `${instanceId}:${++sequence}`, timestamp: new Date().toISOString(), runtime })
    if (kind === 'fallback') output.warn(`[kiokuko-dsh] [warn] toolExposure left the native surface unchanged: ${value.requestedMode}:${value.reason} ${diagnostic}`)
    else output.info(`[kiokuko-dsh] toolExposure projection ${diagnostic}`)
  }
  return {
    fallback(reason: string, context: ToolExposureContext) {
      if (config().mode !== 'full') write('fallback', { requestedMode: config().mode, mode: 'full', reason }, context)
    },
    projection(mode: 'lean' | 'minimal', reason: string, metrics: ToolExposureMetrics, context: ToolExposureContext) {
      if (['lean', 'auto'].includes(config().mode)) write('projection', { requestedMode: config().mode, mode, reason, ...metrics }, context)
    },
  }
}
