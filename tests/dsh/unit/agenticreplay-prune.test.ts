import assert from 'node:assert/strict'
import test from 'node:test'
import { access } from 'node:fs/promises'
import { selectPrunableTraces } from '../../../src/dsh/agenticreplay-read-service.js'
import { agenticReplayFixture, chunks, collect, recordedRunDirectory, request, response } from '../helpers/agenticreplay-fixture.js'

const row = (id: string, state: string, startedAt: string, recordedBytes: number) =>
  ({ agenticreplay_run_id: id, state, started_at: startedAt, recorded_bytes: recordedBytes }) as any
const now = Date.parse('2026-01-10T00:00:00.000Z')

test('prune selection keeps active traces, truncates by age, and never invents an empty request', () => {
  const rows = [
    row('run_aaaaaaaaaaaaaaaaaaaaaaaa', 'completed', '2026-01-01T00:00:00.000Z', 10),
    row('run_bbbbbbbbbbbbbbbbbbbbbbbb', 'completed', '2026-01-09T00:00:00.000Z', 10),
    row('run_cccccccccccccccccccccccc', 'recording', '2026-01-01T00:00:00.000Z', 10),
    row('run_dddddddddddddddddddddddd', 'incomplete', '2026-01-02T00:00:00.000Z', 10),
  ]
  assert.deepEqual(selectPrunableTraces(rows, { olderThanDays: 1 }, now).map(each => each.agenticreplay_run_id),
    ['run_aaaaaaaaaaaaaaaaaaaaaaaa', 'run_dddddddddddddddddddddddd'])
  assert.deepEqual(selectPrunableTraces(rows, { maxBytes: 25 }, now).map(each => each.agenticreplay_run_id),
    ['run_aaaaaaaaaaaaaaaaaaaaaaaa', 'run_dddddddddddddddddddddddd'])
  // An active trace cannot be reclaimed, so its bytes never make the store look smaller.
  assert.deepEqual(selectPrunableTraces([row('run_cccccccccccccccccccccccc', 'recording', '2026-01-01T00:00:00.000Z', 10_000)], { maxBytes: 0 }, now), [])
  assert.deepEqual(selectPrunableTraces(rows, {}, now), [])
})

test('prune deletes a closed recording with its directory and index row, and refuses an unbounded request', async () => {
  const f = await agenticReplayFixture()
  try {
    await collect(f.recorder.stream(f.binding, request, () => chunks(response())))
    await f.recorder.shutdown()
    const trace = (await f.reader.list(f.binding))[0]!
    const dir = await recordedRunDirectory(f.root, trace.agenticreplay_run_id)
    await assert.rejects(() => f.reader.prune(f.binding, {}), (error: any) => error?.code === 'invalid_command')
    const result = await f.reader.prune(f.binding, { maxBytes: 0 })
    assert.deepEqual(result.deleted, [trace.agenticreplay_run_id])
    assert.deepEqual(await f.reader.list(f.binding), [])
    await assert.rejects(() => access(dir))
  } finally { await f.dispose() }
})
