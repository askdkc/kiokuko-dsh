import assert from 'node:assert/strict'
import test from 'node:test'
import { OnDemandIntake } from '../../../src/dsh/on-demand-intake.js'
import { createRequestIntentContext } from '../../../src/dsh/decisions/request-intent.js'
import { injectDshContext, type DshModelMessage } from '../../../src/dsh/context-injection.js'
import { projectDshContext } from '../../../src/dsh/context-projection.js'
import type { DshLogEvent } from '../../../src/dsh/session-memory-finalizer.js'
import type { PreparedAgentTask } from '../../../src/dsh/task-intake.js'

function session() {
  const events: DshLogEvent[] = []
  return {
    events,
    snapshotEvents: () => events,
    append(messages: readonly unknown[]) {
      for (const data of messages) events.push({ type: 'user/message', seq: events.length, time: events.length, data, surfaceOp: 'append' })
    },
  }
}

function fragment(source: DshModelMessage['source'], content: string, name: string = source): DshModelMessage {
  return { role: 'user', source, content, name }
}

test('57 turns retain one copy of each unchanged Skill and only changed directives', async () => {
  const live = session()
  const prepared = {
    intake: { status: 'ready', profile: { target: null, expected: null, constraints: null } },
    nextAction: 'proceed', memoryPolicy: { memoryReasoningRequired: false, contextWithheld: false }, context: null,
  } as unknown as PreparedAgentTask
  const fixed = await injectDshContext({ prepared, task: 'Implement the requested feature.',
    routeSkillNames: ['kiokuko-single-purpose-functions'], soulInSystemPrompt: true })
  for (let turn = 1; turn <= 57; turn++) {
    const messages = projectDshContext([...fixed, fragment('directive', `Current phase ${turn}`)], live)
    assert.equal(messages.length, turn === 1 ? fixed.length + 1 : 1)
    live.append(messages)
  }
  const text = live.events.map(event => (event.data as any).content[0].text).join('\n')
  assert.equal(text.includes('# Kiokuko SOUL router'), false)
  assert.equal(text.split('name: kiokuko-single-purpose-functions').length - 1, 1)
  assert.equal(text.split('DSH host completed the Akinator intake gate').length - 1, 1)
  assert.equal(live.events.length, fixed.length + 57)
})

test('uncommitted attempts do not suppress delivery and pending native messages prevent double injection', () => {
  const live = session()
  const fragments = [fragment('expert', 'Required expert')]
  const proposed = projectDshContext(fragments, live)
  assert.equal(projectDshContext(fragments, live).length, 1, 'discarding a proposal must allow retry')
  assert.deepEqual(projectDshContext(fragments, live, proposed), [])
  live.append(proposed)
  assert.deepEqual(projectDshContext(fragments, live), [])
})

test('latest fragment wins including A to B to A changes, independent Skills, and pending changes', () => {
  const live = session()
  const first = [fragment('directive', 'A'), fragment('route-skill', 'Skill A', 'one'), fragment('route-skill', 'Skill B', 'two')]
  live.append(projectDshContext(first, live))
  live.append(projectDshContext([fragment('directive', 'B')], live))
  assert.equal(projectDshContext(first, live).length, 1)
  assert.deepEqual(projectDshContext(first, live, projectDshContext(first, live)), [])
})

test('compaction and restart reinstate only fragments missing from the retained surface', () => {
  const live = session()
  const fragments = [fragment('route-skill', 'Skill A', 'one'), fragment('expert', 'Expert A', 'one')]
  live.append(projectDshContext(fragments, live))
  live.events.push({ type: 'user/message', seq: 2, time: 2,
    data: { role: 'user', content: [{ type: 'text', text: 'Checkpoint' }], source: { kind: 'plugin:compaction' } },
    surfaceOp: { op: 'replace', start: 0, end: 0 } })
  const restored = { snapshotEvents: () => structuredClone(live.events) }
  const projected = projectDshContext(fragments, restored)
  assert.equal(projected.length, 1)
  assert.equal((projected[0] as any).content[0].text, 'Skill A')
  const native = { surface: { nodes: [2, 1] }, eventAt: (seq: number) => live.events[seq],
    snapshotEvents() { throw new Error('native path must not scan streamed chunks') } }
  assert.equal(projectDshContext(fragments, native).length, 1)
  assert.equal(projectDshContext(fragments, session()).length, 2, 'a separate native session is independent')
})

