import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAgenticReplayLibrary } from '../../../src/dsh/agenticreplay-libraries.js'
import { agenticReplayFixture, recordedRunDirectory } from '../helpers/agenticreplay-fixture.js'

const { TraceReader } = await loadAgenticReplayLibrary('core')
// Mixed-case base62: the shape the core entropy sweep replaces under a camelCase key.
const CALL_ID = 'call_00_gr7EnxHMW4v47FxAz2We2989'

test('a swept call id stays readable under the exempt tool_call_id alias', async () => {
  const f = await agenticReplayFixture()
  try {
    const exec = { token: Symbol(), callId: CALL_ID, rootCallId: CALL_ID, name: 'fixture', arguments: {} }
    f.recorder.preTool(f.binding, exec)
    f.recorder.toolDecision(exec, { kind: 'allow' })
    f.recorder.toolDispatch(exec)
    f.recorder.toolDispatched(exec)
    f.recorder.toolResult(f.binding, exec, { isError: false, content: [{ type: 'text', text: 'ok' }] })
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    const events = await (await TraceReader.open(await recordedRunDirectory(f.root, row.agenticreplay_run_id))).events()
    const call = events.find(event => event.type === 'tool.call')!
    const result = events.find(event => event.type === 'tool.result')!
    assert.equal(call.attrs?.tool_call_id, CALL_ID)
    assert.equal(result.attrs?.tool_call_id, CALL_ID)
    assert.notEqual(call.attrs?.callId, CALL_ID, 'the camelCase copy stays under the entropy sweep')
  } finally { await f.dispose() }
})
