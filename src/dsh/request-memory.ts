import type { SqliteDatabase } from '../db/adapter.js'
import type { PreparedAgentTask } from './task-intake.js'
import { readEntry } from '../memory/entries.js'
import { isRetrievableEntry } from '../memory/hybrid-retrieval.js'
import { entryOriginMatchesWorkspace } from '../context/origin.js'
import { projectMemoryEntry, renderMemoryFields } from '../context/memory-projection.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { randomUUID } from 'node:crypto'
import { retainedEvents } from './context-projection.js'

/** Revalidate at the final request seam, including snapshots retained in native history. */
export function currentRequestMemory(db: SqliteDatabase, prepared: PreparedAgentTask): ReadonlyMap<string, string> {
  const allowed = new Map<string, string>()
  if (prepared.memoryPolicy.contextWithheld) return allowed
  for (const item of prepared.context?.items ?? []) {
    const row = db.prepare('SELECT workspace FROM entries WHERE id=?').get<{workspace:string}>(item.entryId)
    if (!row || !entryOriginMatchesWorkspace({ origin: item.origin, runWorkspace: prepared.project.workspace, entryWorkspace: row.workspace })) continue
    const entry = readEntry(db, { workspace: row.workspace, entryId: item.entryId })
    if (entry.revision !== item.revision || entry.status === 'superseded' || !isRetrievableEntry(db, entry)) continue
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
    if (message?.source?.kind !== 'plugin' || message.source.plugin !== 'kiokuko-dsh' || message.source.form !== 'snapshot') return true
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
      source: { kind: 'plugin', plugin: 'kiokuko-dsh', form: 'snapshot', sections: [{name:'memory-status',text}] } },
    { surfaceOp: v3 ? { op: 'replace', startSeq: event.seq, endSeq: event.seq } : { op: 'replace', start: event.seq, end: event.seq }, sourceEventSeqs: [event.seq] })
  }
}
