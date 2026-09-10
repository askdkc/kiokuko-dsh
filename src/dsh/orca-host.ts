import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from './config.js'
import { canonicalDirectory, detectRepositoryRoot } from '../repository/detect-root.js'
import { DshOrcaRecorder } from './orca-recorder.js'
import { DshOrcaStore } from './orca-store.js'
import { mountDshOrcaHooks } from './orca-hooks.js'
import { getDshOrcaStoreRoot } from './paths.js'
import { workspaceKey } from './orca-security.js'
import { record } from './orca-event-mapper.js'
import { DshOrcaSessionChoices } from './orca-session-choice.js'
import type { DshUserQuestions } from './user-interaction.js'
import type { DshRuntime } from './runtime.js'
import type { DshOrcaBinding, DshOrcaHostServices, WithOrcaIndex } from './orca-types.js'

export function createDshOrcaHost(ctx: Context, config: OrcaConfig, runtime: DshRuntime, native: {
  session(id: string): object | undefined
  agent(id: string): object | undefined
  logicalRun(session: { id: string }): string | undefined
  questions?: DshUserQuestions
  interactive?(agent: { id: string }): boolean
  recordingRun?(agent: object): string | undefined
  recordingParent?(agent: object): { agent: object; session: object } | undefined
}): DshOrcaHostServices {
  // Cordis releases plugin-owned listeners before its async effect cleanup.
  // Root-owned observers are explicitly released only after recorder drain.
  const observerContext = ctx.root ?? ctx
  const bindings = new Map<string, { agent: object; session: object; binding: DshOrcaBinding }>()
  let accepting = true
  const withIndex: WithOrcaIndex = operation => runtime.withDatabase(async db => await operation(new DshOrcaStore(db)))
  const recorder = new DshOrcaRecorder(config, withIndex)
  const choices = new DshOrcaSessionChoices(withIndex, native.questions)
  const operations = new Map<string, Promise<void>>()
  let shutdown: Promise<void> | undefined
  const disposers: (() => void)[] = []
  function enrich(entry: { agent: object; session: object; binding: DshOrcaBinding }): DshOrcaBinding {
    const runId = native.recordingRun?.(entry.agent) ?? native.logicalRun(entry.session as { id: string })
    return Object.freeze({ ...entry.binding, ...(runId === undefined ? {} : { kiokukoRunId: runId }) })
  }
  function recordingAuthority(binding: DshOrcaBinding): DshOrcaBinding | undefined {
    const entry = bindings.get(binding.sessionId), parent = entry && native.recordingParent?.(entry.agent)
    if (!parent) return binding
    const inherited = services.resolveSessionBinding(parent.agent, parent.session)
    return inherited && inherited.workspaceRoot === binding.workspaceRoot && inherited.storeRoot === binding.storeRoot ? inherited : undefined
  }
  const services: DshOrcaHostServices = {
    config, recorder, withIndex,
    canRecord: binding => { const authority = recordingAuthority(binding); return accepting && !!authority && choices.allows(authority) },
    sessionRecordingStatus: binding => { const authority = recordingAuthority(binding); return authority ? choices.status(authority) : Promise.resolve({sessionRecording:'unavailable'}) },
    setSessionRecording(binding, enabled) {
      const pending = (operations.get(binding.sessionId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        if (!accepting) throw new Error('Orca host closed')
        try { await choices.set(binding, enabled) }
        finally { if (!enabled) await recorder.closeSessionRecording(binding.sessionId, 'manual') }
        if (enabled && accepting && choices.allows(binding)) recorder.start(binding)
      })
      operations.set(binding.sessionId, pending)
      void pending.finally(() => { if (operations.get(binding.sessionId) === pending) operations.delete(binding.sessionId) }).catch(() => undefined)
      return pending
    },
    resolveSessionBinding(agent, session) {
      if (!accepting) return undefined
      const a = record(agent), s = record(session)
      if (typeof a.id !== 'string' || typeof s.id !== 'string' || a.session !== session
        || (a.sessionId !== undefined && a.sessionId !== s.id)
        || native.agent(a.id) !== agent || native.session(s.id) !== session) return undefined
      const existing = bindings.get(s.id)
      if (existing) {
        if (existing.agent !== agent || existing.session !== session || canonicalDirectory(record(s.header).cwd) !== existing.binding.sessionCwd) return undefined
        return enrich(existing)
      }
      if (typeof record(s.header).cwd !== 'string') return undefined
      const cwd = canonicalDirectory(s.header.cwd)
      const root = detectRepositoryRoot({ cwd, allowDirectory: true }).root
      const entry = { agent, session, binding: Object.freeze({ sessionId: s.id, sessionCwd: cwd, workspaceRoot: root,
        storeRoot: getDshOrcaStoreRoot(root, config.storage, workspaceKey(root)) }) }
      bindings.set(s.id, entry)
      return enrich(entry)
    },
    resolveModelBinding(id) {
      const entry = bindings.get(id)
      if (!entry) return undefined
      return services.resolveSessionBinding(entry.agent, entry.session)
    },
    closeSessionRecording: (id, reason) => recorder.closeSessionRecording(id, reason),
    shutdown() {
      if (shutdown) return shutdown
      accepting = false
      recorder.stopAccepting()
      shutdown = Promise.all([choices.shutdown(), ...[...operations.values()].map(p => p.catch(() => undefined)), recorder.shutdown()])
        .then(() => undefined).finally(() => { for (const dispose of disposers.reverse()) dispose(); bindings.clear() })
      return shutdown
    },
  }
  try {
    // On hot reload, an existing agent will not emit session-start again.
    // The next pre-step carries its exact native pair; do not scan the registry.
    disposers.push((observerContext as any).on('agent/pre-step', async (payload: { agent?: { id: string; session?: object }; signal?: AbortSignal }, next: () => unknown) => {
      try {
        const agent = payload.agent, session = agent?.session
        const binding = agent && session ? services.resolveSessionBinding(agent, session) : undefined
        if (binding && agent && session) {
          if (native.interactive?.(agent) === false) await services.sessionRecordingStatus(binding)
          else await choices.prepare(binding, agent, payload.signal ?? new AbortController().signal,
            () => services.resolveSessionBinding(agent, session) !== undefined)
        }
      } catch { /* Optional recording cannot veto the native step. */ }
      return next()
    }, { global: true }))
    disposers.push((observerContext as any).on('agent/session-start', (payload: { agent?: { session?: object } }) => {
      try { if (payload.agent?.session) services.resolveSessionBinding(payload.agent, payload.agent.session) } catch { /* attribution unavailable */ }
    }, { global: true }))
    disposers.push((observerContext as any).on('session/disposed', (session: object) => {
      const id = record(session).id
      const entry = bindings.get(id)
      if (!entry || entry.session !== session) return
      choices.forget(entry.binding)
      void recorder.closeSessionRecording(id, 'session_disposed').finally(() => { bindings.delete(id); recorder.forgetSession(id) }).catch(() => undefined)
    }, { global: true }))
    disposers.push(mountDshOrcaHooks(observerContext, services))
  } catch {
    for (const dispose of disposers.reverse()) dispose()
    accepting = false
    recorder.markUnavailable('observer_registration_failed')
  }
  return services
}
