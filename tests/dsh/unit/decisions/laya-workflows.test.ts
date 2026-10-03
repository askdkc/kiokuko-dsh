import assert from 'node:assert/strict'
import test from 'node:test'
import { selectInstalledSkills } from '../../../../src/dsh/decisions/skill-selection.js'
import { DecisionService } from '../../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../../src/dsh/decisions/config.js'
import type { CapabilityDescriptor, CapabilityResolution } from '../../../../src/akinator/capabilities.js'
const signal = () => new AbortController().signal
const catalog: CapabilityDescriptor[] = [ { kind: 'skill', name: 'mandatory', description: 'Required code contract' }, ...['a','b','c','d','e','f'].map(name => ({ kind: 'skill' as const, name, description: 'Code debugging support' })) ]
const resolution: CapabilityResolution = { availability: 'known-nonempty', catalogProvided: true, availableSkillCount: 7, diagnostics: { received: 7, accepted: 7, truncated: 0, dropped: 0 }, warnings: [], recommendations: [
  { kind: 'skill', name: 'mandatory', availability: 'available', reason: 'policy', source: 'akinator_policy', required: true },
  ...['a','b','c','d','e'].map(name => ({ kind: 'skill' as const, name, availability: 'available' as const, reason: 'similarity', source: 'catalog_similarity' as const })) ] }
for (const choice of ['skill-1', 'none', 'abstain', 'failed']) test(`mandatory Skills survive Laya ${choice}; unassessed baseline stays; no second winner search`, async () => {
  const inputs: any[] = []
  const service = new DecisionService(TypedDecisionsConfig.parse({ provider: 'laya-coreml', 'laya-coreml': { protocol: 'v1', model: 'laya-rl-agent' } }), () => ({ capabilities: { maxQuestions: 1, maxChoices: 32, maxBytes: 262144 },
    evaluate: async batch => { inputs.push(batch); if (choice === 'failed') throw new (await import('../../../../src/dsh/decisions/contracts.js')).DecisionError('UNAVAILABLE')
      return { provider: 'laya-coreml', requestedModel: 'fixture', policyVersion: 'fixture', answers: batch.questions.map(q => choice === 'abstain'
        ? { id: q.id, status: 'abstained', reason: 'uncertain' } : { id: q.id, status: 'selected', choiceId: choice }) } } }))
  const selected = await selectInstalledSkills(service, 'skills', 'Code debugging support', catalog, resolution, signal())
  assert.ok(selected.includes('mandatory')); assert.ok(selected.includes('e')); assert.equal(inputs.length, 1)
  assert.equal(inputs[0].state, 'Code debugging support'); assert.equal(inputs[0].questions[0].choices.length, 6)
  assert.equal(selected.includes('f'), false)
  if (choice === 'none' || choice === 'abstain') assert.deepEqual(selected, ['mandatory','e'])
  if (choice === 'skill-1') assert.deepEqual(selected, ['mandatory','b','e'])
  const before = inputs.length
  await selectInstalledSkills(service, 'skills', 'Code debugging support', catalog, resolution, signal()); assert.equal(inputs.length, before)
  await selectInstalledSkills(service, 'skills', 'Code debugging support', [...catalog, { kind: 'skill', name: 'z', description: 'Unrelated' }], resolution, signal()); assert.equal(inputs.length, before + 1)
})
