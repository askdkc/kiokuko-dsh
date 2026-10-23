import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { SqliteDatabase } from '../db/adapter.js'
import { withImmediateTransaction } from '../db/transaction.js'

/** Audit of plugin-managed boundaries, not a sandbox or an OS-wide tracer. */
export const MANAGED_JOURNAL_COVERAGE = Object.freeze(['lisp-process-bridge', 'owned-process', 'owned-file'] as const)
export type JournalState = 'prepared' | 'dispatching' | 'running' | 'completed' | 'denied' | 'cancelled-before-dispatch' | 'cancelled-confirmed' | 'unknown'
export type JournalDelivery = 'pending' | 'delivered' | 'not-delivered' | 'unknown'
export type JournalCause = 'permission-denied' | 'cancelled' | 'timeout' | 'dispatch-error' | 'persistence-error' | 'recovery' | 'host-error'
export interface JournalBinding {
  taskId: string; unitId?: string; workerGeneration?: string | number
  protocolBindGeneration?: number; leaseAuthorityGeneration?: number; leaseRevision?: number
}
export interface JournalScope {
  scopeId: string; sessionId: string; requestId?: string; parentId: string; runtimeIdentity: string
  binding?: JournalBinding; createdAt: number; coverage: readonly string[]
}
export interface JournalTransition {
  state: JournalState; outcome?: 'succeeded' | 'failed'; receiptRef?: string; cause?: JournalCause
}
export interface ManagedOperation extends JournalTransition {
  operationId: string; scopeId: string; parentId: string; sequence: number
  route: 'native' | 'owned'; kind: 'process' | 'file'; binding?: JournalBinding
  requestDigest: string; normalizationVersion: 1; runtimeIdentity: string; originalRef?: string
  delivery: JournalDelivery; createdAt: number; updatedAt: number
}
export interface ManagedJournalSnapshot {
  snapshotId: string; scopeId: string; scope: JournalScope; sealed: boolean; collectorComplete: boolean
  complete: boolean; unresolved: number; operations: readonly ManagedOperation[]; createdAt: number
}
export interface JournalLimits { maxOperations: number; maxOperationsPerScope: number; maxScopes: number; maxSnapshots: number; maxRequestBytes: number; retentionMs: number }
const defaults: JournalLimits = {maxOperations: 100000, maxOperationsPerScope: 4096, maxScopes: 10000, maxSnapshots: 20000, maxRequestBytes: 1048576, retentionMs: 30 * 86400000}
const terminal = new Set<JournalState>(['completed', 'denied', 'cancelled-before-dispatch', 'cancelled-confirmed'])
const states = new Set<JournalState>(['prepared','dispatching','running','completed','denied','cancelled-before-dispatch','cancelled-confirmed','unknown'])
const causes = new Set<JournalCause>(['permission-denied','cancelled','timeout','dispatch-error','persistence-error','recovery','host-error'])
function fail(): never { throw new Error('Managed operation journal contract violation') }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
function exactKeys(value: object, allowed: string[]): void { if(Object.keys(value).some(key=>!allowed.includes(key))) fail() }
function boundedText(value: unknown): asserts value is string { if (typeof value !== 'string' || value.length < 1 || value.length > 512) fail() }
/** Typed canonical encoding distinguishes missing, undefined, null and empty values.
 * This keyed private digest is not a claim of anonymous/public-safe secret hashing. */
export function canonicalJournalRequest(value: unknown): string {
  const seen = new Set<object>()
  function encode(v: unknown, depth: number): unknown {
    if (depth > 64) fail()
    if (v === undefined) return ['undefined']
    if (v === null) return ['null']
    if (typeof v === 'string' || typeof v === 'boolean') return [typeof v, v]
    if (typeof v === 'number' && Number.isFinite(v)) return ['number', Object.is(v,-0) ? '-0' : String(v)]
    if (typeof v !== 'object' || seen.has(v)) fail()
    seen.add(v)
    let result: unknown
    if (Array.isArray(v)) result = ['array', Array.from({length:v.length},(_,i)=> i in v ? encode(v[i],depth+1) : ['missing'])]
    else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail()
      result = ['object', Object.keys(v).sort().map(key => [key, encode((v as Record<string,unknown>)[key],depth+1)])]
    }
    seen.delete(v); return result
  }
  return JSON.stringify(['managed-request-v1', encode(value,0)])
}

