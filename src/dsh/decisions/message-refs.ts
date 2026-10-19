import { canonicalContentHash } from '../../serialization/validate.js'

/** Pure native message references, independent of task/decision runtime initialization. */
export function requestIntentMessageRefs(messages: readonly unknown[], task: string): {id:string;digest:string}[] {
  const refs=messages.flatMap(value=>{
    if(!value || typeof value!=='object' || Array.isArray(value))return []
    const message=value as Record<string,unknown>
    const source=message.source && typeof message.source==='object' && !Array.isArray(message.source) ? message.source as Record<string,unknown> : undefined
    if(message.role!=='user' || source!==undefined && source.kind!=='user')return []
    const id=typeof message.id==='string' && message.id.length>0 ? message.id : `message:${canonicalContentHash(message)}`
    return [{id,digest:canonicalContentHash(message)}]
  })
  return refs.length ? refs.slice(-16) : [{id:`input:${canonicalContentHash(task)}`,digest:canonicalContentHash(task)}]
}
