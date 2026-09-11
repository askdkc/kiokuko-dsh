import type { Context } from '@deepseek-ai/cordis'
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { withImmediateTransaction } from '../db/transaction.js'
import type { DeepPlanningController } from '../deep-thinker/controller.js'

/** Shares DSH authentication and exact Session resolution with the report surface. */
export function mountDshNoticeSurface(ctx: Context, host: DeepPlanningController): () => unknown {
  const connection = ctx.get('connection', false) as { fetch?: { register(route: {
    path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response>
  }): () => unknown } } | undefined
  if (!connection?.fetch) return () => {}
  return connection.fetch.register({ path: '/api/kiokuko.notices', methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: request => dshNoticeResponse(host, request) })
}

export async function dshNoticeResponse(host: DeepPlanningController, request: Request): Promise<Response> {
  const url = new URL(request.url), sessionId = url.searchParams.get('sessionId')
  const headers = { 'cache-control': 'no-store' }
  if (!sessionId || sessionId.length > 256 || /[\p{Cc}\p{Cf}]/u.test(sessionId)) return Response.json({ error: 'Invalid Session' }, { status: 400, headers })
  try {
    const roots = await host.store.database(db => db.prepare('SELECT DISTINCT root_path AS root FROM dsh_session_notices WHERE dsh_session_id=?')
      .all<{ root: string }>(sessionId))
    if (!roots.length) return Response.json({ items: [] }, { headers })
    const live = host.options.sessions?.get(sessionId) as { header?: { cwd?: string } } | undefined
    const snapshot = live ? undefined : await host.options.sessionQuery?.readSession(sessionId)
    const cwd = live?.header?.cwd ?? snapshot?.session.cwd
    if (!cwd || roots.length !== 1 || realpathSync(cwd) !== roots[0]!.root || snapshot && snapshot.session.id !== sessionId) {
      return Response.json({ error: 'Session workspace mismatch' }, { status: 409, headers })
    }
    if (request.method === 'POST') {
      const origin = request.headers.get('origin'), browser = origin ? new URL(origin) : undefined
      if (!browser || !['http:', 'https:'].includes(browser.protocol) || browser.host !== (request.headers.get('host') ?? url.host)) {
        return Response.json({ error: 'Origin mismatch' }, { status: 403, headers })
      }
      const ids = url.searchParams.getAll('id')
      if (!ids.length || ids.length > 9 || ids.some(id => !id || id.length > 256)) return Response.json({ error: 'Invalid notice IDs' }, { status: 400, headers })
      await host.store.database(db => withImmediateTransaction(db, () => {
        for (const id of ids) {
          const item = db.prepare('SELECT rowid,kind FROM dsh_session_notices WHERE id=? AND dsh_session_id=?').get<{ rowid: number; kind: string }>(id, sessionId)
          if (!item) throw new Error('Notice identity mismatch')
          if (item.kind === 'status') db.prepare("UPDATE dsh_session_notices SET delivered=1 WHERE dsh_session_id=? AND kind='status' AND rowid<=?").run(sessionId, item.rowid)
          else db.prepare('UPDATE dsh_session_notices SET delivered=1 WHERE id=?').run(id)
        }
      }))
      return Response.json({ ok: true }, { headers })
    }
    const items = await host.store.database(db => {
      const reports = db.prepare("SELECT id,kind,text,delivered FROM dsh_session_notices WHERE dsh_session_id=? AND kind='report' ORDER BY rowid DESC LIMIT 8").all(sessionId)
      const status = db.prepare("SELECT id,kind,text,delivered FROM dsh_session_notices WHERE dsh_session_id=? AND kind='status' ORDER BY rowid DESC LIMIT 1").get(sessionId)
      return [...reports, ...(status ? [status] : [])].map(row => ({ ...row, delivered: row.delivered === 1 }))
    })
    const etag = `"${createHash('sha256').update(JSON.stringify(items)).digest('hex')}"`
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { ...headers, etag } })
    return Response.json({ items }, { headers: { ...headers, etag } })
  } catch {
    return Response.json({ error: '保存済みの通知を取得できません。再接続後に再確認してください。' }, { status: 503, headers })
  }
}
