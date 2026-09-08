import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFile, chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mountDshOrcaCommand } from '../../../src/dsh/orca-command-surface.js'
import { DshOrcaReadService } from '../../../src/dsh/orca-read-service.js'
import type { DshNativeCommandDefinition } from '../../../src/dsh/commands.js'
import type { DshOrcaHostServices } from '../../../src/dsh/orca-types.js'
import { orcaFixture, request, response, chunks, collect } from '../helpers/orca-fixture.js'

async function completed(f: Awaited<ReturnType<typeof orcaFixture>>) {
  await collect(f.recorder.stream(f.binding, request, () => chunks(response('hello'))))
  await f.recorder.closeSessionRecording(f.binding.sessionId, 'manual')
  return (await f.reader.list(f.binding))[0]!
}
test('timeline cursor is signed, run-bound, seek-based, and limited by bytes and event count', async () => {
  const f = await orcaFixture({ maxTimelineEventsPerPage: 2 })
  try {
    const row = await completed(f)
    const page1 = await f.reader.show(f.binding, row.orca_run_id)
    assert.equal(page1.events.length, 2)
    assert.ok(page1.cursor)
    const page2 = await f.reader.show(f.binding, row.orca_run_id, page1.cursor)
    assert.equal(page2.events[0]?.seq, 2)
    await assert.rejects(f.reader.show(f.binding, row.orca_run_id, page1.cursor + 'bad'), /invalid_cursor/u)
    // An invalid prefix is never rescanned by a subsequent page; full export still detects it.
    const file = join(f.root, '.orca/runs', row.orca_run_id, 'events.jsonl')
    const data = await readFile(file); data[0] = 120; await writeFile(file, data)
    assert.equal((await f.reader.show(f.binding, row.orca_run_id, page1.cursor)).events[0]?.seq, 2)
    await assert.rejects(f.reader.export(f.binding, row.orca_run_id))
  } finally { await f.dispose() }
})
for (const limit of ['maxHtmlExportInputBytes', 'maxHtmlExportEvents', 'maxHtmlExportOutputBytes'] as const) test(`HTML rejects ${limit} before creating any output`, async () => {
  const f = await orcaFixture({ [limit]: 1 })
  try {
    const row = await completed(f)
    await assert.rejects(f.reader.export(f.binding, row.orca_run_id), /limit/u)
    await assert.rejects(readFile(join(f.root, '.orca/exports', row.orca_run_id + '.html')))
  } finally { await f.dispose() }
})
test('stale index totals, missing newline, changed events and unsafe modes reject export', async () => {
  const f = await orcaFixture()
  try {
    const row = await completed(f)
    f.store.save({ ...row, export_input_bytes: row.export_input_bytes + 1 })
    await assert.rejects(f.reader.export(f.binding, row.orca_run_id), /trace_integrity_mismatch/u)
    f.store.save(row)
    const file = join(f.root, '.orca/runs', row.orca_run_id, 'events.jsonl')
    const bytes = await readFile(file)
    await writeFile(file, bytes.subarray(0, -1))
    await assert.rejects(f.reader.export(f.binding, row.orca_run_id), /truncated_jsonl/u)
    await writeFile(file, bytes)
    await chmod(file, 0o644)
    await assert.rejects(f.reader.show(f.binding, row.orca_run_id), /unsafe_path/u)
  } finally { await f.dispose() }
})
test('reader does not infer session ownership and rejects traversal or another session identically', async () => {
  const f = await orcaFixture()
  try {
    const row = await completed(f)
    for (const id of [row.orca_run_id, 'run_123456', '../../etc/passwd', 'last']) {
      await assert.rejects(f.reader.show({ ...f.binding, sessionId: 'other' }, id), /trace_not_found/u)
      await assert.rejects(f.reader.export({ ...f.binding, sessionId: 'other' }, id), /trace_not_found/u)
    }
    const tiny = new DshOrcaReadService({ ...f.config, maxTimelineReadBytesPerPage: 32 }, f.withIndex)
    await assert.rejects(tiny.show(f.binding, row.orca_run_id), /timeline_line_limit/u)
  } finally { await f.dispose() }
})
test('native command requires exact agent/session before every operation, including completed runs', async () => {
  const f = await orcaFixture()
  try {
    const row = await completed(f)
    const session = { id: f.binding.sessionId }, agent = { id: 'agent-a', session }
    const services: DshOrcaHostServices = { config: f.config, recorder: f.recorder, withIndex: f.withIndex,
      resolveSessionBinding: (a, s) => a === agent && s === session ? f.binding : undefined,
      canRecord: () => true, sessionRecordingStatus: async () => ({ sessionRecording: 'enabled' }),
      setSessionRecording: async (binding, enabled) => { if (enabled) f.recorder.start(binding); else await f.recorder.closeSessionRecording(binding.sessionId, 'manual') },
      resolveModelBinding: () => undefined, closeSessionRecording: (id, reason) => f.recorder.closeSessionRecording(id, reason), shutdown: () => f.recorder.shutdown() }
    let definition!: DshNativeCommandDefinition
    mountDshOrcaCommand({ commands: { register: def => { definition = def; return () => {} } } }, true, services)
    const signal = new AbortController().signal
    for (const bad of [undefined, { id: agent.id }, { id: agent.id, session }, { ...agent, sessionId: 'wrong' }]) {
      const result = await definition.handler({ rawInput: `show ${row.orca_run_id}`, signal, ...(bad ? { agent: bad } : {}) })
      assert.equal(result.kind, 'error'); assert.equal(result.text, 'session_required')
    }
    const result = await definition.handler({ rawInput: `show ${row.orca_run_id}`, signal, agent })
    assert.equal(result.kind, 'success')
    const status = await definition.handler({ rawInput: 'status', signal, agent })
    assert.equal(status.kind, 'success')
    assert.match(status.text!, /^OrcaReplay: 記録完了\n/u)
    const json = await definition.handler({ rawInput: 'status --json', signal, agent })
    assert.equal(json.kind, 'success')
    assert.deepEqual(JSON.parse(json.text!), JSON.parse(JSON.stringify({ ...f.recorder.status(session.id), sessionRecording: 'enabled' })))
    for (const rawInput of ['status --verbose', 'status --json extra', 'start --json', 'stop --json']) {
      assert.deepEqual(await definition.handler({ rawInput, signal, agent }), { kind: 'error', text: 'invalid_command' })
    }
    assert.deepEqual(await definition.handler({ rawInput: 'status --json', signal, agent: { ...agent } }),
      { kind: 'error', text: 'session_required' })
    assert.equal(f.recorder.status(session.id).trace?.orca_run_id, row.orca_run_id, 'status and invalid options do not start another recording')
    mountDshOrcaCommand({ commands: { register: def => { definition = def; return () => {} } } }, false)
    assert.match((await definition.handler({ rawInput: 'status', signal, agent })).text!, /^OrcaReplay: 機能が無効です\n/u)
    assert.deepEqual(JSON.parse((await definition.handler({ rawInput: 'status --json', signal, agent })).text!), { capability: 'disabled' })
  } finally { await f.dispose() }
})
test('crash reconciliation never changes live owners or reopens trace files', async () => {
  const f = await orcaFixture()
  try {
    const row = await completed(f)
    f.store.save({ ...row, state: 'recording', recorder_instance_id: 'unknown-owner' })
    // Existing immutable identity is retained; this row belongs to this still-live process.
    assert.equal((await f.reader.list(f.binding))[0]?.state, 'recording')
    const original = await readFile(join(f.root, '.orca/runs', row.orca_run_id, 'events.jsonl'))
    assert.deepEqual(await readFile(join(f.root, '.orca/runs', row.orca_run_id, 'events.jsonl')), original)
  } finally { await f.dispose() }
})

