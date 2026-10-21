import assert from 'node:assert/strict'
import test from 'node:test'
import { HEAD_WORKER_LABEL, headWorkerCandidates } from '../../../src/dsh/head-worker-configuration.js'
import { nativeModelCatalog } from '../../../src/dsh/native-model-catalog.js'
import { MODEL_ROLES, ROLE_LABELS, readModelCatalog, type ModelBinding } from '../../../src/dsh/model-configuration.js'
import { selectExecution, ExecutionSelectionPending } from '../../../src/dsh/model-selection-ui.js'
import type { StoredExecutionSelection } from '../../../src/dsh/execution-selection.js'

const providers = [{ id: 'openai', name: 'OpenAI', route: { provider: 'openai', family: 'openai' as const, connection: 'api' as const, protocol: 'responses' as const } },
  { id: 'deepseek', name: 'DeepSeek', route: { provider: 'deepseek', family: 'deepseek' as const, connection: 'api' as const, protocol: 'chat-completions' as const } }]
const models = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol'].map(id => ({ provider: 'openai', id, name: id }))
models.push({ provider: 'deepseek', id: 'deepseek-flash', name: 'Flash' })

test('head/worker inventory checks membership without resolving credentials or inspecting transports', async () => {
  let auth = 0
  const candidates = await headWorkerCandidates({ providers, models, failures: [], resolveCallConfig: async b => { auth++; return b } }, [],
    { inspect: async () => { auth++; return { protocol: 'responses', goSessionHeaders: true } } })
  assert.equal(auth, 0)
  assert.equal(candidates.heads.length, 1); assert.equal(candidates.workers.length, 1)
  const unavailable = await headWorkerCandidates({ providers, models, failures: ['deepseek'] })
  assert.equal(unavailable.workers.length, 0)
})

test('template display never resolves unselected providers; confirmation resolves each selected binding once', async () => {
  for (const reject of [false, true]) {
    let confirmed = false, rejected = false, credentialWrites = 0
    const resolved: string[] = [], listedAfterConfirmation: string[] = []
    let stored: StoredExecutionSelection = { revision: 0, value: { mode: 'enno', status: 'selecting' } }
    const llm = { listProviders: () => providers,
      listModelsForDisplay: async (provider: string) => models.filter(m => m.provider === provider),
      listModels: async (provider: string) => {
      if (confirmed) listedAfterConfirmation.push(provider)
      return models.filter(m => m.provider === provider)
    }, resolveCallConfig: async (b: ModelBinding) => {
      resolved.push(b.provider + '/' + b.model); credentialWrites++
      assert.equal(confirmed, true, 'display must not refresh authentication')
      assert.equal(b.provider, 'openai', 'unselected provider must remain untouched')
      if (reject) { rejected = true; throw new Error('synthetic credential unavailable') }
      return b
    } }
    const outcome = await selectExecution({ task: 'fix', stored, llm, routes: providers.map(p => p.route), signal: new AbortController().signal,
      save: async (revision, value) => stored = { revision: revision + 1, value },
      questions: { ask: async r => {
        const q = r.questions[0]
        if (!confirmed) assert.equal(credentialWrites, 0)
        const value = q.id === 'enno-model-source' ? 'おすすめテンプレートから選ぶ'
          : q.id === 'enno-template' ? q.options!.find(o => o.label.startsWith('OpenAI —'))!.label
            : q.id === 'enno-model-review' && !rejected ? 'この構成で開始' : '取消・作業を保持'
        if (q.id === 'enno-model-review' && !rejected) confirmed = true
        return { answers: [{ id: q.id, selected: [value] }] }
      } },
    }).catch(e => { if (!(e instanceof ExecutionSelectionPending)) throw e; return undefined })
    assert.equal(outcome?.value.status, reject ? undefined : 'ready')
    assert.equal(new Set(resolved).size, 3)
    assert.equal(resolved.length, 3)
    assert.ok(listedAfterConfirmation.length > 0)
    assert.ok(listedAfterConfirmation.every(provider => provider === 'openai'))
    assert.ok(MODEL_ROLES.every(r => !outcome || outcome.value.configuration?.roles[r].provider === 'openai'))
  }
})

