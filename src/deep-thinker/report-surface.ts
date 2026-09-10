import type { Context } from '@deepseek-ai/cordis'
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { DeepPlanningController } from './controller.js'

/** DSH's authenticated fetch registry; informational reports never mutate native logs. */
export function mountDeepReportSurface(ctx: Context, deep: DeepPlanningController): () => unknown {
  const connection = ctx.get('connection', false) as { fetch?: { register(route: {path:string;methods:string[];requestBody:'buffered';fetch(request:Request):Promise<Response>}): () => unknown } } | undefined
  if (!connection?.fetch) return () => {}
  return connection.fetch.register({ path: '/api/kiokuko.deep', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: request => deepReportResponse(deep, request) })
}

export async function deepReportResponse(deep: DeepPlanningController, request: Request): Promise<Response> {
  const url = new URL(request.url), sessionId = url.searchParams.get('sessionId')
  const headers = { 'cache-control': 'no-store' }
  if (!sessionId || sessionId.length > 256 || /[\p{Cc}\p{Cf}]/u.test(sessionId)) return Response.json({error:'Invalid Session'}, {status:400,headers})
  try {
    const intent = await deep.store.intent(sessionId)
    if (!intent) return Response.json({ items: [] }, {headers})
    const live = deep.options.sessions?.get(sessionId) as {header?:{cwd?:string}} | undefined
    const snapshot = live ? undefined : await deep.options.sessionQuery?.readSession(sessionId)
    const cwd = live?.header?.cwd ?? snapshot?.session.cwd
    if (!cwd || realpathSync(cwd) !== intent.rootPath || snapshot && snapshot.session.id !== sessionId) return Response.json({error:'Session workspace mismatch'}, {status:409,headers})
    if (request.method === 'POST') {
      // DSH's Node bridge uses http://dsh.internal as Request.url and preserves Host.
      const origin = request.headers.get('origin')
      const browserOrigin = origin ? new URL(origin) : undefined
      if (!browserOrigin || !['http:', 'https:'].includes(browserOrigin.protocol) || browserOrigin.host !== (request.headers.get('host') ?? url.host)) return Response.json({error:'Origin mismatch'}, {status:403,headers})
      const ids = url.searchParams.getAll('id')
      if (!ids.length || ids.length > 9 || ids.some(id => id.length > 256)) return Response.json({error:'Invalid report IDs'}, {status:400,headers})
      await deep.reports.acknowledge(sessionId, ids)
      return Response.json({ok:true}, {headers})
    }
    const items = await deep.reports.snapshot(sessionId)
    const etag = `"${createHash('sha256').update(JSON.stringify(items.map(item=>[item.id,item.delivered]))).digest('hex')}"`
    if (request.headers.get('if-none-match') === etag) return new Response(null, {status:304,headers:{...headers,etag}})
    return Response.json({ items }, {headers:{...headers,etag}})
  } catch { return Response.json({error:'Deepの保存済み回答を取得できません。再接続後に再確認してください。'}, {status:503,headers}) }
}
