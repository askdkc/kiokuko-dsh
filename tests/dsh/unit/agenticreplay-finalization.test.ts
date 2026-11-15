import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadAgenticReplayLibrary } from '../../../src/dsh/agenticreplay-libraries.js'
import { agenticReplayErrorCode } from '../../../src/dsh/agenticreplay-types.js'
import { agenticReplayFixture, recordedRunDirectory } from '../helpers/agenticreplay-fixture.js'

const { TraceWriter, TraceReader } = await loadAgenticReplayLibrary('core')

test('SDK capacity and OS errors retain safe codes without retaining arbitrary messages', () => {
  assert.equal(agenticReplayErrorCode(new Error('diagnostic storage limit reached')), 'diagnostic_storage_limit')
  assert.equal(agenticReplayErrorCode(Object.assign(new Error('private'), { code: 'EIO' })), 'EIO')
  assert.equal(agenticReplayErrorCode(new Error('diagnostic storage limit reached private')), 'recording_io_failed')
})

for (const failure of ['none', 'close', 'validation', 'disk'] as const) test(`final recording status follows verification: ${failure}`, async () => {
  const f = await agenticReplayFixture({}, { createWriter: async (...args) => {
    const writer = await TraceWriter.create(...args)
    return {
      get runDir() { return writer.runDir },
      append: async event => {
        const saved = await writer.append(event)
        if (failure === 'disk' && event.type === 'run.start') {
          await writeFile(join(writer.runDir, 'measurement-overflow'), Buffer.alloc(f.config.maxTraceBytes + 1), { mode: 0o600 })
        }
        return saved
      },
      close: async () => {
        if (failure === 'disk') await rm(join(writer.runDir, 'measurement-overflow'))
        const manifest = await writer.close()
        if (failure === 'close') throw Object.assign(new Error('private close detail'), { code: 'EIO' })
        if (failure === 'validation') f.config.maxTraceBytes = 1
        return manifest
      },
    }
  } })
  f.config.maxTraceBytes = 100_000
  try {
    f.recorder.start(f.binding)
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    const dir = await recordedRunDirectory(f.root, row.agenticreplay_run_id)
    const events = await (await TraceReader.open(dir)).events()
    const end = events.find(event => event.type === 'run.end')!
    assert.equal(end.attrs?.recording_complete, false)
    assert.equal(end.attrs?.recording_verification, 'pending')
    const status = JSON.parse(await readFile(join(dir, 'capture-status.json'), 'utf8'))
    assert.equal(status.state, row.state)
    assert.equal(status.recordingComplete, failure === 'none')
    assert.equal(row.missing_event_count, 0, 'post-append measurement and finalization failures do not prove a missing event')
    if (failure === 'none') assert.equal(row.state, 'completed')
    else {
      assert.equal(row.last_error_code, failure === 'close' ? 'EIO' : failure === 'validation' ? 'export_input_limit' : 'trace_limit')
      assert.equal(status.failure.operation, failure === 'close' ? 'writer_close' : failure === 'validation' ? 'trace_validation' : 'disk_measurement')
    }
    assert.doesNotMatch(JSON.stringify(status), /private close detail/)
  } finally { await f.dispose() }
})

test('real SDK storage omission cannot be reported as a complete capture', async () => {
  const f = await agenticReplayFixture({}, { createWriter: async (runs, init) =>
    TraceWriter.create(runs, { ...init, storageLimits: { eventBytes: 1 } } as typeof init) })
  try {
    f.recorder.start(f.binding)
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'incomplete')
    assert.equal(row.last_error_code, 'event_storage_limit')
    assert.equal(row.missing_event_count, 0)
    const dir = await recordedRunDirectory(f.root, row.agenticreplay_run_id)
    const status = JSON.parse(await readFile(join(dir, 'capture-status.json'), 'utf8'))
    assert.equal(status.failure.operation, 'manifest_capture')
    assert.equal(status.recordingComplete, false)
  } finally { await f.dispose() }
})

test('real SDK diagnostic exhaustion is distinguished from disk I/O failure', async () => {
  const f = await agenticReplayFixture({}, { createWriter: async (runs, init) =>
    TraceWriter.create(runs, { ...init, storageLimits: { eventBytes: 1 } } as typeof init) })
  try {
    f.recorder.start(f.binding)
    for (let seq = 0; seq < 100; seq++) f.recorder.harnessAction(f.binding, {
      seq, data: { turn: 0, step: seq, action: 'turn', phase: 'start' },
    })
    await f.recorder.shutdown()
    const status = f.recorder.status(f.binding.sessionId)
    assert.equal(status.trace?.last_error_code, 'diagnostic_storage_limit')
    assert.equal(status.failure?.operation, 'writer_append')
    assert.notEqual(status.trace?.state, 'completed')
  } finally { await f.dispose() }
})

test('final status persistence failure cannot leave a completed index', async () => {
  const f = await agenticReplayFixture({}, { createWriter: async (...args) => {
    const writer = await TraceWriter.create(...args)
    return {
      get runDir() { return writer.runDir },
      append: event => writer.append(event),
      close: async () => {
        const manifest = await writer.close()
        await mkdir(join(writer.runDir, 'capture-status.json'), { mode: 0o700 })
        return manifest
      },
    }
  } })
  try {
    f.recorder.start(f.binding)
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'incomplete')
    assert.equal(row.last_error_code, 'capture_status_persistence_failed')
    assert.equal(f.recorder.status(f.binding.sessionId).persistenceFailed, true)
  } finally { await f.dispose() }
})