test('installed pi-ai provider-only discovery never reads credentials or contacts an endpoint', async () => {
  const { apply, Config } = await import('@deepseek-ai/dsh-llm-pi-ai')
  let discover: ((request: { provider: string }) => Promise<readonly { id: string }[]>) | undefined
  let credentialAccess = 0, network = 0
  const dispose = () => {}; dispose.replace = () => {}
  const ctx = { fiber: { entry: { options: { id: 'llm-pi-ai' } } }, inject() {}, on() {},
    get(name: string) { if (name === 'credentials') { credentialAccess++; throw Error('credential access forbidden') } },
    logger: { error() { assert.fail('unexpected registration error') } }, llm: {
      registerConfigurableProviders() { return dispose }, registerAdapter() { return dispose },
      registerModelDiscovery(_ns: string, fn: typeof discover) { discover = fn },
    } }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { network++; throw Error('network forbidden') }
  try {
    apply(ctx as never, Config({ providers: { openai: {} } }) as never)
    assert.ok((await discover!({ provider: 'openai' })).length > 0)
    await assert.rejects(discover!({ provider: 'synthetic-unknown-route' }), /baseURL/)
    assert.equal(credentialAccess, 0); assert.equal(network, 0)
  } finally { globalThis.fetch = originalFetch }
})

test('native inventory cannot call credential-resolving listModels when no safe metadata seam exists', async () => {
  let calls = 0
  const llm = nativeModelCatalog({ listProviders: () => providers, listModels: async provider => {
    calls++; return models.filter(m => m.provider === provider)
  } })!
  const snapshot = await readModelCatalog(llm)
  assert.equal(calls, 0)
  assert.deepEqual(snapshot.models, [])
  assert.deepEqual(snapshot.failures, [])
  assert.deepEqual(snapshot.unverifiedProviders, ['openai', 'deepseek'])
  const selected = await readModelCatalog(llm, ['openai'])
  assert.equal(calls, 1)
  assert.equal(selected.models.length, 4)
})

test('configured alias IDs and account overrides remain selectable without authenticating inventory', async () => {
  for (const account of [false, true]) {
    const provider = account ? 'deepseek-account' : 'custom-alias', id = 'configured-model'
    let listings = 0, resolutions = 0, confirmed = false
    const profile = account ? { modelOverrides: { [id]: {} } } : { models: [{ id, name: 'Configured model' }] }
    for (const key of ['apiKey', 'headers', 'credential']) Object.defineProperty(profile, key, { get() { assert.fail('secret-shaped fields must not be read') } })
    const ns = account ? 'llm-deepseek-account' : 'llm-pi-ai'
    const native = nativeModelCatalog({ listProviders: () => [{ id: provider, name: provider }],
      listConfigurableProviders: () => [{ provider, settingsNs: ns, settingsPath: [] }],
      listModels: async () => { listings++; assert.equal(confirmed, true); return [{ provider, id, name: id }] },
      resolveCallConfig: async b => { resolutions++; assert.equal(confirmed, true); return b },
    }, { describe: options => { assert.deepEqual(options, { redactSecrets: true }); return [{ ns, value: profile }] } })!
    const inventory = await readModelCatalog(native)
    assert.deepEqual(inventory.models.map(m => m.id), [id]); assert.equal(listings, 0)
    let stored: StoredExecutionSelection = { revision: 0, value: { mode: 'enno', status: 'selecting', draft: {
      roles: Object.fromEntries(MODEL_ROLES.map(role => [role, { provider, model: id }])), custom: true, maxConcurrentChildren: 4,
    } } }
    const result = await selectExecution({ task: 'fix', stored, llm: native, routes: [], signal: new AbortController().signal,
      save: async (revision, value) => stored = { revision: revision + 1, value },
      questions: { ask: async r => { assert.equal(listings, 0); confirmed = true; return { answers: [{ id: r.questions[0].id, selected: ['この構成で開始'] }] } } },
    })
    assert.equal(result.value.status, 'ready'); assert.equal(listings, 1); assert.equal(resolutions, 1)
  }
})

test('partial overrides do not hide the installed catalog or pretend to be a complete account listing', async () => {
  const native = nativeModelCatalog({ listProviders: () => [{ id: 'openai', name: 'OpenAI' }, { id: 'deepseek-account', name: 'Account' }],
    listConfigurableProviders: () => [
      { provider: 'openai', settingsNs: 'llm-pi-ai', settingsPath: [] },
      { provider: 'deepseek-account', settingsNs: 'llm-deepseek-account', settingsPath: [] },
    ], listModels: async () => assert.fail('inventory must not authenticate'),
    discoverModels: async (ns, request) => {
      assert.equal(ns, 'llm-pi-ai'); assert.deepEqual(request, { provider: 'openai' })
      return [{ id: 'installed-model' }]
    },
  }, { describe: () => [
    { ns: 'llm-pi-ai', value: { modelOverrides: { 'override-model': {} } } },
    { ns: 'llm-deepseek-account', value: { modelOverrides: { 'configured-account-model': {} } } },
  ] })!
  const snapshot = await readModelCatalog(native)
  assert.deepEqual(snapshot.models.map(m => m.id), ['installed-model', 'override-model', 'configured-account-model'])
  assert.deepEqual(snapshot.unverifiedProviders, ['deepseek-account'])
  assert.deepEqual(snapshot.failures, [])
})

