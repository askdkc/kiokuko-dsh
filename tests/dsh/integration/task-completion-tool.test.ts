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
import { recordEntry } from '../../../src/memory/entries.js'
import { noteScopedMemory, mountMemorySidebar } from '../../../src/dsh/memory-sidebar.js'
import { observeProcessResult } from '../../../src/dsh/execution-result.js'
import { readMemoryReuseChecks } from '../../../src/dsh/task-completion.js'

test('native completion tool proposes a check and only a later matching foreground result satisfies it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'kiokuko-completion-tool-'))
  let root = join(base, 'repo')
  await mkdir(join(root, 'src'), { recursive: true })
  root = realpathSync(root)
  await writeFile(join(root, 'src/check.mjs'), 'source')
  const db = openConnection(join(base, 'state.sqlite3'))
  let dispose: () => void = () => undefined
  let disposeSidebar: () => void = () => undefined
  try {
    migrateDatabase(db, join(process.cwd(), 'migrations'))
    const prepared = await prepareAgentTask(db, { requestId: 'native-completion-tool', cwd: root,
      task: '調査する\n完了条件: node src/check.mjs', dshSessionId: 'session', completionMode: 'enforce',
      profileHints: { taskType: 'research', target: 'src', expected: '検証', constraints: null },
      capabilities: [], skillDiscoveryMode: 'off' })
    const memory = recordEntry(db, { workspace: prepared.project.workspace, title: 'Native check pattern', kind: 'lesson', body: 'Assert the observed output.' })
    const session = { id: 'session', header: { cwd: root } }, agent = { id: 'agent', session }
    const sidebarHooks = new Map<string, Function>()
    disposeSidebar = mountMemorySidebar({
      get: name => name === 'sessions' ? new Map([[session.id, session]]) : undefined,
      on(name, fn) { sidebarHooks.set(name, fn); return () => sidebarHooks.delete(name) },
    }, { withDatabase() { throw new Error('No sidebar HTTP reads in this fixture') } })
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
    const appliedMemories = [{ entryId: memory.id, revision: memory.revision }]
    const method = { kind: 'native_command', command: 'node src/check.mjs', cwd: '.',
      sourcePaths: ['src/check.mjs'], assertion: 'output_matches', expectedOutput: 'ok', appliedMemories }
    const bind = { action: 'bind', criterionId: status.criteria[0].criterionId, method }
    const bindCall = { agent, name: 'task_completion', callId: 'bind', signal }
    await assert.rejects(tool.execute(bind, bindCall), /sent to the model/)
    const text = 'fixture memory projection'
    const name = `memory:memory:${memory.id}`
    const request = { sessionId: session.id, messages: [
      { id: 'current-user-request', role: 'user', source: { kind: 'user' } },
      { role: 'user', source: { kind: 'plugin:kiokuko-dsh', form: 'snapshot', sections: [{ name, text }] }, content: [{ type: 'text', text }] },
    ] }
    noteScopedMemory(request, new Map([[name, text]]), [{ entryId: memory.id, revision: memory.revision,
      workspace: memory.workspace, selectionReasons: ['project_origin'] }] as any)
    for await (const _ of sidebarHooks.get('llm/stream')!(request, async function* () { yield { type: 'text-delta' } })) { /* model started */ }
    const afterDelivery = await tool.execute({ action: 'status' }, { agent, name: 'task_completion', callId: 'after-delivery', signal })
    assert.deepEqual(afterDelivery.deliveredMemories, appliedMemories)
    const lookup = { workspace: prepared.project.workspace, sessionId: session.id, entryId: memory.id, revision: memory.revision }
    assert.deepEqual(readMemoryReuseChecks(db, lookup), [])
    assert.equal((await tool.execute({ action: 'bind', criterionId: status.criteria[0].criterionId, method },
      { agent, name: 'task_completion', callId: 'bind', signal })).approved, true)
    const execution = { agent, name: 'Bash', arguments: { command: method.command, cwd: root }, callId: 'command', signal }
    assert.equal(foregroundNativeCommand(execution, root), method.command)
    await callbacks.get('tools/pre-execute')!(execution, async () => undefined)
    await callbacks.get('tools/result')!(execution, { value: { exitCode: 1 }, content: [{ type: 'text', text: 'failed' }] })
    assert.deepEqual(readMemoryReuseChecks(db, lookup), [])
    const unobserved = { ...execution, callId: 'unobserved-success' }
    await callbacks.get('tools/pre-execute')!(unobserved, async () => undefined)
    await callbacks.get('tools/result')!(unobserved, { value: { exitCode: 0 }, content: [{ type: 'text', text: 'ok' }] })
    assert.deepEqual(readMemoryReuseChecks(db, lookup), [], 'exit code and matching text cannot mint host proof')
    const retry = { ...execution, callId: 'command-retry' }
    await callbacks.get('tools/pre-execute')!(retry, async () => undefined)
    await callbacks.get('tools/result')!(retry, observeProcessResult({ isError: false,
      value: { exitCode: 0, signal: null, timedOut: false, aborted: false,
        processStarted: true, processStopped: true, outputComplete: true },
      content: [{ type: 'text', text: 'ok' }],
    }))
    const done = await tool.execute({ action: 'status' }, { agent, name: 'task_completion', callId: 'status-2', signal })
    assert.equal(done.verified, true, JSON.stringify({ done, rows: db.prepare('SELECT * FROM dsh_completion_executions').all() }))
    assert.equal(db.prepare('SELECT count(*) AS n FROM dsh_completion_executions').get<{ n: number }>()?.n, 3)
    assert.deepEqual(readMemoryReuseChecks(db, lookup).map(item => [item.state, item.runId, item.evidenceRef]),
      [['verified', prepared.run.runId, 'command-retry']])
    assert.deepEqual(readMemoryReuseChecks(db, { ...lookup, sessionId: 'other' }), [], 'active evidence is session scoped')
    assert.deepEqual(readMemoryReuseChecks(db, { ...lookup, revision: memory.revision + 1 }), [])
    assert.deepEqual(readMemoryReuseChecks(db, { ...lookup, workspace: 'foreign' }), [])
    await writeFile(join(root, 'src/check.mjs'), 'changed after verification')
    assert.deepEqual(readMemoryReuseChecks(db, lookup).map(item => item.state), ['needs_recheck'])
    sidebarHooks.get('session/event')!(session, { type: 'user/message', data: { id: 'next-user-request', source: { kind: 'user' } } })
    await assert.rejects(tool.execute(bind, { ...bindCall, callId: 'previous-request-memory' }), /sent to the model/)
    await assert.rejects(tool.execute({ action: 'status' }, { agent: { id: 'other', session },
      name: 'task_completion', callId: 'forged', signal }), /exact active native run/)
  } finally { disposeSidebar(); dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})
