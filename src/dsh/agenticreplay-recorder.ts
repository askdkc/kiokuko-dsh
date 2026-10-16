import { randomBytes } from 'node:crypto'
import { runtimeEvidence } from './runtime-evidence.js'
import { redactionSafeWriter } from './agenticreplay-writer.js'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { loadAgenticReplayLibrary, installedAgenticReplayCoreVersion, type EventInit, type TraceWriter, type CreateTraceWriter, type CoreLibrary, type SchemaLibrary } from './agenticreplay-libraries.js'
import type { AgenticReplayConfig } from './config.js'
import { AGENTICREPLAY_CAPTURE, boundedAgenticReplayPayload, label, modelRequest, projectBlocks, record, usageAttrs, toolResultOutcome } from './agenticreplay-event-mapper.js'
import { checkPrivatePath, prepareAgenticReplayParent, workspaceKey } from './agenticreplay-security.js'
import { agenticReplayDiskBytes, scanAgenticReplayTrace } from './agenticreplay-files.js'
import { AgenticReplayError, agenticReplayErrorCode, type DshAgenticReplayBinding, type AgenticReplayToolExecution, type AgenticReplayTrace, type WithAgenticReplayIndex } from './agenticreplay-types.js'

type Ref = { seq?: number }
interface ActiveTrace {
  readonly row: AgenticReplayTrace
  readonly binding: DshAgenticReplayBinding
  runDirectory?: string
  writer?: TraceWriter
  tail: Promise<void>
  closePromise?: Promise<void>
  accepting: boolean
  sealed: boolean
  pendingBytes: number
  active: number
  waiters: Set<() => void>
  persistenceFailed: boolean
  failure?: CaptureFailureDiagnostic
  modelCleanups: Set<() => void>
  diagnosticPromise?: Promise<void>
}
interface CaptureFailureDiagnostic {
  readonly phase: string
  readonly eventType: string
  readonly callId?: string
  readonly code: string
}
interface FailureContext { readonly phase: string; readonly eventType: string; readonly callId?: string }
interface Attempt { trace: ActiveTrace; ref: Ref; id: string; started?: number; phase: string; bytes: number }
export interface AgenticReplayRecorderDependencies {
  createWriter?: CreateTraceWriter
  loadCore?: () => Promise<CoreLibrary>
  loadSchema?: () => Promise<SchemaLibrary>
  loadCoreVersion?: () => Promise<string>
}
/** Owns all writers. Observation methods never throw into the DSH pipeline. */
export class DshAgenticReplayRecorder {
  readonly instanceId = `pid_${process.pid}_${randomBytes(12).toString('hex')}`
  readonly diagnostics = { unattributed: 0, auxiliary: 0, lateResults: 0, unsupportedChunks: 0, omittedBodies: 0 }
  readonly #traces = new Map<string, ActiveTrace>()
  readonly #attempts = new Map<symbol, Attempt>()
  // Node 24 supports nonregistered symbols as weak keys. No unbounded token tombstones.
  readonly #seenTokens = new WeakSet<object>()
  #accepting = true
  #bytes = 0
  #shutdown?: Promise<void>
  #unavailable = false
  #unavailableReason: string | undefined
  constructor(readonly config: AgenticReplayConfig, readonly withIndex: WithAgenticReplayIndex, private readonly deps: AgenticReplayRecorderDependencies = {}) {}
  status(sessionId: string) {
    const trace = this.#traces.get(sessionId)
    return { capability: !this.config.enabled ? 'disabled' : this.#unavailable ? 'unavailable' : 'available',
      trace: trace === undefined ? null : { ...trace.row, ...((trace.writer?.runDir ?? trace.runDirectory) ? {run_directory:trace.writer?.runDir ?? trace.runDirectory} : {}) }, persistenceFailed: trace?.persistenceFailed ?? false,
      diagnostics: { ...this.diagnostics }, ...(trace?.failure ? { failure: { ...trace.failure } } : {}), unavailableReason: this.#unavailableReason, capture: AGENTICREPLAY_CAPTURE }
  }
  #fail(trace: ActiveTrace, code: string, context: FailureContext = { phase: 'capture', eventType: 'unknown' }) {
    trace.accepting = false
    trace.row.missing_event_count++
    trace.row.last_error_code ??= code
    if (!trace.failure) {
      const safeCode = /^[A-Za-z0-9_-]{1,64}$/u.test(code) ? code : 'capture_failure'
      let callId: string | undefined
      if (typeof context.callId === 'string' && context.callId) {
        try { callId = label(context.callId.slice(0, 128)) } catch { callId = 'unavailable' }
      }
      trace.failure = { phase: context.phase, eventType: context.eventType, ...(callId ? { callId } : {}), code: safeCode }
    }
    if (!trace.sealed) trace.row.state = trace.writer ? 'incomplete' : 'failed'
    // The event queue may have stopped. Persist a bounded independent diagnostic,
    // without retrying the failed capture or delaying the native operation.
    if (!trace.diagnosticPromise) {
      const pending = trace.tail
      trace.diagnosticPromise = pending.then(() => this.#persistDiagnostic(trace)).catch(() => { trace.persistenceFailed = true })
    }
  }
  async #persistDiagnostic(trace: ActiveTrace): Promise<void> {
    try { await this.withIndex(store => store.save({ ...trace.row })) } catch { trace.persistenceFailed = true }
    if (!trace.writer) return
    const dir = trace.writer.runDir
    const temporary = join(dir, `.capture-status-${randomBytes(12).toString('hex')}.tmp`)
    try {
      await checkPrivatePath(dir, true)
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        await handle.writeFile(JSON.stringify({ format: 'dsh.capture-status.v1', httpCapture: false,
          runId: trace.row.agenticreplay_run_id, state: trace.row.state, lastErrorCode: trace.row.last_error_code,
          failure: trace.failure,
          missingEvents: trace.row.missing_event_count, unresolvedCalls: trace.row.unresolved_call_count,
          endedAt: trace.row.ended_at }) + '\n')
        await handle.sync()
      } finally { await handle.close() }
      await rename(temporary, join(dir, 'capture-status.json'))
    } catch { trace.persistenceFailed = true }
    finally { await rm(temporary, { force: true }).catch(() => undefined) }
  }
  /** Diagnostic flush is separate from capture, including traces stopped by limits. */
  async flushDiagnostics(sessionId: string): Promise<void> {
    const trace = this.#traces.get(sessionId)
    if (!trace) return
    await trace.tail
    await trace.diagnosticPromise
  }
  #safe(trace: ActiveTrace, operation: () => void, context?: FailureContext) {
    if (trace.sealed) return
    try { operation() } catch (error) { this.#fail(trace, agenticReplayErrorCode(error), context) }
  }
  #reserve(trace: ActiveTrace, bytes: number): boolean {
    if (trace.pendingBytes + bytes > this.config.maxQueuedBytesPerTrace || this.#bytes + bytes > this.config.maxQueuedBytesTotal) {
      this.#fail(trace, 'queue_limit'); return false
    }
    trace.pendingBytes += bytes; this.#bytes += bytes; return true
  }
  #reserveBody(trace: ActiveTrace, bytes: number): boolean {
    if (trace.pendingBytes + bytes > this.config.maxQueuedBytesPerTrace || this.#bytes + bytes > this.config.maxQueuedBytesTotal) return false
    trace.pendingBytes += bytes; this.#bytes += bytes; return true
  }
  #recordOmission(trace: ActiveTrace, eventType: string, id: string, reason: string, cause?: Ref): void {
    this.diagnostics.omittedBodies++
    this.#enqueue(trace, { type: 'note', actor: 'harness', attrs: {
      diagnostic: 'content_omitted', event_type: eventType, correlation_id: label(id), omission_reason: label(reason),
    } }, cause)
  }
  #release(trace: ActiveTrace, bytes: number) { trace.pendingBytes -= bytes; this.#bytes -= bytes }
  async #save(trace: ActiveTrace) {
    try { await this.withIndex(store => store.save({ ...trace.row })) }
    catch { trace.persistenceFailed = true; this.#fail(trace, 'index_persistence_failed') }
  }
  #admit(binding: DshAgenticReplayBinding, explicit = false): ActiveTrace | undefined {
    if (!this.config.enabled || !this.#accepting || this.#unavailable) return undefined
    const existing = this.#traces.get(binding.sessionId)
    if (existing && (existing.binding.workspaceRoot !== binding.workspaceRoot || existing.binding.sessionCwd !== binding.sessionCwd || existing.binding.storeRoot !== binding.storeRoot)) return undefined
    if (existing && !explicit) return existing.accepting ? existing : undefined
    if (existing && !existing.sealed) return existing.accepting ? existing : undefined
    if ([...this.#traces.values()].filter(t => !t.sealed).length >= this.config.maxOpenTraces) throw new AgenticReplayError('open_trace_limit')
    const trace: ActiveTrace = { binding: Object.freeze({ ...binding }),
      row: { agenticreplay_run_id: `run_${randomBytes(12).toString('hex')}`, dsh_session_id: binding.sessionId,
        recorder_instance_id: this.instanceId, recording_generation: randomBytes(12).toString('hex'), workspace_key: workspaceKey(binding.workspaceRoot),
        store_root: binding.storeRoot, session_cwd: binding.sessionCwd, capture_format_version: 1, state: 'starting',
        started_at: new Date().toISOString(), ended_at: null, last_error_code: null, missing_event_count: 0,
        unresolved_call_count: 0, event_count: 0, recorded_bytes: 0, export_input_bytes: 0 },
      tail: Promise.resolve(), accepting: true, sealed: false, pendingBytes: 0, active: 0, waiters: new Set(), persistenceFailed: false, modelCleanups: new Set() }
    this.#traces.set(binding.sessionId, trace)
    trace.tail = this.#initialize(trace)
    this.#enqueue(trace, { type: 'run.start', actor: 'harness', payload: { ...AGENTICREPLAY_CAPTURE, reasoning: this.config.capture.reasoning,
      content: this.config.capture.content, runtime: runtimeEvidence() } })
    return trace
  }
  async #initialize(trace: ActiveTrace) {
    try {
      // Dependency validation precedes any filesystem/index side effects.
      let create: CreateTraceWriter
      let agenticreplayVersion: string
      try {
        const [core, , version] = await Promise.all([this.deps.loadCore?.() ?? loadAgenticReplayLibrary('core'), this.deps.loadSchema?.() ?? loadAgenticReplayLibrary('schema'), this.deps.loadCoreVersion?.() ?? installedAgenticReplayCoreVersion()])
        const factory = this.deps.createWriter ?? core.TraceWriter.create
        create = async (...args) => redactionSafeWriter(await factory(...args), core)
        agenticreplayVersion = version
      } catch { this.markUnavailable('dependency_unavailable_reinstall_package'); trace.accepting = false; this.#traces.delete(trace.binding.sessionId); return }
      await this.#save(trace)
      if (trace.persistenceFailed) return
      const runs = await prepareAgenticReplayParent(trace.binding.storeRoot)
      await mkdir(join(runs, trace.row.agenticreplay_run_id), { mode: 0o700 }) // exclusive reservation, never append to an existing run
      trace.writer = await create(runs, { runId: trace.row.agenticreplay_run_id, adapter: { id: 'kiokuko-dsh' },
        argv: [], cwd: trace.binding.sessionCwd, agenticreplayVersion, envAllowlist: [] })
      if (trace.row.last_error_code === null) trace.row.state = 'recording'
      trace.row.recorded_bytes = await agenticReplayDiskBytes(trace.writer.runDir, this.config.maxTraceBytes)
      await this.#save(trace)
    } catch (error) { this.#fail(trace, agenticReplayErrorCode(error)); await this.#save(trace) }
  }
  #enqueue(trace: ActiveTrace, event: EventInit, cause?: Ref, context?: FailureContext): Ref {
    const ref: Ref = {}
    if (trace.sealed) return ref
    // The event is already projected, but JSON overhead is charged as well.
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 512
    if (!this.#reserve(trace, bytes)) return ref
    const occurredAt = new Date()
    trace.tail = trace.tail.then(async () => {
      if (!trace.writer) return
      try {
        // Reserve conservatively for JSON/blob/redaction overhead, then measure real files.
        if (trace.row.recorded_bytes + bytes * 4 + 16_384 > this.config.maxTraceBytes) throw new AgenticReplayError('trace_limit')
        if (cause && cause.seq === undefined) throw new AgenticReplayError('missing_cause')
        const saved = await trace.writer.append({ ...event, occurredAt, ...(cause ? { causes: [cause.seq!] } : {}) })
        ref.seq = saved.seq
        trace.row.recorded_bytes = await agenticReplayDiskBytes(trace.writer.runDir, this.config.maxTraceBytes)
      } catch (error) { this.#fail(trace, agenticReplayErrorCode(error), context ?? {
        phase: 'event_append', eventType: event.type,
        ...(typeof event.attrs?.callId === 'string' ? { callId: event.attrs.callId } : {}),
      }) }
    }).finally(() => this.#release(trace, bytes))
    return ref
  }
  #link(trace: ActiveTrace, binding: DshAgenticReplayBinding) {
    if (binding.kiokukoRunId === undefined) return
    // No growing in-memory logical-run set; SQLite's PK performs deduplication.
    const id = binding.kiokukoRunId
    trace.tail = trace.tail.then(async () => {
      try { await this.withIndex(store => store.link(trace.row.agenticreplay_run_id, id)) }
      catch { trace.persistenceFailed = true; this.#fail(trace, 'index_persistence_failed') }
    })
  }
  start(binding: DshAgenticReplayBinding): void { this.#admit(binding, true) }
  markUnavailable(reason: string): void { this.#unavailable = true; this.#unavailableReason = reason; this.#accepting = false }
  #settle(trace: ActiveTrace) {
    trace.active--
    if (trace.active === 0) for (const resolve of trace.waiters) resolve()
  }
  stream<T>(binding: DshAgenticReplayBinding | undefined, options: Record<string, any>, next: () => AsyncIterable<T>): AsyncIterable<T> {
    const self = this
    return (async function* () {
      let trace: ActiveTrace | undefined
      let ref: Ref | undefined
      const id = randomBytes(12).toString('hex')
      const blocks = new Map<number, Record<string, any>>()
      const seenBlocks = new Set<number>()
      let heldBytes = 0, finish: string | undefined, usage: unknown, failure = false, finishFailureCode: string | undefined
      let bodyOmitted = false, bodyOmissionReason: string | undefined, omissionRecorded = false, bodyBytes = 0, bodyChars = 0, blockCount = 0
      const started = performance.now()
      const releaseModel = () => { if (trace) { self.#release(trace, heldBytes); heldBytes = 0; blocks.clear(); trace.modelCleanups.delete(releaseModel) } }
      const countBody = (text: string) => {
        bodyBytes = Math.min(Number.MAX_SAFE_INTEGER, bodyBytes + Buffer.byteLength(text, 'utf8'))
        bodyChars = Math.min(Number.MAX_SAFE_INTEGER, bodyChars + text.length)
      }
      const omitBody = (reason: string) => {
        if (bodyOmitted) return
        bodyOmitted = true
        bodyOmissionReason = reason
        blocks.clear()
        if (trace && heldBytes > 0) { self.#release(trace, heldBytes); heldBytes = 0 }
      }
      try {
        if (!binding) self.diagnostics.unattributed++
        else if (options.purpose !== undefined && !self.config.includeAuxiliary) self.diagnostics.auxiliary++
        else {
          trace = self.#admit(binding)
          if (trace && !self.#reserve(trace, 512)) trace = undefined
          if (trace) {
            heldBytes = 512
            trace.modelCleanups.add(releaseModel)
            trace.active++
            self.#safe(trace, () => {
              const requestEvent = modelRequest(options, id, self.config)
              ref = self.#enqueue(trace!, requestEvent)
              const attrs = record(requestEvent.attrs)
              if (attrs.content_omitted === true) self.#recordOmission(trace!, 'model.request', id,
                typeof attrs.omission_reason === 'string' ? attrs.omission_reason : 'payload_limit', ref)
              self.#link(trace!, binding)
            })
          }
        }
      } catch { self.diagnostics.unattributed++ }
      try {
        for await (const chunk of next()) {
          if (trace && !trace.sealed && trace.row.last_error_code === null) self.#safe(trace, () => {
            const c = record(chunk)
            if (c.type === 'finish') {
              finish = label(record(c.reason).kind)
              const code = record(record(c.reason).failure).code
              if (finish === 'error' && ['DSH_MEMORY_SNAPSHOT_STALE', 'DSH_MEMORY_REBUILD_EXHAUSTED'].includes(code)) {
                finishFailureCode = code
                self.#enqueue(trace!, { type: 'error', actor: 'harness', attrs: { code, modelCallId: id } }, ref)
              }
              return
            }
            if (c.type === 'usage') { usage = usageAttrs(c.usage); return }
            if (c.type === 'block-start') return
            if (c.type === 'reasoning-delta' && !self.config.capture.reasoning) return
            if (c.type === 'text-delta' || c.type === 'reasoning-delta' || c.type === 'tool-call-delta' || c.type === 'block-end') {
              const n = c.index
              if (!Number.isSafeInteger(n) || n < 0) throw new AgenticReplayError('unsupported_chunk')
              if (blocks.get(n)?.closed) return
              const firstBlockObservation = !seenBlocks.has(n)
              if (firstBlockObservation) {
                if (seenBlocks.size >= 256) { blockCount = 257; omitBody('metadata_limit'); return }
                seenBlocks.add(n); blockCount++
              }
              const sourceBlock = c.type === 'block-end' ? record(c.block) : undefined
              const observedText = c.type === 'block-end'
                ? firstBlockObservation ? sourceBlock?.text ?? sourceBlock?.arguments : undefined
                : c.type === 'tool-call-delta' ? c.argumentsDelta : c.text
              if (typeof observedText === 'string') countBody(observedText)
              if (bodyOmitted) return
              const value = c.type === 'block-end' ? projectBlocks([c.block], self.config)[0] :
                c.type === 'tool-call-delta' ? { type: 'tool-call', id: label(c.id), name: label(c.name), arguments: c.argumentsDelta } :
                { type: c.type === 'text-delta' ? 'text' : 'reasoning', text: c.text }
              const v = record(value)
              if (v.omitted) return
              if (self.config.capture.content === 'metadata') {
                if (!blocks.has(n)) {
                  if (!self.#reserveBody(trace!, 128)) { omitBody('payload_limit'); return }
                  heldBytes += 128; blocks.set(n, { type: v.type, chars: 0 })
                }
                const block = blocks.get(n)!
                if (c.type === 'block-end') { block.chars = v.chars ?? block.chars; block.closed = true }
                else block.chars += typeof v.text === 'string' ? v.text.length : typeof v.arguments === 'string' ? v.arguments.length : 0
                return
              }
              const text = v.text ?? v.arguments ?? ''
              if (typeof text !== 'string') throw new AgenticReplayError('unsupported_chunk')
              const bytes = text.length * 6 + (blocks.has(n) ? 0 : 256)
              if (!self.#reserveBody(trace!, bytes)) { omitBody('payload_limit'); return }
              heldBytes += bytes
              const previous = blocks.get(n)
              if (c.type === 'block-end' || !previous) blocks.set(n, { ...v, closed: c.type === 'block-end' })
              else if (v.type === 'tool-call') blocks.set(n, { ...v, arguments: String(previous.arguments ?? '') + text })
              else blocks.set(n, { ...v, text: String(previous.text ?? '') + text })
              return
            }
            self.diagnostics.unsupportedChunks++
            self.#enqueue(trace!, { type: 'note', actor: 'harness', attrs: { unsupportedChunk: true } })
          })
          yield chunk
        }
      } catch (error) {
        failure = true
        if (trace) self.#safe(trace, () => { self.#enqueue(trace!, { type: 'error', actor: 'model', attrs: { code: 'upstream_exception', modelCallId: id } }) })
        throw error
      } finally {
        if (trace) {
          self.#release(trace, heldBytes); heldBytes = 0
          // Capture is observational. Never wait for writer creation or disk
          // drain before returning the native response.
          self.#safe(trace, () => {
            if (finish === undefined && !failure) self.#fail(trace!, 'model_finish_missing')
            // Projection can fail before a request exists. Never invent an
            // uncaused response, which looks like a missing API request.
            if (!ref) return
            let payload: Record<string, unknown>
            if (bodyOmitted) {
              payload = { format: 'dsh.llm.response.v1', content_omitted: true, omission_reason: bodyOmissionReason ?? 'payload_limit',
                observed_body_bytes: bodyBytes, observed_body_chars: bodyChars, block_count: blockCount }
            } else {
              const bounded = boundedAgenticReplayPayload({ format: 'dsh.llm.response.v1', blocks: [...blocks.values()] },
                Math.max(1, self.config.maxQueuedBytesPerTrace - 2048), 'dsh.llm.response.v1')
              if (bounded.omitted) {
                bodyOmitted = true
                bodyOmissionReason = bounded.omissionReason ?? 'payload_limit'
                payload = { ...bounded.payload, observed_body_bytes: bodyBytes, observed_body_chars: bodyChars, block_count: blockCount }
              } else payload = bounded.payload
            }
            if (bodyOmitted && !omissionRecorded) {
              self.#recordOmission(trace!, 'model.response', id, bodyOmissionReason ?? 'payload_limit', ref)
              omissionRecorded = true
            }
            self.#enqueue(trace!, { type: 'model.response', actor: 'model', attrs: { modelCallId: id,
              stop_reason: finish ?? (failure ? 'exception' : 'incomplete'), duration_ms: performance.now() - started,
              ...(finishFailureCode ? { failure_code: finishFailureCode } : {}),
              ...(bodyOmitted ? { content_omitted: true, omission_reason: bodyOmissionReason ?? 'payload_limit', observed_body_bytes: bodyBytes, observed_body_chars: bodyChars } : {}),
              ...(usage === undefined ? { usage_known: false } : record(usage)) }, payload: payload as Record<string, unknown> }, ref)
          })
          releaseModel(); self.#settle(trace)
        }
      }
    })()
  }
  preTool(binding: DshAgenticReplayBinding | undefined, exec: AgenticReplayToolExecution, startObserved = true): void {
    try {
      this.#seenTokens.add(exec.token as unknown as object)
      if (!binding || this.#attempts.has(exec.token)) return
      const trace = this.#admit(binding)
      if (!trace) return
      this.#safe(trace, () => {
        let argumentValue = exec.arguments
        if (typeof argumentValue === 'string') {
          let encoding = 'invalid-json'
          try { JSON.parse(argumentValue); encoding = 'json-text' } catch { /* Preserve malformed input as redacted diagnostic text. */ }
          argumentValue = { format: 'dsh.tool.arguments.v1', encoding, text: argumentValue }
        }
        const projected = this.config.capture.content === 'metadata' ? undefined
          : boundedAgenticReplayPayload(argumentValue, Math.max(1, this.config.maxQueuedBytesPerTrace - 2048), 'dsh.tool.arguments.v1')
        const name = label(exec.name), callId = label(exec.callId), rootCallId = label(exec.rootCallId)
        const session = record(exec.agent?.session)
        const last = typeof session.eventAt === 'function' && Number.isSafeInteger(session.seq) ? record(session.eventAt(session.seq - 1)) : {}
        const nativeCallSeq = last.type === 'tool/call' && record(last.data).callId === exec.callId ? last.seq : undefined
        if (!this.#reserve(trace, 512)) return
        const id = randomBytes(12).toString('hex')
        const parent = exec.parent === undefined ? undefined : this.#attempts.get(exec.parent)
        const omitted = projected?.omitted === true
        const ref = this.#enqueue(trace, { type: 'tool.call', actor: 'harness', attrs: { name, callId,
          rootCallId, attemptId: id, startObserved, ...(binding.kiokukoRunId ? { taskId: binding.kiokukoRunId } : {}), ...(nativeCallSeq === undefined ? {} : { nativeCallSeq }), ...(omitted ? { content_omitted: true, omission_reason: projected.omissionReason ?? 'payload_limit' } : {}),
          ...(parent && parent.trace === trace ? { parentAttemptId: parent.id } : {}) },
          ...(this.config.capture.content === 'metadata' ? {} : { payload: projected!.payload }) }, undefined,
          { phase: 'tool_call_append', eventType: 'tool.call', callId: exec.callId })
        if (omitted) this.#recordOmission(trace, 'tool.call', id, projected!.omissionReason ?? 'payload_limit', ref)
        trace.active++
        this.#attempts.set(exec.token, { trace, ref, id, phase: 'permission_pending', bytes: 512 })
        this.#link(trace, binding)
      }, { phase: 'tool_call_projection', eventType: 'tool.call', callId: exec.callId })
    } catch { this.diagnostics.unattributed++ }
  }
  toolDecision(exec: AgenticReplayToolExecution, decision: unknown): void {
    const attempt = this.#attempts.get(exec.token)
    if (!attempt) return
    this.#safe(attempt.trace, () => {
      attempt.phase = record(decision).kind === 'allow' ? 'dispatch_pending' : 'final_result_pending'
      this.#enqueue(attempt.trace, { type: 'note', actor: 'harness', attrs: { attemptId: attempt.id, decision: label(record(decision).kind), phase: attempt.phase } })
    })
  }
  toolDispatch(exec: AgenticReplayToolExecution): void {
    const attempt = this.#attempts.get(exec.token)
    if (attempt) { attempt.started = performance.now(); attempt.phase = 'dispatching' }
  }
  toolDispatched(exec: AgenticReplayToolExecution): void {
    const attempt = this.#attempts.get(exec.token)
    if (attempt) this.#safe(attempt.trace, () => {
      this.#enqueue(attempt.trace, { type: 'note', actor: 'harness', attrs: { attemptId: attempt.id, dispatch_duration_ms: performance.now() - attempt.started! } })
      attempt.phase = 'final_result_pending'
    })
  }
  toolResult(binding: DshAgenticReplayBinding | undefined, exec: AgenticReplayToolExecution, result: unknown): void {
    let attempt = this.#attempts.get(exec.token)
    if (!attempt) {
      if (this.#seenTokens.has(exec.token as unknown as object)) { this.diagnostics.lateResults++; return }
      this.preTool(binding, exec, false)
      attempt = this.#attempts.get(exec.token)
      if (attempt) this.#safe(attempt.trace, () => this.#enqueue(attempt!.trace, { type: 'note', actor: 'harness', attrs: { attemptId: attempt!.id, startObserved: false, resultOnly: true } }))
    }
    if (!attempt) return
    const { trace, ref, id, bytes } = attempt
    this.#attempts.delete(exec.token)
    this.#release(trace, bytes)
    this.#safe(trace, () => {
      const r = record(result)
      if (typeof r.isError !== 'boolean') throw new AgenticReplayError('unsupported_tool_result')
      let projected: ReturnType<typeof boundedAgenticReplayPayload>
      try {
        projected = boundedAgenticReplayPayload({ content: projectBlocks(r.content, this.config) },
          Math.max(1, this.config.maxQueuedBytesPerTrace - 2048), 'dsh.tool.result.v1')
      } catch (error) {
        if (!(error instanceof AgenticReplayError) || error.code !== 'queue_limit') throw error
        projected = { payload: { format: 'dsh.tool.result.v1', content_omitted: true, omission_reason: 'payload_limit' },
          omitted: true, omissionReason: 'payload_limit' }
      }
      this.#enqueue(trace, { type: 'tool.result', actor: 'tool', attrs: { name: label(exec.name), attemptId: id, ...toolResultOutcome(r,exec.name),
        ...(projected.omitted ? { content_omitted: true, omission_reason: projected.omissionReason ?? 'payload_limit' } : {}) },
        payload: projected.payload }, ref, { phase: 'tool_result_append', eventType: 'tool.result', callId: exec.callId })
      if (projected.omitted) this.#recordOmission(trace, 'tool.result', id, projected.omissionReason ?? 'payload_limit', ref)
    }, { phase: 'tool_result_projection', eventType: 'tool.result', callId: exec.callId })
    this.#settle(trace)
  }
  stopAccepting(): void { this.#accepting = false; for (const t of this.#traces.values()) t.accepting = false }
  nativeFailure(binding: DshAgenticReplayBinding | undefined): void {
    try {
      if (!binding) return
      const trace = this.#admit(binding)
      if (trace) this.#safe(trace, () => this.#enqueue(trace, { type: 'error', actor: 'harness', attrs: {
        code: 'native_turn_failed', phase: 'agent', httpCapture: false,
      } }))
    } catch { this.diagnostics.unattributed++ }
  }
  closeSessionRecording(sessionId: string, reason: string): Promise<void> {
    const trace = this.#traces.get(sessionId)
    if (!trace) return Promise.resolve()
    if (trace.closePromise) return trace.closePromise
    trace.accepting = false
    if (!trace.row.last_error_code) trace.row.state = 'finalizing'
    trace.closePromise = this.#close(trace, reason)
    return trace.closePromise
  }
  async #close(trace: ActiveTrace, reason: string): Promise<void> {
    if (trace.active > 0) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); trace.waiters.delete(done); resolve() }
      const timer = setTimeout(done, this.config.shutdownDrainTimeoutMs)
      trace.waiters.add(done)
    })
    for (const cleanup of trace.modelCleanups) cleanup()
    trace.row.unresolved_call_count = trace.active
    if (trace.active > 0) this.#fail(trace, 'drain_timeout')
    for (const [token, attempt] of this.#attempts) if (attempt.trace === trace) {
      this.#release(trace, attempt.bytes); this.#attempts.delete(token)
    }
    // Let all already-reserved event writes release their bounded queue bytes
    // before reserving the final diagnostic/end event.
    await trace.tail
    this.#safe(trace, () => { this.#enqueue(trace, { type: 'run.end', actor: 'harness', attrs: {
      reason: label(reason), missing_events: trace.row.missing_event_count, unresolved_calls: trace.row.unresolved_call_count,
      last_error_code: trace.row.last_error_code, recording_complete: trace.row.last_error_code === null } }) })
    trace.sealed = true // late observations cannot append behind run.end
    await trace.tail
    await trace.diagnosticPromise
    if (this.#unavailable && !trace.writer) return
    try {
      if (!trace.writer) throw new AgenticReplayError('writer_unavailable')
      await trace.writer.close() // no invented process exit code
      const scan = await scanAgenticReplayTrace(trace.writer.runDir, trace.row.agenticreplay_run_id, this.config.maxTraceBytes, Number.MAX_SAFE_INTEGER)
      trace.row.event_count = scan.eventCount
      trace.row.export_input_bytes = scan.exportInputBytes
      trace.row.recorded_bytes = await agenticReplayDiskBytes(trace.writer.runDir, this.config.maxTraceBytes)
      trace.row.state = trace.row.last_error_code === null ? 'completed' : 'incomplete'
    } catch (error) { trace.row.state = 'failed'; trace.row.last_error_code ??= agenticReplayErrorCode(error) }
    trace.row.ended_at = new Date().toISOString()
    await this.#save(trace)
    if (trace.row.last_error_code) await this.#persistDiagnostic(trace)
    if (trace.persistenceFailed && trace.row.state === 'completed') trace.row.state = 'incomplete'
    if(trace.writer)trace.runDirectory=trace.writer.runDir
    delete trace.writer
  }
  forgetSession(sessionId: string): void {
    if (this.#traces.get(sessionId)?.sealed) this.#traces.delete(sessionId)
  }
  shutdown(): Promise<void> {
    if (this.#shutdown) return this.#shutdown
    this.stopAccepting()
    this.#shutdown = Promise.all([...this.#traces.keys()].map(id => this.closeSessionRecording(id, 'unload'))).then(() => undefined)
    return this.#shutdown
  }
}
