import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCapabilities } from '../../../src/akinator/capabilities.js'
import { createStandardSkillProvider } from '../../../src/dsh/standard-skill-provider.js'
import { buildDshMessageSources } from '../../../src/dsh/message-sources.js'
import { codingSkills } from '../../../src/dsh/modules/resources.js'
import { compileSkillBundle } from '../../../src/dsh/skill-compiler.js'
import { loadSkillSources } from '../../../src/dsh/skill-sources.js'

const name = 'coding-ideal-routine-skill'

test('always-delivered SOUL guides document verification and successive file edits in both representations', async () => {
  const sources = await loadSkillSources()
  const soul = sources.find(source => source.name === 'kiokuko-soul' && source.relativePath === 'SKILL.md')!
  const compiled = compileSkillBundle(sources).resources.find(resource => resource.id === 'kiokuko-soul/SKILL.md')!
  for (const content of [soul.content, compiled.content]) {
    assert.match(content, /Before diagnostics.*supported.*file/iu)
    assert.match(content, /Markdown.*document.*read.*structure.*requirements.*whitespace/iu)
    assert.match(content, /After a successful.*edit.*write.*re-read.*before.*next mutation/iu)
    assert.match(content, /stale.*re-read.*reconcile.*never.*overwrite/iu)
    assert.match(content, /unavailable.*unverified.*not.*clean/iu)
  }
  const messages = await buildDshMessageSources({ task: 'Revise PLAN.md.', intakeStatus: 'ready', nextAction: 'proceed', context: null,
    memoryPolicy: { memoryReasoningRequired: false, contextWithheld: false } })
  assert.ok(messages.find(message => message.name === 'kiokuko-soul')?.text.includes(soul.content), 'writing must receive the safeguards without a coding route')
})

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
