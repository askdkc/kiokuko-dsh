import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { KiokukoError } from '../errors.js'
import type { DshCoreRuntime } from './core-runtime.js'
import type { ExecutionIdentity, ExecutionReceipt } from './owned-execution.js'
import { isNativeSubagent } from './native-subagent.js'
import { TASK_AUTHORITY, authorizeTaskLease, type TaskAuthorityExecution, type TaskLease } from './task-state.js'
import { captureExecutionTaskLease, withTaskAuthority } from './task-authority-context.js'

type Agent = { id: string; status?: string; cancel?(reason: unknown): void; whenIdle?(): Promise<void>; session?: { id: string; header?: { cwd?: string; parentSession?: unknown; origin?: string; delegationDepth?: number } } }
type Execution = TaskAuthorityExecution & { agent?: any }
interface Backend { startActivation(spec: any): Promise<any> }
interface Options {
  runtime: DshCoreRuntime; repositoryRoot: string; backend: Backend | undefined
  agents: { get(id: string): object | undefined; list?(): readonly Agent[] } | undefined
  sessions: { get(id: string): object | undefined } | undefined
  resolveParent(execution: Execution): ExecutionIdentity | undefined
}
type Proof = { parent: Agent; identity: ExecutionIdentity; lease: TaskLease; child?: Agent; live: boolean; completed?: boolean; launch?: Promise<any> }

const hosts = new WeakMap<DshCoreRuntime, Set<NativeTaskAuthority>>()
export async function stopTaskNativeChildren(runtime: DshCoreRuntime, task: {taskId:string;repositoryRoot:string}, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  const results = await Promise.all([...hosts.get(runtime) ?? []].map(host => host.stopTask(task,signal)))
  if (results.some(result=>!result)) return false
  return runtime.withDatabase(db => !db.prepare("SELECT receipt_json FROM dsh_owned_operations WHERE run_id=? AND state='started'")
    .all<{receipt_json:string}>(task.taskId).some(row => {
      const receipt=JSON.parse(row.receipt_json) as ExecutionReceipt
      return receipt.kind==='native_child' && receipt.repositoryRoot===task.repositoryRoot
    })).catch(()=>false)
}

/** Only a native launch reserved by this host grants child authority. Session
 * header ancestry alone is untrusted; reload deliberately requires a new launch. */
