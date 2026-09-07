import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { findPackageJSON } from 'node:module'
import { join } from 'node:path'
import type { EventInit, TraceWriter } from '@orcareplay/core'
import type { OrcaConfig } from './config.js'
import { ORCA_CAPTURE, label, modelRequest, projectBlocks, record, usageAttrs } from './orca-event-mapper.js'
import { prepareOrcaParent, projectOrcaJson, workspaceKey } from './orca-security.js'
import { orcaDiskBytes, scanOrcaTrace } from './orca-files.js'
import { OrcaError, orcaErrorCode, type DshOrcaBinding, type OrcaToolExecution, type OrcaTrace, type WithOrcaIndex } from './orca-types.js'

type Ref = { seq?: number }
interface ActiveTrace {
  readonly row: OrcaTrace
  readonly binding: DshOrcaBinding
  writer?: TraceWriter
  tail: Promise<void>
  closePromise?: Promise<void>
  accepting: boolean
  sealed: boolean
  pendingBytes: number
  active: number
  waiters: Set<() => void>
  persistenceFailed: boolean
  modelCleanups: Set<() => void>
}
interface Attempt { trace: ActiveTrace; ref: Ref; id: string; started?: number; phase: string; bytes: number }
export interface OrcaRecorderDependencies {
  createWriter?: typeof TraceWriter.create
  loadCore?: () => Promise<typeof import('@orcareplay/core')>
  loadSchema?: () => Promise<typeof import('@orcareplay/schema')>
  loadCoreVersion?: () => Promise<string>
}
async function installedCoreVersion(): Promise<string> {
  const path = findPackageJSON('@orcareplay/core', import.meta.url)
  if (!path) throw new Error('Orca core package metadata unavailable')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  if (manifest.name !== '@orcareplay/core' || typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('Invalid Orca core package metadata')
  }
  return manifest.version
}
/** Owns all writers. Observation methods never throw into the DSH pipeline. */
export class DshOrcaRecorder {
  readonly instanceId = `pid_${process.pid}_${randomBytes(12).toString('hex')}`
  readonly diagnostics = { unattributed: 0, auxiliary: 0, lateResults: 0, unsupportedChunks: 0 }
  readonly #traces = new Map<string, ActiveTrace>()
  readonly #attempts = new Map<symbol, Attempt>()
  // Node 24 supports nonregistered symbols as weak keys. No unbounded token tombstones.
  readonly #seenTokens = new WeakSet<object>()
  #accepting = true
  #bytes = 0
  #shutdown?: Promise<void>
  #unavailable = false
  #unavailableReason: string | undefined
  constructor(readonly config: OrcaConfig, readonly withIndex: WithOrcaIndex, private readonly deps: OrcaRecorderDependencies = {}) {}
  status(sessionId: string) {
    const trace = this.#traces.get(sessionId)
    return { capability: !this.config.enabled ? 'disabled' : this.#unavailable ? 'unavailable' : 'available',
      trace: trace === undefined ? null : { ...trace.row }, persistenceFailed: trace?.persistenceFailed ?? false,
      diagnostics: { ...this.diagnostics }, unavailableReason: this.#unavailableReason, capture: ORCA_CAPTURE }
  }
  #fail(trace: ActiveTrace, code: string) {
    trace.accepting = false
    trace.row.missing_event_count++
    trace.row.last_error_code ??= code
    if (!trace.sealed) trace.row.state = trace.writer ? 'incomplete' : 'failed'
  }
  #safe(trace: ActiveTrace, operation: () => void) {
    if (trace.sealed) return
    try { operation() } catch (error) { this.#fail(trace, orcaErrorCode(error)) }
  }
  #reserve(trace: ActiveTrace, bytes: number): boolean {
    if (trace.pendingBytes + bytes > this.config.maxQueuedBytesPerTrace || this.#bytes + bytes > this.config.maxQueuedBytesTotal) {
      this.#fail(trace, 'queue_limit'); return false
    }
    trace.pendingBytes += bytes; this.#bytes += bytes; return true
  }
  #release(trace: ActiveTrace, bytes: number) { trace.pendingBytes -= bytes; this.#bytes -= bytes }
  async #save(trace: ActiveTrace) {
    try { await this.withIndex(store => store.save({ ...trace.row })) }
    catch { trace.persistenceFailed = true; this.#fail(trace, 'index_persistence_failed') }
  }
  #admit(binding: DshOrcaBinding, explicit = false): ActiveTrace | undefined {
    if (!this.config.enabled || !this.#accepting || this.#unavailable) return undefined
    const existing = this.#traces.get(binding.sessionId)
    if (existing && (existing.binding.workspaceRoot !== binding.workspaceRoot || existing.binding.sessionCwd !== binding.sessionCwd || existing.binding.storeRoot !== binding.storeRoot)) return undefined
    if (existing && !explicit) return existing.accepting ? existing : undefined
    if (existing && !existing.sealed) return existing.accepting ? existing : undefined
    if ([...this.#traces.values()].filter(t => !t.sealed).length >= this.config.maxOpenTraces) throw new OrcaError('open_trace_limit')
    const trace: ActiveTrace = { binding: Object.freeze({ ...binding }),
      row: { orca_run_id: `run_${randomBytes(12).toString('hex')}`, dsh_session_id: binding.sessionId,
        recorder_instance_id: this.instanceId, recording_generation: randomBytes(12).toString('hex'), workspace_key: workspaceKey(binding.workspaceRoot),
        store_root: binding.storeRoot, session_cwd: binding.sessionCwd, capture_format_version: 1, state: 'starting',
        started_at: new Date().toISOString(), ended_at: null, last_error_code: null, missing_event_count: 0,
        unresolved_call_count: 0, event_count: 0, recorded_bytes: 0, export_input_bytes: 0 },
      tail: Promise.resolve(), accepting: true, sealed: false, pendingBytes: 0, active: 0, waiters: new Set(), persistenceFailed: false, modelCleanups: new Set() }
    this.#traces.set(binding.sessionId, trace)
    trace.tail = this.#initialize(trace)
    this.#enqueue(trace, { type: 'run.start', actor: 'harness', payload: { ...ORCA_CAPTURE, reasoning: this.config.capture.reasoning,
      content: this.config.capture.content, verifiedDshVersion: '0.1.2-rc.1' } })
    return trace
  }
  async #initialize(trace: ActiveTrace) {
    try {
      // Dependency validation precedes any filesystem/index side effects.
      let create: typeof TraceWriter.create
      let orcaVersion: string
      try {
        const [core, , version] = await Promise.all([this.deps.loadCore?.() ?? import('@orcareplay/core'), this.deps.loadSchema?.() ?? import('@orcareplay/schema'), this.deps.loadCoreVersion?.() ?? installedCoreVersion()])
        create = this.deps.createWriter ?? core.TraceWriter.create
        orcaVersion = version
      } catch { this.markUnavailable('dependency_unavailable_reinstall_package'); trace.accepting = false; this.#traces.delete(trace.binding.sessionId); return }
      await this.#save(trace)
      if (trace.persistenceFailed) return
      const runs = await prepareOrcaParent(trace.binding.storeRoot)
      await mkdir(join(runs, trace.row.orca_run_id), { mode: 0o700 }) // exclusive reservation, never append to an existing run
      trace.writer = await create(runs, { runId: trace.row.orca_run_id, adapter: { id: 'kiokuko-dsh' },
        argv: [], cwd: trace.binding.sessionCwd, orcaVersion, envAllowlist: [] })
      if (trace.row.last_error_code === null) trace.row.state = 'recording'
      trace.row.recorded_bytes = await orcaDiskBytes(trace.writer.runDir, this.config.maxTraceBytes)
      await this.#save(trace)
    } catch (error) { this.#fail(trace, orcaErrorCode(error)); await this.#save(trace) }
  }
  #enqueue(trace: ActiveTrace, event: EventInit, cause?: Ref): Ref {
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
        if (trace.row.recorded_bytes + bytes * 4 + 16_384 > this.config.maxTraceBytes) throw new OrcaError('trace_limit')
        if (cause && cause.seq === undefined) throw new OrcaError('missing_cause')
        const saved = await trace.writer.append({ ...event, occurredAt, ...(cause ? { causes: [cause.seq!] } : {}) })
        ref.seq = saved.seq
        trace.row.recorded_bytes = await orcaDiskBytes(trace.writer.runDir, this.config.maxTraceBytes)
      } catch (error) { this.#fail(trace, orcaErrorCode(error)) }
    }).finally(() => this.#release(trace, bytes))
    return ref
  }
  #link(trace: ActiveTrace, binding: DshOrcaBinding) {
    if (binding.kiokukoRunId === undefined) return
    // No growing in-memory logical-run set; SQLite's PK performs deduplication.
    const id = binding.kiokukoRunId
    trace.tail = trace.tail.then(async () => {
      try { await this.withIndex(store => store.link(trace.row.orca_run_id, id)) }
      catch { trace.persistenceFailed = true; this.#fail(trace, 'index_persistence_failed') }
    })
  }
  start(binding: DshOrcaBinding): void { this.#admit(binding, true) }
  markUnavailable(reason: string): void { this.#unavailable = true; this.#unavailableReason = reason; this.#accepting = false }
  #settle(trace: ActiveTrace) {
    trace.active--
    if (trace.active === 0) for (const resolve of trace.waiters) resolve()
  }
  stream<T>(binding: DshOrcaBinding | undefined, options: Record<string, any>, next: () => AsyncIterable<T>): AsyncIterable<T> {
    const self = this
    return (async function* () {
      let trace: ActiveTrace | undefined
      let ref: Ref | undefined
      const id = randomBytes(12).toString('hex')
      const blocks = new Map<number, Record<string, any>>()
      let heldBytes = 0, finish: string | undefined, usage: unknown, failure = false
      const started = performance.now()
      const releaseModel = () => { if (trace) { self.#release(trace, heldBytes); heldBytes = 0; blocks.clear(); trace.modelCleanups.delete(releaseModel) } }
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
              ref = self.#enqueue(trace!, modelRequest(options, id, self.config))
              self.#link(trace!, binding)
            })
          }
        }
      } catch { self.diagnostics.unattributed++ }
      try {
        for await (const chunk of next()) {
          if (trace && !trace.sealed && trace.row.last_error_code === null) self.#safe(trace, () => {
            const c = record(chunk)
            if (c.type === 'finish') { finish = label(record(c.reason).kind); return }
            if (c.type === 'usage') { usage = usageAttrs(c.usage); return }
            if (c.type === 'block-start') return
            if (c.type === 'reasoning-delta' && !self.config.capture.reasoning) return
            if (c.type === 'text-delta' || c.type === 'reasoning-delta' || c.type === 'tool-call-delta' || c.type === 'block-end') {
              const value = c.type === 'block-end' ? projectBlocks([c.block], self.config)[0] :
                c.type === 'tool-call-delta' ? { type: 'tool-call', id: label(c.id), name: label(c.name), arguments: c.argumentsDelta } :
                { type: c.type === 'text-delta' ? 'text' : 'reasoning', text: c.text }
              const v = record(value)
              if (v.omitted) return
              const n = c.index
              if (!Number.isSafeInteger(n) || n < 0) throw new OrcaError('unsupported_chunk')
              if (blocks.get(n)?.closed) return
              if (self.config.capture.content === 'metadata') {
                if (!blocks.has(n)) {
                  if (!self.#reserve(trace!, 128)) return
                  heldBytes += 128; blocks.set(n, { type: v.type, chars: 0 })
                }
                const block = blocks.get(n)!
                if (c.type === 'block-end') { block.chars = v.chars ?? block.chars; block.closed = true }
                else block.chars += typeof v.text === 'string' ? v.text.length : typeof v.arguments === 'string' ? v.arguments.length : 0
                return
              }
              const text = v.text ?? v.arguments ?? ''
              if (typeof text !== 'string') throw new OrcaError('unsupported_chunk')
              const bytes = text.length * 6 + (blocks.has(n) ? 0 : 256)
              if (!self.#reserve(trace!, bytes)) return
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
          self.#safe(trace, () => {
            if (finish === undefined && !failure) self.#fail(trace!, 'model_finish_missing')
            const payload = projectOrcaJson({ format: 'dsh.llm.response.v1', blocks: [...blocks.values()] }, self.config.maxQueuedBytesPerTrace)
            self.#enqueue(trace!, { type: 'model.response', actor: 'model', attrs: { modelCallId: id,
              stop_reason: finish ?? (failure ? 'exception' : 'incomplete'), duration_ms: performance.now() - started,
              ...(usage === undefined ? { usage_known: false } : record(usage)) }, payload: payload as Record<string, unknown> }, ref)
          })
          releaseModel(); self.#settle(trace)
        }
      }
    })()
  }
  preTool(binding: DshOrcaBinding | undefined, exec: OrcaToolExecution, startObserved = true): void {
    try {
      this.#seenTokens.add(exec.token as unknown as object)
      if (!binding || this.#attempts.has(exec.token)) return
      const trace = this.#admit(binding)
      if (!trace) return
      this.#safe(trace, () => {
        const projected = this.config.capture.content === 'metadata' ? undefined : projectOrcaJson(exec.arguments, this.config.maxQueuedBytesPerTrace)
        const name = label(exec.name), callId = label(exec.callId), rootCallId = label(exec.rootCallId)
        if (!this.#reserve(trace, 512)) return
        const id = randomBytes(12).toString('hex')
        const parent = exec.parent === undefined ? undefined : this.#attempts.get(exec.parent)
        const ref = this.#enqueue(trace, { type: 'tool.call', actor: 'harness', attrs: { name, callId,
          rootCallId, attemptId: id, startObserved, ...(parent && parent.trace === trace ? { parentAttemptId: parent.id } : {}) },
          ...(this.config.capture.content === 'metadata' ? {} : { payload: projected as Record<string, unknown> }) })
        trace.active++
        this.#attempts.set(exec.token, { trace, ref, id, phase: 'permission_pending', bytes: 512 })
        this.#link(trace, binding)
      })
    } catch { this.diagnostics.unattributed++ }
  }
  toolDecision(exec: OrcaToolExecution, decision: unknown): void {
    const attempt = this.#attempts.get(exec.token)
    if (!attempt) return
    this.#safe(attempt.trace, () => {
      attempt.phase = record(decision).kind === 'allow' ? 'dispatch_pending' : 'final_result_pending'
      this.#enqueue(attempt.trace, { type: 'note', actor: 'harness', attrs: { attemptId: attempt.id, decision: label(record(decision).kind), phase: attempt.phase } })
    })
  }
  toolDispatch(exec: OrcaToolExecution): void {
    const attempt = this.#attempts.get(exec.token)
    if (attempt) { attempt.started = performance.now(); attempt.phase = 'dispatching' }
  }
  toolDispatched(exec: OrcaToolExecution): void {
    const attempt = this.#attempts.get(exec.token)
    if (attempt) this.#safe(attempt.trace, () => {
      this.#enqueue(attempt.trace, { type: 'note', actor: 'harness', attrs: { attemptId: attempt.id, dispatch_duration_ms: performance.now() - attempt.started! } })
      attempt.phase = 'final_result_pending'
    })
  }
  toolResult(binding: DshOrcaBinding | undefined, exec: OrcaToolExecution, result: unknown): void {
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
      if (typeof r.isError !== 'boolean') throw new OrcaError('unsupported_tool_result')
      this.#enqueue(trace, { type: 'tool.result', actor: 'tool', attrs: { name: label(exec.name), attemptId: id, is_error: r.isError },
        payload: projectOrcaJson({ content: projectBlocks(r.content, this.config) }, this.config.maxQueuedBytesPerTrace) as Record<string, unknown> }, ref)
    })
    this.#settle(trace)
  }
  stopAccepting(): void { this.#accepting = false; for (const t of this.#traces.values()) t.accepting = false }
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
    this.#safe(trace, () => { this.#enqueue(trace, { type: 'run.end', actor: 'harness', attrs: {
      reason: label(reason), missing_events: trace.row.missing_event_count, unresolved_calls: trace.row.unresolved_call_count,
      recording_complete: trace.row.last_error_code === null } }) })
    trace.sealed = true // late observations cannot append behind run.end
    await trace.tail
    if (this.#unavailable && !trace.writer) return
    try {
      if (!trace.writer) throw new OrcaError('writer_unavailable')
      await trace.writer.close() // no invented process exit code
      const scan = await scanOrcaTrace(trace.writer.runDir, trace.row.orca_run_id, this.config.maxTraceBytes, Number.MAX_SAFE_INTEGER)
      trace.row.event_count = scan.eventCount
      trace.row.export_input_bytes = scan.exportInputBytes
      trace.row.recorded_bytes = await orcaDiskBytes(trace.writer.runDir, this.config.maxTraceBytes)
      trace.row.state = trace.row.last_error_code === null ? 'completed' : 'incomplete'
    } catch (error) { trace.row.state = 'failed'; trace.row.last_error_code ??= orcaErrorCode(error) }
    trace.row.ended_at = new Date().toISOString()
    await this.#save(trace)
    if (trace.persistenceFailed && trace.row.state === 'completed') trace.row.state = 'incomplete'
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
