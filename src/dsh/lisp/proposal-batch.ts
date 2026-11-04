import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { DshUserQuestions } from '../user-interaction.js'
import { digest, fail, failure, LispError, type LispOwner, type ProposalInput } from './contracts.js'
import { applyChange, backupUsage, freezeChange, restoreBytes, sameFile, snapshot, type FrozenChange, type CreatedParents, type FileSnapshot } from './files.js'
import type { LispStore } from './store.js'
import { isManagedAdmissionDenied } from '../managed-operation-runner.js'

export interface ChangeOutcome {
  id: string; path: string; state: 'APPLIED' | 'UNCHANGED' | 'NOT_APPLIED' | 'UNKNOWN';
  approval?: 'manual' | 'profile'; backup?: string | null; reason?: string; code?: string; message?: string
}
const contentHash = (text: string) => createHash('sha256').update(text).digest('hex')

/** Project-confined changes retain frozen targets, durable outcomes and backups. */
export class LispProposalBatch {
  readonly #targets = new Set<string>()
  #backupReserved = 0
  constructor(readonly options: { store: LispStore; backupRoot: string; protectedRoots: () => string[]; questions?: DshUserQuestions; stopped: () => boolean;
    authorizeEffect?: (owner: LispOwner) => Promise<void>;
    execute?: (owner:LispOwner,name:string,args:Record<string,unknown>,signal:AbortSignal,callId:string)=>Promise<any> }) {}

