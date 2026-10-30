import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { canonicalContentHash } from '../serialization/validate.js'
import type { SqliteDatabase } from '../db/adapter.js'
import { withImmediateTransaction } from '../db/transaction.js'
import { abortable } from './http-json.js'
import { privateDirectory } from './agenticreplay-security.js'

const sourceSchema = z.object({
  sessionId: z.string().min(1).max(256).refine(s => !/[\p{Cc}\p{Cf}]/u.test(s)),
  turn: z.number().int().positive().safe(), origin: z.enum(['answer-context','intent-assessment']),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u), contextDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()
export type AuxiliarySource = z.infer<typeof sourceSchema>
type CheckResult = {state:'verified'|'rejected'|'retry_wait'|'stale';reason:string}
type Binding = {source:AuxiliarySource;current():boolean;check(signal:AbortSignal,attempt:number):Promise<CheckResult>;verified?():void|Promise<void>}
type Receipt = {id:string;storage:'database'|'private_file'|'unavailable';state:string;workMayContinue:true;memoryAdopted:false}
const reason = (value:string) => /^[a-z_]{1,64}$/u.test(value)?value:'auxiliary_failed'
const terminal = new Set(['verified','rejected','stale'])

/** Payload-free, bounded post-idle checks. Rebinding always requires the original native source. */
export class AuxiliaryRecovery {
  private bindings=new Map<string,Binding>()
  private running=new Map<string,Promise<void>>()
  private controllers=new Map<string,AbortController>()
  private idleSessions=new Set<string>()
  private timers=new Map<string,ReturnType<typeof setTimeout>>()
  private receipts=new Map<string,Receipt>()
  private stopped=false
  constructor(readonly runtime:{withDatabase<T>(fn:(db:SqliteDatabase)=>T|Promise<T>):Promise<T>},readonly directory:string,
    readonly options:{budgetMs?:number;retryMs?:number;now?:()=>number}={}){}
  private now(){return this.options.now?.()??Date.now()}
  private database<T>(operation:(db:SqliteDatabase)=>T):Promise<T>{
    const signal=AbortSignal.timeout(250)
    return abortable(this.runtime.withDatabase(db=>{
      signal.throwIfAborted()
      // A JS timer cannot interrupt synchronous SQLite's normal 5s busy wait.
      // This callback is synchronous; restore the shared connection before
      // yielding, so native authority transactions retain their own policy.
      const timeout=Number(db.prepare('PRAGMA busy_timeout').get()!.timeout)
      db.exec('PRAGMA busy_timeout=25')
      try{return operation(db)}finally{db.exec(`PRAGMA busy_timeout=${timeout}`)}
    }),signal)
  }
  private receipt(id:string,storage:Receipt['storage'],state:string):Receipt {
    const value:Receipt={id,storage,state,workMayContinue:true,memoryAdopted:false}
    this.receipts.set(id,value);return value
  }
  active(sessionId:string):void {
    this.idleSessions.delete(sessionId);this.controllers.get(sessionId)?.abort()
    clearTimeout(this.timers.get(sessionId));this.timers.delete(sessionId)
  }
  async defer(binding:Binding,why:string):Promise<Receipt> {
    const source=sourceSchema.parse(binding.source),id=canonicalContentHash(source)
    if(this.stopped)return this.receipt(id,'unavailable','closed')
    if(this.bindings.size>=64&&!this.bindings.has(id)){
      for(const [key] of this.bindings)if(terminal.has(this.receipts.get(key)?.state??'')){this.bindings.delete(key);this.receipts.delete(key);break}
      if(this.bindings.size>=64)return {id,storage:'unavailable',state:'capacity',workMayContinue:true,memoryAdopted:false}
    }
    this.bindings.set(id,{...binding,source})
    let state='pending'
    try {
      await this.database(db=>withImmediateTransaction(db,()=>{
        if(Number(db.prepare('SELECT count(*) AS n FROM dsh_auxiliary_recovery').get()!.n)>=256
          &&!db.prepare('SELECT id FROM dsh_auxiliary_recovery WHERE id=?').get(id))throw new Error('capacity')
        db.prepare(`INSERT OR IGNORE INTO dsh_auxiliary_recovery(id,session_id,native_turn,origin,source_digest,context_digest,state,last_reason,updated_at)
          VALUES(?,?,?,?,?,?,'pending',?,?)`).run(id,source.sessionId,source.turn,source.origin,source.sourceDigest,source.contextDigest,reason(why),this.now())
        state=String(db.prepare('SELECT state FROM dsh_auxiliary_recovery WHERE id=?').get(id)!.state)
      }))
      void rm(join(this.directory,`${id}.json`),{force:true}).catch(()=>{})
      return this.receipt(id,'database',state)
    } catch {
      const path=join(this.directory,`${id}.json`),temporary=join(this.directory,`${id}.${randomUUID()}.tmp`)
      const signal=AbortSignal.timeout(250)
      try {
        await abortable((async()=>{
          await mkdir(join(this.directory,'..'),{recursive:true,mode:0o700});await privateDirectory(this.directory)
          const entries=(await readdir(this.directory)).filter(p=>/^[a-f0-9]{64}\.json$/u.test(p))
          if(entries.length>=256&&!entries.includes(`${id}.json`))throw new Error('capacity')
          signal.throwIfAborted()
          const f=await open(temporary,'wx',0o600)
          try {await f.writeFile(JSON.stringify({format:'kiokuko.auxiliary-quarantine.v1',id,source,reason:reason(why),memoryAdopted:false,evidence:'native_session_and_private_database'}));await f.sync()} finally {await f.close()}
          signal.throwIfAborted();await rename(temporary,path)
        })().finally(()=>rm(temporary,{force:true})),signal)
        return this.receipt(id,'private_file',state)
      } catch {return this.receipt(id,'unavailable',state)}
    }
  }
  idle(sessionId:string):Promise<void> {
    if(this.stopped)return Promise.resolve()
    this.idleSessions.add(sessionId)
    const old=this.running.get(sessionId);if(old)return old
    const operation=this.run(sessionId).finally(()=>{if(this.running.get(sessionId)===operation)this.running.delete(sessionId)})
    this.running.set(sessionId,operation);void operation.catch(()=>{});return operation
  }
  private wake(sessionId:string,delay:number):void {
    if(!this.idleSessions.has(sessionId)||this.stopped)return
    clearTimeout(this.timers.get(sessionId))
    const timer=setTimeout(()=>{this.timers.delete(sessionId);void this.idle(sessionId)},Math.max(1,delay))
    timer.unref();this.timers.set(sessionId,timer)
  }
  private async run(sessionId:string):Promise<void> {
    for(const [id,b] of [...this.bindings]){
      if(b.source.sessionId!==sessionId||!this.idleSessions.has(sessionId)||this.stopped)continue
      // Allow the default 5s provider deadline plus the 1.5s native judge.
      const nonce=randomUUID(),budget=this.options.budgetMs??8000
      const c=new AbortController();this.controllers.set(sessionId,c)
      try {
        // A restart/file fallback can rebind only from a freshly validated native source.
        const stored=await this.defer(b,'retry_pending')
        if(stored.storage!=='database')continue
        if(!b.current()){
          await this.database(db=>db.prepare("UPDATE dsh_auxiliary_recovery SET state='stale',last_reason='source_changed',lease_nonce=NULL,lease_until=NULL WHERE id=? AND state NOT IN ('verified','rejected','stale')").run(id))
          this.receipt(id,'database',terminal.has(stored.state)?stored.state:'stale');continue
        }
        c.signal.throwIfAborted()
        const claim=await this.database(db=>withImmediateTransaction(db,()=>{
          db.prepare("UPDATE dsh_auxiliary_recovery SET state=CASE WHEN attempts>=3 THEN 'rejected' ELSE 'retry_wait' END,lease_nonce=NULL,lease_until=NULL,last_reason='interrupted' WHERE id=? AND state='running' AND lease_until<=?").run(id,this.now())
          return db.prepare(`UPDATE dsh_auxiliary_recovery SET state='running',attempts=attempts+1,lease_nonce=?,lease_until=?,updated_at=?
            WHERE id=? AND state IN ('pending','retry_wait') AND attempts<3 AND next_at<=? RETURNING attempts`).get<{attempts:number}>(nonce,this.now()+budget+500,this.now(),id,this.now())
        }))
        if(!claim){
          const row=await this.database(db=>db.prepare('SELECT state,next_at,lease_until FROM dsh_auxiliary_recovery WHERE id=?').get(id))
          if(row){this.receipt(id,'database',String(row.state));if(!terminal.has(String(row.state)))this.wake(sessionId,Number(row.lease_until??row.next_at)-this.now())}
          continue
        }
        const signal=AbortSignal.any([c.signal,AbortSignal.timeout(budget)])
        let result:CheckResult
        try {result=await abortable(b.check(signal,claim.attempts),signal);signal.throwIfAborted()}
        catch {result={state:'retry_wait',reason:signal.aborted?'deadline_or_interruption':'auxiliary_failed'}}
        if(!b.current())result={state:'stale',reason:'source_changed'}
        if(result.state==='retry_wait'&&claim.attempts>=3)result={state:'rejected',reason:'attempt_limit'}
        const saved=await this.database(db=>db.prepare(`UPDATE dsh_auxiliary_recovery SET state=?,last_reason=?,lease_nonce=NULL,lease_until=NULL,next_at=?,updated_at=?
          WHERE id=? AND state='running' AND lease_nonce=? RETURNING id`).get(result.state,reason(result.reason),this.now()+(this.options.retryMs??1000),this.now(),id,nonce))
        if(!saved){this.receipt(id,'database','lease_lost');continue}
        this.receipt(id,'database',result.state)
        if(result.state==='verified'&&!signal.aborted&&b.current()){
          try{await abortable(Promise.resolve(b.verified?.()),signal)}
          catch{this.receipt(id,'database','verified_effect_unconfirmed')}
        }
        if(result.state==='retry_wait')this.wake(sessionId,this.options.retryMs??1000)
      } catch {this.receipt(id,this.receipts.get(id)?.storage??'unavailable','retry_wait')}
      finally {if(this.controllers.get(sessionId)===c)this.controllers.delete(sessionId)}
    }
  }
  status(sessionId:string):readonly Receipt[] {return [...this.bindings].filter(([,b])=>b.source.sessionId===sessionId).map(([id])=>this.receipts.get(id)??{id,storage:'unavailable',state:'unknown',workMayContinue:true,memoryAdopted:false})}
  async close():Promise<void>{this.stopped=true;for(const c of this.controllers.values())c.abort();for(const t of this.timers.values())clearTimeout(t);await Promise.allSettled(this.running.values())}
}
