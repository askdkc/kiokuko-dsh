import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import type { DiffReviewController } from '../diff-review/controller.js'
import { reviewMarkdown } from '../diff-review/markdown.js'
import { DiffReviewError, ReviewRequest, type DiffReview } from '../diff-review/schema.js'

const PATH = '/api/kiokuko.diff-review'
const HEADERS = { 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" }

function publicReview(review: DiffReview): object {
  const { repositoryRoot: _root, ...snapshot } = review.snapshot
  return { ...review, snapshot }
}

function errorResponse(error: unknown): Response {
  const code = error instanceof DiffReviewError ? error.code : 'review_unavailable'
  const status = error instanceof DiffReviewError ? error.status : 503
  return Response.json({ code }, { status, headers: HEADERS })
}

function sameOrigin(request: Request): boolean {
  try {
    const url = new URL(request.url)
    const origin = new URL(request.headers.get('origin') ?? '')
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === (request.headers.get('host') ?? url.host)
  } catch { return false }
}

/** DSH's connection fetch registry supplies the authenticated caller. */
export async function diffReviewResponse(controller: DiffReviewController, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId || sessionId.length > 256 || /[\p{Cc}\p{Cf}]/u.test(sessionId)) return errorResponse(new DiffReviewError('invalid_session', 400))
  try {
    if (request.method === 'GET') {
      const reviewId = url.searchParams.get('reviewId')
      if (!reviewId) {
        const availability = await controller.availability(sessionId)
        return Response.json({ ...availability, ...(availability.review ? { review: publicReview(availability.review) } : {}) }, { headers: HEADERS })
      }
      const format = url.searchParams.get('format')
      if (format === 'file-link') {
        const fileId = url.searchParams.get('fileId')
        if (!fileId) throw new DiffReviewError('invalid_file_selection', 400)
        return Response.json({ address: await controller.fileAddress(sessionId, reviewId, fileId) }, { headers: HEADERS })
      }
      const review = await controller.get(sessionId, reviewId)
      if (format === 'markdown') return new Response(reviewMarkdown(review), { headers: { ...HEADERS, 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="diff-review.md"' } })
      if (format === 'json') return new Response(JSON.stringify(publicReview(review), null, 2), { headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="diff-review.json"' } })
      if (format) throw new DiffReviewError('invalid_format', 400)
      const body = publicReview(review)
      const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex')}"`
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { ...HEADERS, etag } })
      return Response.json(body, { headers: { ...HEADERS, etag } })
    }
    if (request.method !== 'POST') throw new DiffReviewError('invalid_method', 400)
    if (!sameOrigin(request)) throw new DiffReviewError('origin_mismatch', 403)
    const contentLength = Number(request.headers.get('content-length') ?? 0)
    if (contentLength > 16_384) throw new DiffReviewError('request_too_large', 413)
    const text = await request.text()
    if (Buffer.byteLength(text) > 16_384) throw new DiffReviewError('request_too_large', 413)
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new DiffReviewError('invalid_json', 400) }
    const parsed = ReviewRequest.safeParse(value)
    if (!parsed.success || parsed.data.sessionId !== sessionId) throw new DiffReviewError('invalid_request', 400)
    const action = parsed.data
    const review = action.action === 'capture' ? await controller.capture(action)
      : action.action === 'analyze' ? await controller.analyze(action) : await controller.cancel(action.sessionId, action.reviewId)
    return Response.json(publicReview(review), { status: action.action === 'analyze' ? 202 : 200, headers: HEADERS })
  } catch (error) { return errorResponse(error) }
}

export function mountDiffReviewSurface(ctx: Context, controller: DiffReviewController): () => unknown {
  const connection = ctx.get('connection', false) as { fetch?: { register(route: {
    path: string; methods: string[]; requestBody: 'buffered'; fetch(request: Request): Promise<Response>
  }): () => unknown } } | undefined
  if (!connection?.fetch) return () => undefined
  return connection.fetch.register({ path: PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: request => diffReviewResponse(controller, request) })
}
