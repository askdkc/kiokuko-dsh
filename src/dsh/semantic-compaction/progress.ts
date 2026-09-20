import type { CompactionSession, SurfaceEvent } from './contracts.js'

export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed' }
export interface Boundary { seq: number; before: Todo[]; after: Todo[]; completed: string[] }
function todos(event: SurfaceEvent): Todo[] | undefined {
  const value = event.data.todos
  if (!Array.isArray(value) || value.some(t => !t || typeof t.content !== 'string' || !t.content.trim()
    || !['pending', 'in_progress', 'completed'].includes(t.status))) return undefined
  const result = value.map(t => ({ content: t.content.trim(), status: t.status }))
  return new Set(result.map(t => t.content)).size === result.length ? result : undefined
}
/** A connection starts at the current tail. Only new TODO transitions produce work. */
export class SessionProgress {
  private cursor = 0
  private previous: Todo[] | undefined
  private completed: number[] = []
  private boundary: Boundary | undefined
  readonly pruned = new Set<number>()
  constructor(session: CompactionSession) { this.scan(session, false) }
  scan(session: CompactionSession, notify = true): void {
    for (; this.cursor < session.seq; this.cursor++) {
      const event = session.eventAt(this.cursor)
      if (!event) throw new Error('Missing native progress event')
      if (event.type === 'assistant/message' && event.data.interrupted !== true && Array.isArray(event.data.stream)
        && event.data.message?.source?.kind === 'model') this.completed = [...this.completed.slice(-1), event.seq]
      if (event.type === 'compaction/prune') for (const seq of event.data.shadowedSeqs ?? []) this.pruned.add(seq)
      if (event.type !== 'todo/write') continue
      const after = todos(event), before = this.previous
      this.previous = after
      if (!after) this.boundary = undefined
      if (!notify || !after || !before) continue
      const completed = after.filter(t => t.status === 'completed' && before.some(p => p.content === t.content && p.status !== 'completed')).map(t => t.content)
      if (completed.length && after.some(t => t.status !== 'completed')) this.boundary = { seq: event.seq, before, after, completed }
      else if (this.boundary && JSON.stringify(after) !== JSON.stringify(this.boundary.after)) this.boundary = undefined
    }
  }
  exposedTwice(seq: number): boolean { return this.completed.length === 2 && this.completed[0]! > seq }
  takeBoundary(): Boundary | undefined { const boundary = this.boundary; this.boundary = undefined; return boundary }
}
