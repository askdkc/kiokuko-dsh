import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { KiokukoError } from '../errors.js'
import { canonicalContentHash } from '../serialization/validate.js'
import type { SqliteDatabase } from '../db/adapter.js'
import { HeadWorkerConfigurationSchema, type HeadWorkerConfiguration } from './head-worker-configuration.js'
import type { ModelBinding } from './model-configuration.js'
import type { RoutableAgent } from './model-routing.js'
import { isNativeSubagent } from './native-subagent.js'

const OwnerSchema = z.object({ id: z.string().min(1), sessionId: z.string().min(1), selectionId: z.string().min(1), pair: HeadWorkerConfigurationSchema }).strict()
export type NativeWorkerOwner = z.infer<typeof OwnerSchema>
interface NativeBackend { startActivation(spec: any): Promise<any> }
interface Options {
  runtime: { withDatabase<T>(fn: (db: SqliteDatabase) => T | Promise<T>): Promise<T> }
  backend: NativeBackend | undefined
  agents: { get(id: string): object | undefined; list?(): readonly RoutableAgent[] } | undefined
  sessions: { get(id: string): object | undefined } | undefined
  resolveOwner(agent: RoutableAgent, signal: AbortSignal): Promise<NativeWorkerOwner | undefined>
  validate(pair: HeadWorkerConfiguration, signal: AbortSignal): Promise<void>
}
type Row = { child_session_id: string; parent_session_id: string; owner_json: string; state: string }
const same = (left: unknown, right: unknown) => canonicalContentHash(left) === canonicalContentHash(right)

/** Route only an explicitly selected pair. Native DSH still owns launch,
 * composition, approval, depth, delivery and continuation. No tool is added.
 * Reserved native child IDs let the durable receipt precede the first request.
 */
