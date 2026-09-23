import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig, renderResult, RESULT_BYTES } from '../../../../src/dsh/lisp/contracts.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { createLispCiAdapter } from '../../../../src/dsh/lisp/ci.js'
import { renderHistoryResult } from '../../../../src/dsh/lisp/model-result.js'

test('protected Lisp project: Node startup, scratch cwd, exact approved npm test, replay and failure evidence', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL and Node' : false, timeout: 180000,
}, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-project-'))), root = join(base, 'workspace')
  await mkdir(root)
  const db = new NodeSqliteAdapter(join(base, 'state.sqlite3'), new DatabaseSync(join(base, 'state.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db)), owner = { sessionId: 'session', agentId: 'agent', root }
  let approvals = 0, approve = true
  const observedWorkspace: Array<{operationId:string;generation:string;state:unknown}> = []
  const adapter = createLispCiAdapter({ ask: async request => {
    approvals++
    assert.match(request.questions[0]!.detail!, /npm test/u)
    assert.match(request.questions[0]!.detail!, /scratch\/project|workspace/u)
    return { answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.options![approve ? 1 : 0]!.label] }] }
  } })
  const manager = new LispManager({ store, config: LispConfig.parse({ enabled: true, startupTimeoutMs: 60000 }),
    dataRoot: join(base, 'data'), ciCall: adapter,
    verifiedCall: async (_owner, operationId, generation, request, result) => {
      if (request.kind === 'verify' && request.location !== 'scratch')
        observedWorkspace.push({operationId,generation,state:(result as {state?:unknown}).state})
    } })
  const evaluate = (operationId: string, code: string) => manager.execute(owner, 'lisp_eval', { operationId, code }) as Promise<any>
  const put = (path: string, text: string) => `(let ((p (merge-pathnames ${JSON.stringify(path)} (kioku.files:scratch)))) (ensure-directories-exist p) (kioku.files:write-text p ${JSON.stringify(text)}))`
  try {
    await manager.start(); await manager.enable(owner)
    const described = await manager.execute(owner, 'lisp_describe', { operationId: 'describe-files', symbol: 'kioku.files' }) as any
    assert.equal(described.ok, true, JSON.stringify(described))
    assert.ok(described.value.symbols.includes('kioku.files:copy-scratch'))
    // Reproduce the reported project layout and npm command with a synthetic
    // fixture; no source from the uploaded session is evaluated.
    const fixture = await evaluate('fixture', [
      put('project/package.json', JSON.stringify({ type: 'module', scripts: { test: 'node --test test/*.test.mjs' } })),
      put('project/src/index.mjs', 'export const value = 42;'),
      put('project/test/public.test.mjs', 'import test from "node:test"; import assert from "node:assert/strict"; import { value } from "../src/index.mjs"; test("value", () => assert.equal(value, 42));'),
      '(namestring (kioku.files:scratch))',
    ].join('\n'))
    assert.equal(fixture.ok, true, JSON.stringify(fixture))
    const scratch = fixture.value.json
    const nodeVersion = await evaluate('broker-node-version', '(kioku.process:run "node" (list "--version"))')
    assert.equal(nodeVersion.value.json.code, 0, JSON.stringify(nodeVersion))
    t.diagnostic(`Host Node ${process.version}; protected broker Node ${nodeVersion.value.json.stdout.trim()}`)
    const historySource = await evaluate('history-profile', `(progn (defparameter *history-retained* 42)
      (kioku.process:run "node" (list "-e" "process.stdout.write('old output '.repeat(800))")))`)
    const originalHistoryRow = (await store.get(owner, 'history-profile'))!.result
    const historyText = renderHistoryResult(renderResult(historySource))
    assert.ok(historyText, 'supported display data must fit the history profile')
    const historyResult = JSON.parse(historyText), { tool: historyTool, ...historyHint } = historyResult.inspect
    assert.equal(historyResult.value.json.code, 0)
    const historyPage = await manager.execute(owner, historyTool, { operationId: 'inspect-history-profile', ...historyHint }) as any
    assert.equal(historyPage.data, Array.from(historySource.value.json.stdout).slice(0, 2000).join(''))
    assert.equal((await store.get(owner, 'history-profile'))!.result, originalHistoryRow)
    assert.equal((await evaluate('history-runtime-preserved', '*history-retained*')).value.json, 42)
    const failedPipeline = await evaluate('failed-composed-prerequisite', `(progn
      (kioku.process:run-lines "node" (list "-e" "process.stdout.write('partial');process.stderr.write('prerequisite failed');process.exit(3)"))
      (kioku.files:write-text (merge-pathnames "project/src/index.mjs" (kioku.files:scratch)) "must not write"))`)
    assert.equal(failedPipeline.ok, false, 'run-lines must stop a composed operation on a failed process')
    assert.match(failedPipeline.value, /PROGRAM_FAILED\(3\).*prerequisite failed/u)
    assert.equal(await readFile(join(scratch, 'project/src/index.mjs'), 'utf8'), 'export const value = 42;')
    const helpers = await evaluate('composed-process-helpers', `(progn
      (assert (not (kioku.process:result-ok? (make-hash-table))))
      (assert (not (kioku.process:result-ok? (kioku.data:parse-json "{\\\"code\\\":null}"))))
      (assert (equalp #("line") (kioku.process:run-lines "node" (list "-e" "process.stdout.write('line')") :directory "project")))
      (assert (search "package.json" (kioku.process:python-stdout "import os; print(os.listdir('.'))" :directory "project")))
      (assert (search "/project" (kioku.process:shell-stdout "pwd" :directory "project")))
      :helpers-ok)`)
    assert.equal(helpers.ok, true, JSON.stringify(helpers))
    for (const [index, code] of [
      '(kioku.process:python-stdout "import sys; sys.stderr.write(\'literal ~A\'); sys.exit(2)" :directory "project")',
      '(kioku.process:shell-stdout "printf \'literal ~A\' >&2; exit 2" :directory "project")',
    ].entries()) {
      const failure = await evaluate(`output-helper-failure-${index}`, code)
      assert.equal(failure.ok, false); assert.match(failure.value, /FAILED.*literal ~A/u)
    }
    const run = '(kioku.process:run "node" (list "--test" "--experimental-test-isolation=none" "test/public.test.mjs") :directory "project")'
    const tests = await evaluate('protected-tests', run)
    assert.equal(tests.ok, true, JSON.stringify(tests)); assert.equal(tests.value.json.code, 0, JSON.stringify(tests))
    assert.match(tests.value.json.stdout, /pass 1/u)
    const nonzero = await evaluate('nonzero', '(kioku.process:run "node" (list "-e" "process.exit(7)") :directory "project")')
    assert.equal(nonzero.value.json.code, 7, 'successful evaluation must retain the failed process exit code')
    for (const [index, directory] of ['../workspace', root].entries()) {
      const denied = await evaluate(`invalid-directory-${index}`, `(kioku.process:run "node" (list "-e" "throw 0") :directory ${JSON.stringify(directory)})`)
      assert.equal(denied.ok, false); assert.match(denied.value, /相対パス/u)
    }
    await symlink(root, join(scratch, 'outside'))
    assert.equal((await evaluate('symlink-directory', '(kioku.process:run "node" (list "-e" "throw 0") :directory "outside")')).ok, false)
    const verify = '(kioku.ci:verify :test :location :scratch :directory "project")'
    approve = false
    const refused = await evaluate('refused', verify)
    assert.equal(refused.value.json.state, 'NOT_APPLIED')
    approve = true
    const verified = await evaluate('npm-test', verify)
    assert.equal(verified.ok, true, JSON.stringify(verified)); assert.equal(verified.value.json.state, 'SUCCEEDED', JSON.stringify(verified))
    assert.equal(verified.value.json.code, 0); assert.equal(verified.value.json.cwd, join(scratch, 'project'))
    assert.match(verified.value.json.stdout, /pass 1/u)
    assert.equal((await evaluate('npm-test', verify)).replay, true); assert.equal(approvals, 2)
    await writeFile(join(root, 'package.json'), JSON.stringify({scripts:{test:'node -e "process.exit(0)"'}}))
    const workspaceVerify = '(kioku.ci:verify :test :location :workspace)'
    const workspaceResult = await evaluate('workspace-verify', workspaceVerify)
    assert.equal(workspaceResult.value.json.state, 'SUCCEEDED')
    assert.equal(observedWorkspace.length, 1, JSON.stringify(workspaceResult))
    assert.equal(observedWorkspace[0]?.operationId, 'workspace-verify')
    assert.equal(observedWorkspace[0]?.state, 'SUCCEEDED')
    assert.equal((await evaluate('workspace-verify', workspaceVerify)).replay, true)
    assert.equal(observedWorkspace.length, 1, 'replay cannot create a second observed verification')
    await evaluate('break-test', put('project/src/index.mjs', 'export const value = 0;'))
    const failed = await evaluate('npm-test-fails', verify)
    assert.equal(failed.value.json.state, 'FAILED'); assert.notEqual(failed.value.json.code, 0)

    // Real protected npm -> CI broker -> SBCL return -> journal -> model -> inspect.
    const diagnostic = 'src/cache.ts(48,17): error TS2345: middle\r\n'
    const verifierLog = 'normal line\r\n'.repeat(1000) + diagnostic + 'normal line\r\n'.repeat(1000)
    const logScript = `import{appendFileSync,writeSync}from'node:fs';appendFileSync('runs.txt','1');writeSync(1,${JSON.stringify(verifierLog)});writeSync(2,${JSON.stringify(verifierLog)});process.exitCode=2;`
    await evaluate('diagnostic-fixture', [put('project/logs.mjs', logScript),
      put('project/package.json', JSON.stringify({ type: 'module', scripts: { test: 'node logs.mjs' } }))].join('\n'))
    const printAndVerify = `(progn (dotimes (i 2000) (format *error-output* "Lisp printing~%")) ${verify})`
    const diagnosticResult = await evaluate('diagnostic-verifier', printAndVerify)
    assert.equal(diagnosticResult.ok, true, JSON.stringify(diagnosticResult))
    assert.equal(diagnosticResult.value.json.code, 2)
    assert.equal(diagnosticResult.value.json.stderr, verifierLog)
    assert.ok(diagnosticResult.value.json.stdout.endsWith(verifierLog)) // npm adds its script header.
    const journalBefore = (await store.get(owner, 'diagnostic-verifier'))!.result
    const replayed = await evaluate('diagnostic-verifier', printAndVerify)
    assert.equal(replayed.replay, true)
    assert.equal(await readFile(join(scratch, 'project/runs.txt'), 'utf8'), '1')
    for (const result of [diagnosticResult, replayed]) {
      const rendered = renderResult(result), visible = JSON.parse(rendered)
      assert.ok(Buffer.byteLength(rendered) <= RESULT_BYTES)
      assert.equal(visible.value.json.state, 'FAILED'); assert.equal(visible.value.json.code, 2)
      for (const stream of ['stdout', 'stderr']) assert.ok(visible.value.json[stream].diagnostics.some((e: any) => e.text.includes(diagnostic)))
      const excerpts = ['stdout', 'stderr'].flatMap(stream => visible.value.json[stream].diagnostics)
      for (const template of [visible.inspect, ...excerpts.map((e: any) => e.inspect)]) {
        const { tool, ...hint } = template
        assert.equal(tool, 'lisp_inspect')
        assert.equal(hint.section, 'result')
        assert.ok(['/value/json/stdout', '/value/json/stderr'].includes(hint.pointer))
        const stream = hint.pointer.split('/').at(-1), original = diagnosticResult.value.json[stream]
        const page = await manager.execute(owner, tool, { operationId: 'inspect-diagnostic', ...hint }) as any
        assert.equal(page.data, Array.from(original).slice(hint.offset, hint.offset + 2000).join(''))
        assert.ok(page.data.includes(diagnostic))
      }
    }
    assert.equal((await store.get(owner, 'diagnostic-verifier'))!.result, journalBefore)

    // Assert the JSON encoding size inside actual SBCL before evaluate-code applies its strict limit.
    for (const size of [524287, 524288]) {
      const result = await evaluate(`json-boundary-${size}`, `(let ((r (make-hash-table :test 'equal)))
        (setf (gethash "state" r) "FAILED" (gethash "code" r) 2
              (gethash "stderr" r) "" (gethash "stdout" r) (format nil "~%error TS1: boundary~%"))
        (let* ((base (length (sb-ext:string-to-octets (kioku.data:encode-json r) :external-format :utf-8)))
               (padding (- ${size} base)))
          (setf (gethash "stdout" r) (concatenate 'string (make-string (floor padding 2) :initial-element #\\x)
            (gethash "stdout" r) (make-string (- padding (floor padding 2)) :initial-element #\\x))))
        (let ((bytes (length (sb-ext:string-to-octets (kioku.data:encode-json r) :external-format :utf-8))))
          (assert (= bytes ${size})) (format t "encoded-bytes=~D~%" bytes)) r)`)
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.match(result.output.stdout, new RegExp(`encoded-bytes=${size}`))
      const rendered = renderResult(result)
      if (size < 524288) {
        assert.equal(Buffer.byteLength(JSON.stringify(result.value.json)), size)
        assert.match(rendered, /"diagnostics":/u)
      } else {
        assert.equal(result.value.json, null)
        assert.doesNotMatch(rendered, /"diagnostics":|\/value\/json\/(?:stdout|stderr)/u)
      }
    }
    const largeStream = 'x'.repeat(300 * 1024)
    // Construct large script in scratch without sending it as one oversized eval request.
    await evaluate('large-log-fixture', put('project/logs.mjs', "import{writeSync}from'node:fs';const log='x'.repeat(300*1024);writeSync(1,log);writeSync(2,log);process.exitCode=2;"))
    assert.ok(Buffer.byteLength(JSON.stringify({ code: 2, state: 'FAILED', stdout: largeStream, stderr: largeStream })) > 524288)
    const missingLogs = await evaluate('oversize-verifier', `(let ((r ${verify}))
      (assert (>= (length (gethash "stdout" r)) (* 300 1024)))
      (assert (= (length (gethash "stderr" r)) (* 300 1024)))
      (let ((bytes (length (sb-ext:string-to-octets (kioku.data:encode-json r) :external-format :utf-8))))
        (assert (> bytes 524288)) (format t "oversize-bytes=~D~%" bytes)) r)`)
    assert.equal(missingLogs.ok, true, JSON.stringify(missingLogs))
    assert.equal(missingLogs.value.json, null)
    assert.match(missingLogs.output.stdout, /oversize-bytes=6[0-9]{5}/u)
    assert.doesNotMatch(renderResult(missingLogs), /"diagnostics":|\/value\/json\/(?:stdout|stderr)/u)
    // Restore the original test command before exercising the published toolkit.
    await evaluate('restore-project-test', put('project/package.json', JSON.stringify({ type: 'module', scripts: { test: 'node --test test/*.test.mjs' } })))

    // Execute the published example itself: three reusable functions, then one
    // call which reads, validates, edits and checks without model round trips.
    const skill = await readFile(new URL('../../../../skills/kiokuko-lisp/SKILL.md', import.meta.url), 'utf8')
    const example = skill.slice(skill.indexOf('## Task toolkit example'))
    const [definitions, invocation] = [...example.matchAll(/```lisp\n([\s\S]*?)\n```/gu)].map(match => match[1]!)
    assert.ok(definitions && invocation, 'the documented toolkit must remain executable')
    const describe = (id: string, symbol: string) => manager.execute(owner, 'lisp_describe', { operationId: id, symbol }) as Promise<any>
    assert.deepEqual((await describe('empty-task-tools', 'kioku.user')).value.symbols, [])
    const repaired = await evaluate('compose-and-repair', `${definitions}\n${invocation}`)
    assert.equal(repaired.ok, true, JSON.stringify(repaired)); assert.equal(repaired.value.json.code, 0, JSON.stringify(repaired))
    assert.match(repaired.value.json.stdout, /pass 1/u)
    assert.equal(await readFile(join(scratch, 'project/src/index.mjs'), 'utf8'), 'export const value = 42;')
    const catalog = await describe('task-tools', 'kioku.user')
    assert.deepEqual(catalog.value.symbols, ['kioku.user::check-project', 'kioku.user::repair-and-check', 'kioku.user::replace-once'])
    const detail = await describe('repair-docs', 'kioku.user::repair-and-check')
    assert.equal(detail.ok, true, JSON.stringify(detail))
    assert.match(detail.value.arguments, /DIRECTORY FILE BEFORE AFTER/iu)
    assert.match(detail.value.documentation, /failed tests leave the edit visible/u)
    assert.equal((await describe('short-name', 'replace-once')).ok, true)
    for (const [index, symbol] of ['cl:delete-file', 'kioku.internal:rpc', 'missing-task', 'check-project (delete-file "x")', '#.(error "must-not-run")'].entries()) {
      assert.equal((await describe(`invalid-tool-${index}`, symbol)).ok, false)
    }
    assert.equal(await readFile(join(scratch, 'project/src/index.mjs'), 'utf8'), 'export const value = 42;', 'discovery must never invoke a task function')
    const brokenAgain = await evaluate('reuse-repair', '(repair-and-check "project" "src/index.mjs" "42" "0")')
    assert.equal(brokenAgain.ok, true); assert.notEqual(brokenAgain.value.json.code, 0)
    const baseline = await evaluate('reuse-check', '(check-project "project")')
    assert.equal(baseline.ok, true); assert.notEqual(baseline.value.json.code, 0)
    for (const [index, before] of ['', 'missing', 't'].entries()) {
      const rejected = await evaluate(`bad-replacement-${index}`, `(repair-and-check "project" "src/index.mjs" ${JSON.stringify(before)} "42")`)
      assert.equal(rejected.ok, false)
      assert.equal(await readFile(join(scratch, 'project/src/index.mjs'), 'utf8'), 'export const value = 0;')
    }
    await evaluate('other-definitions', '(defparameter *not-a-tool* 1) (defmacro task-identity (x) x) (defun |Case Sensitive| () 9) (import \'kioku.files:read-text)')
    const otherTools = await describe('other-task-tools', 'kioku.user')
    assert.ok(otherTools.value.symbols.includes('kioku.user::|Case Sensitive|'))
    assert.ok(otherTools.value.symbols.includes('kioku.user::task-identity'))
    assert.ok(!otherTools.value.symbols.some((name: string) => /read-text|not-a-tool/u.test(name)))
    for (const [index, symbol] of ['kioku.user::task-identity', 'kioku.user::|Case Sensitive|'].entries()) {
      assert.equal((await describe(`unusual-function-${index}`, symbol)).ok, true)
    }
    const other = { ...owner, agentId: 'other-agent', sessionId: 'other-session' }
    await manager.enable(other)
    const isolated = await manager.execute(other, 'lisp_describe', { operationId: 'isolated-task-tools', symbol: 'kioku.user' }) as any
    assert.deepEqual(isolated.value.symbols, [], 'task definitions must not leak into another worker')
  } finally { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})
