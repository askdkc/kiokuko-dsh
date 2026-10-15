import { AsyncLocalStorage } from 'node:async_hooks'
import { KiokukoError } from '../../errors.js'
import type { RoutableAgent } from '../model-routing.js'
import type { ModelBinding } from '../model-configuration.js'

export interface DshSpawnBackend {
  getProvider?: (name:string)=>{capabilities:Record<string,boolean>}|undefined
  startActivation(spec: {
    provider: 'spawn'; label: string; signal: AbortSignal; delivery: 'caller';
    request: {
      parent: RoutableAgent; prompt: { type: 'text'; text: string }[];
      agentOptions: ModelBinding; maxDepth: number; toolFilter?: { allow: readonly string[] };
    };
  }): Promise<{ readonly childId: string; result: Promise<{ output: unknown; stopReason: string }>; dispose(): Promise<void> }>
}

type ToolFilter = {allow:readonly string[]}
function scopedTools(agent:RoutableAgent):{restrict?:(filter:ToolFilter)=>()=>void}|undefined {
  return (agent.ctx as RoutableAgent['ctx'] & {get?:(name:string,strict?:boolean)=>any})?.get?.('tools',false)
}
/** alpha.2 advertises backend filtering; alpha.3 exposes the same native mask on
 * the exact child scope. Missing capabilities never imply an unrestricted child. */
export function spawnRestrictionMode(backend:DshSpawnBackend|undefined,parent:RoutableAgent):'backend'|'scope'|undefined {
  if(!backend)return undefined
  if(!backend.getProvider)return 'backend' // Legacy adapters own the declared request contract.
  const capabilities=backend.getProvider('spawn')?.capabilities
  if(!capabilities?.agentOptions||!capabilities.depthLimit)return undefined
  if(capabilities.toolFilter)return 'backend'
  return typeof scopedTools(parent)?.restrict==='function'?'scope':undefined
}

/** Mechanical child ownership only. Each mode supplies and validates its own durable authority. */
export class ManagedAgentExecutor<B extends object> {
  readonly #pending = new AsyncLocalStorage<{ binding: B; child?: RoutableAgent; filter?:ToolFilter }>()
  readonly #children = new WeakMap<object, B>()
  constructor(readonly backend: DshSpawnBackend | undefined) {}
  created(agent: RoutableAgent): B | undefined {
    const pending = this.#pending.getStore()
    if (!pending || pending.child) return undefined
    if(pending.filter){
      const tools=scopedTools(agent)
      if(typeof tools?.restrict!=='function')throw new KiokukoError('SERVICE_UNAVAILABLE','Exact child scoped tool restriction is unavailable')
      tools.restrict(pending.filter)
    }
    pending.child = agent; this.#children.set(agent, pending.binding)
    return pending.binding
  }
  bind(agent: object, binding: B): void { this.#children.set(agent, binding) }
  binding(agent: object): B | undefined { return this.#children.get(agent) }
  async execute<T>(binding: B, request: Parameters<DshSpawnBackend['startActivation']>[0]['request'] & { signal: AbortSignal; label: string; toolFilter:ToolFilter }, consume: (result: Awaited<Awaited<ReturnType<DshSpawnBackend['startActivation']>>['result']>, agent: RoutableAgent) => Promise<T>): Promise<T> {
    if (!this.backend) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Native spawn delegation is unavailable')
    const mode=spawnRestrictionMode(this.backend,request.parent)
    if(!mode)throw new KiokukoError('SERVICE_UNAVAILABLE','Native spawn cannot enforce model, depth and scoped tool restrictions')
    const pending: { binding: B; child?: RoutableAgent; filter?:ToolFilter } = { binding, ...(mode==='scope'?{filter:{allow:[...request.toolFilter.allow]}}:{}) }
    const run = await this.#pending.run(pending, () => this.backend!.startActivation({
      provider: 'spawn', label: request.label, signal: request.signal, delivery: 'caller',
      request: { parent: request.parent, prompt: request.prompt, agentOptions: request.agentOptions,
        maxDepth: request.maxDepth, ...(mode==='backend'?{toolFilter:request.toolFilter}:{}) },
    }))
    let disposal: Promise<void> | undefined
    const dispose = () => disposal ??= Promise.resolve().then(() => run.dispose())
    const abort = () => { void dispose().catch(() => {}) }
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    try {
      const child = pending.child
      if (!child || this.binding(child) !== binding) throw new KiokukoError('INTEGRITY_ERROR', 'Spawn did not establish the exact managed child before first execution')
      if (run.childId !== (child.session?.id ?? child.id)) throw new KiokukoError('INTEGRITY_ERROR', 'Managed child Session identity differs from the published activation')
      return await consume(await run.result, child)
    } finally {
      request.signal.removeEventListener('abort', abort)
      await dispose()
    }
  }
}