export class NativeWorkerRouting {
  private readonly admitting = new Set<string>()
  private readonly requests = new WeakMap<object, NativeWorkerOwner>()
  private readonly original: NativeBackend['startActivation'] | undefined
  private readonly wrapper: NativeBackend['startActivation'] | undefined
  private stopped = false
  constructor(private readonly options: Options) {
    const backend = options.backend
    if (!backend?.startActivation) return
    const original = this.original = backend.startActivation
    const routing = this
    this.wrapper = async function (this: NativeBackend, spec: any) {
      if (routing.stopped || spec.delivery !== 'parent' || !['spawn', 'fork'].includes(spec.provider)) return original.call(this, spec)
      const parent = spec.request?.parent as RoutableAgent | undefined
      if (!parent) return original.call(this, spec)
      const owner = isNativeSubagent(parent)
        ? await routing.childOwner(parent, spec.signal)
        : await routing.owner(parent, spec.signal)
      if (!owner) return original.call(this, spec)
      await routing.options.validate(owner.pair, spec.signal)
      await routing.assertOwner(owner, spec.signal)
      routing.identity(parent)
      spec.signal.throwIfAborted()
      const childId = spec.childId ?? randomUUID()
      await routing.options.runtime.withDatabase(db => db.prepare('INSERT INTO dsh_native_worker_routes(child_session_id,parent_session_id,owner_json,state,created_at) VALUES(?,?,?,\'admitting\',?)')
        .run(childId, parent.session!.id, JSON.stringify(owner), new Date().toISOString()))
      routing.admitting.add(childId)
      try {
        const { provider: _provider, model: _model, reasoningEffort: _effort, ...other } = spec.request.agentOptions ?? {}
        const result = await original.call(this, { ...spec, childId, request: { ...spec.request, agentOptions: { ...other, ...owner.pair.worker } } })
        if (result.childId !== childId) throw new KiokukoError('INTEGRITY_ERROR', 'Native worker Session identity changed')
        await routing.options.runtime.withDatabase(db => db.prepare("UPDATE dsh_native_worker_routes SET state='active' WHERE child_session_id=? AND state='admitting'").run(childId))
        return result
      } catch (error) {
        await routing.options.runtime.withDatabase(db => db.prepare("UPDATE dsh_native_worker_routes SET state='revoked' WHERE child_session_id=?").run(childId))
        throw error
      } finally { routing.admitting.delete(childId) }
    }
    backend.startActivation = this.wrapper
  }
  private identity(agent: RoutableAgent): void {
    if (!agent.session || this.options.agents?.get(agent.id) !== agent || this.options.sessions?.get(agent.session.id) !== agent.session)
      throw new KiokukoError('CONFLICT', 'Native worker routing identity mismatch')
  }
  private async owner(agent: RoutableAgent, signal: AbortSignal): Promise<NativeWorkerOwner | undefined> {
    // Other repository adapters sharing this service must remain untouched.
    const selected = await this.options.resolveOwner(agent, signal)
    if (!selected) return undefined
    this.identity(agent)
    if (selected.sessionId !== agent.session!.id || isNativeSubagent(agent)) throw new KiokukoError('CONFLICT', 'Native worker owner identity mismatch')
    return OwnerSchema.parse(selected)
  }
  private async assertOwner(expected: NativeWorkerOwner, signal: AbortSignal): Promise<void> {
    const roots = (this.options.agents?.list?.() ?? []).filter(agent => agent.session?.id === expected.sessionId)
    if (roots.length !== 1) throw new KiokukoError('CONFLICT', 'Native worker owner is no longer available')
    const current = await this.owner(roots[0]!, signal)
    if (!current || !same(current, expected)) throw new KiokukoError('CONFLICT', 'Native worker selection or owner changed')
    signal.throwIfAborted()
  }
  private async childOwner(agent: RoutableAgent, signal: AbortSignal): Promise<NativeWorkerOwner | undefined> {
    if (!agent.session) return undefined
    const row = await this.options.runtime.withDatabase(db => db.prepare('SELECT child_session_id,parent_session_id,owner_json,state FROM dsh_native_worker_routes WHERE child_session_id=?').get<Row>(agent.session!.id))
    if (!row) return undefined
    this.identity(agent)
    if (!isNativeSubagent(agent) || agent.session.header?.parentSession !== row.parent_session_id)
      throw new KiokukoError('CONFLICT', 'Native worker lineage mismatch')
    if (row.state !== 'active' && !(row.state === 'admitting' && this.admitting.has(row.child_session_id)))
      throw new KiokukoError('CONFLICT', 'Native worker selection is not active')
    const owner = OwnerSchema.parse(JSON.parse(row.owner_json))
    await this.assertOwner(owner, signal)
    return owner
  }
  async head(agent: RoutableAgent, signal: AbortSignal): Promise<ModelBinding | undefined> {
    this.requests.delete(agent)
    if (isNativeSubagent(agent)) return undefined
    const owner = await this.owner(agent, signal)
    if (!owner) return undefined
    await this.options.validate(owner.pair, signal)
    await this.assertOwner(owner, signal)
    this.requests.set(agent, owner)
    return { ...owner.pair.head }
  }
  async worker(agent: RoutableAgent, signal: AbortSignal): Promise<ModelBinding | undefined> {
    this.requests.delete(agent)
    const owner = await this.childOwner(agent, signal)
    if (!owner) return undefined
    await this.options.validate(owner.pair, signal)
    await this.assertOwner(owner, signal)
    this.requests.set(agent, owner)
    return { ...owner.pair.worker }
  }
  /** The request can be assembled before a user changes the selection. */
  async assertRequest(agent: RoutableAgent, binding: ModelBinding | undefined, signal = new AbortController().signal): Promise<void> {
    const expected = this.requests.get(agent)
    if (!expected) return
    const current = isNativeSubagent(agent) ? await this.childOwner(agent, signal) : await this.owner(agent, signal)
    if (!current || !same(expected, current) || !same(binding, isNativeSubagent(agent) ? expected.pair.worker : expected.pair.head))
      throw new KiokukoError('CONFLICT', 'Native worker request selection changed')
    await this.options.validate(expected.pair, signal)
    await this.assertOwner(expected, signal)
  }
  /** Model-selection revocation also fences results from a request already in flight. */
  async assertCurrent(agent: RoutableAgent, signal = new AbortController().signal): Promise<void> {
    await this.childOwner(agent, signal)
  }
  clearRequest(agent: object): void { this.requests.delete(agent) }
  dispose(): void {
    this.stopped = true
    const backend = this.options.backend
    if (backend && backend.startActivation === this.wrapper && this.original) backend.startActivation = this.original
  }
}
