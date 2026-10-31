import assert from 'node:assert/strict'
import test from 'node:test'
import { OnDemandIntake } from '../../../src/dsh/on-demand-intake.js'

function human(id: string, text: string) {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

test('probe: host-accurate sequence with finish()', async () => {
  let calls = 0
  const events: any[] = [{ type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } }]
  const session = { id: 'p-session', snapshotEvents: () => events }
  const agent = { id: 'p-agent', session }
  const intake = new OnDemandIntake({
    validate: async () => {},
    existing: async () => false,
    classify: async () => ({ deferInference: true }),
    prepare: async () => true,
    ready: () => false,
    nativeOwnership: async () => 'unowned',
    prepareNativeCoding: async () => { if (++calls === 2) throw new Error('disable refused: pending') },
  } as any)
  const ctx: any = { tools: { get: () => undefined, register: () => () => {}, guard: () => {} }, on: () => () => {}, provide: () => () => {} }
  intake.mount(ctx, ctx.tools)
  await intake.capture({ agent, turn: 1, step: 0, messages: [human('a', 'Implement parser.ts')], signal: new AbortController().signal } as any)
  console.log('after t1:', intake.snapshot(session.id)?.status)
  intake.finish(session, 1)
  console.log('after finish 1:', intake.snapshot(session.id)?.status)
  events.push({ type: 'turn/end', seq: 2, time: 0, data: { turn: 1 } }, { type: 'turn/start', seq: 3, time: 0, data: { turn: 2 } })
  await assert.rejects(intake.capture({ agent, turn: 2, step: 0, messages: [human('b', 'okay, commit messages?')], signal: new AbortController().signal } as any), /disable refused/u)
  console.log('after t2 fail:', intake.snapshot(session.id)?.status)
  intake.finish(session, 2)
  console.log('after finish 2:', intake.snapshot(session.id)?.status)
  events.push({ type: 'turn/end', seq: 4, time: 0, data: { turn: 2 } }, { type: 'turn/start', seq: 5, time: 0, data: { turn: 3 } })
  try {
    const ok = await intake.capture({ agent, turn: 3, step: 0, messages: [human('c', 'fuck')], signal: new AbortController().signal } as any)
    console.log('t3 allowed ->', ok)
  } catch (error) {
    console.log('t3 THREW ->', (error as Error).message)
  }
  console.log('snapshot:', JSON.stringify(intake.snapshot(session.id)))
  await intake.dispose()
})
