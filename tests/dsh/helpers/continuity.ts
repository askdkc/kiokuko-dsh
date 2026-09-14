import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { initializeDatabase } from '../../../src/dsh/database.js'
import { openConnection } from '../../../src/db/connection.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { DshExecutionSupport, type ExecutionBinding } from '../../../src/dsh/execution-support.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'

export async function fixture(options: any = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'kiokuko-execution-')))
  await mkdir(join(root, 'src'))
  await initializeDatabase({ databasePath: join(root, 'state.sqlite3') })
  const db = openConnection(join(root, 'state.sqlite3'))
  const task = '資料を調査して報告する。\nread paths: src\nwrite paths: src\n変更禁止: src/private\n完了条件: 根拠を示す。'
  const prepared = await prepareAgentTask(db, { requestId: 'execution', cwd: root, task, dshSessionId: 'session',
    profileHints: { taskType: 'research', target: 'src', expected: '根拠付きの報告', constraints: null }, capabilities: [], skillDiscoveryMode: 'off' })
  let fail = false
  let wait: Promise<void> | undefined
  const runtime = { async withDatabase<T>(fn: (database: typeof db, runtime: any) => T | Promise<T>): Promise<T> {
    if (wait) await wait
    if (fail) throw new Error('injected DB failure')
    return fn(db, undefined)
  } }
  const session = { id: 'session', snapshotEvents: () => [] }
  const agent = { session }
  const binding: ExecutionBinding = { runId: prepared.run.runId, sessionId: session.id, nativeSession: session, nativeAgent: agent,
    cwd: root, task, turn: 1, generation: 'work-lease-1', terminal: false, chat: false }
  const support = new DshExecutionSupport(runtime, options)
  const callbacks = new Map<string, Function>()
  let guard!: (execution: any) => string | undefined
  support.mount({ on(name, fn) { callbacks.set(name, fn); return () => { callbacks.delete(name) } },
    tools: { guard(fn) { guard = fn; return () => undefined } } })
  await support.refresh(binding, true)
  const result = { isError: false, content: [{ type: 'text', text: 'facts' }] }
  function read(id: string, overrides: object = {}) {
    const execution = { name: 'read', arguments: { file_path: 'src/facts.md' }, agent, callId: id, rootCallId: 'parent', ...overrides }
    const denied = guard(execution)
    if (!denied) callbacks.get('tools/result')!(execution, result)
    return denied
  }
  const assemble = () => callbacks.get('system-prompt/assemble')!({}, { scope: agent }, async () => ({ contexts: [], variables: {}, sections: [] }))
  const stream = (messages: readonly any[] = []) => callbacks.get('llm/stream')!({ sessionId: 'session', messages }, () => 'original-stream')
  return { root, db, runtime, support, binding, agent, callbacks, guard, read, assemble, stream, result,
    fail(value: boolean) { fail = value }, wait(value: Promise<void> | undefined) { wait = value },
    async close() { support.dispose(); db.close(); await rm(root, { recursive: true, force: true }) } }
}
