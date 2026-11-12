import { randomUUID } from 'node:crypto'
import { canonicalContentHash } from '../serialization/validate.js'

const generations = new WeakMap<object, string>()
const OWNER = 'kiokuko-dsh/memory_explain/v1'
export function explanationProof(session: any, callId: string, registration: string) {
  if (!session?.header || typeof session.snapshotEvents !== 'function') throw new Error('Explanation requires native session provenance')
  const calls = session.snapshotEvents().filter((e: any) => e.type === 'tool/call' && e.data.callId === callId)
  if (calls.length !== 1 || calls[0].data.name !== 'memory_explain') throw new Error('Ambiguous explanation call')
  let generation = generations.get(session)
  if (!generation) { generation = randomUUID(); generations.set(session, generation) }
  return { owner: OWNER, registration, generation, session: canonicalContentHash(session.header), callId, callSeq: calls[0].seq }
}

/** Native result metadata survives restart; unknown legacy results remain untouched. */
export function ownedExplanationCalls(session: any): ReadonlySet<string> {
  const events: any[] = session.snapshotEvents?.() ?? []
  const calls = new Map<string, any[]>()
  for (const e of events) if (e.type === 'tool/call') calls.set(e.data.callId, [...(calls.get(e.data.callId) ?? []), e])
  const owned = new Set<string>()
  if (!session.header) return owned
  const fingerprint = canonicalContentHash(session.header)
  for (const e of events) {
    const proof = e.data?.meta?.kiokukoExplanation
    if (e.type !== 'tool/result' || proof?.owner !== OWNER || proof.session !== fingerprint
      || typeof proof.registration !== 'string' || !proof.registration || typeof proof.generation !== 'string' || !proof.generation) continue
    const call = calls.get(proof.callId)
    if (call?.length !== 1 || call[0].seq !== proof.callSeq || call[0].data.name !== 'memory_explain'
      || e.data.message?.source?.callId !== proof.callId || e.seq <= proof.callSeq) continue
    owned.add(proof.callId)
  }
  return owned
}
