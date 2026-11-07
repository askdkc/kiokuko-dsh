import type { Context } from '@deepseek-ai/cordis'
import { DshSessionLogExportService, dshSessionExportFailure } from './session-log-export.js'

export const DSH_SESSION_EXPORT_PATH = '/api/kiokuko.session.export'

interface FetchRegistry {
  register(route: {
    readonly path: string
    readonly methods: readonly ('GET' | 'HEAD')[]
    readonly requestBody: 'buffered'
    readonly fetch: (request: Request) => Promise<Response>
  }): () => unknown
}

function iterableStream(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason)
    },
  })
}

export async function dshSessionExportResponse(
  service: DshSessionLogExportService,
  request: Request,
): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get('sessionId')
  if (sessionId === null || sessionId.length === 0) {
    return Response.json({ code: 'invalid_request', message: 'missing sessionId query parameter' }, { status: 400 })
  }
  try {
    const opened = await service.open(sessionId)
    return new Response(request.method === 'HEAD' ? null : iterableStream(opened.body), {
      status: opened.status,
      headers: opened.headers,
    })
  } catch (error) {
    const failure = dshSessionExportFailure(error)
    return Response.json(failure.body, {
      status: failure.status,
      headers: { 'cache-control': 'no-store' },
    })
  }
}

/** Mount Kiokuko’s streaming export alongside the stock DSH Web export. */
export function mountDshSessionExportSurface(ctx: Context, service: DshSessionLogExportService): () => Promise<void> {
  const connection = ctx.get('connection', false) as { readonly fetch?: FetchRegistry } | undefined
  if (connection?.fetch === undefined) {
    throw new Error('kiokuko-dsh Web export requires the connection service')
  }
  const disposeRoute = connection.fetch.register({
    path: DSH_SESSION_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: request => dshSessionExportResponse(service, request),
  })
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    await disposeRoute()
  }
}
