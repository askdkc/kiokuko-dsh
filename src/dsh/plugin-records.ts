import { realpathSync } from 'node:fs'
import type { SqliteDatabase } from '../db/adapter.js'
import { canonicalJson } from '../serialization/validate.js'
import type { EvolutionObservation, EvolutionObservationBinding } from './evolution-observation.js'

/** Exact replay is harmless; conflicting proof is never silently substituted. */
export function saveEvolutionObservation(db: SqliteDatabase, observation: EvolutionObservation): void {
  const json = canonicalJson(observation)
  const previous = db.prepare('SELECT observation_json AS json FROM dsh_evolution_observations WHERE run_id=? AND call_seq=?')
    .get<{ json: string }>(observation.runId, observation.callSeq)
  if (previous) {
    if (previous.json !== json) throw new Error('Conflicting evolution observation')
    return
  }
  db.prepare('INSERT INTO dsh_evolution_observations VALUES (?, ?, ?, ?, ?)')
    .run(observation.runId, observation.workspace, observation.sessionId, observation.callSeq, json)
}

export function readEvolutionObservation(db: SqliteDatabase, binding: EvolutionObservationBinding, callSeq: number): unknown {
  const row = db.prepare(`SELECT observation_json AS json FROM dsh_evolution_observations
    WHERE run_id=? AND workspace=? AND dsh_session_id=? AND call_seq=?`)
    .get<{ json: string }>(binding.runId, binding.workspace, binding.sessionId, callSeq)
  return row ? JSON.parse(row.json) : undefined
}

export interface SessionNotice {
  id: string; runId: string; sessionId: string; rootPath: string
  kind: 'report' | 'status'; text: string; anchorSeq: number
}

/** A native sequence is only a display anchor; no native event is appended. */
export function saveSessionNotice(db: SqliteDatabase, notice: SessionNotice): void {
  const root = realpathSync(notice.rootPath)
  const previous = db.prepare('SELECT * FROM dsh_session_notices WHERE id=?').get<{
    run_id: string; dsh_session_id: string; root_path: string; kind: string; text: string
  }>(notice.id)
  if (previous) {
    if (previous.run_id !== notice.runId || previous.dsh_session_id !== notice.sessionId || previous.root_path !== root
      || previous.kind !== notice.kind || previous.text !== notice.text) throw new Error('Conflicting session notice')
    return
  }
  db.prepare('INSERT INTO dsh_session_notices(id,run_id,dsh_session_id,root_path,kind,text,anchor_seq) VALUES(?,?,?,?,?,?,?)')
    .run(notice.id, notice.runId, notice.sessionId, root, notice.kind, notice.text, notice.anchorSeq)
}