export class ManagedOperationJournal {
  readonly limits: JournalLimits
  constructor(private readonly db: SqliteDatabase, limits: Partial<JournalLimits> = {}) {
    this.limits = {...defaults,...limits}
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) fail()
  }
  private transaction<T>(fn:()=>T):T { return withImmediateTransaction(this.db,fn) }
  private count(table:string):number { return this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{n:number}>()!.n }
  private scopeRow(id:string) {
    const row=this.db.prepare('SELECT scope_json,sealed,collector_complete FROM dsh_managed_scopes WHERE scope_id=?').get<{scope_json:string;sealed:number;collector_complete:number}>(id)
    if (!row) fail(); return row
  }
  readScope(id:string):JournalScope { return freeze(JSON.parse(this.scopeRow(id).scope_json) as JournalScope) }
  createScope(input:Omit<JournalScope,'scopeId'|'createdAt'|'coverage'>):JournalScope {
    boundedText(input.sessionId); boundedText(input.parentId); boundedText(input.runtimeIdentity)
    if(input.requestId !== undefined) boundedText(input.requestId)
    if (input.binding) {
      exactKeys(input.binding,['taskId','unitId','workerGeneration','protocolBindGeneration','leaseAuthorityGeneration','leaseRevision'])
      boundedText(input.binding.taskId)
      if(input.binding.unitId!==undefined) boundedText(input.binding.unitId)
      for(const key of ['protocolBindGeneration','leaseAuthorityGeneration','leaseRevision'] as const) {
        const value=input.binding[key]; if(value!==undefined && (!Number.isSafeInteger(value)||value<0)) fail()
      }
      const worker=input.binding.workerGeneration
      if(worker!==undefined && typeof worker!=='string' && (!Number.isSafeInteger(worker)||worker<0)) fail()
    }
    return this.transaction(()=>{
      if(this.count('dsh_managed_scopes')>=this.limits.maxScopes) throw new Error('Managed journal scope capacity exceeded')
      const scope:JournalScope={sessionId:input.sessionId,parentId:input.parentId,runtimeIdentity:input.runtimeIdentity,
        ...(input.requestId!==undefined?{requestId:input.requestId}:{}),...(input.binding?{binding:JSON.parse(JSON.stringify(input.binding))}:{}),
        scopeId:randomUUID(),createdAt:Date.now(),coverage:MANAGED_JOURNAL_COVERAGE}
      this.db.prepare('INSERT INTO dsh_managed_scopes(scope_id,scope_json,created_at) VALUES(?,?,?)').run(scope.scopeId,JSON.stringify(scope),scope.createdAt)
      return freeze(scope)
    })
  }
  private digest(request:unknown):string {
    const data=canonicalJournalRequest(request)
    if(Buffer.byteLength(data)>this.limits.maxRequestBytes) throw new Error('Managed journal request capacity exceeded')
    let key=this.db.prepare('SELECT secret FROM dsh_managed_journal_keys WHERE id=1').get<{secret:string}>()?.secret
    if(!key) { key=randomBytes(32).toString('hex'); this.db.prepare('INSERT INTO dsh_managed_journal_keys VALUES(1,?)').run(key) }
    return createHmac('sha256',key).update(data).digest('hex')
  }
  prepare(scopeId:string,input:{route:'native'|'owned';kind:'process'|'file';request:unknown;originalRef?:string}):ManagedOperation {
    if(!['native','owned'].includes(input.route)||!['process','file'].includes(input.kind)) fail()
    if(input.originalRef!==undefined) boundedText(input.originalRef)
    try { return this.transaction(()=>{
      const row=this.scopeRow(scopeId); if(row.sealed || !row.collector_complete) throw new Error('Managed scope is sealed or incomplete')
      const scope=JSON.parse(row.scope_json) as JournalScope
      const n=this.db.prepare('SELECT COUNT(*) AS n FROM dsh_managed_operations WHERE scope_id=?').get<{n:number}>(scopeId)!.n
      if(n>=this.limits.maxOperationsPerScope || this.count('dsh_managed_operations')>=this.limits.maxOperations) throw new Error('Managed journal operation capacity exceeded')
      const now=Date.now(), op:ManagedOperation={operationId:randomUUID(),scopeId,parentId:scope.parentId,sequence:n+1,
        route:input.route,kind:input.kind,...(scope.binding?{binding:scope.binding}:{}),requestDigest:this.digest(input.request),normalizationVersion:1,
        runtimeIdentity:scope.runtimeIdentity,...(input.originalRef?{originalRef:input.originalRef}:{}),state:'prepared',delivery:'pending',createdAt:now,updatedAt:now}
      this.db.prepare('INSERT INTO dsh_managed_operations VALUES(?,?,?,?,?)').run(op.operationId,scopeId,op.sequence,op.state,JSON.stringify(op))
      this.append(op); return freeze(op)
    }) } catch(error) {
      // Admission/storage failure must not later appear as a complete zero-operation scope.
      try { this.markIncomplete(scopeId) } catch { /* A still-failing DB cannot issue evidence. */ }
      throw error
    }
  }
  /** Enrich authority at the host reservation boundary, before any observed result.
   * Evaluation scopes can contain operations from different units; never rewrite scope identity. */
  bindOperation(id:string,input:{binding:JournalBinding;runtimeIdentity:string;bindScope?:boolean}):ManagedOperation {
    boundedText(input.runtimeIdentity); boundedText(input.binding.taskId)
    exactKeys(input,['binding','runtimeIdentity','bindScope'])
    exactKeys(input.binding,['taskId','unitId','workerGeneration','protocolBindGeneration','leaseAuthorityGeneration','leaseRevision'])
    if(input.binding.unitId!==undefined) boundedText(input.binding.unitId)
    if(typeof input.binding.workerGeneration==='string') boundedText(input.binding.workerGeneration)
    else if(input.binding.workerGeneration!==undefined && (!Number.isSafeInteger(input.binding.workerGeneration)||input.binding.workerGeneration<0)) fail()
    for(const key of ['protocolBindGeneration','leaseAuthorityGeneration','leaseRevision'] as const){
      const value=input.binding[key];if(value!==undefined && (!Number.isSafeInteger(value)||value<0))fail()
    }
    return this.transaction(()=>{
      const op=this.readOperation(id);if(op.state!=='dispatching') fail()
      if(op.binding){
        for(const [key,value] of Object.entries(op.binding)) if(input.binding[key as keyof JournalBinding]!==value) fail()
        if(op.binding.protocolBindGeneration!==undefined && op.runtimeIdentity!==input.runtimeIdentity) fail()
      }
      if(input.bindScope){
        const row=this.scopeRow(op.scopeId)
        const count=this.db.prepare('SELECT COUNT(*) AS n FROM dsh_managed_operations WHERE scope_id=?').get<{n:number}>(op.scopeId)!.n
        if(row.sealed || count!==1) fail()
        const scope=JSON.parse(row.scope_json) as JournalScope
        const bound={...scope,binding:JSON.parse(JSON.stringify(input.binding)),runtimeIdentity:input.runtimeIdentity}
        this.db.prepare('UPDATE dsh_managed_scopes SET scope_json=? WHERE scope_id=?').run(JSON.stringify(bound),op.scopeId)
      }
      return this.save({...op,binding:JSON.parse(JSON.stringify(input.binding)),runtimeIdentity:input.runtimeIdentity,updatedAt:Date.now()})
    })
  }
  attachOriginalRef(id:string,originalRef:string):ManagedOperation {
    boundedText(originalRef)
    return this.transaction(()=>{
      const op=this.readOperation(id)
      if(op.originalRef && op.originalRef!==originalRef) fail()
      if(op.originalRef===originalRef) return op
      return this.save({...op,originalRef,updatedAt:Date.now()})
    })
  }
  lookupOriginalOperation(originalRef:string):ManagedOperation|undefined {
    boundedText(originalRef)
    const row=this.db.prepare("SELECT operation_json FROM dsh_managed_operations WHERE json_extract(operation_json,'$.originalRef')=?").get<{operation_json:string}>(originalRef)
    return row ? freeze(JSON.parse(row.operation_json) as ManagedOperation) : undefined
  }
  snapshotForOriginal(originalRef:string):ManagedJournalSnapshot {
    const op=this.lookupOriginalOperation(originalRef); if(!op) fail(); return this.snapshot(op.scopeId)
  }
  readOperation(id:string):ManagedOperation {
    const row=this.db.prepare('SELECT operation_json FROM dsh_managed_operations WHERE operation_id=?').get<{operation_json:string}>(id)
    if(!row) fail(); return freeze(JSON.parse(row.operation_json) as ManagedOperation)
  }
  private append(op:ManagedOperation):void {
    const n=this.db.prepare('SELECT COUNT(*) AS n FROM dsh_managed_transitions WHERE operation_id=?').get<{n:number}>(op.operationId)!.n
    if(n>=128) throw new Error('Managed journal transition capacity exceeded')
    this.db.prepare('INSERT INTO dsh_managed_transitions VALUES(?,?,?)').run(op.operationId,n+1,JSON.stringify(op))
  }
  private save(op:ManagedOperation):ManagedOperation {
    this.db.prepare('UPDATE dsh_managed_operations SET state=?,operation_json=? WHERE operation_id=?').run(op.state,JSON.stringify(op),op.operationId)
    this.append(op); return freeze(op)
  }
  /** Only the successful claimant may dispatch; replay is observation, never execution. */
  claim(id:string,request?:unknown):boolean {
    return this.transaction(()=>{
      const op=this.readOperation(id)
      if(arguments.length>1 && this.digest(request)!==op.requestDigest) throw new Error('Managed operation request mismatch')
      if(op.state!=='prepared') return false
      const row=this.scopeRow(op.scopeId); if(row.sealed || !row.collector_complete) return false
      // SQL CAS as well as the write lock: exactly one claimant can dispatch.
      const claimed:ManagedOperation={...op,state:'dispatching',updatedAt:Date.now()}
      const rowClaim=this.db.prepare("UPDATE dsh_managed_operations SET state='dispatching',operation_json=? WHERE operation_id=? AND state='prepared' RETURNING operation_id").get(JSON.stringify(claimed),id)
      if(!rowClaim) return false
      this.append(claimed); return true
    })
  }
  transition(id:string,next:JournalTransition):ManagedOperation {
    exactKeys(next,['state','outcome','receiptRef','cause'])
    return this.transaction(()=>{
      const op=this.readOperation(id)
      if(!states.has(next.state) || next.state==='prepared' || next.state==='dispatching') fail()
      if(next.cause!==undefined&&!causes.has(next.cause)) fail()
      if(next.receiptRef!==undefined) boundedText(next.receiptRef)
      if(next.state==='completed' ? !['succeeded','failed'].includes(next.outcome??'') : next.outcome!==undefined) fail()
      if(terminal.has(op.state)) {
        if(op.state===next.state && op.outcome===next.outcome && op.receiptRef===next.receiptRef && op.cause===next.cause) return op
        fail()
      }
      if(op.state==='unknown' && next.state!=='unknown') throw new Error('Managed operation requires explicit reconciliation')
      if(op.state==='prepared' && !['denied','cancelled-before-dispatch','unknown'].includes(next.state)) fail()
      if(op.state==='running' && ['denied','cancelled-before-dispatch'].includes(next.state)) fail()
      return this.save({...op,...next,updatedAt:Date.now()})
    })
  }
  /** Host must first verify original receipt/process identity. No dispatch occurs here. */
  reconcile(id:string,next:JournalTransition & {receiptRef:string}):ManagedOperation {
    exactKeys(next,['state','outcome','receiptRef','cause'])
    return this.transaction(()=>{
      const op=this.readOperation(id); if(op.state!=='unknown'||!terminal.has(next.state)) fail()
      boundedText(next.receiptRef)
      if(next.state==='completed' ? !['succeeded','failed'].includes(next.outcome??'') : next.outcome!==undefined) fail()
      if(next.cause!==undefined&&!causes.has(next.cause)) fail()
      return this.save({...op,...next,updatedAt:Date.now()})
    })
  }
  setDelivery(id:string,delivery:JournalDelivery):ManagedOperation {
    if(!['pending','delivered','not-delivered','unknown'].includes(delivery)) fail()
    return this.transaction(()=>{const op=this.readOperation(id);if(op.delivery===delivery)return op;return this.save({...op,delivery,updatedAt:Date.now()})})
  }
  markIncomplete(scopeId:string):void { this.transaction(()=>{this.scopeRow(scopeId);this.db.prepare('UPDATE dsh_managed_scopes SET collector_complete=0 WHERE scope_id=?').run(scopeId)}) }
  seal(scopeId:string):void { this.transaction(()=>{this.scopeRow(scopeId);this.db.prepare('UPDATE dsh_managed_scopes SET sealed=1 WHERE scope_id=?').run(scopeId)}) }
  recover(scopeId:string):void {
    this.transaction(()=>{
      this.scopeRow(scopeId)
      for(const row of this.db.prepare("SELECT operation_id FROM dsh_managed_operations WHERE scope_id=? AND state IN ('dispatching','running')").all<{operation_id:string}>(scopeId))
        this.transition(row.operation_id,{state:'unknown',cause:'recovery'})
    })
  }
  snapshot(scopeId:string):ManagedJournalSnapshot {
    return this.transaction(()=>{
      if(this.count('dsh_managed_snapshots')>=this.limits.maxSnapshots) throw new Error('Managed journal snapshot capacity exceeded')
      const row=this.scopeRow(scopeId),operations=this.db.prepare('SELECT operation_json FROM dsh_managed_operations WHERE scope_id=? ORDER BY sequence').all<{operation_json:string}>(scopeId).map(r=>JSON.parse(r.operation_json) as ManagedOperation)
      const unresolved=operations.filter(op=>!terminal.has(op.state)).length
      const snapshot:ManagedJournalSnapshot={snapshotId:randomUUID(),scopeId,scope:JSON.parse(row.scope_json),sealed:!!row.sealed,collectorComplete:!!row.collector_complete,
        complete:!!row.sealed && !!row.collector_complete && unresolved===0,unresolved,operations,createdAt:Date.now()}
      this.db.prepare('INSERT INTO dsh_managed_snapshots(snapshot_id,scope_id,snapshot_json,created_at) VALUES(?,?,?,?)').run(snapshot.snapshotId,scopeId,JSON.stringify(snapshot),snapshot.createdAt)
      return freeze(snapshot)
    })
  }
  readSnapshot(id:string):ManagedJournalSnapshot {
    const row=this.db.prepare('SELECT snapshot_json FROM dsh_managed_snapshots WHERE snapshot_id=?').get<{snapshot_json:string}>(id)
    if(!row) fail();return freeze(JSON.parse(row.snapshot_json) as ManagedJournalSnapshot)
  }
  retainSnapshot(id:string):void { this.transaction(()=>{this.readSnapshot(id);this.db.prepare('UPDATE dsh_managed_snapshots SET retained=1 WHERE snapshot_id=?').run(id)}) }
  /** Never expire unresolved operations or scopes referenced by retained evidence. */
  prune(now=Date.now()):number {
    return this.transaction(()=>{
      const rows=this.db.prepare(`WITH RECURSIVE protected(scope_id) AS (
        SELECT scope_id FROM dsh_managed_snapshots WHERE retained=1
        UNION SELECT scope_id FROM dsh_managed_operations WHERE state NOT IN ('completed','denied','cancelled-before-dispatch','cancelled-confirmed')
        UNION SELECT o.scope_id FROM protected p JOIN dsh_managed_scopes c ON c.scope_id=p.scope_id
          JOIN dsh_managed_operations o ON o.operation_id=json_extract(c.scope_json,'$.parentId')
        ) SELECT scope_id FROM dsh_managed_scopes s WHERE sealed=1 AND created_at<?
        AND NOT EXISTS(SELECT 1 FROM protected p WHERE p.scope_id=s.scope_id)
        AND NOT EXISTS(SELECT 1 FROM dsh_managed_operations o WHERE o.scope_id=s.scope_id AND state NOT IN ('completed','denied','cancelled-before-dispatch','cancelled-confirmed'))`).all<{scope_id:string}>(now-this.limits.retentionMs)
      for(const row of rows){
        this.db.prepare('DELETE FROM dsh_managed_transitions WHERE operation_id IN (SELECT operation_id FROM dsh_managed_operations WHERE scope_id=?)').run(row.scope_id)
        this.db.prepare('DELETE FROM dsh_managed_operations WHERE scope_id=?').run(row.scope_id)
        this.db.prepare('DELETE FROM dsh_managed_snapshots WHERE scope_id=?').run(row.scope_id)
        this.db.prepare('DELETE FROM dsh_managed_scopes WHERE scope_id=?').run(row.scope_id)
      }
      return rows.length
    })
  }
}
