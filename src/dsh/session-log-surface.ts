import type { Context } from '@deepseek-ai/cordis'
import { DshSessionLogExportService, dshSessionExportFailure } from './session-log-export.js'

export const DSH_SESSION_EXPORT_PATH = '/api/session.export'

interface CommandRegistry {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly handler: (invocation: { readonly rawInput: string }) => Promise<{ readonly kind: 'success' | 'error'; readonly text: string }>
  }): () => unknown
}

interface FetchRegistry {
  register(route: {
    readonly path: string
    readonly methods: readonly ('GET' | 'HEAD')[]
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

/** Mount the existing DSH Web command contract onto the bounded mirror export. */
export function mountDshSessionExportSurface(ctx: Context, service: DshSessionLogExportService): () => Promise<void> {
  const commands = ctx.get('commands', false) as CommandRegistry | undefined
  const connection = ctx.get('connection', false) as { readonly fetch?: FetchRegistry } | undefined
  if (commands === undefined || connection?.fetch === undefined) {
    throw new Error('kiokuko-dsh Web export requires commands and connection services')
  }
  const disposeCommand = commands.register({
    name: 'export',
    description: 'Download this Session log as a ZIP archive',
    handler: invocation => Promise.resolve(invocation.rawInput.trim() === ''
      ? { kind: 'success', text: 'Session log download requested.' }
      : { kind: 'error', text: 'The Web /export command does not accept a path.' }),
  })
  const disposeRoute = connection.fetch.register({
    path: DSH_SESSION_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    fetch: request => dshSessionExportResponse(service, request),
  })
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    await Promise.allSettled([Promise.resolve(disposeRoute()), Promise.resolve(disposeCommand())])
  }
}
