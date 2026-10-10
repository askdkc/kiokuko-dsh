import type { AgenticReplayConfig } from './config.js'
import type { DshAgenticReplayRecorder } from './agenticreplay-recorder.js'
import type { DshAgenticReplayStore } from './agenticreplay-store.js'

export interface DshAgenticReplayBinding {
  readonly sessionId: string
  readonly workspaceRoot: string
  readonly sessionCwd: string
  readonly storeRoot: string
  readonly kiokukoRunId?: string
}
export type AgenticReplayState = 'starting' | 'recording' | 'finalizing' | 'completed' | 'incomplete' | 'failed'
export interface AgenticReplayTrace {
  agenticreplay_run_id: string
  dsh_session_id: string
  recorder_instance_id: string
  recording_generation: string
  workspace_key: string
  store_root: string
  session_cwd: string
  capture_format_version: number
  state: AgenticReplayState
  started_at: string
  ended_at: string | null
  last_error_code: string | null
  missing_event_count: number
  unresolved_call_count: number
  event_count: number
  recorded_bytes: number
  export_input_bytes: number
}
export type WithAgenticReplayIndex = <T>(operation: (store: DshAgenticReplayStore) => T | PromiseLike<T>) => Promise<T>
export interface DshAgenticReplayHostServices {
  readonly config: AgenticReplayConfig
  resolveSessionBinding(agent: object, session: object): DshAgenticReplayBinding | undefined
  resolveModelBinding(sessionId: string): DshAgenticReplayBinding | undefined
  canRecord(binding: DshAgenticReplayBinding): boolean
  sessionRecordingStatus(binding: DshAgenticReplayBinding): Promise<{ sessionRecording: string; selectionError?: string }>
  setSessionRecording(binding: DshAgenticReplayBinding, enabled: boolean): Promise<void>
  readonly withIndex: WithAgenticReplayIndex
  readonly recorder: DshAgenticReplayRecorder
  closeSessionRecording(sessionId: string, reason: string): Promise<void>
  shutdown(): Promise<void>
}
/** Structural subset verified against DSH 0.2.1-alpha.2. No runtime DSH dependency. */
export interface AgenticReplayToolExecution {
  readonly token: symbol
  readonly parent?: symbol
  readonly callId: string
  readonly rootCallId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: { readonly session?: object }
}
export class AgenticReplayError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AgenticReplayError' }
}
export function agenticReplayErrorCode(error: unknown): string {
  if (error instanceof AgenticReplayError) return error.code
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' ? code : 'recording_io_failed'
}
