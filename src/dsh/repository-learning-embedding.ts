import type { SqliteDatabase } from '../db/adapter.js'
import { JavaScriptVectorSearchBackend } from '../embedding/javascript-backend.js'
import { LocalTransformersEmbeddingProvider } from '../embedding/local-transformers-provider.js'
import { createEmbeddingRuntime } from '../embedding/runtime.js'
import { readPersistedEmbeddingSettings } from '../embedding/settings.js'
import { readActiveEmbeddingProfile } from '../embedding/store.js'
import type { EmbeddingRuntime } from '../embedding/types.js'
import { canonicalContentHash } from '../serialization/validate.js'
import { getDshEmbeddingPresetDirectory } from './paths.js'

export type RepositoryLearningEmbeddingSource = Pick<EmbeddingRuntime, 'mode' | 'embedSearchCorpus'>

/** Own the configured local model for repository learning without starting an embedding worker. */
export class RepositoryLearningEmbedding {
  #local?: {
    db: SqliteDatabase
    key: string
    runtime: EmbeddingRuntime
    provider: LocalTransformersEmbeddingProvider
  } | undefined

  resolve(db: SqliteDatabase, existing?: EmbeddingRuntime): RepositoryLearningEmbeddingSource {
    if (existing?.embedSearchCorpus) {
      void this.close()
      return existing
    }
    try {
      const config = readPersistedEmbeddingSettings(db)
      if (config.mode === 'off') {
        void this.close()
        return existing ?? config
      }
      const active = readActiveEmbeddingProfile(db)
      const identity = active?.profile.identity
      if (!identity || identity.schemaVersion !== 2) {
        void this.close()
        return { mode: config.mode }
      }
      const key = canonicalContentHash([active.profile.profileId, active.generation, config])
      if (this.#local?.db === db && this.#local.key === key) return this.#local.runtime
      void this.close()
      const provider = new LocalTransformersEmbeddingProvider({
        profile: identity,
        modelDirectory: getDshEmbeddingPresetDirectory(identity.presetId, identity.modelRevision),
      })
      const runtime = createEmbeddingRuntime(db, config, { provider, backend: new JavaScriptVectorSearchBackend() })
      this.#local = { db, key, runtime, provider }
      return runtime
    } catch {
      void this.close()
      return { mode: 'optional' }
    }
  }

  async close(): Promise<void> {
    const local = this.#local
    this.#local = undefined
    if (local) await Promise.allSettled([local.runtime.close(), local.provider.close()])
  }
}
