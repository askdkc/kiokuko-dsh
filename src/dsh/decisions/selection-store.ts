import type { DshCoreRuntime } from '../core-runtime.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { TypedDecisionsConfig, type DecisionConfiguration } from './config.js'

export interface DecisionSelectionStore {
  load(): Promise<{ config: DecisionConfiguration; revision: number } | undefined>
  save(config: DecisionConfiguration, revision: number, signal: AbortSignal): Promise<number>
}

/** A successful command persists one selection; stale hosts cannot overwrite a newer command. */
export function databaseDecisionSelection(runtime: Pick<DshCoreRuntime, 'withDatabase'>, repositoryRoot: string, base: DecisionConfiguration): DecisionSelectionStore {
  const digest = canonicalContentHash(base)
  return {
    load: () => runtime.withDatabase(db => {
      const row = db.prepare('SELECT revision,config_json,config_digest FROM dsh_decision_selections WHERE repository_root=? AND base_digest=?').get(repositoryRoot, digest)
      if (!row) return undefined
      const config = TypedDecisionsConfig.parse(JSON.parse(String(row.config_json)))
      if (canonicalContentHash(config) !== row.config_digest) throw new Error('Decision selection integrity mismatch')
      return { config, revision: Number(row.revision) }
    }),
    save: (config, revision, signal) => runtime.withDatabase(db => {
      signal.throwIfAborted()
      db.prepare(`INSERT INTO dsh_decision_selections VALUES (?,?,1,?,?)
        ON CONFLICT(repository_root,base_digest) DO UPDATE SET revision=revision+1,config_json=excluded.config_json,config_digest=excluded.config_digest
        WHERE revision=?`).run(repositoryRoot, digest, JSON.stringify(config), canonicalContentHash(config), revision)
      if (db.prepare('SELECT changes() AS count').get<{ count: number }>()!.count !== 1) throw new Error('Decision selection changed in another host')
      return revision + 1
    }),
  }
}
