import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SessionRecovery, SessionRecoveryError, type RecoveryHost } from './session-recovery.js'

export const SESSION_RECOVERY_PATH = '/api/kiokuko.session-recovery'
const input = z.object({ sessionId: z.string().min(1).max(256), action: z.enum(['continue', 'new']), operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), expectedSeq: z.number().int().min(-1) }).strict()

export async function sessionRecoveryResponse(service: SessionRecovery, request: Request): Promise<Response> {
  const headers = { 'cache-control': 'no-store' }
  try {
    if (request.method === 'GET') {
      const id = new URL(request.url).searchParams.get('sessionId')
      if (!id || id.length > 256) return Response.json({ error: 'セッションを指定してください。' }, { status: 400, headers })
      return Response.json(await service.inspect(id), { headers })
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers })
    const origin = request.headers.get('origin'), host = request.headers.get('host') ?? new URL(request.url).host
    if (request.headers.get('sec-fetch-site') === 'cross-site' || origin && new URL(origin).host !== host) return Response.json({ error: 'Origin mismatch' }, { status: 403, headers })
    if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'JSON required' }, { status: 415, headers })
    const body = await request.text()
    if (body.length > 8192) return Response.json({ error: 'Request too large' }, { status: 413, headers })
    const parsed = input.safeParse(JSON.parse(body))
    if (!parsed.success) return Response.json({ error: '復旧操作の指定が不正です。状態を再確認してください。' }, { status: 400, headers })
    return Response.json(await service.act(parsed.data), { headers })
  } catch (error) {
    return Response.json({ code: error instanceof SessionRecoveryError ? error.code : 'recovery_failed', error: error instanceof SessionRecoveryError ? error.message : '復旧処理に失敗しました。元の履歴は保持されています。状態を再確認してください。' }, { status: error instanceof SessionRecoveryError ? error.status : error instanceof SyntaxError ? 400 : 500, headers })
  }
}

/** Install a host-owned recovery entry without starting or stopping any Session. */
export function mountSessionRecovery(ctx: Context): () => Promise<void> {
  const get = (name: string): any => ctx.get(name as never, false)
  if (!get('agents') || !get('sessions')) return async () => {}
  const service = new SessionRecovery({ get } as RecoveryHost)
  const releases: (() => unknown)[] = []
  const commands = get('commands')
  if (commands?.register) releases.push(commands.register({
    name: 'kioku-recover', description: '中断した会話を確認・続行、または新しい会話にやり直す', input: { hint: 'status | continue | new' },
    handler: async (invocation: { agent?: { id: string }; rawInput: string }) => {
      try {
        if (!invocation.agent) return { kind: 'error', text: '復旧したいセッションを開いてください。' }
        const action = invocation.rawInput.trim() || 'status'
        if (!['status', 'continue', 'new'].includes(action)) return { kind: 'error', text: '/kioku-recover status | continue | new' }
        const status = await service.inspect(invocation.agent.id)
        if (action === 'status') return { kind: 'success', text: JSON.stringify(status) }
        const result = await service.act({ sessionId: invocation.agent.id, action: action as 'continue' | 'new', operationId: randomUUID(), expectedSeq: status.seq })
        return { kind: 'success', text: result.action === 'continue' ? '保存された履歴を使って続行します。結果不明の処理は自動再実行していません。' : `新しい空の会話を作成しました。元の履歴は残っています。\n/resume ${result.sessionId}\n\n引き継ぐ依頼文（まだ送信していません）:\n${result.draft}\n\n${result.warnings.join('\n')}` }
      } catch (error) { return { kind: 'error', text: error instanceof SessionRecoveryError ? error.message : '復旧処理に失敗しました。元の履歴は保持されています。' } }
    },
  }))
  const mountConnection = (scope: Context) => {
    const connection = scope.get('connection' as never, false) as any
    if (connection?.fetch?.register) releases.push(connection.fetch.register({ path: SESSION_RECOVERY_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: (request: Request) => sessionRecoveryResponse(service, request) }))
  }
  if (get('connection')) mountConnection(ctx)
  else if (typeof ctx.inject === 'function') {
    const dispose = ctx.inject(['connection' as never], mountConnection)
    releases.push(() => dispose.dispose())
  }
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    for (const release of releases.reverse()) await release()
    await service.dispose()
  }
}
