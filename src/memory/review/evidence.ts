import type { DshLogEvent } from '../../dsh/session-memory-finalizer.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { findSecretInValue } from '../secrets.js'
import { redactDshSourceText } from '../../dsh/message-sources.js'
import type { ReviewEvidence, ReviewModel } from './contracts.js'

export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function messageText(value: unknown): string {
  const data = object(value), message = Object.keys(object(data.message)).length ? object(data.message) : data
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) return message.content.map(part => object(part).type === 'text' ? String(object(part).text ?? '') : '').join('\n')
  return typeof message.text === 'string' ? message.text : ''
}
export function humanInput(event: DshLogEvent): { id: string; text: string }|undefined {
  const data = object(event.data), message = Object.keys(object(data.message)).length ? object(data.message) : data
  if (event.type !== 'user/message' || object(message.source).kind !== 'user') return undefined
  const source = object(message.source)
  const id = source.id ?? message.id ?? source.messageId ?? data.messageId
  return { id: typeof id === 'string' ? id : `seq:${event.seq}`, text: messageText(event.data) }
}
export interface CompletedReviewTurn { start: number; end: number; inputIds: string[] }
/** Streaming classifier: only complete native turns containing explicit human sources count. */
export async function completedReviewTurns(events: AsyncIterable<DshLogEvent>): Promise<{ turns: CompletedReviewTurn[]; scanned: number; reason?: string }> {
  const turns: CompletedReviewTurn[] = []
  let open: { start: number; turn: number; ids: string[] }|undefined, scanned = -1, reason: string|undefined
  let expected: number|undefined
  for await (const event of events) {
    if (expected !== undefined && event.seq !== expected) throw new Error('source_unavailable')
    expected = event.seq + 1
    const data = object(event.data)
    if (event.type === 'turn/start') {
      if (open) throw new Error('source_boundary_invalid')
      if (!Number.isSafeInteger(data.turn)) throw new Error('source_boundary_invalid')
      open = { start: event.seq, turn: data.turn as number, ids: [] }
    }
    const input = humanInput(event)
    if (open && input) open.ids.push(input.id)
    if (event.type === 'turn/end') {
      if (!open || data.turn !== open.turn) throw new Error('source_boundary_invalid')
      if (object(data.reason).kind === 'completed' && open.ids.length) turns.push({start:open.start,end:event.seq,inputIds:[...new Set(open.ids)]})
      else reason = object(data.reason).kind === 'completed' ? 'no_human_input' : 'turn_not_completed'
      scanned = event.seq; open = undefined
    } else if (!open) scanned = event.seq
  }
  return {turns, scanned, ...(reason ? {reason} : {})}
}
export async function collectReviewEvidence(events: AsyncIterable<DshLogEvent>, maxBytes: number): Promise<ReviewEvidence[]> {
  const evidence: ReviewEvidence[] = [], calls = new Map<string, DshLogEvent>()
  let bytes = 0
  for await (const event of events) {
    const data = object(event.data), input = humanInput(event)
    let text = input?.text, seqs = [event.seq], role: ReviewEvidence['role'] = 'user_assertion'
    if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string' && !/memory|kiok|recall|enno|curator|task_prepare/iu.test(data.name)) {
      if (calls.size >= 128) throw new Error('input_too_large')
      calls.set(data.callId,event)
    }
    if (event.type === 'tool/result') {
      const id = data.callId ?? object(object(data.message).source).callId
      const call = typeof id === 'string' ? calls.get(id) : undefined
      if (call) { text = JSON.stringify({call:call.data,result:event.data}); seqs=[call.seq,event.seq]; role='tool_observation'; calls.delete(id as string) }
    }
    if (!text) continue
    // Reject rather than silently deleting the secret-bearing correction half.
    if (findSecretInValue(text)) throw new Error('secret_detected')
    const clean = redactDshSourceText(text)
    if (!clean) throw new Error('evidence_rejected')
    bytes += Buffer.byteLength(clean)
    if (bytes > maxBytes || evidence.length >= 256) throw new Error('input_too_large')
    const hash = canonicalContentHash({role,sourceSeqs:seqs,text:clean})
    evidence.push({id:`e:${event.seq}:${hash.slice(0,16)}`,role,sourceSeqs:seqs,normalizedSourceHash:hash,text:clean,eligibleForNewMemory:true})
  }
  return evidence
}
export function reviewManifest(evidence: ReviewEvidence[]): Omit<ReviewEvidence,'text'>[] { return evidence.map(({text:_text,...ref})=>ref) }
/** Carried context is useful for corrections but cannot support another memory. */
export async function reviewEvidenceWithContext(source:{streamRange(sessionId:string,start:number,end:number):AsyncIterable<DshLogEvent>},range:{sessionId:string;startSeq:number;endSeq:number},maxBytes:number,contextStartSeq?:number):Promise<ReviewEvidence[]> {
  const current=await collectReviewEvidence(source.streamRange(range.sessionId,range.startSeq,range.endSeq),maxBytes)
  if(contextStartSeq===undefined)return current
  let context:ReviewEvidence[]
  try { context=await collectReviewEvidence(source.streamRange(range.sessionId,contextStartSeq,range.startSeq-1),Math.min(8192,maxBytes)) }
  catch(error){if(error instanceof Error&&error.message==='input_too_large')throw new Error('insufficient_context');throw error}
  return [...context.map(e=>({...e,eligibleForNewMemory:false})),...current]
}
export function reviewModel(header: DshLogEvent|undefined, context: DshLogEvent|undefined): ReviewModel|undefined {
  const config=object(object(object(header?.data).header).config), window=object(context?.data).contextWindow
  if (typeof config.provider!=='string'||typeof config.model!=='string') return undefined
  return {provider:config.provider,model:config.model,...(typeof config.reasoningEffort==='string'?{reasoningEffort:config.reasoningEffort}:{}),...(typeof window==='number'&&Number.isSafeInteger(window)&&window>0?{contextWindow:window}:{})}
}
