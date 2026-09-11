import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../../src/client.js'
import { MODEL_ROLES } from '../../../src/dsh/model-configuration.js'
import { selectExecution } from '../../../src/dsh/model-selection-ui.js'
import type { StoredExecutionSelection } from '../../../src/dsh/execution-selection.js'
import { deepQuestion } from '../../../src/deep-thinker/configuration.js'

const descendants = (node: any): any[] => node && typeof node === 'object'
  ? [node, ...[node.props?.children].flat().flatMap(descendants)] : []
const key = (value: string, extra = {}) => ({ key: value, target: { tagName: 'SECTION' }, preventDefault() {}, stopPropagation() {}, ...extra })
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const question = (id = 'enno-model-zenki', count = 24) => ({
  id, header: '実行方式とモデル', question: '選択してください',
  options: Array.from({ length: count }, (_, i) => ({ label: `Option ${i + 1}` })),
})

function clientHarness(platform = 'Linux x86_64') {
  const globals = globalThis as unknown as Record<string, any>
  const names = ['createSnapshotStore', 'jsx', 'jsxs', 'useState', 'useRef', 'useEffect']
  const previous = names.map(name => globals[name])
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform } })
  const listeners = new Set<(event: any) => void>()
  let visible = true
  const ownerDocument = {
    addEventListener(type: string, listener: (event: any) => void, capture: boolean) {
      assert.equal(type, 'keydown'); assert.equal(capture, true); listeners.add(listener)
    },
    removeEventListener(type: string, listener: (event: any) => void, capture: boolean) {
      assert.equal(type, 'keydown'); assert.equal(capture, true); listeners.delete(listener)
    },
  }
  let slots: any[] = [], cursor = 0
  let effects: Array<() => void> = []
  const hook = (initial: () => any) => { const index = cursor++; if (!(index in slots)) slots[index] = initial(); return index }
  globals.createSnapshotStore = (state: unknown) => ({ getSnapshot: () => state, update() {} })
  globals.jsx = globals.jsxs = (component: unknown, props: unknown) => ({ component, props })
  globals.useState = (initial: any) => {
    const index = hook(() => typeof initial === 'function' ? initial() : initial)
    return [slots[index], (value: unknown) => { slots[index] = value }]
  }
  globals.useRef = (initial: any) => slots[hook(() => ({ current: initial }))]
  globals.useEffect = (effect: () => void | (() => void), dependencies: unknown[]) => {
    const index = hook(() => ({}))
    const old = slots[index]
    if (!old.dependencies || dependencies.some((value, i) => !Object.is(value, old.dependencies[i]))) {
      effects.push(() => { old.cleanup?.(); slots[index] = { dependencies, cleanup: effect() } })
    }
  }
  const registered: any[] = []
  apply({
    uiConversation: { events: { register() {} } }, locale: { register() {} }, effect() {}, on() {},
    slots: { inject: (_name, register) => register(), register: (definition, component) => { registered.push({ definition, component }) } },
  })
  const entry = registered.find(item => item.definition.name === 'conversation.composer')
  const unmount = () => { for (const value of slots) value?.cleanup?.(); slots = []; effects = [] }
  return {
    entry, unmount,
    documentKey(event: any) { for (const listener of listeners) listener(event) },
    get listenerCount() { return listeners.size },
    set visible(value: boolean) { visible = value },
    mount(pending: any) {
      unmount()
      assert.equal(entry.definition.select({ pendingInteraction: pending }), pending)
      const wrapper = entry.component({ matched: pending })
      let focused = '', scrolls = 0
      const render = () => {
        cursor = 0
        const tree = wrapper.component(wrapper.props)
        for (const node of descendants(tree)) if (typeof node.props?.ref === 'function') node.props.ref({
          ownerDocument, isConnected: true, getClientRects: () => visible ? [{}] : [],
          focus() { focused = node.component }, scrollIntoView() { scrolls++ },
        })
        for (const effect of effects.splice(0)) effect()
        return tree
      }
      return { render, get focused() { return focused }, get scrolls() { return scrolls } }
    },
    restore() {
      unmount()
      names.forEach((name, index) => { if (previous[index] === undefined) delete globals[name]; else globals[name] = previous[index] })
      if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
      else delete globals.navigator
    },
  }
}

