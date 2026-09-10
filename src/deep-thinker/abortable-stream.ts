export function withDeepAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('Aborted')) }
    signal.addEventListener('abort', abort, {once:true})
    Promise.resolve(promise).then(value => {cleanup();resolve(value)}, error => {cleanup();reject(error)})
  })
}

/** Stop consuming even if an upstream provider fails to observe AbortSignal. */
export async function* abortableStream<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]()
  let finished = false
  try {
    while (true) {
      signal?.throwIfAborted()
      const item = await new Promise<IteratorResult<T>>((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', abort)
        const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Aborted')) }
        signal?.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => iterator.next()).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
      })
      if (item.done) { finished = true; return }
      yield item.value
    }
  } finally { if (!finished) void iterator.return?.().catch(() => {}) }
}
