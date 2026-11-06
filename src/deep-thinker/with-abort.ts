export function withDeepAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) void Promise.resolve(promise).catch(() => {})
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('Aborted')) }
    signal.addEventListener('abort', abort, {once:true})
    Promise.resolve(promise).then(value => {cleanup();resolve(value)}, error => {cleanup();reject(error)})
  })
}