test('all Enno selection cards use numbered keyboard controls, including lists longer than nine', () => {
  const h = clientHarness()
  try {
    const ids = ['enno-execution-mode', 'enno-model-source', 'enno-template', 'enno-template-provider',
      'enno-template-unavailable', 'enno-bind-provider', 'enno-model-review', 'enno-catalog-retry',
      'enno-route-provider', 'enno-route-family', 'enno-route-auth', 'enno-route-protocol',
      ...MODEL_ROLES.flatMap(role => [`enno-provider-${role}`, `enno-model-${role}`])]
    for (const id of ids) {
      const pending = { kind: 'question', key: id, questions: [question(id)], answer: async () => {}, cancel: async () => {} }
      assert.equal(h.entry.definition.select({ pendingInteraction: pending }), pending, id)
      for (const q of [{ ...question(id), header: 'Other plugin' }, { ...question(id), multiSelect: true }, { ...question(id), options: [] }]) {
        assert.equal(h.entry.definition.select({ pendingInteraction: { ...pending, questions: [q] } }), null)
      }
    }
    for (const id of ['enno-provider-unknown', 'enno-model-not-a-role', 'enno-other']) {
      assert.equal(h.entry.definition.select({ pendingInteraction: { kind: 'question', questions: [question(id)], answer() {}, cancel() {} } }), null)
    }
  } finally { h.restore() }
})

test('Deep cards use the shortcut renderer while unrelated and multi-select questions stay native', () => {
  const h = clientHarness()
  try {
    for (const id of ['deep-configuration', 'deep-budget-field', 'deep-budget-value', 'deep-role-model', 'deep-apply-configuration', 'deep-pending-input', 'deep-uncertain']) {
      const q = { ...question(id), header: 'Deep planning' }
      const pending = { kind: 'question', key: id, questions: [q], answer: async () => {}, cancel: async () => {} }
      const card = h.mount(pending)
      assert.equal(descendants(card.render()).filter(node => node.component === 'kbd').length, 24, id)
      for (const rejected of [{ ...q, header: 'Other plugin' }, { ...q, id: 'deep-unrelated' }, { ...q, multiSelect: true }]) {
        assert.equal(h.entry.definition.select({ pendingInteraction: { ...pending, questions: [rejected] } }), null)
      }
    }
  } finally { h.restore() }
})

test('Deep model search and budget values keep free-text digits literal through the native answer adapter', async () => {
  const h = clientHarness('MacIntel')
  try {
    for (const [id, value] of [['deep-role-model', '4.1'], ['deep-role-model', '2'], ['deep-budget-value', '120000']] as const) {
      const answered = await deepQuestion({ ask: request => new Promise(resolve => {
        const card = h.mount({ kind: 'question', key: id, questions: request.questions,
          answer: async (response: any) => resolve(response), cancel: async () => assert.fail('unexpected cancellation') })
        const tree = card.render()
        descendants(tree).find(node => node.component === 'textarea').props.onChange({ target: { value } })
        card.render().props.onKeyDown(key('Enter', { target: { tagName: 'TEXTAREA' } }))
      }) }, { id: 'deep-parent' }, new AbortController().signal, id, 'Deepの設定', ['current value'])
      assert.equal(answered, value)
    }
  } finally { h.restore() }
})

test('platform shortcuts select from outside the card, show matching hints, and confirm once', async () => {
  for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) for (const [id, header] of [
    ['taskType', 'Kiokuko · 作業の選択'], ['enno-model-zenki', '実行方式とモデル'], ['deep-role-model', 'Deep planning'],
  ]) {
    const mac = platform === 'MacIntel', modifier = mac ? { metaKey: true } : { ctrlKey: true }
    const h = clientHarness(platform), responses: unknown[] = []
    try {
      const q = { ...question(id, 4), header }
      const card = h.mount({ kind: 'question', key: `shortcut-${platform}`, questions: [q],
        async answer(value: unknown) { responses.push(value) }, async cancel() {} })
      let tree = card.render()
      assert.equal(h.listenerCount, 1)
      const hints = descendants(tree).filter(node => node.component === 'kbd')
      assert.deepEqual(hints.map(node => node.props.children), [1, 2, 3, 4].map(n => `${mac ? 'Cmd' : 'Ctrl'}+${n}`))
      assert.ok(hints.every(node => node.props['aria-hidden'] === true))
      let prevented = 0, stopped = 0
      // The host may keep focus in an editor outside this card. Plain digits remain text.
      h.documentKey(key('2', { target: { tagName: 'TEXTAREA' } }))
      assert.equal(descendants(card.render()).some(node => node.props?.['aria-pressed']), false)
      const shortcut = key('2', { ...modifier, target: { tagName: 'TEXTAREA' },
        preventDefault() { prevented++ }, stopPropagation() { stopped++ } })
      h.documentKey(shortcut)
      assert.equal(prevented, 1); assert.equal(stopped, 1)
      assert.equal(card.focused, 'section')
      tree = card.render()
      const chosen = descendants(tree).filter(node => node.props?.['aria-pressed'])
      assert.equal(chosen.length, 1)
      assert.equal(chosen[0].props['aria-keyshortcuts'], `2 ${mac ? 'Meta' : 'Control'}+2`)
      assert.equal(responses.length, 0)
      tree.props.onKeyDown(key('Enter')); tree.props.onKeyDown(key('Enter'))
      h.documentKey(key('3', modifier))
      await flush()
      assert.deepEqual(responses, [{ answers: [{ id, selected: ['Option 2'] }] }])
      h.unmount()
      assert.equal(h.listenerCount, 0, 'unmount releases the document shortcut listener')
    } finally { h.restore() }
  }
})

