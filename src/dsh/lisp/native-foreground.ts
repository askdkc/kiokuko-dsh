import { AsyncLocalStorage } from 'node:async_hooks'

const synchronous = new AsyncLocalStorage<{ active: boolean }>()
interface Jobs { start: (...args: any[]) => any }
const installed = new WeakMap<Jobs, { users: number; release(): void }>()

/** Keep the admitted native Bash policy/dispatch path, but refuse job
 * admission BEFORE a producer starts. Native Bash handles registry admission
 * refusal by using its foreground executor with kill-on-timeout semantics.
 * Changing shell expiry alone is insufficient: it races the promotion timer.
 * This scope never changes another invocation's background policy. */
export async function withNativeForegroundOnly<T>(jobs: Jobs | undefined, dispatch: () => Promise<T>): Promise<T> {
  if (!jobs || typeof jobs.start !== 'function') return dispatch()
  let entry = installed.get(jobs)
  if (!entry) {
    const original = jobs.start
    const wrapper = function (this: Jobs, ...args: any[]) {
      if (synchronous.getStore()?.active)
        throw new Error('Lisp synchronous command requires foreground execution; job admission refused before launch.')
      return Reflect.apply(original, this, args)
    }
    jobs.start = wrapper
    entry = { users: 0, release() {
      if (--this.users) return
      if (jobs.start === wrapper) jobs.start = original
      installed.delete(jobs)
    } }
    installed.set(jobs, entry)
  }
  entry.users++
  const scope = { active: true }
  try { return await synchronous.run(scope, dispatch) }
  finally { scope.active = false; entry.release() }
}