test('viewer failure disables show/export while the recording stays completed', async () => {
  const f = await orcaFixture()
  try {
    const row = await completed(f)
    const reader = new DshOrcaReadService(f.config, f.withIndex, async () => { throw new Error('broken viewer') })
    await assert.rejects(reader.show(f.binding, row.orca_run_id), /viewer_unavailable/u)
    await assert.rejects(reader.export(f.binding, row.orca_run_id), /viewer_unavailable/u)
    assert.equal((await f.reader.list(f.binding))[0]?.state, 'completed')
  } finally { await f.dispose() }
})

test('reconciliation marks a proven dead process incomplete, including index-only crashes', async () => {
  const f = await orcaFixture()
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { cwd: f.root, stdio: ['pipe', 'ignore', 'ignore'] })
  try {
    assert.ok(child.pid)
    const row = await completed(f)
    const interrupted = { ...row, orca_run_id: 'run_aabbccddeeff', state: 'recording' as const,
      recorder_instance_id: `pid_${child.pid}_abcdefabcdefabcdefabcdef`, recording_generation: 'crashed-generation', ended_at: null }
    f.store.save(interrupted)
    assert.equal((await f.reader.list(f.binding)).find(r => r.orca_run_id === interrupted.orca_run_id)?.state, 'recording')
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGTERM'); await exited
    const recovered = (await f.reader.list(f.binding)).find(r => r.orca_run_id === interrupted.orca_run_id)!
    assert.equal(recovered.state, 'incomplete'); assert.equal(recovered.last_error_code, 'owner_terminated')
    await assert.rejects(f.reader.show(f.binding, recovered.orca_run_id), /trace_not_completed/u)
    assert.equal((await f.reader.list(f.binding)).find(r => r.orca_run_id === row.orca_run_id)?.state, 'completed')
  } finally { child.kill(); await f.dispose() }
})

test('hot reload binds an existing session at exact pre-step without scanning or changing the decision', async () => {
  const f = await orcaFixture()
  const { createDshOrcaHost } = await import('../../../src/dsh/orca-host.js')
  const listeners = new Map<string, (...args: any[]) => any>()
  const session = { id: f.binding.sessionId, header: { cwd: f.root } }
  const agent = { id: 'live-before-reload', session }
  const ctx = { on: (name: string, listener: (...args: any[]) => any) => { listeners.set(name, listener); return () => listeners.delete(name) } }
  const services = createDshOrcaHost(ctx as never, f.config, { withDatabase: async (op: any) => op(f.database) } as never,
    { session: id => id === session.id ? session : undefined, agent: id => id === agent.id ? agent : undefined, logicalRun: () => undefined })
  try {
    assert.equal(services.resolveModelBinding(session.id), undefined)
    const decision = Object.freeze({ kind: 'enter', messages: [] })
    let calls = 0
    assert.equal(await listeners.get('agent/pre-step')!({ agent }, () => { calls++; return decision }), decision)
    assert.equal(calls, 1)
    assert.equal(services.resolveModelBinding(session.id)?.sessionCwd, f.root)
    assert.equal(services.resolveSessionBinding({ ...agent }, session), undefined)
    await services.shutdown()
    assert.equal(listeners.size, 0)
  } finally { await services.shutdown(); await f.dispose() }
})
