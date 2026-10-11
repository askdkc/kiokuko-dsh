import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { createLispCiAdapter } from '../../../../src/dsh/lisp/ci.js'
import type { DshUserQuestions } from '../../../../src/dsh/user-interaction.js'

test('AI task tools survive worker and host restarts, compose by exact ref, and deny host RPC', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL' : false, timeout: 180000,
}, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'task-tools-')))
  const root = join(base, 'workspace'); await mkdir(root)
  await writeFile(join(root, 'manifest.json'), await readFile(new URL('../../../fixtures/agent-task-tools/manifest.json', import.meta.url)))
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  const path = join(base, 'db.sqlite3')
  const db = new NodeSqliteAdapter(path, new DatabaseSync(path))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  db.exec(await readFile(new URL('../../../../migrations/031_dsh_lisp_hot_tools.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db))
  let approvalCount = 0
  const questions: DshUserQuestions = { ask: async request => {
    approvalCount++
    return { answers: [{ id: request.questions[0]!.id, selected: [request.questions[0]!.options![1]!.label] }] }
  } }
  const options = { store, questions, config: LispConfig.parse({ executionMode: 'protected', enabled: true, maxWorkers: 1, startupTimeoutMs: 60000 }), dataRoot: join(base, 'data'),
    ciCall: createLispCiAdapter(questions, async (file, args, run) => {
      assert.equal(file, 'npm'); assert.deepEqual(args, ['test'])
      assert.deepEqual(JSON.parse(await readFile(join(run.cwd, 'manifest.json'), 'utf8')), { entries: ['a', 'z'] })
      return { code: 0, stdout: 'fixture verifier', stderr: '' }
    }) }
  const owner = { sessionId: 'session', agentId: 'agent', root }
  let manager = new LispManager(options)
  const arraySchema = { type: 'array', items: { type: 'string' } }
  try {
    await manager.start(); assert.equal((await manager.enableTask(owner) as any).state, 'TASK_READY')
    assert.equal((await manager.execute(owner, 'lisp_eval', { operationId: 'scratch-one', code: '(defparameter *scratch-only* 7)' }) as any).ok, true)
    const disposable = await manager.execute(owner, 'lisp_eval', { operationId: 'scratch-two', code: "(boundp '*scratch-only*)" }) as any
    assert.equal(disposable.ok, true, JSON.stringify(disposable)); assert.equal(disposable.value.json, null)
    assert.equal((await manager.execute(owner, 'lisp_eval', { operationId: 'scratch-proposal', code: '(kioku.files:propose-write "bad.txt" "bad")' }) as any).ok, false)
    const baseTool = await manager.execute(owner, 'lisp_define', {
      operationId: 'define-base', name: 'sort-names', description: 'Sort strings', source: '(lambda (input) (coerce (sort (coerce input \'list) #\'string<) \'vector))',
      inputSchema: arraySchema, outputSchema: arraySchema, examples: [{ input: ['b', 'a'], expected: ['a', 'b'] }],
    }) as any
    assert.equal(baseTool.ok, true, JSON.stringify(baseTool))
    const composite = await manager.execute(owner, 'lisp_define', {
      operationId: 'define-composite', name: 'sorted-twice', description: 'Compose exact tool',
      source: '(lambda (input) (sort-names (sort-names input)))',
      inputSchema: arraySchema, outputSchema: arraySchema,
      dependencies: [{ binding: 'sort-names', toolRef: baseTool.toolRef }],
    }) as any
    assert.equal(composite.ok, true, JSON.stringify(composite))
    const first = await manager.execute(owner, 'lisp_call', { operationId: 'first', toolRef: composite.toolRef, input: ['z', 'a'] }) as any
    assert.equal(first.ok, true, JSON.stringify(first)); assert.deepEqual(first.value, ['a', 'z'])
    assert.equal((await manager.execute(owner, 'lisp_call', { operationId: 'first', toolRef: composite.toolRef, input: ['z', 'a'] }) as any).replay, true)
    assert.equal((await manager.execute(owner, 'lisp_call', { operationId: 'first', toolRef: composite.toolRef, input: ['x'] }) as any).code, 'ID_CONFLICT')
    const observation = await manager.execute(owner, 'lisp_observe', { operationId: 'observe', paths: ['manifest.json', 'package.json'], format: 'json' }) as any
    assert.equal(observation.ok, true, JSON.stringify(observation)); assert.equal(observation.items[0].content, undefined)
    const extract = await manager.execute(owner, 'lisp_define', { operationId: 'define-extract', name: 'manifest-entries', description: 'Extract entries from captured manifest',
      source: '(lambda (input) (gethash "entries" (gethash "content" (aref (gethash "items" input) 0))))',
      inputSchema: { type: 'object', properties: {
        items: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, digest: { type: 'string' }, content: { type: 'object', properties: { entries: arraySchema, scripts: { type: 'object', properties: { test: { type: 'string' } }, additionalProperties: false } }, additionalProperties: false } }, required: ['path', 'digest', 'content'], additionalProperties: false } },
        coverage: { type: 'object', properties: { complete: { type: 'boolean' }, returned: { type: 'integer' }, total: { type: 'integer' } }, required: ['complete', 'returned', 'total'], additionalProperties: false },
        consistency: { type: 'string' },
      }, required: ['items', 'coverage', 'consistency'], additionalProperties: false }, outputSchema: arraySchema,
    }) as any
    assert.equal(extract.ok, true, JSON.stringify(extract))
    const extracted = await manager.execute(owner, 'lisp_call', { operationId: 'extracted', toolRef: extract.toolRef, inputRef: observation.resultRef }) as any
    assert.equal(extracted.ok, true, JSON.stringify(extracted)); assert.deepEqual(extracted.value, ['z', 'a'])
    const proposalSchema = { type: 'array', items: { type: 'object', properties: {
      operation: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' },
    }, required: ['operation', 'path', 'content'], additionalProperties: false } }
    const fix = await manager.execute(owner, 'lisp_define', { operationId: 'define-fix', name: 'fix-manifest', description: 'Prepare a manifest fix',
      source: `(lambda (input) (declare (ignore input)) (vector (kioku.internal:object "operation" "write" "path" "manifest.json" "content" ${JSON.stringify(JSON.stringify({ entries: ['a', 'z'] }))})))`,
      inputSchema: extract.inputSchema ?? { type: 'object', properties: {
        items: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, digest: { type: 'string' }, content: { type: 'object', properties: { entries: arraySchema, scripts: { type: 'object', properties: { test: { type: 'string' } }, additionalProperties: false } }, additionalProperties: false } }, required: ['path', 'digest', 'content'], additionalProperties: false } },
        coverage: { type: 'object', properties: { complete: { type: 'boolean' }, returned: { type: 'integer' }, total: { type: 'integer' } }, required: ['complete', 'returned', 'total'], additionalProperties: false }, consistency: { type: 'string' },
      }, required: ['items', 'coverage', 'consistency'], additionalProperties: false }, outputSchema: proposalSchema,
    }) as any
    assert.equal(fix.ok, true, JSON.stringify(fix))
    const proposed = await manager.execute(owner, 'lisp_call', { operationId: 'proposed', toolRef: fix.toolRef, inputRef: observation.resultRef }) as any
    assert.equal(proposed.ok, true, JSON.stringify(proposed))
    const staged = await manager.execute(owner, 'lisp_stage', { operationId: 'staged', resultRef: proposed.resultRef, baseRef: observation.resultRef }) as any
    assert.equal(staged.ok, true, JSON.stringify(staged))
    assert.deepEqual(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')), { entries: ['z', 'a'] })
    const verified = await manager.execute(owner, 'lisp_verify', { operationId: 'verified', candidateRef: staged.candidateRef, target: 'test' }) as any
    assert.equal(verified.ok, true, JSON.stringify(verified)); assert.equal(verified.testStatus, 'unknown')
    const otherCandidate = await manager.execute(owner, 'lisp_stage', { operationId: 'other-stage', resultRef: proposed.resultRef, baseRef: observation.resultRef }) as any
    const compared = await manager.execute(owner, 'lisp_compare', { operationId: 'compared', leftRef: staged.candidateRef, rightRef: otherCandidate.candidateRef }) as any
    assert.equal(compared.ok, true, JSON.stringify(compared)); assert.equal(compared.sameBase, true)
    assert.equal(compared.changes[0].same, true)
    assert.equal((await manager.execute(owner, 'lisp_apply', { operationId: 'wrong-verification', candidateRef: otherCandidate.candidateRef, verificationRef: verified.operationId }) as any).code, 'VERIFICATION_MISMATCH')
    const applied = await manager.execute(owner, 'lisp_apply', { operationId: 'applied', candidateRef: staged.candidateRef, verificationRef: verified.operationId }) as any
    assert.equal(applied.ok, true, JSON.stringify(applied)); assert.equal(approvalCount, 2)
    assert.deepEqual(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')), { entries: ['a', 'z'] })
    assert.equal((await manager.execute(owner, 'lisp_apply', { operationId: 'again', candidateRef: staged.candidateRef }) as any).code, 'CANDIDATE_ALREADY_USED')
    const newer = await manager.execute(owner, 'lisp_observe', { operationId: 'observe-new', paths: ['manifest.json'], format: 'json' }) as any
    const staleProposal = await manager.execute(owner, 'lisp_call', { operationId: 'stale-proposal', toolRef: fix.toolRef, inputRef: newer.resultRef }) as any
    const staleCandidate = await manager.execute(owner, 'lisp_stage', { operationId: 'stale-stage', resultRef: staleProposal.resultRef, baseRef: newer.resultRef }) as any
    assert.equal(staleCandidate.ok, true, JSON.stringify(staleCandidate))
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ entries: ['external'] }))
    const staleApply = await manager.execute(owner, 'lisp_apply', { operationId: 'stale-apply', candidateRef: staleCandidate.candidateRef }) as any
    assert.equal(staleApply.ok, false); assert.equal(staleApply.changes[0].code, 'BASE_CHANGED')
    assert.deepEqual(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')), { entries: ['external'] })
    assert.equal(approvalCount, 2)
    const second = await manager.execute(owner, 'lisp_call', { operationId: 'second', toolRef: composite.toolRef, inputRef: first.resultRef }) as any
    assert.equal(second.ok, true, JSON.stringify(second)); assert.deepEqual(second.value, ['a', 'z'])
    const otherOwner = { ...owner, agentId: 'other-agent' }
    assert.equal((await manager.execute(otherOwner, 'lisp_call', { operationId: 'cross-owner', toolRef: composite.toolRef, input: ['a'] }) as any).code, 'TASK_TOOL_MISSING')
    const ownedByOther = await manager.execute(otherOwner, 'lisp_define', { operationId: 'other-tool', name: 'identity', description: 'Identity',
      source: '(lambda (input) input)', inputSchema: arraySchema, outputSchema: arraySchema }) as any
    assert.equal(ownedByOther.ok, true, JSON.stringify(ownedByOther))
    assert.equal((await manager.execute(otherOwner, 'lisp_call', { operationId: 'cross-result', toolRef: ownedByOther.toolRef, inputRef: first.resultRef }) as any).code, 'TASK_RESULT_MISSING')
    const logFixture = JSON.parse(await readFile(new URL('../../../fixtures/agent-task-tools/diagnostic-lines.json', import.meta.url), 'utf8')) as { input: string[]; expected: string[] }
    const logTool = await manager.execute(owner, 'lisp_define', {
      operationId: 'define-log', name: 'error-lines', description: 'Select error lines from a saved log',
      source: '(lambda (input) (coerce (loop for line across input when (and (>= (length line) 6) (string= "ERROR:" line :end2 6)) collect line) \'vector))',
      inputSchema: arraySchema, outputSchema: arraySchema,
    }) as any
    assert.equal(logTool.ok, true, JSON.stringify(logTool))
    const diagnosed = await manager.execute(owner, 'lisp_call', { operationId: 'diagnosed', toolRef: logTool.toolRef,
      input: logFixture.input }) as any
    assert.equal(diagnosed.ok, true, JSON.stringify(diagnosed)); assert.deepEqual(diagnosed.value, logFixture.expected)
    const denied = await manager.execute(owner, 'lisp_define', {
      operationId: 'define-denied', name: 'run-process', description: 'Should be denied',
      source: '(lambda (input) (kioku.process:run "echo" (list input)))',
      inputSchema: { type: 'string' }, outputSchema: { type: 'string' },
      examples: [{ input: 'bad', expected: 'bad' }],
    }) as any
    assert.equal(denied.ok, false)
    await manager.dispose()
    manager = new LispManager(options)
    await manager.start()
    assert.equal(await manager.isTaskMode(owner), true)
    const resumed = await manager.execute(owner, 'lisp_call', { operationId: 'resumed', toolRef: composite.toolRef, input: ['m', 'b'] }) as any
    assert.equal(resumed.ok, true, JSON.stringify(resumed)); assert.deepEqual(resumed.value, ['b', 'm'])
  } finally { await manager.dispose() }
})
