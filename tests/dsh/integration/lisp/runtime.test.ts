import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, realpath, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import type { DshUserQuestions } from '../../../../src/dsh/user-interaction.js'

test('real protected SBCL: state, CSV/JSON/regex, Python, deletion permissions, replay, cancellation and recovery', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires an OS sandbox and a working SBCL; not evidence when skipped' : false, timeout: 180000,
}, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'li-'))), root = join(base, 'workspace')
  await mkdir(root)
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db))
  let approval: 'allow' | 'deny' | 'skip' | 'throw' | 'mutate' | 'pending' = 'deny', questions = 0
  let answerLate: ((value: any) => void) | undefined, pendingQuestion: any
  const ui: DshUserQuestions = { ask: async request => {
    questions++
    if (approval === 'pending') { pendingQuestion = request.questions[0]; return new Promise(resolve => { answerLate = resolve }) }
    if (approval === 'throw') throw new Error('UI disconnected')
    if (approval === 'mutate') await writeFile(join(root, 'delete.txt'), 'changed during review')
    return { answers: [{ id: request.questions[0].id, selected: approval === 'skip' ? [] : [request.questions[0].options![approval === 'allow' || approval === 'mutate' ? 1 : 0]!.label] }] }
  } }
  const config = LispConfig.parse({ enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 })
  const ciRequests: unknown[] = []
  const options = { store, config, dataRoot: join(base, 'data'), questions: ui, ciCall: async (_owner: unknown, request: any) => {
    ciRequests.push(request)
    if (request.kind === 'list-runs') return { source: 'fixture', runs: [{ databaseId: 42 }] }
    if (request.kind === 'failed-log') return { source: 'fixture', runId: request.runId, log: 'failed log' }
    return { target: request.target, state: 'SUCCEEDED', code: 0, stdout: 'verified', stderr: '' }
  } }
  let manager = new LispManager(options)
  const owner = { sessionId: 'session', agentId: 'agent', root }
  const evaluate = (operationId: string, code: string, extra = {}) => manager.execute(owner, 'lisp_eval', { operationId, code, ...extra }) as Promise<any>
  try {
    await manager.start(); assert.equal((await manager.enable(owner) as any).state, 'READY')
    const firstCompile = (await manager.status(owner) as any).compilation
    assert.equal(firstCompile.reused, false)
    const bundlePath = join(options.dataRoot, 'compiled', firstCompile.key, 'runtime.fasl')
    const bundleInfo = await stat(bundlePath)
    for (const [index, action] of [
      `(with-open-file (out ${JSON.stringify(bundlePath)} :direction :output :if-exists :supersede) (write-string "bad" out))`,
      `(delete-file ${JSON.stringify(bundlePath)})`,
      `(with-open-file (out ${JSON.stringify(join(options.dataRoot, 'compiled', firstCompile.key, 'injected.fasl'))} :direction :output :if-does-not-exist :create) (write-string "bad" out))`,
    ].entries()) assert.equal((await evaluate(`cache-denial-${index}`, action)).ok, false)
    const pythonCache = await evaluate('python-cache-denial', `(kioku.process:python ${JSON.stringify(`open(${JSON.stringify(bundlePath)},"wb").write(b"bad")`)})`)
    assert.equal(pythonCache.ok, true); assert.notEqual(pythonCache.value.json.code, 0)
    assert.equal((await stat(bundlePath)).mtimeMs, bundleInfo.mtimeMs)
    assert.equal((await evaluate('one', '(defparameter *n* 7)')).ok, true)
    assert.match((await evaluate('two', '(incf *n*)')).value.printed, /8/)
    assert.equal((await evaluate('two', '(incf *n*)')).replay, true)
    assert.match((await evaluate('three', '*n*')).value.printed, /8/)
    assert.equal((await evaluate('two', '(incf *n* 2)')).code, 'ID_CONFLICT')
    const concurrent = evaluate('concurrent', '(progn (sleep 0.1) (incf *n*))')
    assert.equal((await evaluate('concurrent', '(progn (sleep 0.1) (incf *n*))')).code, 'IN_PROGRESS')
    assert.equal((await concurrent).ok, true)
    const printed = await evaluate('output', '(progn (write-line "visible-output") (finish-output) 42)')
    assert.match(printed.output.stdout, /visible-output/)
    const jsonl = await evaluate('jsonl', '(kioku.data:parse-jsonl (format nil "{~S:1}~%{~S:2}" "a" "a"))')
    assert.equal(jsonl.ok, true, JSON.stringify(jsonl))
    const artifact = await evaluate('artifact', '(progn (kioku.files:write-text (merge-pathnames "artifact.txt" (kioku.files:scratch)) "artifact") (kioku.objects:register-artifact "artifact.txt"))')
    assert.equal(artifact.ok, true, JSON.stringify(artifact)); assert.equal(await readFile(artifact.value.json.path, 'utf8'), 'artifact')
    const data = await evaluate('data', `(list (gethash "x" (kioku.data:parse-json ${JSON.stringify('{"x":42}')})) (kioku.data:read-csv "a,b") (kioku.data:regex-matches "[0-9]+" "x12"))`)
    assert.equal(data.ok, true, JSON.stringify(data)); assert.match(data.value.printed, /42/); assert.match(data.value.printed, /12/)
    const ciRuns = await evaluate('ci-runs', '(kioku.ci:list-runs :limit 3)')
    assert.equal(ciRuns.ok, true, JSON.stringify(ciRuns)); assert.match(JSON.stringify(ciRuns), /databaseId/)
    const ciLog = await evaluate('ci-log', '(kioku.ci:failed-log 42)')
    assert.equal(ciLog.ok, true, JSON.stringify(ciLog)); assert.match(JSON.stringify(ciLog), /failed log/)
    const ciVerify = await evaluate('ci-verify', '(kioku.ci:verify :typecheck)')
    assert.equal(ciVerify.ok, true, JSON.stringify(ciVerify)); assert.match(JSON.stringify(ciVerify), /SUCCEEDED/)
    const focused = await evaluate('ci-focused', '(kioku.ci:verify :test :script "test:unit")')
    assert.equal(focused.ok, true, JSON.stringify(focused))
    assert.equal((await evaluate('ci-invalid-run', '(kioku.ci:failed-log "other/repo")')).ok, false)
    assert.deepEqual(ciRequests, [{ kind: 'list-runs', limit: 3 }, { kind: 'failed-log', runId: '42' }, { kind: 'verify', target: 'typecheck' }, { kind: 'verify', target: 'test', script: 'test:unit' }])
    const missing = await evaluate('missing-input', '(+ 1 2)', { inputs: ['missing.ts'] })
    assert.equal(missing.code, 'INPUT_MISSING'); assert.match(missing.message, /missing.ts/)
    assert.doesNotMatch(missing.recovery, /\/kioku-lisp (?:status|recover)/)
    assert.equal((await evaluate('after-missing-input', '(+ 1 2)')).ok, true)
    const largeOutput = await evaluate('large-output', '(write-string (make-string 40000 :initial-element #\\a))')
    assert.equal(largeOutput.output.stdout.length, 40000, 'journal evidence is complete, not only the last 16 KiB')
    const page = await manager.execute(owner, 'lisp_inspect', { operationId: 'output-page', resultOperationId: 'large-output', section: 'stdout', offset: 39000, limit: 1000 }) as any
    assert.equal(page.data.length, 1000); assert.equal(page.nextOffset, null)
    const summary = await manager.execute(owner, 'lisp_status', {}) as any
    assert.equal(summary.operations.length, 10); assert.ok(summary.operationCount > 10); assert.equal(summary.nextOffset, 10)
    const helpers = await evaluate('helpers', `(let* ((root (kioku.files:scratch)) (source (merge-pathnames "helper.txt" root)) (link (merge-pathnames "helper-link.txt" root)))
      (kioku.files:write-text source (format nil "a1~%b2~%c3~%"))
      (assert (equalp #( "a1" "b2") (kioku.files:head-lines source :n 2)))
      (assert (equalp #( "b2" "c3") (kioku.files:tail-lines source :n 2)))
      (assert (= 3 (kioku.files:count-lines source)))
      (kioku.files:copy-scratch "helper.txt" "helper-copy.txt")
      (assert (equal (format nil "a1~%b2~%c3~%") (kioku.files:read-text (merge-pathnames "helper-copy.txt" root))))
      (assert (= 2 (length (kioku.files:grep-scratch "b2" :glob "helper*.txt"))))
      (assert (handler-case (progn (kioku.files:copy-scratch "../helper.txt" "bad.txt") nil) (error () t)))
      (assert (handler-case (progn (kioku.files:copy-scratch "helper.txt" "helper.txt") nil) (error () t)))
      (assert (kioku.process:result-ok? (kioku.process:run "python3" (list "-I" "-c" "import os,sys;os.symlink('helper.txt',os.path.join(sys.argv[1],'helper-link.txt'))" (namestring root)))))
      (assert (handler-case (progn (kioku.files:delete-scratch "helper-link.txt") nil) (error () t)))
      (delete-file link)
      (assert (equalp #( "a" "b") (kioku.data:uniq-lines '("a" "a" "b"))))
      (assert (equalp #( "a" "b" "c") (kioku.data:sort-lines '("c" "a" "b"))))
      (assert (equal "a,b" (kioku.data:join-lines '("a" "b") :separator ",")))
      (let* ((items (loop repeat 5000 collect "x")) (start (get-internal-real-time)))
        (assert (= 1 (length (kioku.data:uniq-lines items))))
        (format t "helpers-5000-ms=~D~%" (round (* 1000 (/ (- (get-internal-real-time) start) internal-time-units-per-second)))))
      (kioku.files:delete-scratch "helper-copy.txt")
      (kioku.files:delete-scratch "helper.txt")
      :helpers-ok)`)
    assert.equal(helpers.ok, true, JSON.stringify(helpers)); assert.match(helpers.output.stdout, /helpers-5000-ms=\d+/)
    assert.equal((await manager.execute(owner, 'lisp_inspect', { operationId: 'inspect', ref: data.value.ref }) as any).ok, true)
    assert.equal((await manager.execute(owner, 'lisp_describe', { operationId: 'describe', symbol: 'kioku.files:propose-delete' }) as any).ok, true)
    const python = await evaluate('python', '(kioku.process:python "print(6*7)")')
    assert.equal(python.ok, true, JSON.stringify(python)); assert.match(JSON.stringify(python), /42/)
    const startedJob = await evaluate('job-start', '(defparameter *job* (kioku.process:start-job "python3" (list "-I" "-c" "import time; time.sleep(30)")))')
    assert.equal(startedJob.ok, true, JSON.stringify(startedJob))
    const listedJobs = await evaluate('job-list', '(kioku.process:list-jobs)')
    assert.equal(listedJobs.ok, true, JSON.stringify(listedJobs))
    assert.match(JSON.stringify(listedJobs), /[0-9a-f]{8}-[0-9a-f-]{27}/i)
    assert.match(JSON.stringify(await evaluate('job-status', '(kioku.process:job-status *job*)')), /RUNNING/)
    assert.equal((await evaluate('job-cancel', '(kioku.process:cancel-job *job*)')).ok, true)
    const protectedFile = join(root, 'private.txt')
    await writeFile(protectedFile, 'private')
    const pythonGuard = `import os,socket,json\nr={}\ndef check(k,f):\n try:\n  f();r[k]="ALLOWED"\n except OSError as e:r[k]=e.errno\ncheck("delete",lambda:os.unlink(${JSON.stringify(protectedFile)}))\ncheck("write",lambda:open(${JSON.stringify(protectedFile)},"w"))\ncheck("tcp",lambda:socket.socket().connect(("127.0.0.1",1)))\ncheck("udp",lambda:socket.socket(socket.AF_INET,socket.SOCK_DGRAM).sendto(b"x",("127.0.0.1",1)))\ncheck("unix",lambda:socket.socket(socket.AF_UNIX).connect(${JSON.stringify(join(root, 'host.sock'))}))\nprint(json.dumps(r))`
    const guarded = await evaluate('python-guard', `(kioku.process:python (format nil ${JSON.stringify(pythonGuard.replaceAll('\n', '~%'))}))`)
    assert.equal(guarded.ok, true, JSON.stringify(guarded))
    assert.equal(guarded.value.json.code, 0, JSON.stringify(guarded))
    const denials = JSON.parse(guarded.value.json.stdout)
    for (const field of ['delete', 'write', 'tcp', 'udp', 'unix']) assert.notEqual(denials[field], 'ALLOWED', field)
    assert.equal(await readFile(protectedFile, 'utf8'), 'private')
    await writeFile(join(root, 'delete.txt'), 'preserve')
    const code = '(kioku.files:propose-delete "delete.txt")'
    for (const decision of ['deny', 'skip', 'throw'] as const) {
      approval = decision
      const result = await evaluate(decision, code)
      assert.equal(result.changes[0].state, 'NOT_APPLIED')
      assert.equal(await readFile(join(root, 'delete.txt'), 'utf8'), 'preserve')
    }
    approval = 'allow'
    const deleted = await evaluate('approved', code)
    assert.equal(deleted.changes[0].state, 'APPLIED')
    assert.equal(await readFile(deleted.changes[0].backup, 'utf8'), 'preserve')
    await assert.rejects(readFile(join(root, 'delete.txt')), { code: 'ENOENT' })
    const before = questions; assert.equal((await evaluate('approved', code)).replay, true); assert.equal(questions, before)
    // A filesystem receipt is not the completed parent operation. If the final
    // parent save fails, replay/recovery must preserve effects without success.
    const saveResult = store.transition.bind(store)
    let lostFinalResult = false
    store.transition = async (...args) => {
      if (args[1] === 'lost-final-result' && Array.isArray((args[4] as any)?.changes) && !lostFinalResult) {
        lostFinalResult = true; throw new Error('fixture: final summary unavailable')
      }
      return saveResult(...args)
    }
    const newFile = '(kioku.files:propose-write "receipt.txt" "applied once")'
    const lostSummary = await evaluate('lost-final-result', newFile)
    assert.equal(lostSummary.ok, false)
    assert.equal((await store.get(owner, 'lost-final-result'))!.state, 'UNKNOWN', 'parent must not appear completed when its final evidence was not committed')
    assert.equal(lostSummary.operationId, 'lost-final-result')
    assert.equal(lostSummary.changes[0].state, 'APPLIED')
    await manager.recover(owner)
    const replayedSummary = await evaluate('lost-final-result', newFile)
    assert.equal(replayedSummary.replay, true); assert.equal(replayedSummary.result.ok, false)
    assert.equal(replayedSummary.result.changes[0].state, 'APPLIED')
    assert.equal(await readFile(join(root, 'receipt.txt'), 'utf8'), 'applied once')
    store.transition = saveResult
    const restored = await manager.restore(owner, deleted.changes[0].id, new AbortController().signal) as any
    assert.equal(restored.state, 'APPLIED'); assert.equal(await readFile(join(root, 'delete.txt'), 'utf8'), 'preserve')
    await manager.recover(owner)
    const secondCompile = (await manager.status(owner) as any).compilation
    assert.equal(secondCompile.reused, true); assert.equal(secondCompile.key, firstCompile.key)
    assert.equal((await stat(bundlePath)).mtimeMs, bundleInfo.mtimeMs)
    const stale = await manager.execute(owner, 'lisp_inspect', {operationId:'stale-ref',ref:data.value.ref}) as any
    assert.equal(stale.ok, false); assert.match(stale.value, /STALE_REFERENCE/)
    approval = 'pending'
    const waiting = evaluate('late-approval', code)
    while (!answerLate) await new Promise(resolve => setTimeout(resolve, 10))
    await manager.execute(owner, 'lisp_cancel', {})
    const cancelledProposal = await waiting
    answerLate!({ answers: [{ id: pendingQuestion.id, selected: [pendingQuestion.options[1].label] }] })
    assert.equal(cancelledProposal.changes[0].state, 'NOT_APPLIED')
    assert.equal(await readFile(join(root, 'delete.txt'), 'utf8'), 'preserve')
    approval = 'deny'; await manager.recover(owner)
    const transition = store.transition.bind(store)
    let failedSave = false
    store.transition = async (...args) => {
      if (args[1] === 'lost-result' && args[3] === 'SUCCEEDED' && !failedSave) { failedSave = true; throw new Error('fixture: result storage unavailable') }
      return transition(...args)
    }
    assert.equal((await evaluate('lost-result', '(+ 20 22)')).ok, false)
    assert.equal((await manager.status(owner) as any).state, 'RECOVERY_REQUIRED')
    assert.equal((await store.get(owner, 'lost-result'))?.state, 'UNKNOWN')
    await manager.recover(owner)
    assert.equal((await evaluate('lost-result', '(+ 20 22)')).replay, true)
    let failedCommit = false
    store.transition = async (...args) => {
      if (args[3] === 'APPLIED' && !failedCommit) { failedCommit = true; throw new Error('fixture: apply commit unavailable') }
      return transition(...args)
    }
    approval = 'allow'
    assert.equal((await evaluate('lost-commit', code)).ok, false)
    await assert.rejects(readFile(join(root, 'delete.txt')), {code:'ENOENT'})
    const reconciliation = await manager.recover(owner) as any
    assert.equal(reconciliation.code, 'RECONCILIATION_REQUIRED')
    const unknown = reconciliation.operations.find((o: any) => o.id.startsWith('proposal-'))
    assert.equal(unknown.state, 'UNKNOWN')
    store.transition = transition
    await manager.abandon(owner, unknown.id)
    assert.equal((await manager.restore(owner, unknown.id, new AbortController().signal) as any).state, 'APPLIED')
    assert.equal(await readFile(join(root, 'delete.txt'), 'utf8'), 'preserve')
    await manager.recover(owner)
    const failed = await evaluate('condition', '(error "expected failure")'); assert.equal(failed.ok, false)
    assert.equal((await evaluate('after-condition', '(+ 1 2)')).ok, true)
    await writeFile(join(root, 'private.txt'), 'private')
    const bypass = await evaluate('bypass', `(delete-file ${JSON.stringify(join(root, 'private.txt'))})`)
    assert.equal(bypass.ok, false); assert.equal(await readFile(join(root, 'private.txt'), 'utf8'), 'private')
    const timeout = await evaluate('timeout', '(loop)', { timeoutMs: 100 })
    assert.equal(timeout.code, 'TIMEOUT')
    assert.equal((await manager.status(owner) as any).state, 'RECOVERY_REQUIRED')
    assert.equal((await evaluate('after-timeout', '(+ 1 2)')).code, 'RECOVERY_REQUIRED')
    await manager.recover(owner)
    assert.equal((await evaluate('after-recovery', '(+ 1 2)')).ok, true)
    const generation = (await manager.status(owner) as any).generation
    const cancelled = await manager.execute(owner, 'lisp_cancel', { operationId: 'cancel-id', generation }) as any
    assert.equal(cancelled.ok, true)
    await manager.recover(owner)
    assert.equal((await manager.execute(owner, 'lisp_cancel', { operationId: 'cancel-id', generation }) as any).replay, true)
    assert.equal((await manager.status(owner) as any).state, 'READY', 'replayed cancellation must not stop a new generation')
    const flood = await evaluate('flood', '(loop (write-string "01234567890123456789012345678901234567890123456789") (finish-output))')
    assert.equal(flood.code, 'OUTPUT_LIMIT')
    assert.equal((await manager.status(owner) as any).state, 'RECOVERY_REQUIRED')
    await manager.recover(owner)
    const broken = await evaluate('broken-frame', '(progn (write-line "not-json" kioku.internal::*wire*) (finish-output kioku.internal::*wire*) (loop))')
    assert.equal(broken.code, 'PROTOCOL_ERROR')
    assert.equal((await manager.execute(owner, 'lisp_describe', {operationId:'offline-docs'}) as any).source, 'bundled')
    await manager.recover(owner)
    await manager.dispose(); manager = new LispManager(options); await manager.start()
    assert.equal((await manager.status(owner) as any).state, 'RECOVERY_REQUIRED')
    assert.equal((await evaluate('one', '(defparameter *n* 7)')).replay, true)
    await manager.recover(owner)
    assert.equal((await manager.status(owner) as any).compilation.reused, true, 'host restart must reuse the compiled bundle')
    assert.equal((await stat(bundlePath)).mtimeMs, bundleInfo.mtimeMs)
    console.log(JSON.stringify({ coldPreparationMs: firstCompile.prepareMs, warmPreparationMs: secondCompile.prepareMs }))
    await manager.disable(owner)
    assert.equal((await manager.status(owner) as any).state, 'DISABLED')
  } finally { await manager.dispose(); db.close() }
})
