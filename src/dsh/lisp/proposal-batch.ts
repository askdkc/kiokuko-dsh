import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { DshUserQuestions } from '../user-interaction.js'
import { confirm } from './approval.js'
import { digest, fail, failure, LispError, type LispOwner, type ProposalInput } from './contracts.js'
import { applyChange, backupUsage, checkedBytes, freezeChange, restoreBytes, sameFile, snapshot, type FrozenChange, type CreatedParents } from './files.js'
import type { LispStore } from './store.js'

export interface ChangeOutcome {
  id: string; path: string; state: 'APPLIED' | 'UNCHANGED' | 'NOT_APPLIED' | 'UNKNOWN';
  backup?: string | null; reason?: string; code?: string; message?: string
}
const contentHash = (text: string) => createHash('sha256').update(text).digest('hex')

/** A single replacement hunk, with common surrounding lines removed, not an LLM summary. */
function changeDiff(before: string, after: string): string {
  const a = before.split('\n'), b = after.split('\n')
  let start = 0, end = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const lines = [...a.slice(start, a.length - end).map(line => `-${line}`), ...b.slice(start, b.length - end).map(line => `+${line}`)]
  let fenceLength = 3
  for (const line of lines) for (const match of line.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1)
  const fence = '`'.repeat(fenceLength)
  return `${fence}diff\n@@ -${start + 1},${a.length - end - start} +${start + 1},${b.length - end - start} @@\n${lines.join('\n')}\n${fence}`
}

/** One frozen batch, one consent, independent durable outcomes and backups. */
export class LispProposalBatch {
  readonly #targets = new Set<string>()
  #backupReserved = 0
  constructor(readonly options: { store: LispStore; backupRoot: string; protectedRoots: () => string[]; questions?: DshUserQuestions; stopped: () => boolean }) {}

  async apply(owner: LispOwner, evalId: string, generation: string, requests: readonly ProposalInput[], signal: AbortSignal,
    restoration?: FrozenChange['restoration']): Promise<ChangeOutcome[]> {
    requests = requests.map(request => ({ ...request }))
    if (!requests.length) return []
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
      await mkdir(backupRoot, { recursive: true, mode: 0o700 })
      const pending = await store.pendingTargets()
      for (const request of requests) {
        const c = await freezeChange(owner, request, backupRoot, roots)
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
      backupReservation = active.reduce((sum, c) => sum + (c.before.size ?? 0), 0)
      this.#backupReserved += backupReservation
      if (await backupUsage(backupRoot) + this.#backupReserved > 1024 ** 3) fail('BACKUP_LIMIT', 'バックアップが 1 GiB に達するため変更を適用していません。')
      if (active.some(c => c.before.exists || c.request.operation === 'delete' || c.restoration)) {
        const details = []
        for (const c of active) {
          await store.transition(owner, id(c), ['RUNNING'], 'AWAITING_APPROVAL', { evalId }); reserved.set(id(c), 'AWAITING_APPROVAL')
          const before = c.before.exists ? (await checkedBytes(c.before)).toString('utf8') : ''
          const after = c.restoration ? (await restoreBytes(c.restoration)).toString('utf8') : c.request.operation === 'write' ? c.request.content : ''
          details.push(`対象: ${c.request.path}\n操作: ${c.restoration ? '復元' : c.request.operation}\n元内容 SHA-256: ${c.before.hash ?? '(新規)'}\n変更後 SHA-256: ${contentHash(after)}\nバックアップ: ${c.backup ?? '(不要)'}\n${changeDiff(before, after)}`)
        }
        const label = `${active.length}件の変更を許可`
        const approval = await confirm(this.options.questions, owner.agentId, {
          id: `batch-${digest({ evalId, changes: active })}`, header: 'Lisp · 変更をまとめて確認',
          question: `${active.length}件の確定した変更を適用しますか？`,
          detail: `${details.join('\n\n')}\n\n途中で競合・取消が起きた場合、残りの適用を止めます。適用済みの変更とバックアップは保持します。`,
          options: [{ label: '許可しない' }, { label }], intent: { kind: 'plan-review', approve: label },
        }, signal)
        if (!approval.approved) {
          for (const c of active) await record(c, { id: id(c), path: c.request.path, state: 'NOT_APPLIED', reason: approval.reason })
          return outcomes
        }
      }
      // Validate the entire frozen batch before the first filesystem effect.
      for (const c of active) if (!sameFile(c.before, await snapshot(owner.root, c.request.path, roots))) throw new LispError('TARGET_CHANGED', '確認中に対象が変わったため、この変更群を適用していません。', '変更後の内容を読み、新しい差分を作成してください。')
      const createdParents: CreatedParents = new Map()
      for (const c of active) {
        if (signal.aborted || this.options.stopped()) throw new LispError('CANCELLED', '残りの変更を取り消しました。', '適用済みの変更は結果一覧で確認できます。')
        await store.transition(owner, id(c), [reserved.get(id(c))!], 'APPLYING', { evalId }); reserved.set(id(c), 'APPLYING')
        await applyChange(owner, c, roots, createdParents)
        await record(c, { id: id(c), path: c.request.path, state: 'APPLIED', backup: c.backup })
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
