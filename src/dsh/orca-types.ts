import type { OrcaConfig } from './config.js'
import type { DshOrcaRecorder } from './orca-recorder.js'
import type { DshOrcaStore } from './orca-store.js'

export interface DshOrcaBinding {
  readonly sessionId: string
  readonly workspaceRoot: string
  readonly sessionCwd: string
  readonly storeRoot: string
  readonly kiokukoRunId?: string
}
export type OrcaState = 'starting' | 'recording' | 'finalizing' | 'completed' | 'incomplete' | 'failed'
export interface OrcaTrace {
  orca_run_id: string
  dsh_session_id: string
  recorder_instance_id: string
  recording_generation: string
  workspace_key: string
  store_root: string
  session_cwd: string
  capture_format_version: number
  state: OrcaState
  started_at: string
  ended_at: string | null
  last_error_code: string | null
  missing_event_count: number
  unresolved_call_count: number
  event_count: number
  recorded_bytes: number
  export_input_bytes: number
}
export type WithOrcaIndex = <T>(operation: (store: DshOrcaStore) => T | PromiseLike<T>) => Promise<T>
export interface DshOrcaHostServices {
  readonly config: OrcaConfig
  resolveSessionBinding(agent: object, session: object): DshOrcaBinding | undefined
  resolveModelBinding(sessionId: string): DshOrcaBinding | undefined
  canRecord(binding: DshOrcaBinding): boolean
  sessionRecordingStatus(binding: DshOrcaBinding): Promise<{ sessionRecording: string; selectionError?: string }>
  setSessionRecording(binding: DshOrcaBinding, enabled: boolean): Promise<void>
  readonly withIndex: WithOrcaIndex
  readonly recorder: DshOrcaRecorder
  closeSessionRecording(sessionId: string, reason: string): Promise<void>
  shutdown(): Promise<void>
}
/** Structural subset verified against DSH 0.1.2-rc.1. No runtime DSH dependency. */
export interface OrcaToolExecution {
  readonly token: symbol
  readonly parent?: symbol
  readonly callId: string
  readonly rootCallId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: { readonly session?: object }
}
export class OrcaError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'OrcaError' }
}
export function orcaErrorCode(error: unknown): string {
  if (error instanceof OrcaError) return error.code
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' ? code : 'recording_io_failed'
}
