import { captureProjectManifestSnapshot, resolveProjectFingerprint } from '../repository/project-fingerprint.js'
import { currentScopedEntry } from '../context/scoped-memory-gate.js'
import type { SqliteDatabase } from '../db/adapter.js'
import type { PreparedAgentTask } from './task-intake.js'
import { projectMemoryEntry, renderMemoryFields } from '../context/memory-projection.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { randomUUID } from 'node:crypto'
import { retainedEvents } from './context-projection.js'
import { isKiokukoDshSource, KIOKUKO_DSH_SOURCE_KIND } from './plugin-source.js'

/** Revalidate at the final request seam, including snapshots retained in native history. */
export function currentRequestMemory(db: SqliteDatabase, prepared: PreparedAgentTask): ReadonlyMap<string, string> {
  const allowed = new Map<string, string>()
  if (prepared.memoryPolicy.contextWithheld) return allowed
  const fingerprint = prepared.context?.items.some(item => item.origin === 'ecosystem')
    ? resolveProjectFingerprint(db, prepared.project, captureProjectManifestSnapshot(prepared.project), { readOnly: true }) : undefined
  for (const item of prepared.context?.items ?? []) {
    let entry
    try { entry = currentScopedEntry(db, prepared.project.workspace, item, fingerprint) } catch { continue }
    const projected = projectMemoryEntry(db, entry)
    if (!projected || item.projection && canonicalContentHash(item.projection) !== canonicalContentHash(projected.projection)) continue
    const text = renderMemoryFields(item)
    if (text !== null) allowed.set(`memory:memory:${item.entryId}`, text)
  }
  return allowed
}

/** Preserve native history on disk; remove superseded plugin data only from this request. */
export function filterRequestMemory<T>(messages: readonly T[], allowed: ReadonlyMap<string,string>): T[] {
  const seen = new Set<string>()
  return messages.filter(value => {
    const message = value as any
    if (!isKiokukoDshSource(message?.source) || message.source.form !== 'snapshot') return true
    const sections = message.source.sections
    if (!Array.isArray(sections) || !sections.some((section: any) => typeof section?.name === 'string' && section.name.startsWith('memory:memory:'))) return true
    if (sections.length !== 1 || message.content?.length !== 1) return false
    const section = sections[0], text = allowed.get(section.name)
    if (text === undefined || text !== section.text || message.content[0]?.type !== 'text' || message.content[0].text !== text || seen.has(section.name)) return false
    seen.add(section.name)
    return true
  })
}

/** DSH builds frozen requests directly from this surface. Retire only owned
 * memory nodes using its append-only replacement API; preserve the audit log. */
export function pruneDshMemorySurface(session: Parameters<typeof retainedEvents>[0] & { append?: Function }, allowed: ReadonlyMap<string,string>): void {
  const events = retainedEvents(session).filter(event => event.type === 'user/message')
  const retained = new Set(filterRequestMemory(events.map(event => event.data), allowed))
  for (const event of events) {
    if (retained.has(event.data)) continue
    if (typeof session.append !== 'function') throw new Error('Native memory retirement requires the Session append API')
    const text = 'Obsolete Kiokuko memory was removed from the active context.'
    const v3 = ((session as {header?:{version?:number}}).header?.version ?? 0) >= 3
    session.append('user/message', { id: randomUUID(), role: 'user', content: [{type:'text',text}],
      source: { kind: KIOKUKO_DSH_SOURCE_KIND, form: 'snapshot', sections: [{name:'memory-status',text}] } },
    { surfaceOp: v3 ? { op: 'replace', startSeq: event.seq, endSeq: event.seq } : { op: 'replace', start: event.seq, end: event.seq }, sourceEventSeqs: [event.seq] })
  }
}