test('human and other-plugin copies cannot suppress host instructions', () => {
  const live = session()
  const fragments = [fragment('expert', 'Required expert')]
  const [owned] = projectDshContext(fragments, live) as any[]
  live.append([{ ...owned, source: { ...owned.source, kind: 'plugin:other' } },
    { ...owned, source: { ...owned.source, kind: 'user' } }])
  assert.equal(projectDshContext(fragments, live).length, 1)
})

test('22 continuations do not copy the native request and preserve additional intake once', async () => {
  const task = '実装を続けて欲しい'
  const human = { id: 'original-user-request', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: task }, { type: 'image', attachment: { attachmentId: 'original-attachment' } }] }
  const prepared = {
    intake: { status: 'ready', profile: { target: 'src', expected: task, constraints: 'Keep existing behavior.' } },
    nextAction: 'proceed', memoryPolicy: { memoryReasoningRequired: false, contextWithheld: false }, context: null,
  } as unknown as PreparedAgentTask
  const fixed = await injectDshContext({ prepared, task, soulInSystemPrompt: true, userTaskInConversation: true })
  const live = session()
  const batch = [human, ...projectDshContext(fixed, live, [human])]
  assert.equal(batch[0], human, 'native text and attachment retain their original object')
  live.append(batch)
  for (let turn = 0; turn < 22; turn++) live.append(projectDshContext(fixed, live))
  assert.equal(live.events.filter(event => (event.data as any).source.kind === 'user').length, 1)
  const pluginText = live.events.filter(event => (event.data as any).source.kind === 'plugin:kiokuko-dsh')
    .map(event => (event.data as any).content[0].text).join('\n')
  assert.equal(pluginText.includes(task), false)
  assert.equal(pluginText.split('Finalized intake:').length - 1, 1)
  assert.ok(pluginText.includes('Keep existing behavior.'))
  const repeat = { ...human, id: 'intentional-second-request' }
  const repeatedBatch = [repeat, ...projectDshContext(fixed, live, [repeat])]
  assert.equal(repeatedBatch[0], repeat, 'an intentional second human submission is preserved')
  assert.equal(repeatedBatch.length, 1)
})

// Identity, not matching prose, controls retries of the host's own current injection.
test('on-demand retries keep one owned origin while preserving human resends, foreign sources and tool state', () => {
  const live = session()
  const turn: any = {
    input: {
      agent: {
        session: { id: 'origin-session', snapshotEvents: live.snapshotEvents },
      },
      turn: 1,
    },
  }
  const intake = new OnDemandIntake({} as any)
  const first = intake.guidance([], turn)[0] as any
  assert.equal(
    (intake.guidance([], turn)[0] as any).id,
    first.id,
    'An uncommitted retry keeps the same origin',
  )
  const human = { ...first, id: 'human-1', source: { kind: 'user' } }
  const resend = { ...human, id: 'human-2' }
  const foreign = {
    ...first,
    source: { ...first.source, kind: 'plugin:other' },
  }
  const changed = {
    ...first,
    content: [{ type: 'text', text: 'Different approval state' }],
  }
  const tool = {
    ...first,
    role: 'tool',
    source: { kind: 'tool', callId: 'tool-result' },
    toolCallId: 'tool-result',
    isError: true,
  }
  const batch = intake.guidance(
    [first, first, human, resend, foreign, changed, tool],
    turn,
  )
  assert.deepEqual(batch, [first, human, resend, foreign, changed, tool])
  live.append([first])
  assert.deepEqual(intake.guidance([first, human, resend], turn), [
    human,
    resend,
  ])
  const nextTurn: any = { input: { ...turn.input, turn: 2 } }
  const next = intake.guidance([], nextTurn)[0] as any
  assert.notEqual(next.id, first.id, 'A different turn has a different origin')
  turn.requestIntentContext = createRequestIntentContext({
    task: 'Inspect parser.ts without editing it',
    messageRefs: [{ id: 'current', digest: 'a'.repeat(64) }],
  })
  const update = intake.guidance([], turn)[0] as any
  assert.notEqual(
    update.id,
    first.id,
    'A changed current instruction is delivered',
  )
  live.append([update])
  delete turn.requestIntentContext
  const restored = intake.guidance([], turn)[0] as any
  assert.notEqual(
    restored.id,
    first.id,
    'A to B to A is a new update, not an old retry',
  )
  assert.equal(restored.content[0].text, first.content[0].text)
  assert.equal(
    live.events.length,
    2,
    'Projection never rewrites retained history',
  )
})
