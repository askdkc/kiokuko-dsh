import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { workingLispTask } from '../../helpers/lisp-task.js'
import { requestTaskStop } from '../../../../src/dsh/task-state.js'
import { digest, LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { DecisionService } from '../../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import { TypeSafeDecisionProvider } from '../../../../src/dsh/decisions/providers.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'

// The lexical value exists only at the failure point. Incrementing before ERROR
// makes any replay visible independently of whether the chosen result is correct.
const expression = (timeout = 1000, effect = false) => `(let ((local 41))
  (handler-bind ((simple-error (lambda (condition)
    (kioku.recovery:select-restart condition (kioku.internal:object "local" local "effectCount" *effects*)
      '((use-local "Use captured local value") (discard "Return an empty value")) :timeout-ms ${timeout}))))
    (restart-case (progn (incf *effects*) (error "synthetic missing value"))
      (use-local () ${effect ? '(kioku.tools:call-tool "kioku_write" (kioku.internal:object "path" "continuation-marker" "content" "synthetic"))' : ''} (+ local 1)) (discard () -1))))`

for (const executionMode of ['development', 'protected'] as const) test(`real SBCL ${executionMode} recovery: live lexical state, single effect, failure modes and no UNKNOWN replay`, {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires the existing local SBCL runtime' : false, timeout: 180000,
}, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-recovery-'))), root = join(base, 'work'); await mkdir(root)
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  const owner = { sessionId: 'session', agentId: 'agent', root }, task = workingLispTask(db, owner)
  let hostEffects = 0
  let calls = 0, mode = 'selected', began!: () => void, late!: (value: unknown) => void, pendingBatch: any
  let providerSignal: AbortSignal | undefined
  const response = (batch: any) => ({ status: 'completed', result: { answers: [{ id: batch.questions[0].id, status: 'selected', choiceId: batch.questions[0].choices[0].id }] } })
  const decisionConfig = TypedDecisionsConfig.parse({})
  const decisionService = new DecisionService(decisionConfig, () => new TypeSafeDecisionProvider(decisionConfig.typesafe, async () => 'fixture-only', async (_url, options) => {
    const body = JSON.parse(String(options!.body))
    return Response.json({ model: body.model, answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      const keys = Object.keys(q.criteria), choice = keys[0]
      return [id, { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])), confidence: 1 }]
    })) })
  }))
  const manager = new LispManager({ store: new LispStore(async fn => fn(db)), dataRoot: join(base, 'data'),
    config: LispConfig.parse({ enabled: true, executionMode, startupTimeoutMs: 60000 }),
    toolCall: async (_owner, name) => { assert.equal(name, 'kioku_write'); hostEffects++; await writeFile(join(root, 'continuation-marker'), 'observed'); return { applied: true } },
    decisionCall: async (_owner, _method, batch: any, context) => {
      calls++; providerSignal = context.signal; pendingBatch = batch
      assert.equal(batch.state.context.local, 41)
      if (mode === 'typed') return decisionService.evaluate(context.evaluationId, batch, context.signal)
      if (mode === 'hang') { began(); return new Promise(resolve => { late = resolve }) }
      if (mode === 'abstain') return { status: 'completed', result: { answers: [{ id: batch.questions[0].id, status: 'abstained', reason: 'uncertain' }] } }
      if (mode === 'stale') return response({ questions: [{ id: 'old', choices: [{ id: 'old/0' }] }] })
      if (mode === 'error') throw new Error('provider unavailable')
      if (mode === 'unknown-late') db.prepare('INSERT INTO dsh_owned_operations VALUES(?,?,?,?,?,?,?,?)').run('unknown-owned', task.taskId, owner.sessionId, 'synthetic', digest({ synthetic: true }), 'unknown', '{}', new Date().toISOString())
      if (mode === 'revoke') requestTaskStop(db, { taskId: task.taskId, sessionId: owner.sessionId, repositoryRoot: root },
        { operation: 'wait', operationId: 'pause-recovery', expectedRevision: task.revision, reason: 'revoke while model selects', evidence: [] })
      return response(batch)
    } })
  const run = (operationId: string, code: string, extra = {}, signal?: AbortSignal) => manager.execute(owner, 'lisp_eval', { operationId, code, ...extra }, signal) as Promise<any>
  try {
    await manager.start(); assert.equal((await manager.enable(owner) as any).state, 'READY')
    assert.equal((await run('init', '(defparameter *effects* 0)')).ok, true)
    const recovered = await run('recover-live', expression())
    assert.equal(recovered.ok, true, JSON.stringify(recovered)); assert.equal(recovered.value.json, 42)
    assert.equal((await run('recover-live', expression())).replay, true); assert.equal(calls, 1)
    assert.equal((await run('count', '*effects*')).value.json, 1)
    for (const failure of ['abstain', 'stale', 'error']) {
      mode = failure; const failed = await run(`failure-${failure}`, expression())
      assert.equal(failed.ok, false, JSON.stringify(failed)); assert.equal((await manager.status(owner) as any).state, 'READY')
    }
    mode = 'hang'
    let started = new Promise<void>(resolve => { began = resolve })
    let pending = run('deadline', expression(100)); await started
    const deadlineResult = await pending
    assert.equal(deadlineResult.ok, false); assert.match(String(deadlineResult.value), /RECOVERY_TIMEOUT/); assert.equal(providerSignal!.aborted, true)
    late(response(pendingBatch))
    assert.equal((await run('after-deadline', '*effects*')).value.json, 5)
    const abort = new AbortController(); started = new Promise<void>(resolve => { began = resolve })
    pending = run('cancel', expression(), {}, abort.signal); await started; abort.abort()
    assert.equal((await pending).state, 'UNKNOWN'); assert.equal(providerSignal!.aborted, true)
    const beforeReplay = calls; assert.equal((await run('cancel', expression())).replay, true); assert.equal(calls, beforeReplay)
    late(response(pendingBatch)); assert.equal((await manager.status(owner) as any).state, 'RECOVERY_REQUIRED')
    await manager.recover(owner)
    assert.equal((await run('heap-lost', '(boundp (quote *effects*))')).value.json, null)
    await run('init-new', '(defparameter *effects* 0)')
    // The original ticket cannot survive a worker generation change.
    mode = 'typed'
    const typed = await run('typed-contract', expression())
    assert.equal(typed.ok, true, JSON.stringify(typed)); assert.equal(typed.value.json, 42)
    const effectful = await run('effectful-control', expression(1000, true))
    assert.equal(effectful.ok, true, JSON.stringify(effectful)); assert.equal(hostEffects, 1)
    assert.equal(await readFile(join(root, 'continuation-marker'), 'utf8'), 'observed')
    await unlink(join(root, 'continuation-marker')); hostEffects = 0
    await run('typed-cleanup', '(setf *effects* 0)')
    const eight = Array.from({ length: 8 }, (_, i) => `r${i}`)
    const atChoiceLimit = await run('eight-live-restarts', `(handler-bind ((simple-error (lambda (condition) (kioku.recovery:select-restart condition (kioku.internal:object "local" 41) '(${eight.map(name => `(${name} "Continue with ${name}")`).join(' ')}))))) (restart-case (error "synthetic") ${eight.map((name, i) => `(${name} () ${i + 1})`).join(' ')}))`)
    assert.equal(atChoiceLimit.ok, true, JSON.stringify(atChoiceLimit)); assert.equal(atChoiceLimit.value.json, 1)
    const beforeInvalid: number = calls
    for (const [index, choices] of ["()", "((use-local \"one\") (use-local \"duplicate\"))", "((absent \"missing\"))", `(${Array.from({ length: 9 }, () => '(use-local "too many")').join(' ')})`].entries()) {
      const invalid = await run(`invalid-restarts-${index}`, `(handler-bind ((simple-error (lambda (condition) (kioku.recovery:select-restart condition (kioku.internal:object "local" 41) '${choices})))) (restart-case (error "synthetic") (use-local () 42)))`)
      assert.equal(invalid.ok, false)
    }
    assert.equal(calls, beforeInvalid)
    const store = new LispStore(async fn => fn(db))
    await store.reserve(owner, 'unknown-effect', 'proposal', digest({ synthetic: true }), 'old-generation', {})
    await store.transition(owner, 'unknown-effect', ['RUNNING'], 'UNKNOWN', { synthetic: true })
    const beforeUnknown: number = calls
    const unknown = await run('unknown-must-not-select', expression())
    assert.equal(unknown.ok, false); assert.match(String(unknown.value), /RECOVERY_UNCERTAIN/); assert.equal(calls, beforeUnknown)
    await store.transition(owner, 'unknown-effect', ['UNKNOWN'], 'ABANDONED', { reexecuted: false })
    await run('unknown-cleanup', '(setf *effects* 0)')
    mode = 'unknown-late'
    const becameUnknown = await run('unknown-after-model', expression(1000, true))
    assert.equal(becameUnknown.ok, false); assert.match(String(becameUnknown.value), /RECOVERY_UNCERTAIN/); assert.equal(hostEffects, 0)
    const callsAtUnknown: number = calls
    const stillUnknown = await run('unknown-before-model', expression(1000, true))
    assert.equal(stillUnknown.ok, false); assert.equal(calls, callsAtUnknown); assert.equal(hostEffects, 0)
    db.prepare("UPDATE dsh_owned_operations SET state='completed' WHERE operation_id='unknown-owned'").run()
    await run('unknown-owned-cleanup', '(setf *effects* 0)')
    for (const boundary of ['evaluation-timeout', 'worker-death']) {
      mode = 'hang'; started = new Promise<void>(resolve => { began = resolve })
      pending = run(boundary, expression(30000, true), boundary === 'evaluation-timeout' ? { timeoutMs: 200 } : {})
      await started
      if (boundary === 'worker-death') {
        const pid = (await manager.status(owner) as any).supervisorPid
        assert.ok(Number.isInteger(pid) && pid > 1); process.kill(pid, 'SIGTERM') // this fixture's worker only
      }
      assert.equal((await pending).state, 'UNKNOWN'); assert.equal(providerSignal!.aborted, true)
      const callsBeforeReplay: number = calls
      assert.equal((await run(boundary, expression(30000, true), boundary === 'evaluation-timeout' ? { timeoutMs: 200 } : {})).replay, true)
      assert.equal(calls, callsBeforeReplay)
      assert.equal((await manager.status(owner) as any).state, 'RECOVERY_REQUIRED')
      await manager.recover(owner); await run(`init-${boundary}`, '(defparameter *effects* 0)')
      late(response(pendingBatch))
      assert.equal((await run(`late-no-effect-${boundary}`, '*effects*')).value.json, 0)
      assert.equal(hostEffects, 0); await assert.rejects(readFile(join(root, 'continuation-marker')), { code: 'ENOENT' })
    }
    mode = 'stale'; assert.equal((await run('old-generation', expression())).ok, false)
    mode = 'revoke'; const revoked = await run('task-revoked', expression())
    assert.equal(revoked.ok, false); assert.match(JSON.stringify(revoked), /stale or stopped/)
    assert.equal((await run('revoked-count', '*effects*')).value.json, 2)
    const callsAtRevocation: number = calls
    assert.equal((await run('already-revoked', expression(1000, true))).ok, false)
    assert.equal(calls, callsAtRevocation); assert.equal(hostEffects, 0)
  } finally { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})
