import { symbols } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { fileURLToPath } from 'node:url'
import { CodeRequest, codeOutcome, validateCodeResponse, type CodeRequestV1, type CodeResponseV1, type CodeHostBindingV1, type CodeIntelligenceServiceV1, type CodeLeaseV1 } from './code-intelligence-contracts.js'
import { LispError } from './contracts.js'
const RPC = { 'code-capabilities':'capabilities', 'code-open':'snapshot.open', 'code-release':'snapshot.release', 'code-outline':'structure.outline', 'code-enclosing':'structure.enclosing', 'code-query':'structure.query', 'code-span':'structure.span', 'code-semantic':'semantic.query' } as const
/** One evaluation owns one lease and cumulative budget. No fallback to tools.execute. */
export class CodeIntelligenceAdapterV1 {
  #lease?: Promise<CodeLeaseV1>; #provider?: unknown; #closed = false; #calls = 0; #inputBytes = 0; #responseBytes = 0
  #handles = new Set<string>(); #nodes = new Map<string,string>(); #start = performance.now()
  #lifetime = new AbortController(); #disposal?: Promise<void>
  constructor(readonly binding: CodeHostBindingV1, readonly resolve: () => unknown) {}
  async request(method: string, args: unknown, signal: AbortSignal): Promise<CodeResponseV1> {
    if (!Object.hasOwn(RPC, method)) throw new LispError('CODE_INVALID_INPUT', 'Unknown code operation.')
    if (method !== 'code-release') this.#calls++
    const raw = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : null
    if (!raw || Object.hasOwn(raw, 'method')) throw new LispError('CODE_INVALID_INPUT', 'Code arguments must be a fixed DTO.')
    const parsed = CodeRequest.safeParse({ ...raw, method: RPC[method as keyof typeof RPC] })
    if (!parsed.success) throw new LispError('CODE_INVALID_INPUT', 'Invalid code operation arguments.')
    const input = JSON.parse(JSON.stringify(parsed.data)) as CodeRequestV1
    if (this.#closed) return codeOutcome('stale', 'evaluation_closed')
    if (signal.aborted) return this.account(codeOutcome(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', signal.reason?.name === 'TimeoutError' ? 'caller_deadline' : 'caller_cancelled'))
    await this.binding.assertCurrent()
    // Releases are idempotent cleanup and remain possible after exhaustion/cancellation.
    if (input.method === 'snapshot.release') {
      const known = this.#handles.delete(input.handle)
      for (const [node, snapshot] of this.#nodes) if (snapshot === input.handle) this.#nodes.delete(node)
      if (known && this.#lease) {
        const cleanup = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(2000)])
        try { await raced((await raced(this.#lease, cleanup)).request(input, cleanup), cleanup) }
        catch { return codeOutcome('unavailable', 'release_failed') }
      }
      return { ...codeOutcome('ok', 'released'), data: { released: known } }
    }
    if (this.#calls > 100 || input.method === 'snapshot.open' && this.#inputBytes >= 16777216 || this.#responseBytes >= 65536) return codeOutcome('limit_exceeded', 'evaluation_budget')
    const remaining = 30000 - (performance.now() - this.#start)
    if (remaining <= 0) return codeOutcome('timeout', 'batch_deadline')
    if ('handle' in input && !this.#handles.has(input.handle) || 'nodeHandle' in input && !this.#nodes.has(input.nodeHandle)) return codeOutcome('stale', 'unknown_handle')
    let provider: unknown
    try { provider = this.resolve() } catch { return this.account(codeOutcome('unavailable', 'provider_resolution')) }
    if (!provider) return this.account(codeOutcome('unavailable', 'provider_missing'))
    if (this.#lease && this.#provider !== identity(provider)) return this.account(codeOutcome('stale', 'scope_changed'))
    const candidate = provider as Partial<CodeIntelligenceServiceV1>
    let capabilities: readonly string[]
    try {
    if (candidate.version !== 1) return this.account(codeOutcome('unavailable', 'provider_version'))
    capabilities = candidate.capabilities ?? []
    if (!Array.isArray(capabilities) || capabilities.some(c => !['snapshots','structure','semantic'].includes(c)) || !capabilities.includes('snapshots') || typeof candidate.bind !== 'function') return this.account(codeOutcome('unavailable', 'provider_contract'))
    } catch { return this.account(codeOutcome('unavailable', 'provider_contract')) }
    const needed = input.method.startsWith('structure.') ? 'structure' : input.method === 'semantic.query' ? 'semantic' : 'snapshots'
    if (!capabilities.includes(needed)) return this.account(codeOutcome('unsupported', 'capability_missing'))
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(remaining, input.method === 'semantic.query' ? 10000 : 2000))))
    const deadline = AbortSignal.any([signal, this.#lifetime.signal, timeout])
    try {
      if (!this.#lease) { this.#provider = identity(provider); this.#lease = candidate.bind(this.binding, deadline) }
      const value = await raced((await raced(this.#lease, deadline)).request(input, deadline), deadline)
      await this.binding.assertCurrent()
      if (this.#closed || identity(this.resolve()) !== identity(provider)) return this.account(codeOutcome('stale', 'scope_changed'))
      const result = validateCodeResponse(input, value)
      if (input.method === 'semantic.query' && result.data && typeof result.data === 'object' && 'items' in result.data) {
        const locations = (result.data as {items:{uri?:string}[]}).items.filter(item => item.uri !== undefined)
        if (locations.length && !await raced(this.locationsInScope(locations, deadline), deadline)) return this.account(codeOutcome('unavailable', 'semantic_uri_outside_workspace'))
      }
      deadline.throwIfAborted()
      await this.binding.assertCurrent()
      if (this.#closed || identity(this.resolve()) !== identity(provider)) return this.account(codeOutcome('stale', 'scope_changed'))
      if (Buffer.byteLength(JSON.stringify(result)) > 32768) throw new Error('response limit')
      if (result.inputBytes) {
        this.#inputBytes += result.inputBytes
        if (this.#inputBytes > 16777216) return this.account(codeOutcome('limit_exceeded', 'input_budget'))
      }
      if ((result.status === 'ok' || result.status === 'partial') && input.method === 'snapshot.open') this.#handles.add((result.data as {handle:string}).handle)
      if ((result.status === 'ok' || result.status === 'partial') && input.method.startsWith('structure.') && input.method !== 'structure.span') for (const item of (result.data as {items:{handle:string}[]}).items) this.#nodes.set(item.handle, 'handle' in input ? input.handle : '')
      return this.account(result)
    } catch (error) {
      if (deadline.aborted) return this.account(codeOutcome(this.#lifetime.signal.aborted || signal.aborted && signal.reason?.name !== 'TimeoutError' ? 'cancelled' : 'timeout', signal.aborted ? signal.reason?.name === 'TimeoutError' ? 'caller_deadline' : 'caller_cancelled' : 'operation_deadline'))
      if (error instanceof LispError) throw error
      return this.account(codeOutcome('unavailable', 'provider_invalid_response'))
    }
  }
  private async locationsInScope(locations: {uri?:string}[], signal: AbortSignal): Promise<boolean> {
    const fs = this.binding.context.get('fs', false) as FileSystem | undefined
    if (!fs) return false
    const root = await fs.resolve(this.binding.workspaceRoot, {signal})
    for (const location of locations) {
      if (!location.uri?.startsWith('file:')) return false
      const target = await fs.resolve(fileURLToPath(location.uri), {signal})
      if (!fs.contains(root, target)) return false
    }
    await this.binding.assertCurrent()
    return identity(this.binding.context.get('fs', false)) === identity(fs)
  }
  private account(result: CodeResponseV1): CodeResponseV1 {
    const bytes = Buffer.byteLength(JSON.stringify(result))
    this.#responseBytes += bytes
    return this.#responseBytes > 65536 ? codeOutcome('limit_exceeded', 'response_budget') : result
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal
    this.#closed = true; this.#lifetime.abort(); this.#handles.clear(); this.#nodes.clear()
    // Observe and dispose even a provider bind which finishes after cancellation.
    const cleanup = this.#lease ? this.#lease.then(lease => lease.dispose(), () => {}) : Promise.resolve()
    // Keep observing late completion, but an invalid provider cannot hold host teardown forever.
    this.#disposal = raced(cleanup, AbortSignal.timeout(10000)).catch(() => {})
    return this.#disposal
  }
}
async function raced<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let listener: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => { listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once:true }) })
  try { return await Promise.race([promise, aborted]) } finally { signal.removeEventListener('abort', listener) }
}

function identity(value: unknown): unknown { return value && typeof value === 'object' ? (value as Record<symbol, unknown>)[symbols.original] ?? value : value }
