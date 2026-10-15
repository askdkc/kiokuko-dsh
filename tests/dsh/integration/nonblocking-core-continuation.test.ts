import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshCoreRuntime } from '../../../src/dsh/core-runtime.js'
import { CoreTasks } from '../../../src/dsh/core/tasks.js'
import { bindMainModelRequestIntent, createRequestIntentContext, requestIntentMessageRefs, requestIntentReferenceIds } from '../../../src/dsh/decisions/request-intent.js'
import { authorizeTaskLease, readTaskSnapshot, requestTaskStop } from '../../../src/dsh/task-state.js'

test('Core admits a source-bound conversational continuation without a formal Goal, then honors a durable human hold after restart', { timeout: 30_000 }, async () => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'nonblocking-core-continuation-')))
  const configuration = { repositoryRoot: root, databasePath: join(root, 'authority.sqlite3'), autoRegisterRepository: true,
    embeddingConfig: { mode: 'off' as const, provider: 'openai-compatible' as const, allowRemote: false, vectorBackend: 'auto' as const, timeoutMs: 30_000, batchSize: 16 } }
  let runtime = new DshCoreRuntime(configuration)
  try {
    await runtime.start()
    const task = 'Continue inspecting the local parser behavior without editing files.'
    const context = createRequestIntentContext({ task, messageRefs: requestIntentMessageRefs([], task) })!
    const intent = bindMainModelRequestIntent({ relation: 'same_scope_continuation', action: 'research', evidenceRefs: requestIntentReferenceIds(context) }, context)
    assert.ok(intent, 'Goal-less continuation retains exact human evidence')
    let admitted: Awaited<ReturnType<CoreTasks['prepare']>> | undefined
    await assert.doesNotReject(async () => { admitted = await new CoreTasks(runtime).prepare({ requestId: 'continue-research', sessionId: 'core-native', turn: 1, task, cwd: root,
      capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }], requestIntent: intent, requestIntentContext: context, signal: new AbortController().signal }) },
    'a conversation continuation without any previous owned task must use new admission, never a nonexistent task resume')
    assert.ok(admitted?.admitted); assert.ok(admitted.authority)
    await runtime.withDatabase(db => {
      authorizeTaskLease(db, admitted!.authority!)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_coding_workflows').get<{ n: number }>()!.n, 0)
      const current = readTaskSnapshot(db, admitted!.authority!)
      requestTaskStop(db, current, { operation: 'wait', operationId: 'human-hold', expectedRevision: current.revision,
        expectedGeneration: current.generation, reason: 'Human explicitly holds the task', explicit: true, evidence: [] })
    })
    await runtime.close(); runtime = new DshCoreRuntime(configuration); await runtime.start()
    await assert.rejects(runtime.withDatabase(db => authorizeTaskLease(db, admitted!.authority!)), /stale|Working|stopped|authority/i)
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
})
