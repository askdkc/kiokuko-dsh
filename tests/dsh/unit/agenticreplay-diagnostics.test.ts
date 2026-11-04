import assert from 'node:assert/strict'
import test from 'node:test'
import { mountDshAgenticReplayHooks } from '../../../src/dsh/agenticreplay-hooks.js'
import { agenticReplayFixture, chunks, collect, request } from '../helpers/agenticreplay-fixture.js'

for (const content of ['redacted', 'metadata'] as const) test(`failure facts survive all recording seams (${content})`, async () => {
  const f = await agenticReplayFixture({ capture: { content } })
  const failure = { code: 'RATE_LIMITED', status: 429, requestId: 'req-diagnostic-123', providerRetryAfterMs: 1200,
    message: 'Provider capacity exhausted; authorization Bearer fixture-secret', response: { body: 'private-body' } }
  const thrown = Object.assign(new Error(failure.message), { failure })
  const listeners = new Map<string, Function>()
  const dispose = mountDshAgenticReplayHooks({ on(name: string, listener: Function) { listeners.set(name, listener); return () => {} } } as any,
    { recorder: f.recorder, resolveSessionBinding: () => f.binding, resolveModelBinding: () => f.binding, canRecord: () => true } as any)
  try {
    const finished = [{ type: 'finish', reason: { kind: 'error', failure } }]
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(finished))), finished)
    await assert.rejects(collect(f.recorder.stream(f.binding, request, () => (async function* () { throw thrown })())), error => error === thrown)
    listeners.get('agent/error')!({ agent: { session: {} }, turn: 2, step: 3, error: thrown })
    f.recorder.harnessAction(f.binding, { seq: 71, data: { action: 'turn', phase: 'error', turn: 2, step: 3, diagnostic: failure } })
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    const events = (await f.reader.show(f.binding, row.agenticreplay_run_id)).events
    const errors = events.filter(e => e.type === 'error')
    assert.equal(errors.length, 3)
    for (const event of [...errors, events.find(e => e.attrs?.native_seq === 71)!]) {
      assert.equal((event.attrs?.diagnostic as any)?.code, failure.code)
      assert.equal((event.attrs?.diagnostic as any)?.status, 429)
      assert.equal((event.attrs?.diagnostic as any)?.requestId, failure.requestId)
      assert.equal((event.attrs?.diagnostic as any)?.providerRetryAfterMs, 1200)
      if (content === 'redacted') assert.match((event.attrs?.diagnostic as any).message, /Provider capacity exhausted/)
      else assert.equal((event.attrs?.diagnostic as any).message, undefined)
    }
    assert.equal(events.find(e => e.attrs?.code === 'native_turn_failed')?.attrs?.step, 3)
    assert.equal(events.find(e => e.attrs?.code === 'native_turn_failed')?.turn, 2)
    assert.ok(events.filter(e => e.type === 'model.response').every(e => e.attrs?.failure_code === failure.code))
    assert.ok(errors.filter(e => e.attrs?.modelCallId).every(e => e.causes?.length === 1))
    assert.doesNotMatch(JSON.stringify(events), /fixture-secret|private-body|stack/)
  } finally { dispose(); await f.dispose() }
})
