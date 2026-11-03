import { AsyncLocalStorage } from 'node:async_hooks'
import { scopeChainOf } from '@deepseek-ai/dsh-scope'

interface Agent { id: string; session: { id: string; header: { parentSession?: string } } }
interface Backend { startActivation(spec: any): Promise<any> }

/** Capture native launch authority before agent/created, when current DSH has
 * not yet published the child into its activation tree. Session metadata alone
 * is never proof of live ownership. */
export class NativeChildOwnership {
  private readonly pending = new AsyncLocalStorage<{ parent: Agent; childId?: string; child?: Agent }>()
  private readonly parents = new WeakMap<Agent, Agent>()
  private readonly original: Backend['startActivation'] | undefined
  private readonly wrapper: Backend['startActivation'] | undefined
  constructor(private readonly backend: Backend | undefined, private readonly agents: { get(id: string): Agent | undefined }) {
    if (!backend) return
    const original = this.original = backend.startActivation, ownership = this
    this.wrapper = async function (this: Backend, spec: any) {
      const parent = spec.parent ?? spec.request?.parent
      if (!['spawn', 'fork'].includes(spec.provider) || !parent || ownership.agents.get(parent.id) !== parent) return original.call(this, spec)
      const pending: { parent: Agent; childId?: string; child?: Agent } = { parent, childId: spec.childId }
      try {
        const activation = await ownership.pending.run(pending, () => original.call(this, spec))
        if (pending.child && activation.childId !== pending.child.id) ownership.parents.delete(pending.child)
        return activation
      } catch (error) {
        if (pending.child) ownership.parents.delete(pending.child)
        throw error
      }
    }
    backend.startActivation = this.wrapper
  }
  created(child: Agent): void {
    const pending = this.pending.getStore()
    if (!pending || pending.child || this.agents.get(child.id) !== child
      || child.session.header.parentSession !== pending.parent.session.id
      || pending.childId !== undefined && pending.childId !== child.id) return
    pending.child = child
    this.parents.set(child, pending.parent)
  }
  owns(child: Agent, parent: Agent): boolean {
    return this.agents.get(child.id) === child && this.agents.get(parent.id) === parent
      && (this.parents.get(child) === parent || scopeChainOf(child).slice(1).includes(parent))
  }
  dispose(): void {
    if (this.backend && this.backend.startActivation === this.wrapper && this.original) this.backend.startActivation = this.original
  }
}
