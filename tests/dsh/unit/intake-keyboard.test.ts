import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../../src/client.js'

test('intake keyboard is scoped, confirms once, preserves drafts, and leaves editing and other buttons alone', async () => {
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
  globals.useState = (initial: any) => { const index = hook(() => typeof initial === 'function' ? initial() : initial); return [slots[index], (value: unknown) => { slots[index] = value }] }
  globals.useRef = (initial: any) => { const index = hook(() => ({ current: initial })); return slots[index] }
  globals.useEffect = (effect: () => void) => { hook(() => { effect(); return true }) }
  const registered: any[] = []
  const responses: any[] = []
  let cancellations = 0
  const pending = {
    kind: 'question', key: 'intake-one',
    questions: [{ id: 'taskType', header: 'Kiokuko · 作業の選択', question: '選んでください', options: [{ label: '実装・変更' }, { label: '不具合の調査・修正' }] }],
    async answer(answer: unknown) { responses.push(answer) },
    async cancel() { cancellations++ },
  }
  const descendants = (node: any): any[] => node && typeof node === 'object'
    ? [node, ...[node.props?.children].flat().flatMap(descendants)] : []
  const key = (value: string, extra = {}) => ({ key: value, target: { tagName: 'SECTION' }, preventDefault() {}, stopPropagation() {}, ...extra })
  try {
    apply({
      uiConversation: { events: { register() {} } }, locale: { register() {} }, effect() {}, on() {},
      slots: { inject: (_name, register) => register(), register: (definition, component) => { registered.push({ definition, component }) } },
    })
    const entry = registered.find(item => item.definition.name === 'conversation.composer')
    assert.equal(entry.definition.select({ pendingInteraction: pending }), pending)
    assert.equal(entry.definition.select({ pendingInteraction: { ...pending, kind: 'plan-review' } }), null)
    assert.equal(entry.definition.select({ pendingInteraction: { ...pending, questions: [{ ...pending.questions[0], header: 'Other plugin' }] } }), null)
    const wrapper = entry.component({ matched: pending })
    const render = () => { cursor = 0; return wrapper.component(wrapper.props) }
    let tree = render()
    for (const event of [key('2', { repeat: true }), key('2', { ctrlKey: true }), key('2', { nativeEvent: { isComposing: true } }), key('2', { target: { tagName: 'TEXTAREA' } })]) {
      tree.props.onKeyDown(event)
      tree = render()
      assert.equal(descendants(tree).some(node => node.props?.['aria-pressed'] === true), false)
    }
    tree.props.onKeyDown(key('2'))
    tree = render()
    assert.equal(descendants(tree).filter(node => node.props?.['aria-pressed'] === true).length, 1)
    // Session-switch remount of the same native carrier retains its draft.
    slots = []; tree = render()
    assert.equal(descendants(tree).filter(node => node.props?.['aria-pressed'] === true).length, 1)
    tree.props.onKeyDown(key('Enter', { nativeEvent: { keyCode: 229 } }))
    tree.props.onKeyDown(key('Enter', { target: { tagName: 'BUTTON' } }))
    await Promise.resolve()
    assert.equal(responses.length, 0, 'IME and close/skip button Enter must not confirm the selection')
    tree.props.onKeyDown(key('Enter')); tree.props.onKeyDown(key('Enter'))
    await Promise.resolve(); await Promise.resolve()
    assert.deepEqual(responses, [{ answers: [{ id: 'taskType', selected: ['不具合の調査・修正'] }] }])
    assert.equal(cancellations, 0)
    slots = []
    const next = { ...pending, key: 'intake-two' }
    const nextWrapper = entry.component({ matched: next })
    cursor = 0; tree = nextWrapper.component(nextWrapper.props)
    const textarea = descendants(tree).find(node => node.component === 'textarea')
    textarea.props.onChange({ target: { value: '９' } })
    cursor = 0; tree = nextWrapper.component(nextWrapper.props)
    tree.props.onKeyDown(key('Enter', { target: { tagName: 'TEXTAREA' } }))
    cursor = 0; tree = nextWrapper.component(nextWrapper.props)
    assert.match(descendants(tree).find(node => node.props?.role === 'status').props.children, /番号は1〜2/u)
    assert.equal(responses.length, 1)
    descendants(tree).find(node => node.props?.['aria-label'] === '質問を閉じる').props.onClick()
    await Promise.resolve(); await Promise.resolve()
    assert.equal(cancellations, 1)
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete globals[name]; else globals[name] = previous[index] })
  }
})
