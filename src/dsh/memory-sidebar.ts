import type { ScopedContextItem } from '../context/scoped-broker.js'
import { memoryTextDigest, redactDshSourceText } from '../context/memory-projection.js'
import type { SqliteDatabase } from '../db/adapter.js'
import { KiokukoError } from '../errors.js'
import { readEntry } from '../memory/entries.js'
import { readRevisionEvidence } from '../memory/evidence.js'
import { readEntryRevision } from '../memory/revisions.js'
import { isRetrievableEntry } from '../memory/hybrid-retrieval.js'
import { proposalDigest, type ReplayMemoryProposal } from '../memory/replay-review.js'
import { readRepositoryLearning } from '../memory/repository-learning.js'
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js'
import type { DshCoreRuntime } from './core-runtime.js'
import { isNativeSubagent } from './native-subagent.js'
import { isKiokukoDshSource } from './plugin-source.js'
import { readMemoryReuseChecks, type MemoryReuseCheck } from './task-completion.js'

export const MEMORY_SIDEBAR_PATH = '/api/kiokuko.memory-sidebar'

interface MemorySelection {
  entryId: string
  workspace: string
  revision: number
  reasons: readonly string[]
}

interface SourceExcerpt {
  kind: 'native_user_message' | 'native_tool_result'
  text: string
  reference: string
}

export interface SidebarMemory {
  id: string
  revision?: number
  title: string
  text: string
  reasons: readonly string[]
  sources: SourceExcerpt[]
  references: string[]
  sourcesOmitted: boolean
  reuse?: MemoryReuseCheck[]
}

export type MemorySidebarView =
  | { state: 'unobserved' }
  | { state: 'observed'; requestId: string; items: SidebarMemory[] }

type Session = { id: string; header?: { cwd?: string; origin?: string; delegationDepth?: number } }
type NativeMessage = { id?: string; role?: string; source?: unknown; content?: unknown }
type ModelRequest = { sessionId?: string; purpose?: string; messages?: readonly NativeMessage[] }
type Observation = { requestId: string; cwd: string; items: MemorySelection[]; repositoryDigest?: string }
type State = { requestId: string; observation?: Observation }
type Host = {
  get(name: string, strict: false): any
  on(name: string, listener: (...args: any[]) => any, options: { global: true; prepend?: true }): () => void
}

const scopedSelections = new WeakMap<object, ReadonlyMap<string, MemorySelection>>()
const replaySelections = new WeakMap<object, { messageId: string; digest: string; items: MemorySelection[] }>()
const states = new WeakMap<Session, State>()

/** Identity comes from the host-owned Session object, never a request parameter. */
export function observedMemoryInput(session: Session | undefined): Observation | undefined {
  return session && states.get(session)?.observation
}

/** Bind ranking data at the request fence. The exact frozen input still decides membership. */
export function noteScopedMemory(request: object, allowed: ReadonlyMap<string, string>, items: readonly ScopedContextItem[]): void {
  scopedSelections.set(request, new Map(items.flatMap(item => {
    const text = allowed.get(`memory:memory:${item.entryId}`)
    if (!text || !item.workspace) return []
    return [[memoryTextDigest(text), { entryId: item.entryId, workspace: item.workspace,
      revision: item.revision, reasons: [...item.selectionReasons] }]]
  })))
}

export function noteReplayMemory(session: Session, messageId: string, text: string, items: readonly Omit<MemorySelection, 'reasons'>[]): void {
  replaySelections.set(session, { messageId, digest: memoryTextDigest(text), items: items.map(item => ({ ...item, reasons: ['approved_replay_term_match'] })) })
}

