import type { Context } from '@deepseek-ai/cordis'
import type { LispManager } from './manager.js'
import { failure, identifier, type LispOwner } from './contracts.js'

/** Human-only recovery entry point; no approval token or file-write action is accepted. */
export function mountLispHttp(ctx: Context, manager: LispManager, resolveOwner: (session: string, recover?: boolean) => LispOwner): () => void {
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
      if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length !== 1 || !('action' in parsed)) throw new Error('Invalid action')
      let result: unknown
      if (parsed.action === 'cancel') result = await manager.execute(owner, 'lisp_cancel', {})
      else if (parsed.action === 'recover') result = await manager.recover(resolveOwner(id, true), request.signal)
      else throw new Error('Invalid action')
      return Response.json(result, { headers })
    } catch (error) { return Response.json(failure(error), { status: 409, headers }) }
  } })
}
