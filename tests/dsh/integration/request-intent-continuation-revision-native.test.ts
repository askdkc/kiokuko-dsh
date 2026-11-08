import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { interpretedPreparation, toolValue } from '../helpers/coding-script.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
import { openConnection } from '../../../src/db/connection.js'
import { readCodingWorkflow, mutateCodingWorkflow } from '../../../src/dsh/coding-workflow/store.js'
import { setTimeout as delay } from 'node:timers/promises'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const extra = { lisp: { enabled: false }, typedDecisions: { mode: 'off' }, answerReview: { mode: 'off' },
  memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, memoryIndexReasoning: { mode: 'off' },
  deepPlanning: { enabled: false }, modelAutoMode: { mode: 'off' } }

// Seed a verified workflow at the previous native turn's durable boundary.
// Preparation and all subsequent dispatch/assembly use the real native loop.
for (const explicit of [true, false]) for (const fault of ['none', 'revision', 'generation', 'owner', 'repository', 'stopped'] as const) {
  test(`completed workflow scope change uses admitted lease (${explicit ? 'adapter' : 'public'}, ${fault})`, { timeout: 60000 }, async () => {
    const f = await nativeSkillFixture({ packages, ...(packageRoot ? { packageRoot } : {}), explicit, extra })
    const databasePath = join(f.dir, explicit ? 'state.sqlite3' : 'kiokuko-dsh.sqlite3')
    const withDb = <T>(read: (db: ReturnType<typeof openConnection>) => T) => {
      const db = openConnection(databasePath)
      try { return read(db) } finally { db.close() }
    }
    let stop = () => {}
    try {
      await writeFile(join(f.dir, 'parser.js'), 'process.stdout.write("42\\n")\n')
      f.responses.push(interpretedPreparation(f.mock, 'first', 'new', 'change', 'build'),
        f.mock.toolCallResponse('proof-status', 'task_completion', { action: 'status' }),
        (request: any) => f.mock.toolCallResponse('proof-bind', 'task_completion', { action: 'bind',
          criterionId: toolValue(request, 'proof-status').criteria[0].criterionId,
          method: { kind: 'native_command', command: 'node parser.js', cwd: '.', sourcePaths: ['parser.js'],
            assertion: 'output_matches', expectedOutput: '42' } }),
        f.mock.toolCallResponse('proof-execute', 'kioku_exec', { command: 'node parser.js' }),
        (request: any) => { assert.equal(toolValue(request, 'proof-execute').exitCode, 0); return f.mock.textResponse('The parser is verified.') })
      await f.turn('Implement a parser in parser.js. 通常実行で。')
      for (let attempt = 0; attempt < 100; attempt++) {
        if (withDb(db => db.prepare("SELECT 1 FROM ledger_runs WHERE status='completed'").get())) break
        await delay(10)
      }
      const source = withDb(db => {
        const row = db.prepare('SELECT run_id FROM dsh_coding_workflows').get<any>()!
        const workflow = readCodingWorkflow(db, row.run_id)!
        mutateCodingWorkflow(db, workflow, 'fixture-completion', workflow.revision, {}, value => { value.state = 'completed' })
        const task = db.prepare('SELECT status, task_state, task_revision, task_generation FROM ledger_runs WHERE run_id=?').get<any>(row.run_id)!
        assert.equal(task.status, 'completed')
        assert.equal(task.task_state, 'Pending')
        return { runId: row.run_id, revision: task.task_revision, generation: task.task_generation }
      })
      let prepared = false, advanced = false, admittedRunId = ''
      let observerError: unknown
      stop = f.ctx.on('session/event', (session: any, event: any) => {
        if (event.type !== 'tool/result' || event.data.message.toolCallId !== 'change') return
        try {
          const message = event.data.message
          assert.notEqual(message.isError, true)
          const value = JSON.parse(message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join(''))
          assert.equal(value.prepared, true)
          assert.equal(value.requestIntent.evidence.taskRevision, source.revision, 'original interpretation stays source-bound')
          withDb(db => {
            const owner = db.prepare("SELECT run_id FROM ledger_runs WHERE dsh_session_id=? AND status='active' AND run_id<>?").get<any>(session.id, source.runId)!
            admittedRunId = owner.run_id
            assert.notEqual(admittedRunId, source.runId, 'completed source is retired rather than silently reopened')
            assert.ok(['completed', 'cancelled'].includes(db.prepare('SELECT status FROM ledger_runs WHERE run_id=?').get<any>(source.runId)!.status))
            const mutations = { revision: 'task_revision=task_revision+1', generation: 'task_generation=task_generation+1',
              owner: "task_owner_session_id='foreign-session'", repository: "task_repository_root='/foreign-repository'", stopped: "task_state='Pending'" }
            if (fault !== 'none') db.prepare(`UPDATE ledger_runs SET ${mutations[fault]} WHERE run_id=?`).run(admittedRunId)
          })
          prepared = true
        } catch (error) { observerError = error }
      })
      f.responses.push(interpretedPreparation(f.mock, 'change', 'scope_change', 'change', 'build'), (request: any) => {
        assert.equal(toolValue(request, 'change').prepared, true)
        advanced = true
        return f.mock.toolCallResponse('current-workflow', 'coding_workflow', { action: 'status' })
      }, (request: any) => {
        assert.equal(toolValue(request, 'current-workflow').runId, admittedRunId)
        return f.mock.textResponse('The current request has its own execution authority.')
      })
      const turn = f.turn('Change the parser so it also accepts empty input. 通常実行で。')
      if (fault === 'none') { await turn; if (observerError) throw observerError }
      else await assert.rejects(turn, /Task execution authority is stale or stopped|Task owner or repository changed/)
      if (observerError) throw observerError
      assert.equal(prepared, true, 'preparation itself succeeds before the next assembly')
      assert.equal(advanced, fault === 'none', 'stale authority blocks the next model dispatch')
    } finally { stop(); await f.close() }
  })
}
