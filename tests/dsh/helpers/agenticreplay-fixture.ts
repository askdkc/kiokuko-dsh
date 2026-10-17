import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { AgenticReplayConfig } from '../../../src/dsh/config.js'
import { DshAgenticReplayStore } from '../../../src/dsh/agenticreplay-store.js'
import { DshAgenticReplayRecorder, type AgenticReplayRecorderDependencies } from '../../../src/dsh/agenticreplay-recorder.js'
import { DshAgenticReplayReadService } from '../../../src/dsh/agenticreplay-read-service.js'
import type { DshAgenticReplayBinding, WithAgenticReplayIndex } from '../../../src/dsh/agenticreplay-types.js'
import type { z } from 'zod'
export async function agenticReplayFixture(input: z.input<typeof AgenticReplayConfig> = {}, dependencies: AgenticReplayRecorderDependencies = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'kiokuko-agenticreplay-')))
  const database = openConnection(join(root, 'index.sqlite3'))
  migrateDatabase(database, join(process.cwd(), 'migrations'))
  const store = new DshAgenticReplayStore(database)
  const withIndex: WithAgenticReplayIndex = async operation => await operation(store)
  const config = AgenticReplayConfig.parse({ shutdownDrainTimeoutMs: 20, ...input })
  const binding: DshAgenticReplayBinding = { sessionId: 'session-a', workspaceRoot: root, sessionCwd: root, storeRoot: root }
  const recorder = new DshAgenticReplayRecorder(config, withIndex, dependencies)
  const reader = new DshAgenticReplayReadService(config, withIndex)
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

/** Locate fixture output by manifest identity, independent of SDK directory naming and empty ID claims. */
export async function recordedRunDirectory(root: string, runId: string): Promise<string> {
  const runs = join(root, '.agenticreplay', 'runs'), matches: string[] = []
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = join(runs, entry.name)
    let manifest: string
    try { manifest = await readFile(join(directory, 'manifest.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    if (JSON.parse(manifest).run_id === runId) matches.push(directory)
  }
  if (matches.length !== 1) throw new Error(`Expected one recorded fixture directory, found ${matches.length}`)
  return matches[0]!
}
