import { randomUUID } from 'node:crypto'
import type { DshModelMessage } from './context-injection.js'
import { retainedEvents } from './context-projection.js'
import { isKiokukoDshSource, KIOKUKO_DSH_SOURCE_KIND } from './plugin-source.js'

/** Update only single-section, host-owned Skill snapshots; keep the audit log and tool pairs intact. */
export function refreshDshSkillSnapshots(messages: readonly DshModelMessage[], session: Parameters<typeof retainedEvents>[0] & { append?: Function }, systemSkills: ReadonlySet<string> = new Set()): void {
  if (!session.append) return // Non-native hosts retain ordinary append/dedup semantics.
  const desired = new Map(messages.filter(message => ['route-skill', 'expert', 'memory-reasoning'].includes(message.source))
    .map(message => [`${message.source}:${message.name}`, message.content]))
  const seen = new Set<string>()
  for (const event of retainedEvents(session)) {
    const data = event.data as any, source = data?.source, section = source?.sections?.[0]
    if (event.type !== 'user/message' || data.role !== 'user' || !isKiokukoDshSource(source)
      || source.form !== 'snapshot' || !Array.isArray(source.sections) || source.sections.length !== 1 || data.content?.length !== 1
      || data.content[0]?.type !== 'text' || data.content[0].text !== section?.text || typeof section.name !== 'string') continue
    const name: string = section.name
    const suppliedBySystem = name.startsWith('route-skill:') && systemSkills.has(name.slice('route-skill:'.length))
    if (!desired.has(name) && !suppliedBySystem) continue
    const redundant = suppliedBySystem || seen.has(name)
    const text = redundant ? '' : desired.get(name)!
    seen.add(name)
    if (!redundant && text === section.text) continue
    const replacementName = redundant ? 'skill-retired' : name
    const v3 = ((session as {header?:{version?:number}}).header?.version ?? 0) >= 3
    session.append('user/message', { id: randomUUID(), role: 'user', content: text ? [{type:'text',text}] : [],
      source: { kind: KIOKUKO_DSH_SOURCE_KIND, form:'snapshot', sections:[{name:replacementName,text}] } },
    { surfaceOp: v3 ? {op:'replace',startSeq:event.seq,endSeq:event.seq} : {op:'replace',start:event.seq,end:event.seq}, sourceEventSeqs:[event.seq] })
  }
}
