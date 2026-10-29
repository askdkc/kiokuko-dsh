import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { openConnection } from '../../../src/db/connection.js'
import { DecisionError } from '../../../src/dsh/decisions/contracts.js'
import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import {
  createRequestIntentContext,
  requestIntentMessageRefs,
  requestIntentReferenceIds,
} from '../../../src/dsh/decisions/request-intent.js'
import { prepareAgentTask } from '../../../src/dsh/task-intake.js'
import { initializeCodingWorkflow } from '../../../src/dsh/coding-workflow/store.js'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { isolateSkillHome } from '../helpers/skill-home.js'
isolateSkillHome()
const packages =
  process.env.KIOKUKO_DSH_PACKAGE_ROOT ??
  join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
for (const provider of ['off', 'abstain', 'unavailable'] as const) {
  test(
    `source-bound Lisp intake keeps current references for first and queued turns with provider ${provider}`,
    { timeout: 30000 },
    async () => {
      let questions = 0,
        decisionsSent = 0
      const decisions = new DecisionService(
        TypedDecisionsConfig.parse(
          provider === 'off' ? { mode: 'off' } : { provider: 'typesafe' },
        ),
        () =>
          ({
            capabilities: {
              maxQuestions: 256,
              maxChoices: 256,
              maxBytes: 262144,
            },
            async evaluate(batch: any) {
              if (batch.purpose === 'request-intent') decisionsSent++
              if (provider === 'unavailable')
                throw new DecisionError('UNAVAILABLE')
              return {
                provider: 'fixture',
                requestedModel: 'fixture',
                policyVersion: 'fixture',
                answers: batch.questions.map((q: any) => ({
                  id: q.id,
                  status: 'abstained',
                  reason: 'insufficient',
                })),
              }
            },
          }) as any,
      )
      const firstText = 'Implement parser.ts without publishing.',
        secondText =
          'Explain QUEUED_READ_ONLY_TOPIC without changing any files.'
      let second: any
      const f = await nativeSkillFixture({
        packages,
        explicit: true,
        mode: 'compiled',
        decisions,
        extra: {
          lisp: {
            enabled: true,
            executionMode: 'development',
            sbclPath: process.env.KIOKUKO_LISP_SBCL,
          },
          typedDecisions:
            provider === 'off' ? { mode: 'off' } : { provider: 'typesafe' },
          answerReview: { mode: 'off' },
          memoryReview: { mode: 'off' },
          memoryEvolution: { mode: 'off' },
          memoryIndexReasoning: { mode: 'off' },
          deepPlanning: { enabled: false },
          modelAutoMode: { mode: 'off' },
        },
        nativeAnswer: async (q) => {
          assert.match(q.questions[0].id, /^lisp-early-/)
          questions++
          assert.equal(
            f.agent.session
              .snapshotEvents()
              .filter((e: any) => e.type === 'turn/start').length,
            0,
            'Only Lisp availability is prepared before turn/start',
          )
          f.agent.followup(second)
          return {
            answers: [{ id: q.questions[0].id, selected: ['使わない'] }],
          }
        },
      })
      const errors: unknown[] = []
      const offError = f.ctx.on('agent/error', (event: any) =>
        errors.push(event.error),
      )
      try {
        const db = openConnection(join(f.dir, 'state.sqlite3'))
        try {
          const task = 'Implement a previous parser in src/parser.ts'
          const prepared = await prepareAgentTask(db, {
            requestId: 'previous-work',
            dshSessionId: f.agent.session.id,
            cwd: f.dir,
            task,
            profileHints: {
              taskType: 'build',
              target: 'src/parser.ts',
              expected: 'Parser works',
              constraints: 'No publishing',
            },
            capabilities: [],
            skillDiscoveryMode: 'off',
            completionMode: 'shadow',
          })
          initializeCodingWorkflow(db, {
            runId: prepared.run.runId,
            sessionId: f.agent.session.id,
            repositoryRoot: f.dir,
            requestId: 'previous-work',
            task,
          })
        } finally {
          db.close()
        }
        const first = f.llm.createUserMessage({
          content: [{ type: 'text', text: firstText }],
          source: { kind: 'user' },
        })
        second = f.llm.createUserMessage({
          content: [{ type: 'text', text: secondText }],
          source: { kind: 'user' },
        })
        for (const [turn, message, task] of [
          [1, first, firstText],
          [2, second, secondText],
        ] as const) {
          f.responses.push((q: any) => {
            const starts = f.agent.session
              .snapshotEvents()
              .filter(
                (event: any) =>
                  event.type === 'turn/start' && event.data.turn === turn,
              )
            assert.equal(
              starts.length,
              1,
              'Source evidence requires the actual current turn boundary',
            )
            const section = q.messages
              .flatMap((m: any) => m.source?.sections ?? [])
              .filter((s: any) => s.name === 'on-demand-intake')
              .at(-1)
            const line = section?.text
              .split('\n')
              .find((value: string) => value.startsWith('{"references":'))
            assert.ok(
              line,
              'Current host evidence must survive unavailable/abstaining decisions',
            )
            const envelope = JSON.parse(line)
            const context = createRequestIntentContext({
              task,
              messageRefs: requestIntentMessageRefs([message], task),
            })
            assert.ok(context)
            assert.ok(
              envelope.references.includes(
                requestIntentReferenceIds(context)[0],
              ),
              `Turn ${turn} references must bind this input, not a cached earlier turn`,
            )
            return f.mock.textResponse(`Read-only reply for turn ${turn}.`)
          })
        }
        f.agent.followup(first)
        await f.agent.whenIdle()
        assert.deepEqual(
          errors,
          [],
          'Provider failure must not become a generic agent error',
        )
        assert.equal(questions, 1)
        assert.equal(f.model.requests.length, 2)
        if (provider !== 'off')
          assert.ok(
            decisionsSent > 0 && decisionsSent <= 4,
            `Decision calls must be finite: ${decisionsSent}`,
          )
      } finally {
        offError()
        await f.close()
      }
    },
  )
}
