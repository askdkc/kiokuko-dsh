import { digest } from './lisp-prototype-evidence.mjs'

/** Meter the real provider serializer at fetch, before any network effect. No retry/redirect. */
export function evaluationFetch(config, budget, signal, records, request = fetch) {
  const endpoint = `${config.baseURL.replace(/\/$/u, '')}/chat/completions`
  const base = config.baseURL.replace(/\/+$/u, '')
  const messagesEndpoint = `${new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`}/messages`
  return async (url, init) => {
    if (![endpoint, messagesEndpoint].includes(String(url)) || init?.method !== 'POST') throw new Error('unapproved_evaluation_endpoint')
    const body = JSON.parse(String(init.body))
    if (body.model !== config.model || body.max_tokens !== config.maxOutputTokens) throw new Error('evaluation_model_or_output_limit_changed')
    signal.throwIfAborted()
    if (!budget.reserve()) throw new Error('evaluation_budget_exhausted')
    const row = { requestDigest: digest(String(init.body)), status: 'failed', responseDigest: null, usage: null, responseModel: null }
    records.push(row)
    const response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) })
    if (!response.ok || !response.body) throw new Error('evaluation_provider_http_error')
    const reader = response.body.getReader(), chunks = []
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        signal.throwIfAborted()
        bytes += value.byteLength
        if (bytes > 4 * 1024 * 1024) throw new Error('evaluation_response_limit')
        chunks.push(value)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    const text = Buffer.concat(chunks).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue
      const event = JSON.parse(line.slice(5))
      const model = event.model ?? event.message?.model
      if (model) {
        if (model !== config.model) throw new Error('evaluation_response_model_changed')
        row.responseModel = model
      }
      if (event.usage ?? event.message?.usage) row.usage = { ...row.usage, ...(event.usage ?? event.message.usage) }
    }
    if (!row.responseModel) throw new Error('evaluation_response_model_missing')
    row.status = 'completed'; row.responseDigest = digest(text)
    return new Response(text, { status: response.status, headers: { 'content-type': 'text/event-stream' } })
  }
}
