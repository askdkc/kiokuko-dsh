import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { DshAnswerContext } from '../../../src/dsh/answer-context.js'
import { MemoryOwnerChanged } from '../../../src/dsh/memory-owner.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import { MemoryRetrievalConfig } from '../../../src/memory/retrieval-contracts.js'
import type { DshDatabaseOperation } from '../../../src/dsh/core-runtime.js'
import { createEmbeddingRuntime } from '../../../src/embedding/runtime.js'
import { defaultEmbeddingConfig } from '../../../src/embedding/settings.js'
import { resolveProjectWorkspace } from '../../../src/memory/workspaces.js'
import { recordEntry } from '../../../src/memory/entries.js'

for (const phase of ['prepare', 'project', 'fence', 'rebuild', 'dispatch'] as const) for (const change of ['abort', 'session', 'workspace'] as const) {
  test(`answer memory preserves ${change} after ${phase} database wait`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'answer-owner-'))
    await mkdir(join(root, '.git'))
    const db = openConnection(join(root, 'memory.sqlite3')); migrateDatabase(db)
    let after: (() => void) | undefined, cwd = root
    let waits = 0
    const controller = new AbortController(), events: any[] = []
    const session = { id: 'session', snapshotEvents: () => events, append: () => assert.fail('no surface mutation after invalidation') }
    const agent = { id: 'agent', session }
    const task = 'Explain the request.'
    const input = { agent, turn: 1, step: 1, signal: controller.signal, messages: [{ role: 'user', content: task }] }
    const identity = { agentId: agent.id, sessionId: session.id, turn: 1, requestDigest: canonicalContentHash(task) }
    const context = new DshAnswerContext({ async withDatabase<T>(fn: DshDatabaseOperation<T>) { const value = await fn(db, createEmbeddingRuntime(db, { ...defaultEmbeddingConfig(), mode: 'off' })); if (after && ++waits >= (phase === 'rebuild' ? 2 : 1)) after(); return value } },
      { root, cwd: () => cwd, projectOnly: true, memoryRetrieval: MemoryRetrievalConfig.parse({}) })
    try {
      if (phase !== 'prepare') await context.prepare(input, task)
      after = () => {
        after = undefined
        if (change === 'abort') controller.abort(new Error('native stop'))
        if (change === 'session') agent.session = { ...session }
        if (change === 'workspace') cwd = join(root, 'different')
      }
      if (phase === 'dispatch') {
        const changeState = after; after = undefined
        const guard = await context.fence(input, { sessionId: session.id, messages: [] }, identity)
        assert.ok(guard)
        changeState()
        assert.throws(() => guard.check(), change === 'abort' ? /native stop/ : MemoryOwnerChanged)
        return
      }
      const call = phase === 'prepare' ? context.prepare(input, task)
        : phase === 'project' ? context.project(input, [], identity)
        : context.fence(input, { sessionId: session.id, messages: phase === 'rebuild' ? [{ role: 'user',
          source: { kind: 'plugin:kiokuko-dsh', form: 'snapshot', sections: [{ name: 'memory:memory:obsolete', text: 'old memory' }] },
          content: [{ type: 'text', text: 'old memory' }] }] : [] }, identity)
      await assert.rejects(call, change === 'abort' ? /native stop/ : MemoryOwnerChanged)
      assert.equal(db.prepare('SELECT count(*) AS n FROM entries').get()?.n, 0, 'an invalidated read/rebuild does not store memory')
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
  })
}

