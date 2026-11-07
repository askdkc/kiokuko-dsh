import assert from 'node:assert/strict'
import test from 'node:test'
import { CodingDefinitionSchema, CODING_MINIMUM_DEFINITION_EXAMPLE } from '../../../../src/dsh/coding-workflow/contracts.js'

test('legacy plans preserve incomplete Goal mappings and normalize exact duplicate references', () => {
  const input = structuredClone(CODING_MINIMUM_DEFINITION_EXAMPLE)
  input.goal.criterionIds.push('goal-check')
  input.items[0]!.goalCriterionIds = ['not-mapped-yet', 'not-mapped-yet']
  const definition = CodingDefinitionSchema.parse(input)
  assert.deepEqual(definition.goal.criterionIds, ['goal-check'])
  assert.deepEqual(definition.items[0]!.goalCriterionIds, ['not-mapped-yet'])
  assert.deepEqual(input.items[0]!.goalCriterionIds, ['not-mapped-yet', 'not-mapped-yet'])
  input.items[0]!.goalCriterionIds = []
  assert.deepEqual(CodingDefinitionSchema.parse(input).items[0]!.goalCriterionIds, [])
})

test('malformed legacy execution references still report the exact field', () => {
  const input = structuredClone(CODING_MINIMUM_DEFINITION_EXAMPLE)
  input.items[0]!.criterionIds.push('missing')
  const parsed = CodingDefinitionSchema.safeParse(input)
  assert.equal(parsed.success, false)
  assert.deepEqual(parsed.error?.issues[0]?.path, ['items', 0, 'criterionIds', 1])
  assert.match(parsed.error?.issues[0]?.message ?? '', /Missing item criterion: missing/u)
})
