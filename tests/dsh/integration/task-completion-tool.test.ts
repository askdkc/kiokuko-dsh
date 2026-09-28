import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { mountTaskCompletion } from '../../../src/dsh/task-completion-host.js'
import { foregroundNativeCommand } from '../../../src/dsh/memory-application.js'

test('native completion tool proposes a check and only a later matching foreground result satisfies it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'kiokuko-completion-tool-'))
  let root = join(base, 'repo')
  await mkdir(join(root, 'src'), { recursive: true })
  root = realpathSync(root)
  await writeFile(join(root, 'src/check.mjs'), 'source')
  const db = openConnection(join(base, 'state.sqlite3'))
  let dispose: () => void = () => undefined
  try {
    migrateDatabase(db, join(process.cwd(), 'migrations'))
    const prepared = await prepareAgentTask(db, { requestId: 'native-completion-tool', cwd: root,
      task: '調査する\n完了条件: node src/check.mjs', dshSessionId: 'session', completionMode: 'enforce',
      profileHints: { taskType: 'research', target: 'src', expected: '検証', constraints: null },
      capabilities: [], skillDiscoveryMode: 'off' })
    const session = { id: 'session' }, agent = { id: 'agent', session }
    const callbacks = new Map<string, Function>()
    let tool: any
    dispose = mountTaskCompletion({ tools: { register(definition) { tool = definition; return () => undefined } },
      on(name, fn) { callbacks.set(name, fn); return () => callbacks.delete(name) } }, {
      runtime: { withDatabase: async (fn: (database: typeof db) => unknown) => fn(db) } as any,
      resolve(execution) { return execution.agent === agent ? { runId: prepared.run.runId, sessionId: 'session',
        repositoryRoot: root, agent } : undefined },
    })
    const signal = new AbortController().signal
    const status = await tool.execute({ action: 'status' }, { agent, name: 'task_completion', callId: 'status', signal })
    assert.equal(status.criteria[0].state, 'unknown')
    const method = { kind: 'native_command', command: 'node src/check.mjs', cwd: '.',
      sourcePaths: ['src/check.mjs'], assertion: 'exit_zero' }
    assert.equal((await tool.execute({ action: 'bind', criterionId: status.criteria[0].criterionId, method },
      { agent, name: 'task_completion', callId: 'bind', signal })).approved, true)
    const execution = { agent, name: 'Bash', arguments: { command: method.command, cwd: root }, callId: 'command', signal }
    assert.equal(foregroundNativeCommand(execution, root), method.command)
    await callbacks.get('tools/pre-execute')!(execution, async () => undefined)
    await callbacks.get('tools/result')!(execution, { value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
    const done = await tool.execute({ action: 'status' }, { agent, name: 'task_completion', callId: 'status-2', signal })
    assert.equal(done.verified, true, JSON.stringify({ done, rows: db.prepare('SELECT * FROM dsh_completion_executions').all() }))
    assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_completion_executions').get<{ n: number }>()?.n, 1)
    await assert.rejects(tool.execute({ action: 'status' }, { agent: { id: 'other', session },
      name: 'task_completion', callId: 'forged', signal }), /exact active native run/)
  } finally { dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})
