import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { interpretedPreparation } from '../helpers/coding-script.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
import { openConnection } from '../../../src/db/connection.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')

for (const reload of [false, true, 'legacy'] as const)
test(`cancelled optional preparation does not strand ordinary native edit (host reload=${reload})`, { timeout: 45000 }, async () => {
  let cancelledQuestions = 0
  let prior: { run: Record<string, any>; owner: Record<string, any> } | undefined
  const f = await nativeSkillFixture({ packages, explicit: true, intakeAnswers: false,
    startupChoice: 'decision OFF / Lisp OFF',
    extra: { typedDecisions: { mode: 'off' }, answerReview: { mode: 'off' },
      memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, lisp: { enabled: false } },
    nativeAnswer: async request => {
      if (cancelledQuestions) return { answers: request.questions.map((question: { id: string; options?: { label: string }[] }) => {
        const first = question.options?.[0]
        return { id: question.id, selected: first ? [first.label] : [],
          ...(first ? {} : { custom: 'regression.txt contains next-turn' }) }
      }) }
      cancelledQuestions++
      if (reload === 'legacy') {
        const db = openConnection(join(f.dir, 'state.sqlite3'))
        try {
          const owner = db.prepare('SELECT * FROM dsh_execution_owners WHERE dsh_session_id=?').get<Record<string, any>>(f.agent.session.id)!
          prior = { owner, run: db.prepare('SELECT * FROM ledger_runs WHERE run_id=?').get<Record<string, any>>(owner.run_id)! }
        } finally { db.close() }
      }
      throw new Error('the user cancelled ask_user_question')
    },
    hostPlugin: { name: 'native-edit-fixture', async apply(ctx: any) {
      const tool = await import(pathToFileURL(join(packages, '@deepseek-ai/dsh-tool-fs/lib/index.js')).href)
      await ctx.plugin(tool.default ?? tool)
    } },
  })
  const result = (q: any, id: string) => {
    const value = nativeToolResults(q.messages).find(message => message.toolCallId === id)
    assert.ok(value, id)
    return value
  }
  try {
    const file = join(f.dir, 'regression.txt')
    await writeFile(file, 'before\n')
    f.responses.push(
      interpretedPreparation(f.mock, 'cancel-intake', 'new', 'change', 'debug'),
      (q: any) => {
        const failure = result(q, 'cancel-intake')
        assert.equal(failure.isError, true)
        assert.match(JSON.stringify(failure), /cancelled ask_user_question/)
        return f.mock.toolCallResponse('status-after-cancel', 'task_completion', { action: 'status' })
      },
      (q: any) => {
        const status = result(q, 'status-after-cancel')
        assert.equal(status.isError, false, JSON.stringify(status))
        assert.match(status.content.map((block: any) => block.text ?? '').join(''), /"applicable":false/)
        return f.mock.toolCallResponse('read-after-cancel', 'read', { file_path: file })
      },
      (q: any) => {
        const read = result(q, 'read-after-cancel')
        assert.equal(read.isError, false, JSON.stringify(read))
        assert.match(JSON.stringify(read), /before/)
        return f.mock.toolCallResponse('edit-after-cancel', 'edit', { file_path: file, old_string: 'before', new_string: 'same-turn' })
      },
      (q: any) => { assert.equal(result(q, 'edit-after-cancel').isError, false, JSON.stringify(result(q, 'edit-after-cancel'))); return f.mock.textResponse('Edited.') },
    )
    await f.turn('修正してください。')
    assert.equal(cancelledQuestions, 1)
    assert.equal(await readFile(file, 'utf8'), 'same-turn\n')
    if (reload === 'legacy') {
      // Restore the exact pre-fix residue, not a hand-repaired success state.
      // The recorded native failed call remains the only recovery evidence.
      assert.ok(prior)
      const db = openConnection(join(f.dir, 'state.sqlite3'))
      try {
        const { run, owner } = prior
        db.prepare(`UPDATE ledger_runs SET status=?,task_state=?,task_revision=?,task_generation=?,metadata_json=?,ended_at=? WHERE run_id=?`)
          .run(run.status, run.task_state, run.task_revision, run.task_generation, run.metadata_json, run.ended_at, run.run_id)
        db.prepare('INSERT INTO dsh_execution_owners(dsh_session_id,workspace,mode,start_id,run_id) VALUES(?,?,?,?,?)')
          .run(owner.dsh_session_id, owner.workspace, owner.mode, owner.start_id, owner.run_id)
      } finally { db.close() }
    }
    if (reload) await f.reloadHost('compiled')
    f.responses.push(
      f.mock.toolCallResponse('edit-next-turn', 'edit', { file_path: file, old_string: 'same-turn', new_string: 'next-turn' }),
      (q: any) => { assert.equal(result(q, 'edit-next-turn').isError, false, JSON.stringify(result(q, 'edit-next-turn'))); return f.mock.textResponse('Edited again.') },
    )
    await f.turn('続けて修正してください。')
    assert.equal(await readFile(file, 'utf8'), 'next-turn\n')
    assert.equal(cancelledQuestions, 1, 'direct editing must not reopen the cancelled intake')
    f.responses.push(
      interpretedPreparation(f.mock, 'fresh-preparation', 'new', 'change', 'debug'),
      (q: any) => {
        assert.equal(result(q, 'fresh-preparation').isError, false, JSON.stringify(result(q, 'fresh-preparation')))
        return f.mock.toolCallResponse('status-after-reprepare', 'task_completion', { action: 'status' })
      },
      (q: any) => {
        assert.equal(result(q, 'status-after-reprepare').isError, false, JSON.stringify(result(q, 'status-after-reprepare')))
        return f.mock.textResponse('Fresh preparation is available.')
      },
    )
    await f.turn('新しい修正としてregression.txtを確認し、必要なら修正してください。完了条件: next-turnと記録されていること。')
  } finally { await f.close() }
})
