import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'
import { DECISION_BYTES, DecisionError } from './contracts.js'

export const LAYA_MAX_FRAME = 1024 * 1024
export type LayaTransport = (socketPath: string, json: string, signal: AbortSignal, timeoutMs: number) => Promise<unknown>

/** One bounded frame per connection. A cancelled/incomplete stream is never reused. */
export const requestLaya: LayaTransport = (socketPath, json, signal, timeoutMs) => {
  if (signal.aborted) return Promise.reject(new DecisionError('CANCELLED'))
  if (!isAbsolute(socketPath)) return Promise.reject(new DecisionError('INVALID_INPUT'))
  const payload = Buffer.from(json, 'utf8')
  if (!payload.length || payload.length > Math.min(DECISION_BYTES, LAYA_MAX_FRAME)) return Promise.reject(new DecisionError('TOO_LARGE'))
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new DecisionError('TIMEOUT'))
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4), prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(payload.length)
    let headerBytes = 0, body: Buffer | undefined, bodyBytes = 0, settled = false
    const socket = createConnection({ path: socketPath })
    const finish = (error?: DecisionError, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error); else resolve(value)
    }
    const abort = () => finish(new DecisionError('CANCELLED'))
    const timer = setTimeout(() => finish(new DecisionError('TIMEOUT')), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    socket.once('connect', () => { if (!settled) socket.write(Buffer.concat([prefix, payload])) })
    socket.on('error', () => finish(new DecisionError('UNAVAILABLE')))
    socket.on('end', () => { if (!settled) finish(new DecisionError('MALFORMED_RESPONSE')) })
    socket.on('close', () => { if (!settled) finish(new DecisionError('UNAVAILABLE')) })
    socket.on('data', (chunk: Buffer) => {
      if (settled) return
      let offset = 0
      if (headerBytes < 4) {
        const count = Math.min(4 - headerBytes, chunk.length)
        chunk.copy(header, headerBytes, 0, count); headerBytes += count; offset += count
        if (headerBytes < 4) return
        const length = header.readUInt32BE()
        if (!length || length > Math.min(DECISION_BYTES, LAYA_MAX_FRAME)) { finish(new DecisionError('MALFORMED_RESPONSE')); return }
        body = Buffer.alloc(length)
      }
      const count = chunk.length - offset
      if (!body || count > body.length - bodyBytes) { finish(new DecisionError('MALFORMED_RESPONSE')); return }
      chunk.copy(body, bodyBytes, offset); bodyBytes += count
      if (bodyBytes !== body.length) return
      try { finish(undefined, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))) }
      catch { finish(new DecisionError('MALFORMED_RESPONSE')) }
    })
  })
}
