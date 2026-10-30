import assert from 'node:assert/strict'

// This is the expected public UI contract, independent of the implementation's constants.
export const STARTUP_FIXTURE_CHOICES = [
  'decision ON / Lisp ON', 'decision ON / Lisp OFF',
  'decision OFF / Lisp ON', 'decision OFF / Lisp OFF', '取消・作業を保持',
] as const
export type StartupFixtureChoice = typeof STARTUP_FIXTURE_CHOICES[number]

export function answerTaskStartup(request: any, selected: StartupFixtureChoice) {
  assert.equal(request.questions?.length, 1, 'startup must be one combined question')
  const question = request.questions[0]
  assert.match(question.id, /^task-startup:[a-f0-9]{64}:\d{16}:[a-f0-9]{64}$/u)
  assert.equal(question.header, 'Kiokuko · 作業開始')
  assert.equal(question.question, 'この作業で decision と Lisp を使いますか？')
  assert.deepEqual(question.options, STARTUP_FIXTURE_CHOICES.map(label => ({ label })))
  assert.ok(STARTUP_FIXTURE_CHOICES.includes(selected), 'fixture must select an explicit startup choice')
  return { answers: [{ id: question.id, selected: [selected] }] }
}
