import assert from 'node:assert/strict'
import type { CodingDefinition } from '../../../src/dsh/coding-workflow/contracts.js'
import { nativeToolResults } from './native-mock.js'

export function toolValue(request: any, id: string): any {
  const result = nativeToolResults(request.messages).filter(value => value.toolCallId === id).at(-1)
  assert.ok(result && !result.isError, JSON.stringify(result))
  return JSON.parse(result.content.filter((value: any) => value.type === 'text').map((value: any) => value.text).join(''))
}
export function fixtureDefinition(target = 'src/parser.mjs'): CodingDefinition {
  return {
    goal: { goalId: 'goal', revision: 1, ideal: 'The user can run the public parser entry and get the requested value', target,
      outOfScope: ['Publishing or deployment'], constraints: ['Keep existing inputs compatible'], requestBasis: `Implement ${target}`, criterionIds: ['user-entry'] },
    items: [{ itemId: 'implementation', change: `Implement ${target} and its regression assertions`, dependsOn: [], criterionIds: ['regression'], goalCriterionIds: ['user-entry'] }],
    criteria: [{ criterionId: 'regression', revision: 1, outcome: 'The parser handles the requested input', procedure: 'Run the selected regression assertions', expected: 'All selected assertions pass without skips', evidence: 'selected_tests' },
      { criterionId: 'user-entry', revision: 1, outcome: 'The public entry returns the expected value', procedure: 'After item checks, run assertions that launch the public entry', expected: 'Public entry outputs 42', evidence: 'selected_tests' }],
  }
}
/** The scripted model supplies the same public proposals as a real coding agent. */
export function codingPrelude(mock: any, prefix: string, definition = fixtureDefinition()): any[] {
  const status = `${prefix}-status`, propose = `${prefix}-propose`
  return [mock.toolCallResponse(status, 'coding_workflow', { action: 'status' }),
    (request: any) => mock.toolCallResponse(propose, 'coding_workflow', {
      action: 'propose', expectedRevision: toolValue(request, status).revision, definition,
    })]
}
