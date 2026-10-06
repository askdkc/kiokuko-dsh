import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCapabilities } from '../../../src/akinator/capabilities.js'
import { createStandardSkillProvider } from '../../../src/dsh/standard-skill-provider.js'
import { buildDshMessageSources } from '../../../src/dsh/message-sources.js'
import { codingSkills } from '../../../src/dsh/modules/resources.js'

const name = 'coding-ideal-routine-skill'

test('coding routine is bundled, selected by coding policy and delivered to the model', async () => {
  const provider = createStandardSkillProvider()
  try {
    const listed = await provider.list({})
    const candidates = 'candidates' in listed ? listed.candidates : listed
    const candidate = candidates.find(skill => skill.name === name)
    assert.ok(candidate, 'coding routine must be available in the bundled provider')
    assert.ok(codingSkills.resources?.some(resource => resource.name === name))
    const definition = await provider.get(candidate, {})
    assert.ok(definition)
    const task = 'Implement a function in the source code.'
    const resolution = resolveCapabilities({ task,
      profile: { taskType: 'build', target: 'source code', expected: 'working function', constraints: null },
      recommendedTags: [], memoryUse: 'none', capabilities: candidates.map(skill => ({ kind: 'skill', name: skill.name })),
    })
    const routes = resolution.recommendations.filter(skill => skill.source === 'akinator_policy' && skill.availability === 'available').map(skill => skill.name)
    assert.ok(routes.includes(name), 'coding policy must select the routine without similarity matching')
    const messages = await buildDshMessageSources({ task, intakeStatus: 'ready', nextAction: 'proceed', context: null,
      memoryPolicy: { memoryReasoningRequired: false, contextWithheld: false }, routeSkillNames: routes })
    assert.equal(messages.find(message => message.name === name)?.text, definition.content)
    const unrelated = resolveCapabilities({ task: 'Explain a poem.',
      profile: { taskType: 'writing', target: 'poem', expected: 'explanation', constraints: null },
      recommendedTags: [], memoryUse: 'none', capabilities: candidates.map(skill => ({ kind: 'skill', name: skill.name })),
    })
    assert.ok(!unrelated.recommendations.some(skill => skill.name === name && skill.source === 'akinator_policy'))
  } finally { provider.dispose() }
})
