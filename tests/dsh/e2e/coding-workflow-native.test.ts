import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openConnection } from '../../../src/db/connection.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { codingPrelude, toolValue, fixtureDefinition } from '../helpers/coding-script.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const installed = existsSync(join(packages, '@deepseek-ai/dsh/package.json'))
if (!installed && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1') throw new Error('Pinned native DSH is required')
const program = "export function parse(value){return Number(value)+1}\nif(process.argv[1]?.endsWith('parser.mjs'))console.log(String(parse(process.argv[2])))\n"
const check = "import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {parse} from './parser.mjs';test('regression',()=>assert.equal(parse('41'),42));test('public entry',()=>assert.equal(execFileSync(process.execPath,['src/parser.mjs','41'],{encoding:'utf8'}).trim(),'42'));\n"
const command = 'node --test --test-reporter=tap src/parser.test.mjs'
const lispString = (value: string) => `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
const extra = { lisp: { enabled: true }, answerReview: { mode: 'off' }, typedDecisions: { mode: 'off' },
  memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, memoryIndexReasoning: { mode: 'off' }, deepPlanning: { enabled: false }, modelAutoMode: { mode: 'off' } }

for (const choice of ['使わない', '使う'] as const) test(`native coding session ${choice}: real artifact, item evidence, fresh user-entry Goal`, { skip: !installed, timeout: 120000 }, async () => {
  const questions: any[] = []
  const f = await nativeSkillFixture({ packages, explicit: true, mode: 'full', extra, nativeAnswer: async request => {
    const question = request.questions[0]; questions.push(question)
    if (question.id.startsWith('coding-lisp-')) {
      assert.match(question.detail, /Goal:.*public parser/u)
      assert.match(question.detail, /regression assertions/u)
      assert.equal(existsSync(join(f.dir, 'src/parser.mjs')), false, 'question precedes implementation')
      const db = openConnection(join(f.dir, 'state.sqlite3'))
      try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_lisp_operations').get<any>().n, 0) } finally { db.close() }
    }
    return { answers: [{ id: question.id, selected: [question.id.startsWith('coding-lisp-') ? choice : '通常実行'] }] }
  } })
  try {
    f.responses.push(...codingPrelude(f.mock, 'coding'))
    const call = (id: string, name: string, args: object) => f.responses.push(f.mock.toolCallResponse(id, name, args))
    if (choice === '使う') {
      call('write-program', 'lisp_eval', { operationId: 'program', code: `(kioku.files:propose-write "src/parser.mjs" ${lispString(program)})` })
      call('write-test', 'lisp_eval', { operationId: 'test', code: `(kioku.files:propose-write "src/parser.test.mjs" ${lispString(check)})` })
    } else {
      call('write-program', 'kioku_write', { path: 'src/parser.mjs', content: program })
      call('write-test', 'kioku_write', { path: 'src/parser.test.mjs', content: check })
    }
    for (const id of ['regression', 'user-entry']) f.responses.push((request: any) => {
      const workflow = toolValue(request, 'coding-propose')
      return f.mock.toolCallResponse('bind-'+id, 'task_completion', { action: 'bind', criterionId: `coding:${workflow.workflowId}:${id}`,
        method: { kind: 'native_command', command, cwd: '.', sourcePaths: ['src/parser.mjs', 'src/parser.test.mjs'], assertion: 'selected_tests_pass' } })
    })
    for (const id of ['item-check', 'goal-check']) call(id, choice === '使う' ? 'lisp_eval' : 'kioku_exec', choice === '使う'
      ? { operationId: id, code: '(kioku.process:run "node" (list "--test" "--test-reporter=tap" "src/parser.test.mjs"))' } : { command })
    call('completed', 'coding_workflow', { action: 'status' })
    f.responses.push((request: any) => {
      const failed = nativeToolResults(request.messages).filter(value => value.isError)
      assert.deepEqual(failed, [])
      const status = toolValue(request, 'completed'); assert.equal(status.state, 'completed', JSON.stringify(status.assessment)); assert.equal(status.assessment.verified, true)
      return f.mock.textResponse('Goal achieved: the public entry returns 42; regression and final user-entry checks passed.')
    })
    await f.turn('Implement src/parser.mjs so the public command adds one to its numeric input. 通常実行で。')
    assert.equal(execFileSync(process.execPath, ['src/parser.mjs', '41'], { cwd: f.dir, encoding: 'utf8' }).trim(), '42')
    assert.equal(await readFile(join(f.dir, 'src/parser.mjs'), 'utf8'), program)
    assert.equal(questions.filter(question => question.id.startsWith('coding-lisp-')).length, 1)
    const db = openConnection(join(f.dir, 'state.sqlite3'))
    try {
      assert.equal(db.prepare('SELECT status FROM ledger_runs').get<any>().status, 'completed')
      const snapshot = JSON.parse(db.prepare('SELECT snapshot_json FROM dsh_coding_workflows').get<any>().snapshot_json)
      assert.equal(snapshot.choice.state, choice === '使う' ? 'yes' : 'no')
      const receipts = db.prepare('SELECT receipt_json FROM dsh_owned_operations').all<any>().map(value => JSON.parse(value.receipt_json))
      assert.ok(receipts.filter(value => value.verification === 'passed').length >= 2)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_lisp_sessions WHERE enabled=1').get<any>().n, choice === '使う' ? 1 : 0)
    } finally { db.close() }
  } finally { await f.close() }
})

for (const answer of ['closed', 'empty', 'disconnected', 'cancel'] as const) test(`native coding ${answer}: no effects, reads and explanation remain available`, { skip: !installed, timeout: 30000 }, async () => {
  const f = await nativeSkillFixture({ packages, explicit: true, extra, nativeAnswer: async request => {
    const question = request.questions[0]
    if (!question.id.startsWith('coding-lisp-')) return { answers: [{ id: question.id, selected: ['通常実行'] }] }
    if (answer === 'disconnected') throw new Error('Disconnected')
    return { answers: answer === 'closed' ? [] : [{ id: question.id, selected: answer === 'cancel' ? ['取消・作業を保持'] : [] }] }
  } })
  try {
    f.responses.push(...codingPrelude(f.mock, 'pending'), f.mock.toolCallResponse('premature', 'kioku_write', { path: 'must-not-exist', content: 'wrong' }),
      f.mock.toolCallResponse('state', 'coding_workflow', { action: 'status' }), (request: any) => {
        assert.ok(nativeToolResults(request.messages).find(value => value.toolCallId === 'premature')?.isError)
        const state = toolValue(request, 'state'); assert.equal(state.choice.state, answer === 'cancel' ? 'cancelled' : 'pending')
        return f.mock.textResponse('Implementation is waiting for this task’s Lisp choice. The prepared Goal is preserved.')
      })
    await f.turn('Implement src/parser.mjs. 通常実行で。')
    assert.equal(existsSync(join(f.dir, 'must-not-exist')), false)
    const db = openConnection(join(f.dir, 'state.sqlite3')); try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_lisp_sessions WHERE enabled=1').get<any>().n, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dsh_owned_operations').get<any>().n, 0)
    } finally { db.close() }
  } finally { await f.close() }
})

for (const mode of ['full', 'compiled'] as const) test(`native ${mode}: a new task requires a new choice even with the previous Lisp runtime enabled`, { skip: !installed, timeout: 120000 }, async () => {
  const questions: any[] = []
  const f = await nativeSkillFixture({ packages, explicit: mode === 'full', mode, extra, nativeAnswer: async request => {
    const question = request.questions[0]
    const coding = question.id.startsWith('coding-lisp-')
    if (coding) questions.push(question)
    return { answers: [{ id: question.id, selected: [coding ? questions.length === 1 ? '使う' : '使わない' : '通常実行'] }] }
  } })
  try {
    f.responses.push(...codingPrelude(f.mock, 'first'), f.mock.textResponse('Goal prepared; its checks are still pending.'))
    await f.turn('Implement src/parser.mjs. 通常実行で。完了条件: public entry outputs 42')
    f.responses.push(...codingPrelude(f.mock, 'second', fixtureDefinition('src/second.mjs')),
      f.mock.toolCallResponse('second-write', 'kioku_write', { path: 'src/second.mjs', content: 'console.log(42)\n' }),
      f.mock.toolCallResponse('old-lisp', 'lisp_eval', { operationId: 'forbidden', code: '(kioku.files:propose-write "forbidden" "bad")' }),
      f.mock.toolCallResponse('second-state', 'coding_workflow', { action: 'status' }),
      (request: any) => {
        assert.equal(toolValue(request, 'second-write').applied, true)
        assert.ok(nativeToolResults(request.messages).find(value => value.toolCallId === 'old-lisp')?.isError)
        assert.equal(toolValue(request, 'second-state').choice.state, 'no')
        return f.mock.textResponse('The new task uses ordinary tools and still awaits its own checks.')
      })
    await f.turn('Implement src/second.mjs. 通常実行で。完了条件: public entry outputs 42')
    assert.equal(questions.length, 2); assert.notEqual(questions[0].id, questions[1].id)
    assert.equal(existsSync(join(f.dir, 'forbidden')), false)
    assert.equal(await readFile(join(f.dir, 'src/second.mjs'), 'utf8'), 'console.log(42)\n')
  } finally { await f.close() }
})

test('native core reload restores the exact pending task and question before allowing an ordinary write', { skip: !installed, timeout: 120000 }, async () => {
  const questions: any[] = []
  const f = await nativeSkillFixture({ packages, explicit: false, mode: 'compiled', extra, nativeAnswer: async request => {
    const question = request.questions[0]
    if (question.id.startsWith('coding-lisp-')) {
      questions.push(question)
      return { answers: [{ id: question.id, selected: questions.length === 1 ? [] : ['使わない'] }] }
    }
    return { answers: [{ id: question.id, selected: ['通常実行'] }] }
  } })
  try {
    f.responses.push(...codingPrelude(f.mock, 'pending-reload'), f.mock.textResponse('The Goal is preserved while the task choice is pending.'))
    await f.turn('Implement src/parser.mjs. 通常実行で。完了条件: public entry outputs 42')
    assert.equal(existsSync(join(f.dir, 'src/parser.mjs')), false)
    await f.reload('compiled')
    f.responses.push(f.mock.toolCallResponse('resume-task', 'coding_workflow', { action: 'next' }),
      f.mock.toolCallResponse('resumed-write', 'kioku_write', { path: 'src/parser.mjs', content: 'console.log(42)\n' }),
      f.mock.toolCallResponse('resumed-state', 'coding_workflow', { action: 'status' }),
      (request: any) => {
        const state = toolValue(request, 'resumed-state')
        assert.equal(state.workflowId, toolValue(request, 'pending-reload-propose').workflowId)
        assert.equal(state.choice.state, 'no'); assert.equal(state.assessment.verified, false)
        return f.mock.textResponse('The same task resumed; its acceptance checks remain pending.')
      })
    await f.turn('Continue the current task.')
    assert.equal(questions.length, 2); assert.equal(questions[0].id, questions[1].id)
    assert.equal(await readFile(join(f.dir, 'src/parser.mjs'), 'utf8'), 'console.log(42)\n')
  } finally { await f.close() }
})
