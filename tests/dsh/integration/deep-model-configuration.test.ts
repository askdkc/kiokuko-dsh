import assert from 'node:assert/strict'
import test from 'node:test'
import { DeepConfigurationUI, deepQuestion } from '../../../src/deep-thinker/configuration.js'
import { DEEP_ROLES } from '../../../src/deep-thinker/core/contracts.js'
import type { DshModelCatalog, ModelRoute } from '../../../src/dsh/model-configuration.js'
import type { DshUserQuestions } from '../../../src/dsh/user-interaction.js'
import { deepFixture } from '../helpers/deep-fixture.js'

test('Deep budget option labels remain exact numbers instead of being reinterpreted as ordinals', async () => {
  for (const value of ['0', '1', '120000']) {
    const result = await deepQuestion({ ask: async request => ({ answers: [{ id: request.questions[0].id, selected: [value] }] }) },
      { id: 'parent' }, new AbortController().signal, 'deep-budget-value', '予算', [value])
    assert.equal(result, value)
  }
})

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

test('quality configuration requires an alternative, preserves drafts and allows the same exact model', async()=>{
  const f=await deepFixture(), steps=['推論:','品質重視（実験）','別案のモデル:','設定済みの役割からコピー','閉じる・下書きを保持','保存']
  const catalog:DshModelCatalog={listProviders:()=>[{id:'mock',name:'Mock'}],listModels:async()=>[{provider:'mock',id:'same',name:'Same'}]}
  const ui=new DeepConfigurationUI(f.store,catalog,{ask:async request=>{
    const q=request.questions[0],prefix=steps.shift()!;const selected=q.options!.find(o=>o.label.startsWith(prefix))
    assert.ok(selected,JSON.stringify(q));return {answers:[{id:q.id,selected:[selected.label]}]}
  }},[{provider:'mock',family:'other',connection:'api',protocol:'chat-completions'}],undefined,f.configuration.budget)
  const parent={id:'parent',options:{provider:'mock',model:'same'}}
  try {
    await assert.rejects(ui.configure(f.state.workspace,parent,new AbortController().signal),/設定待ち/)
    const saved=await ui.configure(f.state.workspace,parent,new AbortController().signal)
    assert.equal(saved.reasoningMode,'quality');assert.deepEqual(saved.alternativeSolver,saved.roles.solver)
    assert.deepEqual(await ui.resolve(f.state.workspace,parent),saved);assert.equal(steps.length,0)
    const {alternativeSolver:_alt,...missing}=saved
    assert.match((await ui.problems(missing)).join(' '),/別案のモデル/)
    assert.match((await ui.problems({...saved,alternativeSolver:{provider:'mock',model:'missing'}})).join(' '),/ありません/)
  } finally{await f.close()}
})
