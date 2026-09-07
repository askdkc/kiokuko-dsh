import type { Context } from '@deepseek-ai/cordis'
import type { OrcaConfig } from './config.js'
import { canonicalDirectory, detectRepositoryRoot } from '../repository/detect-root.js'
import { DshOrcaRecorder } from './orca-recorder.js'
import { DshOrcaStore } from './orca-store.js'
import { mountDshOrcaHooks } from './orca-hooks.js'
import { getDshOrcaStoreRoot } from './paths.js'
import { workspaceKey } from './orca-security.js'
import { record } from './orca-event-mapper.js'
import type { DshRuntime } from './runtime.js'
import type { DshOrcaBinding, DshOrcaHostServices, WithOrcaIndex } from './orca-types.js'

export function createDshOrcaHost(ctx: Context, config: OrcaConfig, runtime: DshRuntime, native: {
  session(id: string): object | undefined
  agent(id: string): object | undefined
  logicalRun(session: { id: string }): string | undefined
}): DshOrcaHostServices {
  // Cordis releases plugin-owned listeners before its async effect cleanup.
  // Root-owned observers are explicitly released only after recorder drain.
  const observerContext = ctx.root ?? ctx
  const bindings = new Map<string, { agent: object; session: object; binding: DshOrcaBinding }>()
  let accepting = true
  const withIndex: WithOrcaIndex = operation => runtime.withDatabase(async db => await operation(new DshOrcaStore(db)))
  const recorder = new DshOrcaRecorder(config, withIndex)
  let shutdown: Promise<void> | undefined
  const disposers: (() => void)[] = []
  function enrich(entry: { session: object; binding: DshOrcaBinding }): DshOrcaBinding {
    const runId = native.logicalRun(entry.session as { id: string })
    return Object.freeze({ ...entry.binding, ...(runId === undefined ? {} : { kiokukoRunId: runId }) })
  }
  const services: DshOrcaHostServices = {
    config, recorder, withIndex,
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
      shutdown = recorder.shutdown().finally(() => { for (const dispose of disposers.reverse()) dispose(); bindings.clear() })
      return shutdown
    },
  }
  try {
    // On hot reload, an existing agent will not emit session-start again.
    // The next pre-step carries its exact native pair; do not scan the registry.
    disposers.push((observerContext as any).on('agent/pre-step', (payload: { agent?: { session?: object } }, next: () => unknown) => {
      try { if (payload.agent?.session) services.resolveSessionBinding(payload.agent, payload.agent.session) } catch { /* attribution unavailable */ }
      return next()
    }, { global: true }))
    disposers.push((observerContext as any).on('agent/session-start', (payload: { agent?: { session?: object } }) => {
      try { if (payload.agent?.session) services.resolveSessionBinding(payload.agent, payload.agent.session) } catch { /* attribution unavailable */ }
    }, { global: true }))
    disposers.push((observerContext as any).on('session/disposed', (session: object) => {
      const id = record(session).id
      const entry = bindings.get(id)
      if (!entry || entry.session !== session) return
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
