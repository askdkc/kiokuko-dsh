import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeSqliteAdapter } from '../../../../src/db/adapter.js'
import { LispConfig } from '../../../../src/dsh/lisp/contracts.js'
import { LispManager } from '../../../../src/dsh/lisp/manager.js'
import { LispStore } from '../../../../src/dsh/lisp/store.js'
import { HttpTypeSafeClient } from '../../../../src/dsh/typesafe/client.js'
import { TypeSafeCredentials } from '../../../../src/dsh/typesafe/credentials.js'
import { compileSkillResource } from '../../../../src/dsh/skill-compiler.js'

test('protected Lisp consumes TypeSafe decisions, catches API errors, preserves approval and aborts HTTP on termination', {
  skip: process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1' ? 'requires protected SBCL' : false, timeout: 180000,
}, async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'typesafe-lisp-'))), root = join(base, 'work')
  await mkdir(root); await writeFile(join(root, 'candidate.txt'), 'original')
  const db = new NodeSqliteAdapter(join(base, 'db.sqlite3'), new DatabaseSync(join(base, 'db.sqlite3')))
  db.exec(await readFile(new URL('../../../../migrations/019_dsh_lisp.sql', import.meta.url), 'utf8'))
  const store = new LispStore(async fn => fn(db)), owner = { sessionId: 'session', agentId: 'agent', root }
  let decision = 'inspect', mode = 'ok', approvals = 0, requestSignal: AbortSignal | undefined, began!: () => void, late!: (response: Response) => void
  const bodies: any[] = [], bindings: any[] = []
  const client = new HttpTypeSafeClient(new TypeSafeCredentials(() => undefined, () => 'fixture-host-secret'), async (_url, options) => {
    bodies.push(JSON.parse(String(options!.body))); requestSignal = options!.signal!
    if (mode === 'hang') { began(); return new Promise(resolve => { late = resolve }) }
    if (mode === 'auth') return new Response('fixture-host-secret error body', { status: 401 })
    const questions = bodies.at(-1).questions
    if (!questions.next) {
      const answers = Object.fromEntries(Object.entries(questions).map(([id, q]: [string, any]) => [id, q.type === 'choice'
        ? { type: 'choice', choice: decision, probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === decision ? 1 : 0])), confidence: 1 }
        : q.type === 'score' ? { type: 'score', score: 0.5, probabilities: { '0': 0.5, '1': 0.5 }, legend: { '0': q.criteria[0], '1': q.criteria[1] }, confidence: 0 }
        : { type: 'noul', noul: id === '0' || id === 'fit' && decision === 'propose' ? 0.95 : 0.05 }]))
      return Response.json({ model: 'fixture-model', answers, usage: { input_tokens: 10, output_tokens: 5 } })
    }
    return Response.json({ model: 'fixture-model', answers: { next: { type: 'choice', choice: decision,
      probabilities: { inspect: decision === 'inspect' ? 1 : 0, propose: decision === 'propose' ? 1 : 0, insufficient: decision === 'insufficient' ? 1 : 0 }, confidence: 1 } }, usage: { input_tokens: 30, output_tokens: 10 } })
  })
  const manager = new LispManager({ store, config: LispConfig.parse({ enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 }), dataRoot: join(base, 'data'),
    questions: { ask: async request => { approvals++; return { answers: [{ id: request.questions[0].id, selected: [request.questions[0].options![0]!.label] }] } } },
    typesafeCall: async (bound, method, args, context) => { bindings.push({ owner: bound, generation: context.generation, evaluationId: context.evaluationId }); return method === 'typesafe-status' ? client.status() : client.evaluate(args, context.signal) },
  })
  const evaluate = (id: string, code: string, extra = {}, signal?: AbortSignal) => manager.execute(owner, 'lisp_eval', { operationId: id, code, ...extra }, signal) as Promise<any>
  const questionsJson = JSON.stringify({ next: { type: 'choice', instructions: 'Choose an inspection or proposal step', criteria: { inspect: 'inspect known candidate', propose: 'prepare a change', insufficient: 'need further evidence' } } })
  const request = `(kioku.typesafe:evaluate #("synthetic code" "failure evidence") (kioku.data:parse-json ${JSON.stringify(questionsJson)}))`
  try {
    await manager.start(); assert.equal((await manager.enable(owner) as any).state, 'READY')
    const docs = await manager.execute(owner, 'lisp_describe', {}) as any
    assert.ok(docs.packages.includes('kioku.typesafe'))
    const exports = await manager.execute(owner, 'lisp_describe', { operationId: 'exports', symbol: 'kioku.typesafe' }) as any
    assert.ok(exports.value.symbols.includes('kioku.typesafe:evaluate'))
    const status = await evaluate('status', '(kioku.typesafe:status)')
    assert.deepEqual(status.value.json, { configured: true, source: 'env', writable: false }); assert.equal(bodies.length, 0)
    const code = `(let* ((result ${request}) (choice (gethash "choice" (gethash "next" (gethash "answers" result)))))
      (cond ((equal choice "propose") (kioku.files:propose-write "candidate.txt" "changed") "proposal")
            ((equal choice "insufficient") (kioku.files:read-text (kioku.files:input 0)))
            (t "inspect selected candidate")))`
    const inspect = await evaluate('inspect', code, { inputs: ['candidate.txt'] }); assert.equal(inspect.value.json, 'inspect selected candidate')
    decision = 'insufficient'
    const uncertain = await evaluate('insufficient', code, { inputs: ['candidate.txt'] }); assert.equal(uncertain.value.json, 'original')
    decision = 'propose'
    const proposed = await evaluate('propose', code, { inputs: ['candidate.txt'] })
    assert.equal(proposed.changes[0].state, 'NOT_APPLIED'); assert.equal(approvals, 1); assert.equal(await readFile(join(root, 'candidate.txt'), 'utf8'), 'original')
    const answer = await evaluate('answer', request); assert.equal(answer.value.json.model, 'fixture-model'); assert.equal(answer.value.json.usage.input_tokens, 30)
    mode = 'auth'
    const caught = await evaluate('caught', `(handler-case ${request} (kioku.typesafe:service-error (e) (kioku.typesafe:error-code e)))`)
    assert.equal(caught.ok, true); assert.equal(caught.value.json, 'TYPESAFE_AUTH')
    const uncaught = await evaluate('uncaught', `(kioku.files:propose-write "candidate.txt" "must not apply") ${request}`)
    assert.equal(uncaught.ok, false); assert.match(uncaught.value, /TYPESAFE_AUTH/); assert.deepEqual(uncaught.proposals, [])
    assert.equal(approvals, 1); assert.equal((await evaluate('usable', '(+ 20 22)')).value.json, 42)
    const tooLarge = await evaluate('oversized', '(handler-case (kioku.typesafe:evaluate (make-string 1100000 :initial-element #\\x) (make-hash-table)) (kioku.typesafe:service-error (e) (kioku.typesafe:error-code e)))')
    assert.equal(tooLarge.value.json, 'TYPESAFE_REQUEST_TOO_LARGE')
    assert.equal((await evaluate('no-worker-key', '(uiop:getenv "TYPESAFE_API_KEY")')).value.json, null)
    assert.ok(!JSON.stringify([status, caught, uncaught, await manager.diagnostics(owner)]).includes('fixture-host-secret'))
    assert.deepEqual(bodies[0].state, ['synthetic code', 'failure evidence'])
    for (const b of bindings) { assert.deepEqual(b.owner, owner); assert.equal(b.generation, answer.generation); assert.ok(b.evaluationId) }
    const wrongOwner = await manager.execute({ ...owner, root: base }, 'lisp_eval', { operationId: 'wrong-owner', code: request }) as any
    assert.equal(wrongOwner.ok, false); assert.equal(wrongOwner.code, 'LISP_DISABLED')
    // Execute the shipped examples, including both branches of the proposal helper.
    mode = 'ok'
    const skill = await readFile(new URL('../../../../skills/kiokuko-lisp/SKILL.md', import.meta.url), 'utf8')
    const examples = skill.slice(skill.indexOf('### Explicit TypeSafe decisions')).match(/```lisp\n([\s\S]*?)```/)![1]!
    assert.equal((await evaluate('documented-helpers', examples)).ok, true)
    const compiledGuide = compileSkillResource({ name: 'kiokuko-lisp', relativePath: 'SKILL.md', content: skill }).content
    const deliveredExamples = compiledGuide.slice(compiledGuide.indexOf('### TypeSafe')).match(/```lisp\n([\s\S]*?)```/)![1]!
    assert.equal((await evaluate('delivered-examples', deliveredExamples)).ok, true)
    decision = 'import'
    const mixed = await evaluate('mixed', `(kioku.typesafe:evaluate (obj "code" "synthetic" "facts" #(1 2))
      (obj "0" (obj "type" "noul" "instructions" "Related?")
           "cause" (obj "type" "choice" "instructions" "Cause?" "criteria" (obj "import" "Module resolution" "insufficient" "Need evidence"))
           "severity" (obj "type" "score" "instructions" "Severity?" "criteria" #("Low" "High"))))`)
    assert.equal(mixed.value.json.answers['0'].noul, 0.95); assert.equal(mixed.value.json.answers.severity.score, 0.5)
    const delivered = await evaluate('consume-delivered', '(inspect-diagnosis (kioku.typesafe:evaluate "module not found" (obj "cause" (obj "type" "choice" "instructions" "Cause?" "criteria" (obj "import" "Missing module" "insufficient" "Need evidence")))))', { inputs: ['candidate.txt'] })
    assert.deepEqual(delivered.value.json, ['original'])
    const selected = await evaluate('select-shortlist', '(inspect-relevant "requirement" #("relevant candidate" "unrelated candidate") 0.8)', { inputs: ['candidate.txt', 'candidate.txt'] })
    assert.deepEqual(selected.value.json, ['original'])
    decision = 'insufficient'
    assert.match((await evaluate('classify-uncertain', '(inspect-failure "partial error")')).value.json, /Collect the failing command/)
    decision = 'import'
    assert.deepEqual((await evaluate('classify-import', '(inspect-failure "module not found")', { inputs: ['candidate.txt'] })).value.json, ['original'])
    decision = 'inspect'
    assert.match((await evaluate('change-inspect', '(consider-change "requirement" "original" "changed" "candidate.txt" 0.8 0.2)')).value.json, /Inspect/)
    decision = 'propose'
    assert.equal((await evaluate('change-propose', '(consider-change "requirement" "original" "changed" "candidate.txt" 0.8 0.2)')).changes[0].state, 'NOT_APPLIED')
    assert.equal(approvals, 2)
    mode = 'hang'; began = () => {}
    const serviceTimeout = await evaluate('service-timeout', request.slice(0, -1) + ' :timeout-ms 20)')
    assert.equal(serviceTimeout.ok, false); assert.match(serviceTimeout.value, /TYPESAFE_TIMEOUT/); assert.equal(requestSignal!.aborted, true)
    late(Response.json({})); assert.equal((await evaluate('after-service-timeout', '(+ 1 2)')).value.json, 3)
    for (const termination of ['timeout', 'cancel', 'signal', 'exit', 'dispose'] as const) {
      mode = 'hang'
      const started = new Promise<void>(resolve => { began = resolve })
      const controller = new AbortController()
      const pending = evaluate(`terminate-${termination}`, request, { timeoutMs: termination === 'timeout' ? 200 : 10000 }, controller.signal)
      await started
      if (termination === 'cancel') await manager.execute(owner, 'lisp_cancel', {})
      if (termination === 'signal') controller.abort()
      if (termination === 'exit') {
        const generation = (await manager.status(owner) as any).generation
        const { execFileSync } = await import('node:child_process')
        const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
        const worker = ps.split('\n').find(line => line.includes('supervisor.mjs') && line.includes(generation))
        assert.ok(worker, 'find only this fixture worker supervisor'); process.kill(Number(worker.trim().split(/\s+/)[0]), 'SIGTERM')
      }
      if (termination === 'dispose') await manager.dispose()
      const result = await pending
      assert.equal(result.ok, false); assert.equal(requestSignal!.aborted, true, termination)
      late(Response.json({ model: 'late', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }))
      if (termination !== 'dispose') { await manager.recover(owner); assert.equal((await evaluate(`after-${termination}`, '(+ 1 2)')).value.json, 3) }
    }
  } finally { await manager.dispose(); db.close(); await rm(base, { recursive: true, force: true }) }
})
