import assert from 'node:assert/strict'
import test from 'node:test'
import { DeepConfigurationUI } from '../../../src/deep-thinker/configuration.js'
import { DEEP_ROLES } from '../../../src/deep-thinker/core/contracts.js'
import type { DshModelCatalog, ModelRoute } from '../../../src/dsh/model-configuration.js'
import type { DshUserQuestions } from '../../../src/dsh/user-interaction.js'
import { deepFixture } from '../helpers/deep-fixture.js'

for (const family of ['deepseek', 'orcarouter'] as const) test(`Deep configuration accepts, saves and reloads the shared ${family} route`, async () => {
  const f = await deepFixture()
  const routes: ModelRoute[] = (['other', family] as const).map((family, index) => ({ provider: `route-${index}`, family, connection: 'api', protocol: 'chat-completions' }))
  const catalog: DshModelCatalog = {
    listProviders: () => routes.map(r => ({ id: r.provider, name: r.provider })),
    listModels: async provider => [{ provider, id: 'configured-model', name: 'Configured model' }],
  }
  const questions: DshUserQuestions = { ask: async request => {
    const question = request.questions[0]
    assert.equal(question.id, 'deep-configuration')
    assert.ok(question.options?.some(o => o.label === '保存'))
    return { answers: [{ id: question.id, selected: ['保存'] }] }
  } }
  const ui = new DeepConfigurationUI(f.store, catalog, questions, routes, undefined, f.configuration.budget)
  const existing = { id: 'parent', options: { provider: 'route-0', model: 'configured-model' } }
  try {
    // An additional route must not break a different current model's default configuration.
    assert.deepEqual((await ui.resolve(f.state.workspace, existing))?.routeBindings, routes)
    const selected = { ...existing, options: { ...existing.options, provider: 'route-1' } }
    const saved = await ui.configure(f.state.workspace, selected, new AbortController().signal)
    for (const role of DEEP_ROLES) assert.deepEqual(saved.roles[role], selected.options)
    assert.deepEqual(await ui.resolve(f.state.workspace, existing), saved)
  } finally { await f.close() }
})
