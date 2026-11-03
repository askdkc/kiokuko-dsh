/** Explicit test-user answers for fixtures testing a contract other than intake. */
export function answerFixtureScope(request: any): DshUserQuestionAnswer | undefined {
  const q = request.questions[0]
  if (!['target', 'expected'].includes(q?.id)) return undefined
  return { answers: [{ id: q.id, selected: [], custom: q.id === 'target'
    ? 'the fixture repository source' : 'the requested fixture result is verified' }] }
}
import type { DshUserQuestionAnswer } from '../../../src/dsh/intake-questions.js'
