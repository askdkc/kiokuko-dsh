import assert from 'node:assert/strict'
import test from 'node:test'
import { LispRecoverySession } from '../../../../src/dsh/lisp/recovery.js'

const context = () => ({ generation: 'generation', evaluationId: 'evaluation', signal: new AbortController().signal })
const input = (n = 1) => ({ ticket: `generation/evaluation/${n}`, condition: 'SIMPLE-ERROR', context: { local: 41 },
  restarts: [{ id: `generation/evaluation/${n}/0`, description: 'Use captured local value' }], timeoutMs: 100 })
const selected = async (batch: any) => ({ status: 'completed', result: { answers: [{ id: batch.questions[0].id, status: 'selected', choiceId: batch.questions[0].choices[0].id }] } })
const current = async () => {}

test('recovery binds evaluation, consumes each ticket once, and caps all attempts', async () => {
  const session = new LispRecoverySession('generation', 'evaluation')
  assert.equal((await session.select(input(), context(), selected, current)).restartId, 'generation/evaluation/1/0')
  await assert.rejects(session.select(input(), context(), selected, current), { code: 'RECOVERY_CONSUMED' })
  for (let n = 2; n <= 4; n++) await session.select(input(n), context(), selected, current)
  await assert.rejects(session.select(input(5), context(), selected, current), { code: 'RECOVERY_LIMIT' })
})

test('stale generation, evaluation, restart id and malformed evidence never dispatch', async () => {
  let calls = 0
  const run = async () => { calls++; return {} }
  for (const request of [{ ...input(), ticket: 'old/evaluation/1' }, { ...input(), restarts: [{ id: 'old', description: 'stale' }] },
    { ...input(), timeoutMs: 99 }, { ...input(), restarts: [] }, { ...input(), context: 'x'.repeat(300000) }]) {
    await assert.rejects(new LispRecoverySession('generation', 'evaluation').select(request, context(), run, current))
  }
  await assert.rejects(new LispRecoverySession('generation', 'old').select(input(), context(), run, current), { code: 'RECOVERY_STALE' })
  assert.equal(calls, 0)
})

test('abstention, fallback, old/duplicate answers and arbitrary selection never invoke a restart', async () => {
  for (const response of [undefined, { status: 'fallback' }, ...[
    [{ id: input().ticket, status: 'abstained', reason: 'uncertain' }],
    [{ id: 'old', status: 'selected', choiceId: input().restarts[0]!.id }],
    [{ id: input().ticket, status: 'selected', choiceId: 'old' }],
    [{ id: input().ticket, status: 'selected', choiceId: input().restarts[0]!.id }, { id: input().ticket, status: 'selected', choiceId: input().restarts[0]!.id }],
  ].map(answers => ({ status: 'completed', result: { answers } }))]) {
    const session = new LispRecoverySession('generation', 'evaluation')
    await assert.rejects(session.select(input(), context(), async () => response, current), { code: 'RECOVERY_DECLINED' })
    await assert.rejects(session.select(input(), context(), selected, current), { code: 'RECOVERY_CONSUMED' })
  }
})

test('hung provider deadline and cancelled/late selections are terminal; authority rechecked', async () => {
  const session = new LispRecoverySession('generation', 'evaluation')
  let late!: (value: unknown) => void
  const timed = session.select(input(), context(), async () => new Promise(resolve => { late = resolve }), current)
  await assert.rejects(timed, { code: 'RECOVERY_TIMEOUT' })
  late(await selected({ questions: [{ id: input().ticket, choices: input().restarts }] }))
  await assert.rejects(session.select(input(), context(), selected, current), { code: 'RECOVERY_CONSUMED' })
  const abort = new AbortController(); abort.abort()
  await assert.rejects(new LispRecoverySession('generation', 'evaluation').select(input(), { ...context(), signal: abort.signal }, selected, current))
  let checks = 0
  await assert.rejects(new LispRecoverySession('generation', 'evaluation').select(input(), context(), selected, async () => {
    if (++checks === 2) throw new Error('task revoked')
  }), /task revoked/)
  assert.equal(checks, 2)
})


test('concurrent duplicate selection admits exactly one provider call', async () => {
  const session = new LispRecoverySession('generation', 'evaluation')
  let calls = 0
  const results = await Promise.allSettled([1, 2].map(() => session.select(input(), context(), async batch => {
    calls++; return selected(batch)
  }, current)))
  assert.equal(calls, 1)
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'RECOVERY_CONSUMED')
})


test('safety budgets accept boundary values and reject neighbours without dispatch', async () => {
  let calls = 0
  const evaluate = async (batch: unknown) => { calls++; return selected(batch) }
  for (const count of [1, 8]) for (const timeoutMs of [100, 30000]) {
    const request = { ...input(), timeoutMs, restarts: Array.from({ length: count }, (_, i) => ({ id: `${input().ticket}/${i}`, description: `Continuation ${i}` })) }
    await new LispRecoverySession('generation', 'evaluation').select(request, context(), evaluate, current)
  }
  assert.equal(calls, 4)
  for (const count of [0, 9]) for (const timeoutMs of [99, 30001]) {
    const request = { ...input(), timeoutMs, restarts: Array.from({ length: count }, (_, i) => ({ id: `${input().ticket}/${i}`, description: `Continuation ${i}` })) }
    await assert.rejects(new LispRecoverySession('generation', 'evaluation').select(request, context(), evaluate, current))
  }
  for (const timeoutMs of [99, 30001]) await assert.rejects(new LispRecoverySession('generation', 'evaluation').select({ ...input(), timeoutMs }, context(), evaluate, current))
  for (const count of [0, 9]) await assert.rejects(new LispRecoverySession('generation', 'evaluation').select({ ...input(), restarts: Array.from({ length: count }, (_, i) => ({ id: `${input().ticket}/${i}`, description: `Continuation ${i}` })) }, context(), evaluate, current))
  assert.equal(calls, 4)
})

test('abort during initial authority check never dispatches a provider', async () => {
  const abort = new AbortController(); let calls = 0
  await assert.rejects(new LispRecoverySession('generation', 'evaluation').select(input(), { ...context(), signal: abort.signal }, async batch => {
    calls++; return selected(batch)
  }, async () => { abort.abort() }))
  assert.equal(calls, 0)
})


test('failed choices consume the same four-attempt budget', async () => {
  const session = new LispRecoverySession('generation', 'evaluation')
  for (let n = 1; n <= 4; n++) await assert.rejects(session.select(input(n), context(), async () => ({ status: 'fallback' }), current), { code: 'RECOVERY_DECLINED' })
  await assert.rejects(session.select(input(5), context(), selected, current), { code: 'RECOVERY_LIMIT' })
})
