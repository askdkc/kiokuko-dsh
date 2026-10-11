/** Bound async I/O even when a reader or fixture does not honor fetch cancellation. */
export function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
