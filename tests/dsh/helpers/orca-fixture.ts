import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { OrcaConfig } from '../../../src/dsh/config.js'
import { DshOrcaStore } from '../../../src/dsh/orca-store.js'
import { DshOrcaRecorder, type OrcaRecorderDependencies } from '../../../src/dsh/orca-recorder.js'
import { DshOrcaReadService } from '../../../src/dsh/orca-read-service.js'
import type { DshOrcaBinding, WithOrcaIndex } from '../../../src/dsh/orca-types.js'
import type { z } from 'zod'
export async function orcaFixture(input: z.input<typeof OrcaConfig> = {}, dependencies: OrcaRecorderDependencies = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'kiokuko-orca-')))
  const database = openConnection(join(root, 'index.sqlite3'))
  migrateDatabase(database, join(process.cwd(), 'migrations'))
  const store = new DshOrcaStore(database)
  const withIndex: WithOrcaIndex = async operation => await operation(store)
  const config = OrcaConfig.parse({ enabled: true, shutdownDrainTimeoutMs: 20, ...input })
  const binding: DshOrcaBinding = { sessionId: 'session-a', workspaceRoot: root, sessionCwd: root, storeRoot: root }
  const recorder = new DshOrcaRecorder(config, withIndex, dependencies)
  const reader = new DshOrcaReadService(config, withIndex)
  return { root, database, store, withIndex, config, binding, recorder, reader,
    async dispose() { await recorder.shutdown(); database.close(); await rm(root, { recursive: true, force: true }) } }
}
export const request = { provider: 'mock', model: 'mock', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
export const response = (text = 'hello') => [{ type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 2 } },
  { type: 'finish', reason: { kind: 'stop' } }]
export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of stream) values.push(value); return values }
export async function* chunks<T>(values: T[]): AsyncIterable<T> { yield* values }
