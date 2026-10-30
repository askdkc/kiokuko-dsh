import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NodeSqliteAdapter } from '../../../src/db/adapter.js'
import { migrateDatabase } from '../../../src/db/migrate.js'
import { openConnection } from '../../../src/db/connection.js'
import { createEmbeddingRuntime } from '../../../src/embedding/runtime.js'
import { defaultEmbeddingConfig } from '../../../src/embedding/settings.js'
import { canonicalContentHash } from '../../../src/serialization/validate.js'
import { DshAnswerContext } from '../../../src/dsh/answer-context.js'
import { MemoryRetrievalConfig } from '../../../src/memory/retrieval-contracts.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { workingLispTask } from '../helpers/lisp-task.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
isolateSkillHome()

test('answer Skill delivery retains one origin per request and recovers after compaction without dropping human or foreign messages', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'answer-skill-delivery-')),
  )
  await mkdir(join(root, '.git'))
  const db = new NodeSqliteAdapter(':memory:', new DatabaseSync(':memory:'))
  migrateDatabase(db)
  let instructions = [
    'Applicable installed Skill for this request: kiokuko-lisp\n\n' +
      'bounded instructions '.repeat(1300),
  ]
  const events: any[] = []
  const agent = {
    id: 'agent',
    session: { id: 'session', snapshotEvents: () => events },
  }
  const task = 'Inspect the requested file without changing it.'
  const input = {
    agent,
    turn: 1,
    step: 1,
    messages: [{ id: 'human', role: 'user', content: task }],
    signal: new AbortController().signal,
  }
  const identity = {
    agentId: agent.id,
    sessionId: agent.session.id,
    turn: 1,
    requestDigest: canonicalContentHash(task),
  }
  const context = new DshAnswerContext(
    {
      withDatabase: async (action) =>
        action(
          db,
          createEmbeddingRuntime(db, {
            ...defaultEmbeddingConfig(),
            mode: 'off',
          }),
        ),
    },
    {
      root,
      projectOnly: true,
      memoryRetrieval: MemoryRetrievalConfig.parse({}),
      instructions: async () => instructions,
    },
  )
  try {
    await context.prepare(input, task, null, 'none')
    const first = (await context.project(input, [], identity)) as any[]
    assert.equal(first.length, 1)
    events.push({
      seq: 0,
      type: 'user/message',
      surfaceOp: 'append',
      data: first[0],
    })
    assert.deepEqual(
      await context.project(input, [], identity),
      [],
      'retained native history already carries this instruction',
    )
    const human = {
      id: 'human-resend',
      role: 'user',
      content: first[0].content,
      source: { kind: 'user' },
    }
    const foreign = {
      ...first[0],
      source: {
        kind: 'plugin:another',
        form: 'instructions',
        name: 'answer-skills',
      },
    }
    const tool = { role: 'tool', toolCallId: 'read', content: first[0].content }
    assert.deepEqual(
      await context.project(input, [human, foreign, tool, first[0]], identity),
      [human, foreign, tool],
    )
    await context.prepare(input, task, null, 'none')
    assert.deepEqual(
      await context.project(input, [], identity),
      [],
      'same-request preparation retry must retain the origin',
    )
    events.length = 0
    assert.deepEqual(
      await context.project(input, [], identity),
      first,
      'compaction can require the same instruction again',
    )
    events.push({
      seq: 1,
      type: 'user/message',
      surfaceOp: 'append',
      data: first[0],
    })
    const next = { ...input, turn: 2 },
      nextIdentity = { ...identity, turn: 2 }
    await context.prepare(next, task, null, 'none')
    const second = (await context.project(next, [], nextIdentity)) as any[]
    assert.equal(second.length, 1)
    assert.notEqual(
      second[0].id,
      first[0].id,
      'another request is a distinct origin',
    )
    events.push({
      seq: 2,
      type: 'user/message',
      surfaceOp: 'append',
      data: second[0],
    })
    instructions = ['Updated applicable instructions']
    await context.prepare(next, task, null, 'none')
    const updated = (await context.project(next, [], nextIdentity)) as any[]
    assert.equal(updated.length, 1)
    assert.notEqual(updated[0].id, second[0].id)
    assert.equal(updated[0].content[0].text, instructions[0])
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

const packages =
  process.env.KIOKUKO_DSH_PACKAGE_ROOT ??
  join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
for (const entry of [
  'web',
  ...(process.env.KIOKUKO_CLI_HOST_ROOT ? ['cli'] : []),
]) {
  test(
    `${entry}: repeated real native Skill reads do not reinject the installed Skill body`,
    { timeout: 30000 },
    async () => {
      // Only model/Skill selection is scripted; native delivery, history and tool dispatch are real.
      const DecisionClass = process.env.KIOKUKO_SKILL_PACKAGE_ROOT
        ? (
            await import(
              pathToFileURL(
                join(
                  process.env.KIOKUKO_SKILL_PACKAGE_ROOT,
                  'dist/dsh/decisions/service.js',
                ),
              ).href
            )
          ).DecisionService
        : DecisionService
      const evaluate = DecisionClass.prototype.evaluate
      const selection = mock.method(
        DecisionClass.prototype,
        'evaluate',
        function (this: any, ...args: any[]) {
          const batch = args[1]
          if (batch.purpose !== 'skills') return evaluate.apply(this, args)
          return Promise.resolve({
            status: 'completed',
            result: {
              provider: 'fixture',
              requestedModel: 'fixture',
              policyVersion: 'fixture',
              answers: batch.questions.map((q: any) => ({
                id: q.id,
                status: 'selected',
                choiceId: q.instructions.includes('"name":"kiokuko-lisp"')
                  ? 'yes'
                  : 'no',
              })),
            },
          })
        },
      )
      const hostPlugin =
        entry === 'cli'
          ? await import(
              pathToFileURL(
                join(
                  process.env.KIOKUKO_CLI_HOST_ROOT!,
                  'src/dsh-adapter/plugin-host.ts',
                ),
              ).href
            )
          : undefined
      const f = await nativeSkillFixture({
        packages,
        ...(process.env.KIOKUKO_SKILL_PACKAGE_ROOT
          ? { packageRoot: process.env.KIOKUKO_SKILL_PACKAGE_ROOT }
          : {}),
        hostPlugin,
        extra: {
          lisp: { enabled: false },
          typedDecisions: { mode: 'off' },
          answerReview: { mode: 'off' },
          memoryReview: { mode: 'off' },
          memoryEvolution: { mode: 'off' },
          memoryIndexReasoning: { mode: 'off' },
          deepPlanning: { enabled: false },
          modelAutoMode: { mode: 'off' },
        },
      })
      try {
        const db = openConnection(join(f.dir, 'kiokuko-dsh.sqlite3'))
        try {
          workingLispTask(db, {
            root: f.dir,
            sessionId: f.agent.session.id,
            agentId: f.agent.id,
          })
        } finally {
          db.close()
        }
        let requests = 0
        for (let step = 0; step <= 6; step++)
          f.responses.push((request: any) => {
            const skillMessages = request.messages.filter(
              (message: any) =>
                message.role === 'user' &&
                message.content.some(
                  (part: any) =>
                    part.type === 'text' &&
                    part.text.startsWith(
                      'Applicable installed Skill for this request: kiokuko-lisp\n',
                    ),
                ),
            )
            assert.equal(
              skillMessages.length,
              1,
              `step ${step}: exactly one retained Skill body belongs to this request`,
            )
            requests++
            if (step) {
              const result = nativeToolResults(request.messages).find(
                (item: any) => item.toolCallId === `read-skill-${step - 1}`,
              )
              assert.ok(result && !result.isError, JSON.stringify(result))
            }
            return step === 6
              ? f.mock.textResponse('The real native Skill reads completed.')
              : f.mock.toolCallResponse(`read-skill-${step}`, 'skill', {
                  name: 'kiokuko-lisp',
                })
          })
        await f.turn(
          'Explain the installed kiokuko-lisp Skill. Read it without editing any files.',
        )
        assert.equal(requests, 7)
        assert.equal(
          f.agent.session
            .snapshotEvents()
            .filter((e: any) => e.type === 'tool/result').length,
          6,
          'intentional repeated tool results remain intact',
        )
      } finally {
        await f.close()
        selection.mock.restore()
      }
    },
  )
}
