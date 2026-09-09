import { digest } from '../memory/evolution/contracts.js'

export const EVOLUTION_OBSERVATION_EVENT = 'kiokuko/evolution-observation'
export interface EvolutionObservationBinding { runId: string; workspace: string; sessionId: string }
export interface EvolutionObservation extends EvolutionObservationBinding {
  schemaVersion: 1; callId: string; callSeq: number; exitCode: number | null; failed: boolean; presentationHash: string
}
function record(value: unknown): Record<string,unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined
}
export function toolPresentationHash(result: { content: unknown; isError: boolean; meta?: unknown; error?: unknown }): string {
  return digest({content:result.content,isError:result.isError,meta:result.meta??null,error:result.error??null})
}
/** The final tools/result observer has a typed value; the native text log often omits exitCode. */
export function executionObservation(binding: EvolutionObservationBinding, callId: string, callSeq: number, result: unknown): EvolutionObservation | undefined {
  const r=record(result),value=record(r?.value),exitCode=value?.exitCode ?? value?.exit_code
  if (!r || !value || value.kind === 'background' || !Array.isArray(r.content)) return undefined
  const interrupted=value.timedOut===true || value.aborted===true || value.signal!==undefined && value.signal!==null
  if (!Number.isSafeInteger(exitCode) && !interrupted) return undefined
  return {...binding,schemaVersion:1,callId,callSeq,exitCode:Number.isSafeInteger(exitCode) ? exitCode as number : null,
    failed:r.isError===true || exitCode!==0 || interrupted,
    presentationHash:toolPresentationHash({content:r.content,isError:r.isError===true,meta:r.meta,error:record(r.error)?.info})}
}
export function observationMatchesResult(observation: EvolutionObservation, data: unknown): boolean {
  const r=record(data),message=record(r?.message),content=message?.content
  if (!Array.isArray(content) || content.length!==1) return false
  const block=record(content[0])
  return block?.type==='tool-result' && block.toolCallId===observation.callId &&
    toolPresentationHash({content:block.content,isError:block.isError===true,meta:r?.meta,error:r?.error})===observation.presentationHash
}
