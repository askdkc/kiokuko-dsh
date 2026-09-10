import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../../src/client.js'

/**
 * The OrcaReplay detailed-log choice is a native DSH question, so the plugin's
 * composer entry has to claim exactly that carrier and give it the same
 * number-key plus Enter contract as the task-type card, without taking over any
 * other plugin's question.
 */
const recordingQuestion = {
  id: 'kioku-orca-recording',
  header: 'OrcaReplay · 詳細ログ',
  question: 'このチャットの詳細ログを記録しますか？',
  detail: 'モデルの応答やツールの実行結果をローカルに保存し、後で確認・HTML出力できます。',
  options: [
    { label: '記録する', description: 'この選択以降の動作を記録します。' },
    { label: '記録しない', description: '詳細ログを作らずに続行します。' },
  ],
}

test('recording question uses the numbered option card and falls through for every other question', async () => {
  const globals = globalThis as unknown as Record<string, any>
  const names = ['createSnapshotStore', 'jsx', 'jsxs', 'useState', 'useRef', 'useEffect']
  const previous = names.map(name => globals[name])
  let slots: any[] = []
  let cursor = 0
  const hook = (initial: () => any) => {
    const index = cursor++
    if (!(index in slots)) slots[index] = initial()
    return index
  }
  globals.createSnapshotStore = (state: unknown) => ({ getSnapshot: () => state, update() {} })
  globals.jsx = globals.jsxs = (component: unknown, props: unknown) => ({ component, props })
  globals.useState = (initial: any) => {
    const index = hook(() => typeof initial === 'function' ? initial() : initial)
    return [slots[index], (value: unknown) => { slots[index] = value }]
  }
  globals.useRef = (initial: any) => {
    const index = hook(() => ({ current: initial }))
    return slots[index]
  }
  globals.useEffect = (effect: () => void) => hook(() => { effect(); return true })

  const registered: any[] = []
  const responses: any[] = []
  let cancellations = 0
  const pending = {
    kind: 'question', key: 'orca-recording-one',
    questions: [recordingQuestion],
    async answer(answer: unknown) { responses.push(answer) },
    async cancel() { cancellations++ },
  }
  const descendants = (node: any): any[] => node && typeof node === 'object'
    ? [node, ...[node.props?.children].flat().flatMap(descendants)] : []
  const key = (value: string, extra = {}) => ({
    key: value, target: { tagName: 'SECTION' }, preventDefault() {}, stopPropagation() {}, ...extra,
  })
  const optionButtons = (tree: any): any[] => descendants(tree)
    .filter(node => node.props?.className === 'kiokuko-intake-option')

  try {
    apply({
      uiConversation: { events: { register() {} } }, locale: { register() {} }, effect() {}, on() {},
      slots: {
        inject: (_name, register) => register(),
        register: (definition, component) => { registered.push({ definition, component }) },
      },
    })
    const entry = registered.find(item => item.definition.name === 'conversation.composer')
    assert.ok(entry, 'the plugin must register one composer entry')

    // Boundary: only the exact identity pair is claimed; each single half and a
    // multi-select carrier fall through to the native composer.
    assert.equal(entry.definition.select({ pendingInteraction: pending }), pending)
    assert.equal(entry.definition.select({ pendingInteraction: { ...pending, kind: 'plan-review' } }), null)
    for (const questions of [
      [{ ...recordingQuestion, header: 'OrcaReplay · 別の見出し' }],
      [{ ...recordingQuestion, id: 'other-recording' }],
      [{ ...recordingQuestion, multiSelect: true }],
      [{ ...recordingQuestion, options: [] }],
    ]) {
      assert.equal(entry.definition.select({ pendingInteraction: { ...pending, questions } }), null)
    }
    assert.equal(entry.definition.select({
      pendingInteraction: { ...pending, questions: [recordingQuestion, recordingQuestion] },
    }), null)

    const wrapper = entry.component({ matched: pending })
    const render = () => { cursor = 0; return wrapper.component(wrapper.props) }
    let tree = render()
    assert.equal(optionButtons(tree).length, 2, 'both choices are rendered as numbered options')
    assert.match(descendants(tree).find(node => node.component === 'strong').props.children, /^1\. 記録する$/u)
    assert.ok(descendants(tree).some(node => node.props?.children === recordingQuestion.detail),
      'the question detail stays visible')

    // Guards: key repeat, modifiers, IME composition, and editing fields never select.
    for (const event of [
      key('2', { repeat: true }),
      key('2', { ctrlKey: true }),
      key('2', { nativeEvent: { isComposing: true } }),
      key('2', { nativeEvent: { keyCode: 229 } }),
      key('2', { target: { tagName: 'TEXTAREA' } }),
      key('9'),
    ]) {
      tree.props.onKeyDown(event)
      tree = render()
      assert.equal(optionButtons(tree).some(node => node.props?.['aria-pressed'] === true), false,
        `unexpected selection for ${JSON.stringify(event)}`)
    }

    tree.props.onKeyDown(key('2'))
    tree = render()
    const selected = optionButtons(tree).filter(node => node.props?.['aria-pressed'] === true)
    assert.equal(selected.length, 1)
    assert.equal(selected[0].props['aria-keyshortcuts'], '2')

    // Enter confirms exactly once; a repeated or IME Enter adds nothing.
    tree.props.onKeyDown(key('Enter', { nativeEvent: { keyCode: 229 } }))
    tree.props.onKeyDown(key('Enter', { target: { tagName: 'BUTTON' } }))
    await Promise.resolve()
    assert.equal(responses.length, 0, 'IME and focus-on-button Enter must not confirm')
    tree.props.onKeyDown(key('Enter'))
    tree.props.onKeyDown(key('Enter'))
    await Promise.resolve(); await Promise.resolve()
    assert.deepEqual(responses, [{
      answers: [{ id: 'kioku-orca-recording', selected: ['記録しない'] }],
    }])
    assert.equal(cancellations, 0)
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete globals[name]
      else globals[name] = previous[index]
    })
  }
})