/** Observe final native messages only. Keep identities and digests in memory, never the request or its evidence. */
function observedMemory(session: Session, request: ModelRequest, requestId: string, cwd: string): Observation {
  const items = new Map<string, MemorySelection>()
  const scoped = scopedSelections.get(request)
  const replay = replaySelections.get(session)
  let repositoryDigest: string | undefined
  for (const message of request.messages ?? []) {
    const source = message.source
    if (message.role !== 'user' || !isKiokukoDshSource(source) || source.form !== 'snapshot'
      || !Array.isArray(source.sections) || source.sections.length !== 1 || !Array.isArray(message.content)
      || message.content.length !== 1 || message.content[0]?.type !== 'text') continue
    const section = source.sections[0]
    if (typeof section?.name !== 'string' || typeof section.text !== 'string') continue
    const content = message.content[0].text
    if (section.name.startsWith('memory:memory:') && content === section.text) {
      const selected = scoped?.get(memoryTextDigest(section.text))
      if (selected && section.name === `memory:memory:${selected.entryId}`) items.set(selected.entryId, selected)
    } else if (section.name === 'memory:approved-replay' && replay && replay.messageId === message.id
      && replay.digest === memoryTextDigest(section.text) && typeof content === 'string' && content.endsWith(`\n${section.text}`)) {
      for (const item of replay.items) items.set(item.entryId, items.get(item.entryId) ?? item)
    } else if (section.name === 'memory:repository-learning' && typeof content === 'string' && content.endsWith(`\n${section.text}`)) {
      repositoryDigest = memoryTextDigest(section.text)
    }
  }
  return { requestId, cwd, items: [...items.values()], ...(repositoryDigest ? { repositoryDigest } : {}) }
}

function replaySources(db: SqliteDatabase, item: MemorySelection): SourceExcerpt[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='replay_memory_entries'").get()) return []
  const row = db.prepare(`SELECT m.proposal_json, m.digest FROM replay_memory_entries r JOIN replay_memories m ON m.approval_key=r.memory_key
    WHERE r.entry_id=? AND r.entry_revision=? AND m.workspace=?`).get<{ proposal_json: string; digest: string }>(item.entryId, item.revision, item.workspace)
  if (!row) return []
  const proposal = JSON.parse(row.proposal_json) as ReplayMemoryProposal
  if (proposalDigest(proposal) !== row.digest || proposal.source.workspace !== item.workspace) return []
  return [
    ...(proposal.request.evidenceRefs.length ? [{ kind: 'native_user_message' as const, text: proposal.request.text, reference: proposal.request.evidenceRefs[0]! }] : []),
    ...proposal.attempts.flatMap(attempt => attempt.resultRef && attempt.outputExcerpt
      ? [{ kind: 'native_tool_result' as const, text: attempt.outputExcerpt, reference: attempt.resultRef }] : []),
  ]
}

function readObservedEntry(db: SqliteDatabase, item: MemorySelection): SidebarMemory | undefined {
  let entry
  try {
    entry = readEntry(db, { workspace: item.workspace, entryId: item.entryId })
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND') return undefined
    throw error
  }
  if (entry.status === 'superseded' || !isRetrievableEntry(db, entry)) return undefined
  const revision = readEntryRevision(db, { workspace: item.workspace, entryId: item.entryId, revision: item.revision })
  const title = redactDshSourceText(revision.title)
  if (!title) return undefined
  const evidence = readRevisionEvidence(db, item.entryId, item.revision, item.workspace)
  const sources = evidence ? evidence.claims.flatMap(claim => claim.sources.map(source => ({
    kind: source.kind, text: source.supportingText, reference: `native:${source.sessionId}:${source.sourceSeqs.join(',')}`,
  }))) : replaySources(db, item)
  const seen = new Set<string>()
  const safe = sources.flatMap(source => {
    const text = redactDshSourceText(source.text)
    const key = JSON.stringify([source.kind, source.reference, text])
    if (!text || seen.has(key)) return []
    seen.add(key)
    return [{ ...source, text: text.slice(0, 2000), reference: redactDshSourceText(source.reference)?.slice(0, 512) ?? '' }]
  })
  return { id: item.entryId, revision: item.revision, title, text: redactDshSourceText(revision.summary ?? '')?.slice(0, 2000) ?? '',
    reasons: item.reasons, sources: safe.slice(0, 12), references: [],
    sourcesOmitted: safe.length > 12 || sources.some(source => source.text.length > 2000 || !redactDshSourceText(source.text)) }
}

