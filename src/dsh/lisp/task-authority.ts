import type { LispNativeCommands } from '../lisp-tool-identity.js'
import { readProtocol } from '../guardrail/service.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SqliteDatabase } from '../../db/adapter.js'
import { authorizeTaskLease, findSessionTask, type TaskLease, type TaskSnapshot } from '../task-state.js'
import { fail, LispError, type LispOwner } from './contracts.js'
import type { LispDatabase } from './store.js'
import { currentTaskAuthority, hasNoTaskAuthority } from '../task-authority-context.js'

export interface LispTaskExecution {
  readonly owner: LispOwner
  readonly lease?: TaskLease
  readonly nativeCommands?: LispNativeCommands
  readonly unavailable?: unknown
  performedEffect: boolean
}

/** Pin task identity once per host invocation. Worker RPC callbacks must restore
 * this exact binding; they may not capture a newer task after an await or job. */
export class LispTaskAuthority {
  readonly #scope = new AsyncLocalStorage<LispTaskExecution>()
  constructor(private readonly database: LispDatabase) {}

  current(): LispTaskExecution | undefined { return this.#scope.getStore() }

  async run<T>(owner: LispOwner, action: () => Promise<T>, nativeCommands?: LispNativeCommands): Promise<T> {
    const current = this.current()
    if (current) { this.checkOwner(current, owner); return action() }
    nativeCommands?.assertCurrent()
    const inherited = currentTaskAuthority()
    if (inherited && (inherited.sessionId !== owner.sessionId || inherited.repositoryRoot !== owner.root))
      fail('TASK_OWNER_MISMATCH', '呼び出し元のタスクと Lisp のセッションが一致しません。')
    let task: TaskSnapshot | undefined, unavailable: unknown
    // A compiled outer execution which began without a task cannot acquire one
    // merely because another turn admitted work while it was awaiting.
    if (!inherited && !hasNoTaskAuthority()) {
      try { task = await this.database(db => findSessionTask(db, { sessionId: owner.sessionId, repositoryRoot: owner.root })) }
      catch (error) { unavailable = error }
    }
    const binding: LispTaskExecution = { owner: { ...owner }, performedEffect: false,
      ...(nativeCommands ? { nativeCommands } : {}),
      ...(unavailable ? { unavailable } : {}),
      ...(inherited ? { lease: Object.freeze({ ...inherited }) } : task ? { lease: Object.freeze({ taskId: task.taskId, sessionId: task.sessionId, repositoryRoot: task.repositoryRoot,
        revision: task.revision, generation: task.generation }) } : {}) }
    return this.#scope.run(binding, action)
  }

  bound<T>(binding: LispTaskExecution | undefined, action: () => Promise<T>): Promise<T> {
    if (!binding) fail('TASK_REQUIRED', 'この実行のタスク識別子を確認できません。作業状態を確認してください。')
    return this.#scope.run(binding, action)
  }

  private checkOwner(binding: LispTaskExecution, owner: LispOwner): void {
    if (binding.owner.sessionId !== owner.sessionId || binding.owner.agentId !== owner.agentId || binding.owner.root !== owner.root)
      fail('TASK_OWNER_MISMATCH', '実行中にタスクのセッションまたは作業場所が変わりました。')
  }

  async authorizeEffect(owner: LispOwner, route: 'direct' | 'owned' | 'protected' = 'direct'): Promise<TaskLease> {
    const binding = this.current()
    if (binding?.unavailable) fail('TASK_STATE_UNAVAILABLE', 'タスク状態を確認できないため、副作用を停止しました。')
    if (!binding?.lease) fail('TASK_REQUIRED', '副作用を実行するには、このセッションの Working タスクが必要です。')
    this.checkOwner(binding, owner)
    await this.database(db => { this.validate(db, binding.lease!); if (route === 'direct' && readProtocol(db,binding.lease!.taskId)) fail('PROTOCOL_ROUTE_REQUIRED','Bounded protocol effects require the owned tool bridge.') })
    binding.performedEffect = true
    return binding.lease
  }

  /** Called in the same synchronous database callback as a successful receipt.
   * Read-only/scratch computations retain their results without activating work. */
  authorizePublication(db: SqliteDatabase, owner: LispOwner): void {
    const binding = this.current()
    if (!binding?.performedEffect) return
    this.authorizeEffectPublication(db, owner)
  }

  /** Evidence itself is an effect, so it may never use the pure-result bypass. */
  authorizeEffectPublication(db: SqliteDatabase, owner: LispOwner): void {
    const binding = this.current()
    if (!binding?.lease) fail('TASK_REQUIRED', 'タスク識別子がない実行結果は確定できません。')
    this.checkOwner(binding, owner)
    this.validate(db, binding.lease)
  }

  private validate(db: SqliteDatabase, lease: TaskLease): void {
    try { authorizeTaskLease(db, lease) }
    catch (error) { throw new LispError('TASK_STATE_CONFLICT', error instanceof Error ? error.message : 'Task execution authority changed.', '/kioku-task status で状態を確認し、必要なら明示的に再開してください。') }
  }
}