export class NativeTaskAuthority {
  private readonly proofs = new Map<string, Proof>()
  private readonly original: Backend['startActivation'] | undefined
  private readonly wrapper: Backend['startActivation'] | undefined
  private stopped = false
  constructor(private readonly options: Options) {
    const registered = hosts.get(options.runtime) ?? new Set(); registered.add(this); hosts.set(options.runtime,registered)
    const backend = options.backend
    if (!backend?.startActivation) return
    const original = this.original = backend.startActivation, host = this
    this.wrapper = async function (this: Backend, spec: any) {
      if (host.stopped || spec.delivery !== 'parent' || !['spawn', 'fork'].includes(spec.provider)) return original.call(this, spec)
      const parent = spec.request?.parent as Agent | undefined
      if (!parent || !host.local(parent)) return original.call(this, spec)
      host.exact(parent)
      const execution: Execution = { agent: parent }
      const identity = host.resolve(execution) ?? options.resolveParent(execution)
      if (!identity) throw new KiokukoError('CONFLICT', 'No admitted task owns this native child launch')
      const pinned = Object.freeze({ ...identity })
      const lease = await options.runtime.withDatabase(db => captureExecutionTaskLease(db, {
        taskId: pinned.runId, sessionId: pinned.workflowSessionId ?? pinned.sessionId, repositoryRoot: pinned.repositoryRoot,
      }, execution))
      host.exact(parent)
      const current = host.resolve(execution) ?? options.resolveParent(execution)
      if (!current || !host.same(pinned, current)) throw new KiokukoError('CONFLICT', 'Native child task owner changed')
      spec.signal?.throwIfAborted()
      const childId = spec.childId ?? randomUUID()
      if (host.proofs.has(childId)) throw new KiokukoError('CONFLICT', 'Native child identity already reserved')
      const proof: Proof = { parent, identity: pinned, lease, live: true }
      await host.receipt(childId,proof,'started',true)
      host.proofs.set(childId, proof)
      try {
        proof.launch = withTaskAuthority(lease, () => original.call(this, { ...spec, childId }))
        const result = await proof.launch
        if (result.childId !== childId) throw new KiokukoError('INTEGRITY_ERROR', 'Native child identity changed')
        const child = options.agents?.list?.().find(agent => agent.session?.id === childId)
        if (child) {
          host.exact(child)
          if (!host.local(child) || !isNativeSubagent(child) || child.session?.header?.parentSession !== parent.session?.id)
            throw new KiokukoError('CONFLICT', 'Native child lineage changed')
          proof.child = child
          // This is the exact activation returned by the trusted backend. Its
          // result settles after teardown; a memoized dispose also exposes any
          // teardown failure that did not replace a captured model result.
          if (result.result && typeof result.dispose === 'function')
            void host.observeNaturalCompletion(childId, proof, result).catch(() => {})
        }
        return result
      } catch (error) { proof.live = false; throw error }
    }
    backend.startActivation = this.wrapper
  }
  private local(agent: Agent): boolean {
    try { return !!agent.session?.header?.cwd && realpathSync(agent.session.header.cwd) === this.options.repositoryRoot } catch { return false }
  }
  private exact(agent: Agent): void {
    if (!agent.session || this.options.agents?.get(agent.id) !== agent || this.options.sessions?.get(agent.session.id) !== agent.session)
      throw new KiokukoError('CONFLICT', 'Native child runtime identity changed')
  }
  private same(left: ExecutionIdentity, right: ExecutionIdentity): boolean {
    return left.agent === right.agent && left.runId === right.runId && left.sessionId === right.sessionId
      && left.workflowSessionId === right.workflowSessionId && left.repositoryRoot === right.repositoryRoot && left.generation === right.generation
  }
  resolve(execution: Execution): ExecutionIdentity | undefined {
    const agent = execution.agent as Agent | undefined
    if (!agent?.session || !isNativeSubagent(agent)) return undefined
    const proof = this.proofs.get(agent.session.id)
    if (this.stopped || !proof?.live) return undefined
    this.exact(agent); this.exact(proof.parent)
    if (!this.local(agent) || agent.session.header?.parentSession !== proof.parent.session!.id || proof.child && proof.child !== agent)
      throw new KiokukoError('CONFLICT', 'Native child lineage changed')
    proof.child ??= agent
    const parentExecution: Execution = { agent: proof.parent }
    const current = this.resolve(parentExecution) ?? this.options.resolveParent(parentExecution)
    if (!current || !this.same(proof.identity, current)) throw new KiokukoError('CONFLICT', 'Native child task owner changed')
    execution[TASK_AUTHORITY] = proof.lease
    return { ...proof.identity, sessionId: agent.session.id, workflowSessionId: proof.lease.sessionId, agent }
  }
  /** Reading/cancelling an old child receipt remains possible after parent stop. */
  read(execution: Execution): ExecutionIdentity | undefined {
    const agent = execution.agent as Agent | undefined, proof = agent?.session ? this.proofs.get(agent.session.id) : undefined
    if (this.stopped || !agent?.session || !proof?.live) return undefined
    this.exact(agent)
    if (!this.local(agent) || !isNativeSubagent(agent) || agent.session.header?.parentSession !== proof.parent.session?.id || proof.child && proof.child !== agent) return undefined
    proof.child ??= agent
    return { ...proof.identity, sessionId: agent.session.id, workflowSessionId: proof.lease.sessionId, agent }
  }
  private async receipt(childId:string, proof:Proof, state:'started'|'completed', authorize=false): Promise<void> {
    const operationId=`native-child:${childId}`
    const receipt:ExecutionReceipt={version:1,operationId,runId:proof.lease.taskId,sessionId:proof.identity.sessionId,generation:proof.identity.generation,
      kind:'native_child',repositoryRoot:proof.lease.repositoryRoot,cwd:proof.lease.repositoryRoot,targets:[],state,evidenceRef:operationId,persistence:'saved',taskAuthority:proof.lease}
    await this.options.runtime.withDatabase(db=>{
      if(authorize)authorizeTaskLease(db,proof.lease)
      if(state==='completed') {
        try { authorizeTaskLease(db,proof.lease); receipt.authority='current' }
        catch { receipt.authority='stale' }
      }
      db.prepare(`INSERT INTO dsh_owned_operations(operation_id,run_id,session_id,generation,request_digest,state,receipt_json,updated_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,receipt_json=excluded.receipt_json,updated_at=excluded.updated_at`)
        .run(operationId,receipt.runId,receipt.sessionId,receipt.generation,JSON.stringify(proof.lease),state,JSON.stringify(receipt),new Date().toISOString())
    })
    if(state==='completed')proof.completed=true
  }
  private async observeNaturalCompletion(childId:string, proof:Proof, activation:{result:Promise<unknown>;dispose():Promise<void>}):Promise<void> {
    await activation.result
    await activation.dispose()
    const child=proof.child
    if(this.stopped||!proof.live||proof.completed||!child?.session||!child.whenIdle)return
    await child.whenIdle()
    if(this.stopped||!proof.live||proof.completed||child.status!=='idle')return
    // Successful native teardown can remove the exact object. A replacement
    // with the same id is never evidence about this activation.
    const registered=this.options.agents?.get(child.id), session=this.options.sessions?.get(child.session.id)
    if(registered&&registered!==child||session&&session!==child.session)return
    if(!this.local(child)||!isNativeSubagent(child)||child.session.header?.parentSession!==proof.parent.session?.id)return
    await this.receipt(childId,proof,'completed')
  }
  async stopTask(task:{taskId:string;repositoryRoot:string},signal?:AbortSignal):Promise<boolean> {
    const pending=[...this.proofs].filter(([,proof])=>proof.lease.taskId===task.taskId&&proof.lease.repositoryRoot===task.repositoryRoot)
    await Promise.allSettled(pending.map(([,proof])=>proof.launch))
    let confirmed=true
    for(const [id,proof] of pending){
      signal?.throwIfAborted()
      if(proof.completed)continue
      const child=proof.child??this.options.agents?.list?.().find(agent=>agent.session?.id===id)
      if(!child){confirmed=false;continue}
      this.exact(child)
      if(!isNativeSubagent(child)||child.session?.header?.parentSession!==proof.parent.session?.id){confirmed=false;continue}
      proof.child=child
      if(child.status!=='idle')child.cancel?.({kind:'hook',reason:'Kiokuko task stopped'})
      if(!child.whenIdle){confirmed=false;continue}
      await child.whenIdle();signal?.throwIfAborted()
      this.exact(child)
      if(child.status!=='idle'){confirmed=false;continue}
      await this.receipt(id,proof,'completed')
    }
    return confirmed
  }
  dispose(): void {
    this.stopped = true; this.proofs.clear(); hosts.get(this.options.runtime)?.delete(this)
    const backend = this.options.backend
    if (backend && backend.startActivation === this.wrapper && this.original) backend.startActivation = this.original
  }
}
