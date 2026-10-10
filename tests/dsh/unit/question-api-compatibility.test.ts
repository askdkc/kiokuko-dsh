import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeQuestionClass } from '../helpers/native-question.js'
import { apply } from '../../../src/client.js'

// Exercise the shipped native class, not a hand-written cancel-only carrier.
for (const fixture of ['dsh-runtime']) test(`numbered composer claims real ${fixture} question carriers`, () => {
  const PendingQuestion = nativeQuestionClass()
  const store = (state: any) => ({ getSnapshot: () => state, update() {} })
  const globals = globalThis as any, previous = globals.createSnapshotStore
  globals.createSnapshotStore = store
  try {
    let select: any
    apply({ uiConversation: { events: { register() {} } }, locale: { register() {} }, effect() {}, on() {},
      slots: { inject: (_n, f) => f(), register(d) { if (d.name === 'conversation.composer') select = d.select } } })
    for (const count of [1, 9, 10, 24, 0]) {
      const q = { id: 'unknown-question', header: 'Test', question: 'Choose', options: Array.from({ length: count }, (_, i) => ({ label: `Choice ${i + 1}` })) }
      const pending = new PendingQuestion('session', [q], fixture === 'dsh-runtime' ? new AbortController().signal : undefined)
      assert.equal(select({ pendingInteraction: pending }), pending)
      if (pending.close) pending.close()
    }
  } finally { globals.createSnapshotStore = previous }
})
