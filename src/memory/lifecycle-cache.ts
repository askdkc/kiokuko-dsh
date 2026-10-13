import type {SqliteDatabase} from '../db/adapter.js'
import type {MemoryContext} from './lifecycle.js'
import {canonicalContentHash} from '../serialization/validate.js'

export interface ContextMeta {stamp:string;hash:string;expiresAt:number}
type Cached={value:MemoryContext;meta:ContextMeta;createdAt:number}
const contexts=new WeakMap<SqliteDatabase,Map<string,Cached>>()
const metadata=new WeakMap<MemoryContext,ContextMeta>()
export function contextStamp(db:SqliteDatabase,workspace:string):string {
  const rows=db.prepare('SELECT workspace,context_revision FROM dsh_memory_processing_state WHERE workspace IN (?,?) ORDER BY workspace')
    .all<{workspace:string;context_revision:number}>(workspace,'global')
  const revisions=new Map(rows.map(row=>[row.workspace,row.context_revision]))
  return JSON.stringify([workspace,revisions.get(workspace)??0,revisions.get('global')??0])
}
export function cachedContext(db:SqliteDatabase,key:string,stamp:string,now:number):MemoryContext|undefined {
  const cache=contexts.get(db),entry=cache?.get(key)
  if(!entry||entry.meta.stamp!==stamp||now<entry.createdAt||now>=entry.meta.expiresAt)return undefined
  cache!.delete(key);cache!.set(key,entry)
  return copy(entry)
}
export function saveContext(db:SqliteDatabase,key:string,stamp:string,value:MemoryContext,expiresAt:number,now:number):MemoryContext {
  const cache=contexts.get(db)??new Map<string,Cached>();contexts.set(db,cache)
  const entry={value:structuredClone(value),meta:{stamp,hash:canonicalContentHash(value),expiresAt},createdAt:now}
  cache.delete(key);cache.set(key,entry)
  while(cache.size>32)cache.delete(cache.keys().next().value!)
  return copy(entry)
}
function copy(entry:Cached):MemoryContext {
  const value=structuredClone(entry.value)
  metadata.set(value,{...entry.meta})
  return value
}
export function contextMeta(value:MemoryContext):ContextMeta|undefined {
  return metadata.get(value)
}
