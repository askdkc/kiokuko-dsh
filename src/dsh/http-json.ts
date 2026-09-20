/** Discard late results, including non-cooperative credential/fetch implementations. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); signal.throwIfAborted() }
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}
/** Read one bounded JSON body without retaining provider diagnostics in public errors. */
export async function readBoundedJson(response: Response, signal: AbortSignal, bytesLimit: number, failure: (kind: 'large' | 'malformed') => Error): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > bytesLimit) { void response.body?.cancel().catch(() => {}); throw failure('large') }
  if (!response.body) throw failure('malformed')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0, complete = false
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) { complete = true; break }
      bytes += chunk.value.byteLength
      if (bytes > bytesLimit) throw failure('large')
      chunks.push(chunk.value)
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
    catch { throw failure('malformed') }
  } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock() }
}
