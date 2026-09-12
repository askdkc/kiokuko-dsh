import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../../src/client.js'

/** One answer batch the card submitted, matching the native carrier's payload. */
interface RecordedAnswer { answers: { id: string; selected: string[]; custom?: string }[] }

/**
 * The OrcaReplay detailed-log choice is a native DSH question, so the plugin's
 * composer entry has to claim that carrier and give it the same number-key plus
 * Enter contract as the task-type card. Every other single-select question that
 * carries one to nine options is claimed the same way, so no question this
 * composer shows is left without a shortcut.
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

test('every single-select question keeps the numbered option card while unaddressable carriers stay native', async () => {
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
  // The recorded payload keeps its own shape: `assert.deepEqual` narrows
  // `responses` to whatever it was compared against, and an `unknown` parameter
  // would then stop being pushable.
  const responses: RecordedAnswer[] = []
  let cancellations = 0
  const pending = {
    kind: 'question', key: 'orca-recording-one',
    questions: [recordingQuestion],
    async answer(answer: RecordedAnswer) { responses.push(answer) },
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

    // The card claims every single-select question inside the range one number
    // key addresses, so a question this plugin has never seen still shows a
    // shortcut. Each single half of a known pair is no longer an exemption.
    assert.equal(entry.definition.select({ pendingInteraction: pending }), pending)
    assert.equal(entry.definition.select({ pendingInteraction: { ...pending, kind: 'plan-review' } }), null)
    for (let count = 1; count <= 9; count += 1) {
      const questions = [{
        id: 'reflection-method', header: '反映方法', question: 'どちらにしますか？',
        options: Array.from({ length: count }, (_, index) => ({ label: `選択肢${index + 1}` })),
      }]
      const carrier = { ...pending, key: `coverage-${count}`, questions }
      assert.equal(entry.definition.select({ pendingInteraction: carrier }), carrier, `options=${count}`)
    }
    for (const questions of [
      [{ ...recordingQuestion, header: 'OrcaReplay · 別の見出し' }],
      [{ ...recordingQuestion, id: 'other-recording' }],
    ]) {
      const carrier = { ...pending, questions }
      assert.equal(entry.definition.select({ pendingInteraction: carrier }), carrier,
        'an unlisted single-select question keeps the shortcut card')
    }
    // Carriers one number key cannot address stay with the native composer.
    for (const questions of [
      [{ ...recordingQuestion, multiSelect: true }],
      [{ ...recordingQuestion, options: [] }],
      [{ ...recordingQuestion, options: Array.from({ length: 10 }, (_, index) => ({ label: `選択肢${index + 1}` })) }],
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

    // Guards: key repeat, unsupported modifiers, IME, and plain digits in editing fields never select.
    for (const event of [
      key('2', { repeat: true }),
      key('2', { ctrlKey: true, altKey: true }),
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
    assert.match(selected[0].props['aria-keyshortcuts'], /^2 (Control|Meta)\+2$/u)

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

    // The same shortcut answers a question the plugin has never seen, such as a
    // choice the model composed in chat.
    const reflection = {
      kind: 'question', key: 'reflection-one',
      questions: [{
        id: 'reflection-method', header: '反映方法', question: 'いま入れ替えますか？',
        options: [{ label: '今すぐ反映する' }, { label: 'ソース変更のみで終える' }],
      }],
      async answer(answer: RecordedAnswer) { responses.push(answer) },
      async cancel() { cancellations++ },
    }
    slots = []
    const reflectionWrapper = entry.component({ matched: reflection })
    cursor = 0
    let reflectionTree = reflectionWrapper.component(reflectionWrapper.props)
    reflectionTree.props.onKeyDown(key('2'))
    cursor = 0; reflectionTree = reflectionWrapper.component(reflectionWrapper.props)
    reflectionTree.props.onKeyDown(key('Enter'))
    await Promise.resolve(); await Promise.resolve()
    assert.deepEqual(responses[1], {
      answers: [{ id: 'reflection-method', selected: ['ソース変更のみで終える'] }],
    })
    assert.equal(cancellations, 0)
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete globals[name]
      else globals[name] = previous[index]
    })
  }
})