test('modified shortcuts reject IME and unsupported keys, reset long ordinals, and ignore hidden cards', async () => {
  const h = clientHarness('MacIntel'), responses: unknown[] = []
  try {
    const card = h.mount({ kind: 'question', key: 'shortcut-guards', questions: [question()],
      async answer(value: unknown) { responses.push(value) }, async cancel() {} })
    let tree = card.render()
    for (const extra of [{ ctrlKey: true }, { repeat: true }, { altKey: true }, { shiftKey: true },
      { isComposing: true }, { keyCode: 229 }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) {
      h.documentKey(key('2', { metaKey: true, ...extra, preventDefault() { assert.fail('must not intercept') } }))
    }
    for (const value of ['0', 'Enter', 'Backspace']) {
      h.documentKey(key(value, { metaKey: true, preventDefault() { assert.fail('must not intercept') } }))
    }
    h.visible = false
    h.documentKey(key('2', { metaKey: true, preventDefault() { assert.fail('hidden card') } }))
    assert.equal(descendants(card.render()).some(node => node.props?.['aria-pressed']), false)
    h.visible = true
    tree.props.onKeyDown(key('1')); tree.props.onKeyDown(key('2'))
    h.documentKey(key('2', { metaKey: true, code: 'Numpad2' }))
    tree = card.render()
    const chosen = descendants(tree).filter(node => node.props?.['aria-pressed'])
    assert.equal(chosen[0].props.children[0].props.children, '2. Option 2', 'shortcut replaces a buffered ordinal')
    assert.equal(chosen[0].props['aria-keyshortcuts'], 'Meta+2')
    assert.equal(descendants(tree).filter(node => node.component === 'kbd')[11].props.children, '12 → Enter')
    tree.props.onKeyDown(key('Enter')); await flush()
    assert.deepEqual(responses, [{ answers: [{ id: 'enno-model-zenki', selected: ['Option 2'] }] }])
  } finally { h.restore() }
})

test('multi-digit selection and immediate Enter send the exact option once without requiring a rerender', async () => {
  const h = clientHarness(), responses: unknown[] = []
  try {
    const card = h.mount({ kind: 'question', key: 'multi-digit', questions: [question()],
      async answer(value: unknown) { responses.push(value) }, async cancel() {} })
    const tree = card.render()
    assert.equal(card.focused, 'section')
    tree.props.onKeyDown(key('1')); tree.props.onKeyDown(key('2'))
    assert.equal(responses.length, 0)
    const selectedTree = card.render()
    const chosen = descendants(selectedTree).filter(node => node.props?.['aria-pressed'])
    assert.equal(chosen.length, 1)
    assert.equal(chosen[0].props.children[0].props.children, '12. Option 12')
    assert.equal(chosen[0].props['aria-keyshortcuts'], undefined, 'ARIA has no multi-digit shortcut sequence syntax')
    assert.ok(card.scrolls > 0)
    // Correct 12 to 13, then send before rendering the new state.
    selectedTree.props.onKeyDown(key('Backspace')); selectedTree.props.onKeyDown(key('3'))
    selectedTree.props.onKeyDown(key('Enter')); selectedTree.props.onKeyDown(key('Enter'))
    await flush()
    assert.deepEqual(responses, [{ answers: [{ id: 'enno-model-zenki', selected: ['Option 13'] }] }])
  } finally { h.restore() }
})

test('numeric search input stays literal while fixed menus accept full-width option numbers', async () => {
  const h = clientHarness(), responses: unknown[] = []
  try {
    for (const [id, custom] of [['enno-model-zenki', '99'], ['enno-provider-ideal', '99'], ['enno-template', '１２']] as const) {
      const card = h.mount({ kind: 'question', key: id, questions: [question(id)],
        async answer(value: unknown) { responses.push(value) }, async cancel() {} })
      const tree = card.render()
      tree.props.onKeyDown(key('2', { target: { tagName: 'TEXTAREA' } }))
      descendants(tree).find(node => node.component === 'textarea').props.onChange({ target: { value: custom } })
      tree.props.onKeyDown(key('Enter', { target: { tagName: 'TEXTAREA' } }))
      await flush()
    }
    assert.deepEqual(responses, [
      { answers: [{ id: 'enno-model-zenki', selected: [], custom: '99' }] },
      { answers: [{ id: 'enno-provider-ideal', selected: [], custom: '99' }] },
      { answers: [{ id: 'enno-template', selected: ['Option 12'] }] },
    ])
  } finally { h.restore() }
})

test('invalid numbers, IME, unsupported modifiers and repeated keys cannot submit; failures retain the selected option', async () => {
  const h = clientHarness(), responses: unknown[] = []
  let fail = true
  try {
    const card = h.mount({ kind: 'question', key: 'guards', questions: [question()],
      async answer(value: unknown) { if (fail) { fail = false; throw new Error('Retry delivery') }; responses.push(value) }, async cancel() {} })
    let tree = card.render()
    for (const extra of [{ repeat: true }, { ctrlKey: true, metaKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) {
      tree.props.onKeyDown(key('2', extra)); tree.props.onKeyDown(key('Enter', extra))
    }
    tree.props.onKeyDown(key('9')); tree.props.onKeyDown(key('9')); tree.props.onKeyDown(key('Enter'))
    await flush()
    assert.equal(responses.length, 0)
    tree.props.onKeyDown(key('Backspace')); tree.props.onKeyDown(key('Backspace')); tree.props.onKeyDown(key('2'))
    tree.props.onKeyDown(key('Enter', { target: { tagName: 'DIV', isContentEditable: true } }))
    tree.props.onKeyDown(key('Enter', { nativeEvent: { isComposing: true } }))
    await flush()
    assert.equal(fail, true)
    tree.props.onKeyDown(key('Enter'))
    await flush(); tree = card.render()
    assert.match(descendants(tree).find(node => node.props?.role === 'status').props.children, /Retry delivery/u)
    assert.equal(descendants(tree).filter(node => node.props?.['aria-pressed']).length, 1)
    tree.props.onKeyDown(key('Enter')); await flush()
    assert.deepEqual(responses, [{ answers: [{ id: 'enno-model-zenki', selected: ['Option 2'] }] }])
  } finally { h.restore() }
})

test('keyboard-only native card answers drive the Codex template selector through to ready', async () => {
  const h = clientHarness()
  let stored: StoredExecutionSelection = { revision: 0, value: { mode: 'pending', status: 'selecting' } }
  const answers = new Map([
    ['enno-execution-mode', '役小角を使う'], ['enno-model-source', 'おすすめテンプレートから選ぶ'],
    ['enno-template', 'OpenAI Codex・推奨（dsh-codex） — 適用可能'], ['enno-model-review', 'この構成で開始'],
  ])
  const seen: string[] = []
  try {
    const selected = await selectExecution({ stored, task: 'Fix selection', routes: [], signal: new AbortController().signal,
      llm: { listProviders: () => [{ id: 'openai-codex', name: 'Codex' }], listModels: async provider => ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-luna'].map(id => ({ id, name: id, provider })) },
      save: async (revision, value) => stored = { revision: revision + 1, value },
      questions: { ask: async request => {
        const q = request.questions[0], label = answers.get(q.id)
        seen.push(q.id)
        if (!label) throw new Error(`Unexpected question ${q.id}`)
        const index = q.options!.findIndex(option => option.label === label)
        assert.ok(index >= 0)
        let response: any
        const card = h.mount({ kind: 'question', key: q.id, questions: [q],
          async answer(value: unknown) { response = value }, async cancel() { throw new Error('Unexpected cancellation') } })
        const tree = card.render()
        for (const digit of String(index + 1)) tree.props.onKeyDown(key(digit))
        tree.props.onKeyDown(key('Enter')); await flush()
        assert.ok(response)
        return response
      } },
    })
    assert.deepEqual(seen, [...answers.keys()])
    assert.equal(selected.value.status, 'ready')
    assert.equal(selected.value.configuration?.template?.id, 'openai-codex')
  } finally { h.restore() }
})
