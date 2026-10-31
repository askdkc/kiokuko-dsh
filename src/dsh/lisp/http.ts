import type { Context } from '@deepseek-ai/cordis'
import type { LispManager } from './manager.js'
import { failure, identifier, type LispOwner } from './contracts.js'

/** Human-only recovery entry point; no approval token or file-write action is accepted. */
export function mountLispHttp(ctx: Context, manager: LispManager, resolveOwner: (session: string, recover?: boolean) => LispOwner, recover?: (session: string, signal: AbortSignal) => Promise<unknown>): () => void {
  const connection = ctx.get('connection', false) as { fetch?: { register(route: { path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response> }): () => void } } | undefined
  if (!connection?.fetch) return () => {}
  return connection.fetch.register({ path: '/api/kiokuko.lisp', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: async request => {
    const headers = { 'cache-control': 'no-store' }
    try {
      const url = new URL(request.url), id = identifier.parse(url.searchParams.get('sessionId'))
      const owner = resolveOwner(id)
      if (request.method === 'GET') return Response.json(await manager.status(owner), { headers })
      const origin = request.headers.get('origin')
      const browser = origin ? new URL(origin) : undefined
      // DSH reconstructs the internal Request URL; preserve its authenticated Host header.
      if (!browser || !['http:', 'https:'].includes(browser.protocol) || browser.host !== (request.headers.get('host') ?? url.host)) return Response.json({ message: '接続元が一致しません。同じ DSH 画面を開き直してください。' }, { status: 403, headers })
      const body = await request.text()
      if (body.length > 1024) return Response.json({ error: 'Request too large' }, { status: 413, headers })
      const parsed: unknown = JSON.parse(body)
      const shape = (parsed as { action?: unknown })?.action === 'abandon-managed'
        ? ['action', 'operationId', 'evidence']
        : ['action']
      if (!parsed || typeof parsed !== 'object' || !('action' in parsed)
        || Object.keys(parsed).some(key => !shape.includes(key)) || !('action' in parsed)) throw new Error('Invalid action')
      let result: unknown
      if (parsed.action === 'cancel') result = await manager.execute(owner, 'lisp_cancel', {})
      else if (parsed.action === 'recover') { const current = resolveOwner(id, true); result = await (recover ? recover(id, request.signal) : manager.recover(current, request.signal)) }
      else if (parsed.action === 'abandon-managed') {
        // Human reconciliation from the Lisp control; the exact ID and the
        // inspected evidence stay explicit so nothing is cleared by a guess.
        const payload = JSON.parse(body) as { action: string; operationId?: unknown; evidence?: unknown }
        if (typeof payload.operationId !== 'string' || typeof payload.evidence !== 'string') throw new Error('Invalid action')
        result = await manager.abandonManaged(owner, payload.operationId, payload.evidence)
      }
      else throw new Error('Invalid action')
      return Response.json(result, { headers })
    } catch (error) { return Response.json(failure(error), { status: 409, headers }) }
  } })
}
