import { z } from 'zod'
import { identifier, LispError, RESULT_BYTES, type LispOwner } from './contracts.js'
import type { LispStore } from './store.js'
import { recordedResult } from './recorded-result.js'

export const SavedInspection = z.object({ resultOperationId: identifier,
  section: z.enum(['result', 'value', 'stdout', 'stderr', 'changes']).default('result'),
  pointer: z.string().max(1024).optional(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(2000).default(2000),
}).strict()

function pointedValue(result: unknown, pointer: string): unknown {
  if (pointer === '') return result
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) throw new LispError('INVALID_POINTER', '結果の参照位置が不正です。', '返された pointer を変更せず指定してください。')
  let value = result
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key) || (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/u.test(key))) {
      throw new LispError('UNKNOWN_RESULT_FIELD', '保存結果に指定した項目がありません。', '現在の応答で返された pointer を指定してください。')
    }
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/** Read a saved evidence snapshot under the exact owner; never replay an effect. */
export async function inspectSavedResult(store: LispStore, owner: LispOwner, input: z.input<typeof SavedInspection>) {
  const request = SavedInspection.parse(input), operation = await store.get(owner, request.resultOperationId)
  if (!operation) throw new LispError('UNKNOWN_OPERATION', 'この主体の操作記録がありません。', '現在のセッションで返された操作IDを指定してください。')
  if (!operation.result) throw new LispError('RESULT_EXPIRED', '保存結果は利用できません。操作を自動再実行しないでください。', '操作IDと状態は記録に保持されています。')
  const result = await recordedResult(store, owner, operation)
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const output = object(result?.output), json = object(object(result?.value).json)
  if (request.pointer !== undefined && request.section !== 'result') throw new LispError('INVALID_INSPECTION', 'pointer は section=result と組み合わせてください。', '返された取得条件をそのまま使用してください。')
  const value = request.pointer !== undefined ? pointedValue(result, request.pointer) : request.section === 'result' ? result : request.section === 'stdout' || request.section === 'stderr'
    ? output[request.section] || json[request.section] || '' : result?.[request.section] ?? null
  const chars = Array.from(typeof value === 'string' ? value : JSON.stringify(value))
  if (request.offset > chars.length) throw new LispError('INVALID_OFFSET', '取得開始位置が結果の長さを超えています。', '返された nextOffset を指定してください。')
  let end = Math.min(chars.length, request.offset + request.limit)
  while (true) {
    const page = { ok: true, resultOperationId: request.resultOperationId, state: operation.state, section: request.section,
      ...(request.pointer === undefined ? {} : { pointer: request.pointer }),
      offset: request.offset, totalCharacters: chars.length, nextOffset: end < chars.length ? end : null, data: chars.slice(request.offset, end).join('') }
    if (Buffer.byteLength(JSON.stringify(page)) <= RESULT_BYTES) return page
    if (end <= request.offset + 1) throw new LispError('RESULT_METADATA_LIMIT', '取得条件が応答サイズの上限を超えています。', 'section による取得を使用してください。')
    end = request.offset + Math.floor((end - request.offset) / 2)
  }
}
