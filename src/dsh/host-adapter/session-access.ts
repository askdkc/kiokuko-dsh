import type { AdapterContext, NativeSessions } from './native-events.js'
import { DshSessionLogExportService } from '../session-log-export.js'
import type { DshSessionLogMirror, DshMirrorEventSession } from '../session-log-mirror.js'
import type { DshSessionQuery } from '../session-memory-finalizer.js'
import { readHistoricalDshSession } from '../session-history-lookup.js'
import { KiokukoError } from '../../errors.js'

interface SessionAccessDependencies {
  readonly native: AdapterContext
  readonly sessions: NativeSessions | undefined
  readonly sessionQuery: DshSessionQuery | undefined
  readonly sessionMirror: DshSessionLogMirror
}

export function createSessionAccess(deps: SessionAccessDependencies) {
  const { native, sessions, sessionQuery, sessionMirror } = deps
  async function importLegacySession(sessionId: string) {
    if (sessionQuery === undefined) throw new KiokukoError('NOT_FOUND', 'DSH session is unavailable')
    // Preserve historical coordinates before the native query attempts migration.
    // Live sessions must still use their native view rather than an older disk log.
    const historical = sessions !== undefined && sessions.get(sessionId) === undefined
      ? await readHistoricalDshSession(native.get('sessionPersistence', false), sessionId) : undefined
    const snapshot = historical ?? await sessionQuery.readSession(sessionId)
    // Bound the materializing native fallback before copying into the mirror.
    let bytes = 0
    for (const event of snapshot.events) {
      bytes += Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
      if (bytes > 32 * 1024 * 1024) {
        throw new KiokukoError('VALIDATION_ERROR', 'legacy DSH log exceeds the bounded one-time import limit', {
          httpStatus: 413,
          code: 'legacy_log_too_large',
        })
      }
      await sessionMirror.observe(sessionId, event)
    }
    return snapshot
  }
  const finalizationQuery: DshSessionQuery = {
    cachePromptLayout: (layout) => sessionMirror.cachePromptLayout(layout),
    streamSession: async (sessionId) => {
      try {
        return await sessionMirror.streamSession(sessionId)
      } catch (error) {
        if (!(error instanceof KiokukoError) || error.code !== 'NOT_FOUND') throw error
      }
      const snapshot = await importLegacySession(sessionId)
      return Object.freeze({
        session: snapshot.session,
        inheritedEventCount: snapshot.inheritedEventCount,
        events: (async function* () { for (const event of snapshot.events) yield event })(),
      })
    },
    readSession: async (sessionId) => {
      try {
        return await sessionMirror.readSession(sessionId)
      } catch (error) {
        if (!(error instanceof KiokukoError) || error.code !== 'NOT_FOUND') throw error
      }
      return importLegacySession(sessionId)
    },
  }
  const sessionExport = new DshSessionLogExportService(sessionMirror, {
    ensureNativeDurable: async (sessionId) => {
      const liveSession = sessions?.get(sessionId)
      if (liveSession !== undefined) {
        if (sessions?.flush === undefined || typeof liveSession.snapshotEvents !== 'function') {
          throw new KiokukoError('SERVICE_UNAVAILABLE', 'The live DSH session cannot be durably flushed for export')
        }
        await sessions.flush(liveSession)
        // Mirror checkpointing is non-vetoing. Its structured degraded health
        // is evaluated by the export service after this durability barrier.
        await sessionMirror.checkpointAfterNativeFlush(liveSession as DshMirrorEventSession)
        return
      }
      const current = await sessionMirror.checkpoint(sessionId)
      if (current.error !== undefined
        || (current.confirmedThrough >= current.observedThrough && current.observedThrough >= 0)) return
      if (sessionQuery === undefined) return
      const snapshot = await importLegacySession(sessionId)
      // Cold lookup returns the already persisted DSH source log;
      // unlike a live Session, it does not require another sessions.flush().
      await sessionMirror.checkpointAfterNativeFlush({
        id: sessionId,
        header: snapshot.session,
        snapshotEvents: () => snapshot.events,
      })
    },
  })
  return { finalizationQuery, sessionExport }
}
