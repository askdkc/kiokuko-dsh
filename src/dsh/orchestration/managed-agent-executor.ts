import { AsyncLocalStorage } from 'node:async_hooks'
import { KiokukoError } from '../../errors.js'
import type { RoutableAgent } from '../model-routing.js'
import type { ModelBinding } from '../model-configuration.js'

export interface DshSpawnBackend {
  start(name: 'spawn', request: {
    parent: RoutableAgent; prompt: { type: 'text'; text: string }[]; signal: AbortSignal;
    agentOptions: ModelBinding; maxDepth: number; toolFilter: { allow: readonly string[] }; label: string;
  }): Promise<{ readonly id: string; readonly localAgent?: RoutableAgent; result: Promise<{ output: unknown; stopReason: string }>; dispose(): Promise<void> }>
}

/** Mechanical child ownership only. Each mode supplies and validates its own durable authority. */
export class ManagedAgentExecutor<B extends object> {
  readonly #pending = new AsyncLocalStorage<{ binding: B; child?: RoutableAgent }>()
  readonly #children = new WeakMap<object, B>()
  constructor(readonly backend: DshSpawnBackend | undefined) {}
  created(agent: RoutableAgent): B | undefined {
    const pending = this.#pending.getStore()
    if (!pending || pending.child) return undefined
    pending.child = agent; this.#children.set(agent, pending.binding)
    return pending.binding
  }
  bind(agent: object, binding: B): void { this.#children.set(agent, binding) }
  binding(agent: object): B | undefined { return this.#children.get(agent) }
  async execute<T>(binding: B, request: Parameters<DshSpawnBackend['start']>[1], consume: (result: Awaited<Awaited<ReturnType<DshSpawnBackend['start']>>['result']>, agent: RoutableAgent) => Promise<T>): Promise<T> {
    if (!this.backend) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Native spawn delegation is unavailable')
    const pending: { binding: B; child?: RoutableAgent } = { binding }
    const run = await this.#pending.run(pending, () => this.backend!.start('spawn', request))
    try {
      if (!run.localAgent || pending.child !== run.localAgent || this.binding(run.localAgent) !== binding) throw new KiokukoError('INTEGRITY_ERROR', 'Spawn did not establish the exact managed child before first execution')
      if (run.id !== (run.localAgent.session?.id ?? run.localAgent.id)) throw new KiokukoError('INTEGRITY_ERROR', 'Managed child Session identity differs from the published run')
      return await consume(await run.result, run.localAgent)
    } finally { await run.dispose() }
  }
}