async function readObservation(runtime: Pick<DshCoreRuntime, 'withDatabase'>, session: Session, observation: Observation): Promise<MemorySidebarView> {
  return runtime.withDatabase(async db => {
    const project = await resolveProjectWorkspaceReadOnly(db, observation.cwd, { allowDirectory: true })
    if (!project) return { state: 'unobserved' }
    // The frozen request's fenced selection binds global/ecosystem entries to this session.
    const items = observation.items.flatMap(item => item.workspace === project.workspace
      || item.reasons.includes('global_origin') || item.reasons.includes('ecosystem_origin')
      ? readObservedEntry(db, item) ?? [] : [])
    for (const item of items) {
      item.reuse = readMemoryReuseChecks(db, { workspace: project.workspace, sessionId: session.id, entryId: item.id, revision: item.revision! })
        .map(check => ({ ...check, description: redactDshSourceText(check.description)?.slice(0, 500) ?? '' }))
    }
    if (observation.repositoryDigest) {
      const learning = readRepositoryLearning(db, project.repositoryRoot)
      if (memoryTextDigest(learning.compact) === observation.repositoryDigest) {
        for (const [index, point] of learning.points.entries()) {
          const title = redactDshSourceText(point.lesson?.hypothesis ?? point.summary ?? '')
          if (!title) continue
          items.push({ id: `repository-learning:${index}`, title, text: '',
            reasons: ['repository_learning'], sources: [], sourcesOmitted: false,
            references: point.evidenceRefs.flatMap(ref => redactDshSourceText(ref) ?? []).slice(0, 12) })
        }
      }
    }
    return { state: 'observed', requestId: observation.requestId, items }
  })
}

/** Mount on the authenticated DSH connection. No model tool or write endpoint. */
export function mountMemorySidebar(host: Host, runtime: Pick<DshCoreRuntime, 'withDatabase'>): () => void {
  const connection = host.get('connection', false)
  const lookup = (id: string): Session | undefined => host.get('sessions', false)?.get(id)
  const stopEvents = host.on('session/event', (session: Session, event: { type: string; data: any }) => {
    if (event.type === 'user/message' && event.data?.source?.kind === 'user' && typeof event.data.id === 'string')
      states.set(session, { requestId: event.data.id })
  }, { global: true })
  const stopStream = host.on('llm/stream', async function* (request: ModelRequest, next: () => AsyncIterable<any>) {
    const session = !request.purpose && request.sessionId ? lookup(request.sessionId) : undefined
    const cwd = session?.header?.cwd
    if (!session || !cwd || isNativeSubagent({ session })) { yield* next(); return }
    let requestId: string | undefined
    for (let index = (request.messages?.length ?? 0) - 1; index >= 0; index--) {
      const message = request.messages?.[index]
      if (message?.role === 'user' && (message.source as { kind?: string })?.kind === 'user') { requestId = message.id; break }
    }
    if (!requestId) { yield* next(); return }
    const state = states.get(session) ?? { requestId }
    if (!states.has(session)) states.set(session, state)
    let recorded = false
    for await (const chunk of next()) {
      if (!recorded && (chunk.type !== 'finish' || !['error', 'aborted'].includes(chunk.reason?.kind))
        && states.get(session) === state && requestId === state.requestId) {
        try { state.observation = observedMemory(session, request, requestId, cwd) } catch { /* A sidebar observation cannot affect model execution. */ }
        recorded = true
      }
      yield chunk
    }
  }, { global: true, prepend: true })
  const stopRoute = connection?.fetch?.register({
    path: MEMORY_SIDEBAR_PATH, methods: ['GET'], requestBody: 'buffered',
    async fetch(request: Request) {
      const headers = { 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" }
      const reply = (body: object, status = 200) => Response.json(body, { status, headers })
      if (request.method !== 'GET') return reply({ code: 'invalid_method' }, 405)
      const url = new URL(request.url)
      const origin = request.headers.get('origin')
      if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== url.origin))
        return reply({ code: 'origin_mismatch' }, 403)
      const id = url.searchParams.get('sessionId')
      if (!id || id.length > 256 || /[\p{Cc}\p{Cf}]/u.test(id)) return reply({ code: 'invalid_session' }, 400)
      try {
        const session = lookup(id)
        if (!session) {
          const stored = await host.get('sessionPersistence', false)?.stat?.(id)
          return stored?.header?.id === id ? reply({ state: 'unobserved' }) : reply({ code: 'session_unavailable' }, 404)
        }
        const state = states.get(session), observation = state?.observation
        if (session.id !== id || !observation || observation.cwd !== session.header?.cwd) return reply({ state: 'unobserved' })
        const view = await readObservation(runtime, session, observation)
        return lookup(id) === session && states.get(session) === state && state.observation === observation && observation.cwd === session.header?.cwd
          ? reply(view) : reply({ state: 'unobserved' })
      } catch { return reply({ code: 'memory_unavailable' }, 503) }
    },
  })
  return () => { stopRoute?.(); stopStream(); stopEvents() }
}