test('parallel native sessions retain their own repository, request and cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parallel-memory-'))
  const roots = [join(root, 'first'), join(root, 'second')]
  for (const path of roots) await mkdir(join(path, '.git'), { recursive: true })
  const db = openConnection(join(root, 'memory.sqlite3')); migrateDatabase(db)
  try {
    const inputs = []
    for (const [index, cwd] of roots.entries()) {
      const project = (await resolveProjectWorkspace(db, cwd, { allowDirectory: true }))!
      recordEntry(db, { workspace: project.workspace, kind: 'fact', title: 'PARALLEL_CONTEXT', body: `PARALLEL_CONTEXT only repository ${index}.`, scope: { visibility: 'project' } })
      const controller = new AbortController(), task = 'Explain PARALLEL_CONTEXT.'
      const agent = { id: String(index), session: { id: `session-${index}`, snapshotEvents: () => [] } }
      inputs.push({ agent, task, controller, input: { agent, turn: 1, step: 1, signal: controller.signal, messages: [{ role: 'user', content: task }] },
        identity: { agentId: agent.id, sessionId: agent.session.id, turn: 1, requestDigest: canonicalContentHash(task) } })
    }
    const context = new DshAnswerContext({ async withDatabase(fn) { return fn(db, createEmbeddingRuntime(db, { ...defaultEmbeddingConfig(), mode: 'off' })) } },
      { root, cwd: agent => roots[Number(agent.id)]!, projectOnly: true, memoryRetrieval: MemoryRetrievalConfig.parse({}) })
    await Promise.all(inputs.map(value => context.prepare(value.input, value.task)))
    const messages = await Promise.all(inputs.map(value => context.project(value.input, [], value.identity)))
    for (const index of [0, 1]) {
      assert.match(JSON.stringify(messages[index]), new RegExp(`only repository ${index}`))
      assert.doesNotMatch(JSON.stringify(messages[index]), new RegExp(`only repository ${1 - index}`))
    }
    inputs[0]!.controller.abort(new Error('first stopped'))
    await assert.rejects(context.fence(inputs[0]!.input, { sessionId: inputs[0]!.agent.session.id, messages: messages[0]! }, inputs[0]!.identity), /first stopped/)
    const second = inputs[1]!
    const guard = await context.fence(second.input, { sessionId: second.agent.session.id, messages: messages[1]! }, second.identity)
    assert.ok(guard); guard.check()
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

for (const mixed of [false, true]) test(`answer context accepts captured goal text (mixed human input: ${mixed}) and rejects changed requests`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-answer-context-'))
  await mkdir(join(root, '.git'))
  const db = openConnection(join(root, 'memory.sqlite3')); migrateDatabase(db)
  const goal = { role: 'user', source: { kind: 'goal', goalId: 'goal', revision: 1, round: 2 }, content: [{ type: 'text', text: 'Continue the current goal.' }] }
  const messages = [...(mixed ? [{ role: 'user', source: { kind: 'user' }, content: 'Check the tests.' }] : []), goal,
    { role: 'user', source: { kind: 'runtime-context' }, content: 'This is not request text.' }]
  const task = mixed ? 'Check the tests.\nContinue the current goal.' : 'Continue the current goal.'
  const agent = { id: 'agent', session: { id: 'session', snapshotEvents: () => [] } }
  const input = { agent, turn: 1, step: 1, signal: new AbortController().signal, messages }
  const identity = { agentId: agent.id, sessionId: agent.session.id, turn: 1, requestDigest: canonicalContentHash(task) }
  const context = new DshAnswerContext({ async withDatabase(fn) { return fn(db, createEmbeddingRuntime(db, { ...defaultEmbeddingConfig(), mode: 'off' })) } },
    { root, projectOnly: true, memoryRetrieval: MemoryRetrievalConfig.parse({}) })
  try {
    await context.prepare(input, task)
    const projected = await context.project(input, messages, identity)
    assert.deepEqual(projected.slice(0, messages.length), messages)
    await context.beforeRequest(input, identity)
    const guard = await context.fence(input, { sessionId: agent.session.id, messages: projected }, identity)
    assert.ok(guard); guard.check()
    const changed = { ...input, messages: [{ ...goal, content: 'A different task.' }] }
    await assert.rejects(context.project(changed, messages, identity), MemoryOwnerChanged)
    await assert.rejects(context.fence(changed, { sessionId: agent.session.id, messages }, identity), MemoryOwnerChanged)
    const malformed = { ...input, messages: [{ ...goal, source: { ...goal.source, round: 0 } }] }
    await assert.rejects(context.project(malformed, messages, identity), MemoryOwnerChanged)
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})
