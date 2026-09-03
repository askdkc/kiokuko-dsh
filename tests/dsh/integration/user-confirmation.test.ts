import assert from 'node:assert/strict'
import test from 'node:test'
import { DshConfirmationController } from '../../../src/dsh/enno-controller.js'
import { createDshConfirmationAnswerer, renderDshConfirmation, type DshUserQuestions } from '../../../src/dsh/user-interaction.js'
import type { UserFacingConfirmation } from '../../../src/enno-oduno/types.js'

function confirmation(): UserFacingConfirmation {
  return {
    presentationVersion: 2,
    language: 'en',
    title: 'Plan approval',
    summary: { basis: 'proposal', text: 'Apply the approved change.' },
    scope: { basis: 'repository', paths: ['src/dsh/commands.ts'] },
    exclusions: { basis: 'user', paths: ['dist/'] },
    completion: { basis: 'proposal', items: ['Focused test passes'] },
    skills: [{ label: 'kiokuko-soul', basis: 'repository', required: true, purposes: ['review'], referenceOnly: false }],
    workItems: [{
      number: 1, summary: 'Implement command', paths: ['src/dsh/commands.ts'], dependsOn: [], doneWhen: ['Command is request-local'],
      checks: [{ category: 'test', executable: 'node', arguments: ['scripts/run-tests.mjs', 'tests/dsh/integration/ponytail-command.test.ts'], directory: '.', timeoutMs: 120000 }],
      expertise: [{ area: 'Input and data boundaries', basis: 'proposal', reason: 'Reject invalid command input' }],
    }],
    finalChecks: { basis: 'repository', checks: [{ category: 'typecheck', executable: 'npm', arguments: ['run', 'typecheck'], directory: '.', timeoutMs: 120000 }] },
    attemptLimit: { basis: 'proposal', maxAttempts: 3 },
    actions: ['approve', 'revise', 'cancel'],
  }
}

function japaneseConfirmation(): UserFacingConfirmation {
  return {
    ...confirmation(),
    language: 'ja',
    title: '計画の確認',
    summary: { basis: 'proposal', text: '承認された変更を実装する。' },
    scope: { basis: 'repository', paths: ['src/dsh/commands.ts'] },
    exclusions: { basis: 'user', paths: ['dist/'] },
    completion: { basis: 'proposal', items: ['対象テストが成功する'] },
    workItems: [{
      number: 1, summary: 'コマンドを実装する', paths: ['src/dsh/commands.ts'], dependsOn: [], doneWhen: ['コマンドがリクエスト単位になる'],
      checks: [{ category: 'test', executable: 'node', arguments: ['scripts/run-tests.mjs', 'tests/dsh/integration/ponytail-command.test.ts'], directory: '.', timeoutMs: 120000 }],
      expertise: [{ area: '入力とデータの境界', basis: 'proposal', reason: '不正なコマンド入力を拒否する' }],
    }],
  }
}

function service(answer: { selected: string[]; custom?: string }): DshUserQuestions {
  return { ask: async (request) => ({ answers: [{ id: request.questions[0]!.id, selected: answer.selected, ...(answer.custom === undefined ? {} : { custom: answer.custom }) }] }) }
}

test('confirmation renders every public item and preserves command/path/timeout values', () => {
  const text = renderDshConfirmation(confirmation())
  for (const expected of ['src/dsh/commands.ts', 'dist/', 'node', 'scripts/run-tests.mjs', '120000 ms', 'kiokuko-soul']) assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.equal(text.includes('runId'), false)
  assert.equal(text.includes('code.domain.v1'), false)
})

test('Japanese confirmation renders as structured Markdown without changing exact commands or paths', () => {
  const text = renderDshConfirmation(japaneseConfirmation())
  assert.match(text, /^# 計画の確認$/mu)
  for (const heading of ['概要', '対象範囲', '対象外', '完了条件', '使用するスキル', '作業項目', '最終確認', '試行上限']) {
    assert.match(text, new RegExp(`^## ${heading}$`, 'mu'))
  }
  assert.match(text, /^### 1\. コマンドを実装する$/mu)
  assert.match(text, /`src\/dsh\/commands\.ts`/u)
  assert.match(text, /`node` `scripts\/run-tests\.mjs` `tests\/dsh\/integration\/ponytail-command\.test\.ts`/u)
  assert.match(text, /120000 ms/u)
  assert.doesNotMatch(text, /Summary \[|Work items:|doneWhen:|timeoutMs=/u)
})

test('Japanese confirmation request keeps machine decision labels stable while localizing its prompt and help', async () => {
  let received: Parameters<DshUserQuestions['ask']>[0] | undefined
  const answerer = createDshConfirmationAnswerer({
    ask: async (request) => {
      received = request
      return { answers: [{ id: request.questions[0]!.id, selected: ['approve'] }] }
    },
  })
  await answerer.ask(japaneseConfirmation())
  assert.equal(received?.questions[0]?.question, '提案された計画を確認し、操作を選択してください。')
  assert.deepEqual(received?.questions[0]?.options?.map((option) => option.label), ['approve', 'cancel'])
  assert.deepEqual(received?.questions[0]?.options?.map((option) => option.description), [
    'この計画を承認し、最初の作業項目を開始します。',
    '実装を開始せず、このEnno計画を取り消します。',
  ])
})

test('explicit approve is the only path that submits host work', async () => {
  const calls: unknown[] = []
  const questionAgents: unknown[] = []
  const nativeAgent = { id: 'live-confirmation-agent' }
  const controller = new DshConfirmationController({
    answerer: createDshConfirmationAnswerer({
      ask: async (request) => {
        questionAgents.push(request.agent)
        return { answers: [{ id: request.questions[0]!.id, selected: ['approve'] }] }
      },
    }),
    readRevision: () => 2,
    submit: async (input) => { calls.push(input) },
  })
  const result = await controller.confirm({ confirmation: confirmation(), expectedRevision: 2, agent: nativeAgent })
  assert.equal(result.kind, 'submitted')
  assert.deepEqual(calls, [{ action: 'approve', expectedRevision: 2 }])
  assert.deepEqual(questionAgents, [nativeAgent])
})

test('revise requires requested changes and stale answers produce no mutation', async () => {
  const calls: unknown[] = []
  let revision = 3
  const controller = new DshConfirmationController({
    answerer: createDshConfirmationAnswerer(service({ selected: ['revise'], custom: 'Change the focused verifier.' })),
    readRevision: () => revision,
    submit: async (input) => { calls.push(input) },
  })
  const result = await controller.confirm({ confirmation: confirmation(), expectedRevision: 2 })
  assert.deepEqual(result, { kind: 'blocked', reason: 'stale_revision' })
  assert.deepEqual(calls, [])
})

test('headless confirmation is blocked before asking or mutating', async () => {
  let submitted = false
  const result = await new DshConfirmationController({
    readRevision: () => 2,
    submit: () => { submitted = true },
  }).confirm({ confirmation: confirmation(), expectedRevision: 2 })
  assert.deepEqual(result, { kind: 'blocked', reason: 'answerer_unavailable' })
  assert.equal(submitted, false)
})

test('dismissing the dedicated plan review returns the composer without mutating', async () => {
  let submitted = false
  const result = await new DshConfirmationController({
    answerer: { ask: async () => { throw Object.assign(new Error('chat about it'), { code: 'ASK_CANCELLED' }) } },
    readRevision: () => 2,
    submit: () => { submitted = true },
  }).confirm({ confirmation: confirmation(), expectedRevision: 2 })
  assert.deepEqual(result, { kind: 'dismissed' })
  assert.equal(submitted, false)
})