  async apply(owner: LispOwner, evalId: string, generation: string, requests: readonly ProposalInput[], signal: AbortSignal,
    restoration?: FrozenChange['restoration'], expected?: { readSet: FileSnapshot[]; targets: Record<string, FileSnapshot> }): Promise<ChangeOutcome[]> {
    requests = requests.map(request => ({ ...request }))
    if (!requests.length) return []
    const beforeEffect = async () => {
      if (!this.options.authorizeEffect) fail('TASK_REQUIRED', '変更の適用には現在の有効なタスクが必要です。')
      await this.options.authorizeEffect(owner)
      if (signal.aborted || this.options.stopped()) fail('CANCELLED', '残りの変更を取り消しました。')
    }
    if(this.options.execute){
      const outcomes:ChangeOutcome[]=[]
      if(expected)for(const before of expected.readSet){
        if(!sameFile(before,await snapshot(owner.root,before.path.slice(owner.root.length+1),this.options.protectedRoots())))
          return requests.map((request,index)=>({id:`${evalId}:${index}`,path:request.path,state:'NOT_APPLIED',code:'BASE_CHANGED'}))
      }
      for(const [index,request] of requests.entries()){
        if(signal.aborted||this.options.stopped())break
        let attempted = false
        try{
          const before=expected?.targets[request.path]
          const content = request.operation === 'write' ? restoration ? (await restoreBytes(restoration)).toString('utf8') : request.content : undefined
          await beforeEffect()
          attempted = true
          const result=await this.options.execute(owner,request.operation==='delete'?'kioku_remove':'kioku_write',
            {path:request.path,...(request.operation==='write'?{content}:{}),...(before?{expectedHash:before.hash??null}:{})},signal,`lisp-proposal:${evalId}:${index}`)
          const state=result.applied?'APPLIED':result.receipt?.state==='unknown'?'UNKNOWN':'NOT_APPLIED'
          outcomes.push({id:`${evalId}:${index}`,path:request.path,state,...(result.receipt?.error?{message:result.receipt.error}:{})})
          if(state!=='APPLIED')break
        }catch(error){const problem=failure(error);outcomes.push({id:`${evalId}:${index}`,path:request.path,state:attempted&&!isManagedAdmissionDenied(error)?'UNKNOWN':'NOT_APPLIED',code:problem.code,message:problem.message});break}
      }
      for(const [index,request] of requests.entries())if(!outcomes.some(outcome=>outcome.path===request.path))outcomes.push({id:`${evalId}:${index}`,path:request.path,state:'NOT_APPLIED',reason:'batch_stopped'})
      return outcomes
    }
    const { store, backupRoot } = this.options, roots = this.options.protectedRoots()
    const changes: FrozenChange[] = [], reserved = new Map<string, string>(), outcomes: ChangeOutcome[] = []
    let backupReservation = 0
    const id = (c: FrozenChange) => `proposal-${c.id}`
    const record = async (c: FrozenChange, outcome: ChangeOutcome) => {
      await store.transition(owner, id(c), [reserved.get(id(c))!], outcome.state, { evalId, ...outcome })
      reserved.set(id(c), outcome.state); outcomes.push(outcome)
    }
    try {
      if (new Set(requests.map(r => r.path)).size !== requests.length) throw new LispError('DUPLICATE_TARGET', '同じ評価内の変更対象は一意にしてください。', '重複した変更案を一つにまとめてください。')
      await beforeEffect()
      await mkdir(backupRoot, { recursive: true, mode: 0o700 })
      const pending = await store.pendingTargets()
      for (const request of requests) {
        const c = await freezeChange(owner, request, backupRoot, roots)
        const expectedTarget = expected?.targets[request.path]
        if (expected && (!expectedTarget || !sameFile(c.before, expectedTarget)))
          fail('BASE_CHANGED', '候補作成時の対象が変わりました。')
        if (restoration) { await restoreBytes(restoration); c.restoration = restoration }
        if (this.#targets.has(c.before.path) || pending.some(o => (JSON.parse(o.payload) as FrozenChange).before.path === c.before.path)) fail('TARGET_LOCKED', '対象に未確定の変更があります。新しい変更は適用していません。')
        this.#targets.add(c.before.path); changes.push(c)
      }
      for (const c of changes) {
        if (!c.restoration && c.request.operation === 'write' && c.before.hash === contentHash(c.request.content)) {
          outcomes.push({ id: id(c), path: c.request.path, state: 'UNCHANGED' }); continue
        }
        const payload = { ...c, evalId }
        await store.reserve(owner, id(c), 'proposal', digest(payload), generation, payload); reserved.set(id(c), 'RUNNING')
      }
      const active = changes.filter(c => reserved.has(id(c)))
      if (!active.length) return outcomes
      if (expected) for (const before of expected.readSet) {
        const relative = before.path.slice(owner.root.length + 1)
        if (!sameFile(before, await snapshot(owner.root, relative, roots))) fail('BASE_CHANGED', '候補の根拠が変わりました。')
      }
      backupReservation = active.reduce((sum, c) => sum + (c.before.size ?? 0), 0)
      this.#backupReserved += backupReservation
      if (await backupUsage(backupRoot) + this.#backupReserved > 1024 ** 3) fail('BACKUP_LIMIT', 'バックアップが 1 GiB に達するため変更を適用していません。')
      // freezeChange has already confined every target to the project and
      // rejected protected paths/links. Local changes need no extra approval.
      // Validate the entire frozen batch before the first filesystem effect.
      if (expected) for (const before of expected.readSet) {
        const relative = before.path.slice(owner.root.length + 1)
        if (!sameFile(before, await snapshot(owner.root, relative, roots))) throw new LispError('BASE_CHANGED', '確認中に候補の根拠が変わりました。')
      }
      for (const c of active) if (!sameFile(c.before, await snapshot(owner.root, c.request.path, roots))) throw new LispError('TARGET_CHANGED', '確認中に対象が変わったため、この変更群を適用していません。', '変更後の内容を読み、新しい差分を作成してください。')
      const createdParents: CreatedParents = new Map()
      for (const c of active) {
        if (signal.aborted || this.options.stopped()) throw new LispError('CANCELLED', '残りの変更を取り消しました。', '適用済みの変更は結果一覧で確認できます。')
        await beforeEffect()
        await store.transition(owner, id(c), [reserved.get(id(c))!], 'APPLYING', { evalId }); reserved.set(id(c), 'APPLYING')
        await applyChange(owner, c, roots, createdParents, beforeEffect)
        await record(c, { id: id(c), path: c.request.path, state: 'APPLIED', backup: c.backup, approval: 'profile' })
      }
      return outcomes
    } catch (error) {
      const problem = failure(error)
      for (const c of changes) {
        const state = reserved.get(id(c))
        if (state && ['RUNNING', 'AWAITING_APPROVAL', 'APPLYING'].includes(state)) await record(c, {
          id: id(c), path: c.request.path, state: state === 'APPLYING' ? 'UNKNOWN' : 'NOT_APPLIED',
          code: problem.code, message: problem.message, reason: problem.code === 'CANCELLED' ? 'cancelled' : 'batch_failed',
        })
      }
      for (const request of requests) if (!outcomes.some(o => o.path === request.path)) outcomes.push({
        id: evalId, path: request.path, state: 'NOT_APPLIED', code: problem.code, message: problem.message, reason: 'batch_failed',
      })
      return outcomes
    } finally {
      for (const c of changes) this.#targets.delete(c.before.path)
      this.#backupReserved -= backupReservation
    }
  }
}
