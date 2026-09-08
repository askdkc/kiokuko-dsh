import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openConnection } from '../../../src/db/connection.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { DshEnnoDelegation, childFileScopeDenial } from '../../../src/dsh/enno-delegation.js'
import { initializeExecutionSelection, readExecutionSelection, writeExecutionSelection } from '../../../src/dsh/execution-selection.js'
import { answerEnno, submitEnnoPlan, submitOdunoIdeal } from '../../../src/enno-oduno/service.js'
import { readEnnoSnapshot } from '../../../src/enno-oduno/store.js'
import type { DshDatabaseOperation } from '../../../src/dsh/runtime.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('delegation requires the live lease, limits Ollama concurrency, preserves child identity on reload and never accepts a WorkUnit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-delegation-'))
  const repo = join(root, 'repo'); await mkdir(repo); await writeFile(join(repo, 'source.txt'), 'before')
  const db = openConnection(join(root, 'state.sqlite3'))
  try {
    migrateDatabase(db, join(process.cwd(), 'migrations'))
    const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'kiokuko-single-purpose-functions' }]
    const task = await prepareAgentTask(db, { requestId: 'delegate-fixture', cwd: repo, task: 'Implement source.txt', profileHints: { taskType: 'build', target: 'source.txt', expected: 'verified' }, capabilities, dshSessionId: 'parent', skillDiscoveryMode: 'off' })
    const identity = { runId: task.run.runId, workspace: task.project.workspace, orchestrationId: task.intake.sessionId }
    submitOdunoIdeal(db, { ...identity, expectedRevision: 1, idempotencyKey: 'ideal', ideal: { objective: 'Implement source', principles: ['Verify'], skillContributions: [], successSignals: ['verified'] } })
    const verifier = { id: 'verify', kind: 'test', executable: process.execPath, args: ['--eval', 'process.exit(0)'], cwd: '.', timeoutMs: 1000 }
    await submitEnnoPlan(db, { ...identity, expectedRevision: 1, idempotencyKey: 'plan', scope: ['source.txt'], exclusions: [], acceptanceCriteria: [{ id: 'done', description: 'Verified' }],
      workPlan: { objective: 'Implement source', units: [{ id: 'unit', objective: 'Implement source', scope: ['source.txt'], dependencies: [], routes: ['code'], skillNames: ['kiokuko-single-purpose-functions'], expertRefs: [{ id: 'code.verification.v1', reason: 'Verify' }], acceptanceCriteria: ['Verified'], focusedVerifiers: [verifier] }] },
      skillRequirements: [], finalVerifiers: [verifier], maxAttempts: 3, capabilities,
      provenance: { scope: 'explicit_user', exclusions: 'explicit_user', acceptanceCriteria: 'explicit_user', workPlan: 'inferred', skillSet: 'repository_evidence', finalVerifiers: 'repository_evidence', maxAttempts: 'inferred' },
    })
    const approved = answerEnno(db, { ...identity, expectedRevision: 2, idempotencyKey: 'approve', action: 'approve' })
    const model = { provider: 'local-custom-name', model: 'qwen3-coder:30b' }
    initializeExecutionSelection(db, identity.runId)
    writeExecutionSelection(db, identity.runId, 0, { mode: 'enno', status: 'ready', configuration: { custom: false, template: { id: 'ollama', version: 1 }, maxConcurrentChildren: 1, roles: { ideal: model, zenki: model, goki: model, worker: model, check: model } } })
    const parent = { id: 'parent', session: { id: 'parent', header: { cwd: repo } } }
    const child = { id: 'child', session: { id: 'child', header: { cwd: repo } } }
    const finished = deferred<{ output: unknown; stopReason: string }>()
    const started = deferred<void>()
    let starts = 0
    const runtime = { withDatabase: async <T>(fn: DshDatabaseOperation<T>): Promise<T> => fn(db, undefined as never) }
    const delegation = new DshEnnoDelegation(runtime, { start: async (backend, request) => {
      starts++; assert.equal(backend, 'spawn'); assert.deepEqual(request.agentOptions, model); assert.equal(request.maxDepth, 1)
      assert.deepEqual(request.toolFilter.allow, ['read', 'write'])
      delegation.created(child); await delegation.restoreOrPersist(child); started.resolve()
      return { id: 'child', localAgent: child, result: finished.promise, dispose: async () => {} }
    } })
    const binding = { ...identity, dshSessionId: 'parent', revision: 2, routeEpoch: approved.executionLease!.routeEpoch, leaseToken: approved.executionLease!.leaseToken, workUnitId: 'unit', idempotencyKey: 'delegate-1' }
    const signal = new AbortController().signal
    await assert.rejects(delegation.execute(parent, { instruction: 'Inspect' }, { ...binding, leaseToken: 'wrong' }, ['read'], signal), /lease/u)
    const pending = delegation.execute(parent, { instruction: 'Inspect' }, binding, ['read', 'write', 'bash', 'enno_delegate'], signal)
    await started.promise
    const reloadedActive = new DshEnnoDelegation(runtime, { start: async () => { throw new Error('Must not start another child') } })
    await assert.rejects(reloadedActive.execute(parent, { instruction: 'After reload' }, { ...binding, idempotencyKey: 'delegate-reload' }, ['read'], signal), /concurrency/u)
    await delegation.assertCurrent(child)
    db.prepare("UPDATE dsh_enno_delegations SET authority_json = json_set(authority_json, '$.leaseToken', 'stale') WHERE delegation_id = ?").run(binding.idempotencyKey)
    await assert.rejects(delegation.assertCurrent(child), /lease/u)
    db.prepare("UPDATE dsh_enno_delegations SET authority_json = json_set(authority_json, '$.leaseToken', ?) WHERE delegation_id = ?").run(binding.leaseToken, binding.idempotencyKey)
    await assert.rejects(delegation.execute(parent, { instruction: 'Other work' }, { ...binding, idempotencyKey: 'delegate-2' }, ['read'], signal), /concurrency/u)
    await assert.rejects(delegation.execute(child, { instruction: 'Grandchild' }, binding, ['read'], signal), /grandchildren/u)
    finished.resolve({ output: [{ type: 'text', text: 'Verified evidence' }], stopReason: 'completed' })
    const result = await pending as { accepted: boolean }
    assert.equal(result.accepted, false)
    assert.notEqual(readEnnoSnapshot(db, identity).workUnits[0]?.status, 'completed')
    assert.deepEqual(await delegation.execute(parent, { instruction: 'Inspect' }, binding, ['read', 'write'], signal), result)
    assert.equal(starts, 1)
    const restored = new DshEnnoDelegation(runtime, undefined)
    assert.deepEqual(await restored.restoreOrPersist(child), model)
    assert.equal(restored.isChild(child), true)
    await assert.rejects(restored.assertCurrent(child), /no longer active/u)
    assert.match(restored.toolDenial(child, 'enno_delegate', {})!, /scope/u)
    assert.equal(readExecutionSelection(db, identity.runId)?.value.configuration?.template?.version, 1)
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})
test('child file boundary rejects traversal, sibling writes, in-repository symlink escapes and arbitrary shells', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'kiokuko-child-scope-'))
  const root = await realpath(temporary)
  try {
    await mkdir(join(root, 'src')); await mkdir(join(root, 'docs')); await symlink(join(root, 'docs'), join(root, 'src/link'))
    assert.equal(childFileScopeDenial(root, ['src'], 'write', { file_path: 'src/file.ts' }), undefined)
    assert.ok(childFileScopeDenial(root, ['src'], 'write', { file_path: 'docs/file.md' }))
    assert.ok(childFileScopeDenial(root, ['src'], 'write', { file_path: 'src/link/file.md' }))
    assert.ok(childFileScopeDenial(root, ['src'], 'read', { file_path: '../outside' }))
    assert.ok(childFileScopeDenial(root, ['src'], 'bash', { command: 'touch outside' }))
  } finally { await rm(root, { recursive: true, force: true }) }
})