test('account without public static metadata accepts explicit IDs, then uses the normal selected connection', async () => {
  for (const exists of [true, false]) {
    const provider = 'deepseek-account', model = 'selected-model'
    let confirmed = false, listings = 0, resolutions = 0
    let stored: StoredExecutionSelection = { revision: 0, value: { mode: 'enno', status: 'selecting' } }
    const native = nativeModelCatalog({ listProviders: () => [{ id: provider, name: 'Account' }],
      listConfigurableProviders: () => [{ provider, settingsNs: 'llm-deepseek-account', settingsPath: [] }],
      listModels: async () => { assert.equal(confirmed, true); listings++; return exists ? [{ provider, id: model, name: model }] : [] },
      resolveCallConfig: async b => { resolutions++; return b },
    })!
    const result = await selectExecution({ task: 'fix', stored, llm: native, routes: [], signal: new AbortController().signal,
      save: async (revision, value) => stored = { revision: revision + 1, value },
      questions: { ask: async r => {
        const q = r.questions[0]; let selected: string
        if (q.id === 'enno-model-source') selected = 'DSHに設定済みのモデルから選ぶ'
        else if (q.id === 'enno-model-review') {
          const missing = MODEL_ROLES.find(role => !stored.value.draft?.roles[role])
          selected = confirmed ? '取消・作業を保持' : missing ? `${ROLE_LABELS[missing]}を変更` : 'この構成で開始'
          if (selected === 'この構成で開始') confirmed = true
        } else if (q.id === 'enno-provider-ideal') selected = `Account [${provider}]`
        else if (q.id === 'enno-model-ideal') selected = 'モデルIDを直接指定'
        else if (q.id === 'enno-model-id-ideal') selected = model
        else selected = 'enno-idealからコピー'
        return { answers: [{ id: q.id, selected: [selected] }] }
      } },
    }).catch(e => { if (!(e instanceof ExecutionSelectionPending)) throw e; return undefined })
    assert.equal(result?.value.status, exists ? 'ready' : undefined)
    assert.equal(listings, 1); assert.equal(resolutions, exists ? 1 : 0)
  }
})

test('unverified account keeps the exact worker preset as a candidate, not a successful connection', async () => {
  for (const mode of ['normal', 'enno'] as const) for (const exists of [true, false]) {
    let confirmed = false
    const listed: string[] = [], resolved: string[] = []
    const llm = nativeModelCatalog({ listProviders: () => [{ id: 'openai', name: 'Head' }, { id: 'deepseek-account', name: 'Account' }],
      listConfigurableProviders: () => [{ provider: 'deepseek-account', settingsNs: 'llm-deepseek-account', settingsPath: [] }],
      listModelsForDisplay: async provider => provider === 'openai' ? [{ provider, id: 'gpt-6.1-sol', name: 'Sol' }] : { models: [], complete: false },
      listModels: async provider => {
        assert.equal(confirmed, true); listed.push(provider)
        return provider === 'openai' ? [{ provider, id: 'gpt-6.1-sol', name: 'Sol' }] : exists ? [{ provider, id: 'deepseek-flash', name: 'Flash' }] : []
      }, resolveCallConfig: async b => { assert.equal(confirmed, true); resolved.push(b.provider); return b },
    })!
    const pair = { preset: 'gpt-6.1-sol-deepseek-v4.1-flash' as const, head: { provider: 'openai', model: 'gpt-6.1-sol' }, worker: { provider: 'deepseek-account', model: 'deepseek-flash' } }
    let stored: StoredExecutionSelection = { revision: 0, value: { mode: mode === 'normal' ? 'pending' : 'enno', status: 'selecting' } }
    const result = await selectExecution({ task: 'fix', stored, llm, ...(mode === 'enno' ? { savedHeadWorker: pair } : {}), routes: [], signal: new AbortController().signal,
      save: async (revision, value) => stored = { revision: revision + 1, value },
      questions: { ask: async r => {
        const q = r.questions[0]
        const choice = q.id === 'enno-execution-mode' ? `通常実行: ${HEAD_WORKER_LABEL}`
          : (q.id === 'head-worker-review' || q.id === 'enno-model-review') && !confirmed ? 'この構成で開始' : '取消・作業を保持'
        if (choice === 'この構成で開始') { assert.equal(resolved.length, 0); confirmed = true }
        return { answers: [{ id: q.id, selected: [choice] }] }
      } },
    }).catch(e => { if (!(e instanceof ExecutionSelectionPending)) throw e; return undefined })
    assert.equal(result?.value.status, exists ? 'ready' : undefined)
    assert.deepEqual(listed.sort(), ['deepseek-account', 'openai'])
    assert.deepEqual(resolved.sort(), exists ? ['deepseek-account', 'openai'] : ['openai'])
  }
})
