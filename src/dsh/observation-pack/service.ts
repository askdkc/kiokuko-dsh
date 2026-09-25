import type { z } from 'zod'
import { canonicalContentHash } from '../../serialization/validate.js'
import { toolPresentationHash } from '../evolution-observation.js'
import { requestSize } from '../efficiency.js'
import type { CompactionAgent, CompactionSession, NativeTokenMeter, ResultCandidate, SurfaceEvent } from '../semantic-compaction/contracts.js'
import { compactionSurface, surfaceMessage } from '../semantic-compaction/policy.js'
import type { SessionProgress } from '../semantic-compaction/progress.js'
import { ObservationPackConfig, ObservationReadInput, packedMessage, packedSource, plainResult, resolveObservation, textDigest } from './policy.js'

interface Host { get(name: string, strict?: boolean): any; on(name: string, listener: (...args: any[]) => any): () => void }
export class ObservationPack {
  readonly config: z.infer<typeof ObservationPackConfig>
  readonly stats = { packed: 0, restored: 0, originalBytes: 0, packedBytes: 0, reads: 0, readBytes: 0, toolDefinitionBytes: 0,
    nativeRequestAttempts: 0, nativeRequestBytes: 0, nativeToolsBytes: 0, observationErrors: 0 }
  private readonly proofs = new WeakMap<CompactionSession, Map<number, string>>()
  private readonly visible = new WeakMap<CompactionAgent, boolean>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly disposeTool?: () => void
  private readonly disposeResult: () => void
  private readonly definition: any
  constructor(private readonly ctx: Host, config: z.input<typeof ObservationPackConfig> | undefined,
    private readonly authorize: (agent: CompactionAgent, session: CompactionSession) => Promise<unknown>, private readonly stopped: AbortSignal) {
    this.config = ObservationPackConfig.parse(config ?? {})
    this.definition = { name: 'observation_read', modelFacing: true,
      description: 'Read original tool output using an ObservationPack handle from this session. Offsets count Unicode characters; each page is at most 2000 characters.',
      parameters: { type: 'object', additionalProperties: false, required: ['handle'], properties: { handle: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } } },
      output: { schema: {}, render: (_: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args: unknown, execution: any) => {
        const operation = this.read(args, execution)
        this.pending.add(operation)
        try { return await operation } finally { this.pending.delete(operation) }
      } }
    const tools = ctx.get('tools', false)
    // Never replace another plugin's implementation under a trusted name.
    if (typeof tools?.register === 'function' && typeof tools.get === 'function' && typeof tools.schemas === 'function' && !tools.get('observation_read')) {
      this.disposeTool = tools.register(this.definition)
      this.stats.toolDefinitionBytes = Buffer.byteLength(JSON.stringify({ name: this.definition.name, description: this.definition.description, parameters: this.definition.parameters }))
    }
    this.disposeResult = ctx.on('tools/result', (execution: any, result: any) => this.observe(execution, result))
  }
  stop(): void { this.disposeResult(); this.disposeTool?.() }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending]) }
  observeRequest(request: Record<string, unknown>): void {
    try {
      const size = requestSize(request)
      this.stats.nativeRequestAttempts++; this.stats.nativeRequestBytes += size.totalBytes; this.stats.nativeToolsBytes += size.toolsBytes
    } catch { this.stats.observationErrors++ }
  }
  assembled(agent: CompactionAgent, tools: unknown): void {
    this.visible.set(agent, Array.isArray(tools) && tools.some(t => t?.name === 'observation_read'))
  }
  available(agent: CompactionAgent): boolean {
    const tools = this.ctx.get('tools', false)
    return !this.stopped.aborted && !!this.disposeTool && tools?.get('observation_read', agent) === this.definition
      && this.visible.get(agent) === true && tools.schemas(agent).some((t: any) => t.name === 'observation_read')
  }
  private async read(args: unknown, execution: any): Promise<unknown> {
    const { handle, offset, limit } = ObservationReadInput.parse(args), agent = execution.agent as CompactionAgent | undefined, session = agent?.session
    if (!agent || !session || this.ctx.get('tools', false)?.get('observation_read', agent) !== this.definition) throw new Error('Observation reader unavailable')
    this.stopped.throwIfAborted(); execution.signal?.throwIfAborted()
    const owner = await this.authorize(agent, session), event = resolveObservation(session, handle), original = plainResult(event)!
    const points = Array.from(original.text)
    if (offset > points.length) throw new Error('Observation offset exceeds original size')
    const text = points.slice(offset, offset + limit).join(''), nextOffset = offset + limit < points.length ? offset + limit : null
    const current = await this.authorize(agent, session)
    this.stopped.throwIfAborted(); execution.signal?.throwIfAborted()
    if (canonicalContentHash(current) !== canonicalContentHash(owner) || session.eventAt(event.seq) !== event
      || this.ctx.get('tools', false)?.get('observation_read', agent) !== this.definition) throw new Error('Observation authority changed')
    this.stats.reads++; this.stats.readBytes += Buffer.byteLength(text)
    return { text, nextOffset, characters: points.length, bytes: Buffer.byteLength(original.text), digest: textDigest(original.text) }
  }
  private observe(execution: any, result: any): void {
    const session = execution.agent?.session as CompactionSession | undefined
    if (!session || execution.parent !== undefined || execution.name !== 'bash') return
    let call: SurfaceEvent | undefined
    for (let seq = session.seq - 1; seq >= Math.max(0, session.seq - 4096); seq--) {
      const event = session.eventAt(seq)
      if (event?.type === 'tool/call' && event.data.callId === execution.callId) { call = event; break }
    }
    if (!call || call.data.name !== 'bash') return
    const proofs = this.proofs.get(session) ?? new Map<number, string>()
    this.proofs.set(session, proofs); proofs.delete(call.seq)
    const value = result?.value
    if (result?.isError !== false || !Array.isArray(result.content) || value?.kind !== 'foreground' || value.exitCode !== 0
      || value.signal != null || value.timedOut !== false || value.aborted !== false || value.sandbox?.denied || value.sandbox?.runnerFailed) return
    proofs.set(call.seq, toolPresentationHash({ content: result.content, isError: false, meta: result.meta, error: result.error?.info }))
    while (proofs.size > 256) proofs.delete(proofs.keys().next().value!)
  }
  candidates(session: CompactionSession, meter: NativeTokenMeter, progress: SessionProgress, restore: boolean): ResultCandidate[] {
    const result: ResultCandidate[] = []
    for (const [position, event] of compactionSurface(session).entries()) {
      const original = plainResult(event)
      if (!original || progress.pruned.has(event.seq)) continue
      const source = packedSource(session, event)
      if (restore) {
        if (source) result.push({ id: `o${event.seq}`, tool: 'observation_read', callId: original.callId, event, original: original.message,
          replacement: surfaceMessage(source)!, position, savings: 0 })
        continue
      }
      if (source || this.config.mode === 'off' || !progress.exposedTwice(event.seq) || Buffer.byteLength(original.text) <= 10240 || event.sourceEventSeqs?.length !== 1) continue
      const call = session.eventAt(event.sourceEventSeqs[0]!)
      if (call?.type !== 'tool/call' || call.data.callId !== original.callId || !['read', 'glob', 'grep', 'bash'].includes(call.data.name)) continue
      const resultContent = original.message.role === 'tool' ? original.message.content : original.message.content[0]!.content
      if (call.data.name === 'bash' && this.proofs.get(session)?.get(call.seq) !== toolPresentationHash({ content: resultContent, isError: false, meta: event.data.meta, error: event.data.error })) continue
      const replacement = packedMessage(session.id, event), savings = meter.estimateMessage(original.message) - meter.estimateMessage(replacement)
      if (savings > 0) result.push({ id: `o${event.seq}`, tool: call.data.name, callId: original.callId, event, original: original.message, replacement, savings, position })
    }
    return result
  }
  committed(candidates: readonly ResultCandidate[], restore: boolean): void {
    for (const c of candidates) {
      if (restore) this.stats.restored++
      else {
        const original = c.original.role === 'tool' ? c.original.content[0]!.text : c.original.content[0]!.content[0].text
        const packed = c.replacement.role === 'tool' ? c.replacement.content[0]!.text : c.replacement.content[0]!.content[0].text
        this.stats.packed++; this.stats.originalBytes += Buffer.byteLength(original); this.stats.packedBytes += Buffer.byteLength(packed)
      }
    }
  }
}
