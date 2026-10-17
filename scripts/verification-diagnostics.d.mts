export interface CommandInput { point: string; command?: string; result: unknown }
export interface AdmissionInput { point: string; requests: readonly unknown[]; events: readonly unknown[]; expectedRounds: number; pendingResponses?: number; status?: unknown; error?: unknown; turnFailed?: boolean }
export function reasonSummary(value: unknown): Record<string, unknown>;
export function commandDiagnostic(input: CommandInput): Record<string, unknown>;
export function admissionDiagnostic(input: AdmissionInput): Record<string, unknown>;
export function requireCommandSuccess(input: CommandInput): Record<string, unknown>;
export function requireAdmissionRounds(input: AdmissionInput): Record<string, unknown>;
export function processDiagnostic(input: {point: string; success?: boolean; error?: unknown; stderr?: unknown; elapsedMs?: number; timeoutMs?: number; timedOut?: boolean | null}): Record<string, unknown>;
export function observeProcess(run: (signal: AbortSignal) => Promise<unknown>, options: {point: string; timeoutMs: number; now?: () => number; schedule?: (callback: () => void, delay: number) => unknown; clear?: (timer: unknown) => void}): Promise<{ok: boolean; diagnostic: Record<string, unknown>}>;
