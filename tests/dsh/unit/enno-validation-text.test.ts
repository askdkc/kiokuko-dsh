import assert from 'node:assert/strict'
import test from 'node:test'
import * as z from 'zod/v4'
import { acceptanceCriterionSchema } from '../../../src/enno-oduno/schemas.js'
import { publicIssuesFromZod } from '../../../src/enno-oduno/validation-errors.js'

test('multiline canonical-text failures retain the public non-canonical reason', () => {
  const parsed = acceptanceCriterionSchema.safeParse({
    id: 'criterion',
    description: 'before\u0000after',
  })
  assert.equal(parsed.success, false)
  if (parsed.success) return

  assert.deepEqual(publicIssuesFromZod(parsed.error), [{
    path: ['description'],
    reasonCode: 'non_canonical_text',
  }])
})

test('multiline Enno text requires canonical LF without changing slash or file mentions', () => {
  const parsed = acceptanceCriterionSchema.parse({
    id: 'criterion',
    description: '@PLAN.md\nCheck /api/v1\nDo not run /not-a-command',
  })

  assert.equal(parsed.description, '@PLAN.md\nCheck /api/v1\nDo not run /not-a-command')
  assert.equal(acceptanceCriterionSchema.safeParse({
    id: 'criterion',
    description: '@PLAN.md\r\nCheck /api/v1',
  }).success, false)
})

test('multiline validation preserves the model-facing JSON string schema', () => {
  const schema = z.toJSONSchema(acceptanceCriterionSchema, { unrepresentable: 'any' }) as any

  assert.equal(schema.properties.description.type, 'string')
  assert.equal(schema.properties.description.minLength, 1)
  assert.equal(schema.properties.description.maxLength, 8_192)
})
