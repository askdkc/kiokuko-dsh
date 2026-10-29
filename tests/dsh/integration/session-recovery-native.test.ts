import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('a real process crash after an effect resumes without re-executing that unknown operation', async () => {
  const helper = new URL('../helpers/session-recovery-runtime.mjs', import.meta.url)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kiokuko-native-recovery-')))
  const child = spawnSync(process.execPath, [fileURLToPath(helper), '--crash', root], { encoding: 'utf8', timeout: 15000 })
  assert.equal(child.status, 73, child.stdout + child.stderr)
  assert.equal(readFileSync(join(root, 'effect-count.txt'), 'utf8'), '1')
  const { recoveryRuntime } = await import('../helpers/session-recovery-runtime.mjs')
  const { SessionRecovery } = await import('../../../src/dsh/session-recovery.js')
  const h = await recoveryRuntime(root)
  const recovery = new SessionRecovery(h.ctx)
  try {
    const cold = await recovery.inspect('crashed-session')
    assert.equal(cold.interrupted, true)
    assert.deepEqual(cold.unknownCalls, [{ id: 'before-crash', name: 'write_fixture' }])
    assert.equal(h.requests.length, 0)
    const { agent } = await h.ctx.agents.resume({ resumeSessionId: 'crashed-session' })
    const status = await recovery.inspect(agent.id)
    assert.equal(status.canContinue, true)
    assert.ok(agent.session.snapshotEvents().some((event: any) => event.type === 'tool/result' && event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN'))
    await recovery.act({ sessionId: agent.id, action: 'continue', operationId: 'crash-recovery', expectedSeq: status.seq })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !(h.requests.length === 1 && agent.status === 'idle')) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(h.requests.length, 1)
    assert.equal(agent.status, 'idle')
    assert.equal(readFileSync(h.counter, 'utf8'), '1', 'the started operation is not executed again')
    const request: any = h.requests[0]
    assert.ok(request.messages.some((message: any) => message.role === 'tool' && message.toolCallId === 'before-crash' && message.isError))
    assert.ok(request.messages.some((message: any) => message.role === 'user' && JSON.stringify(message.content).includes('無条件に再実行しない')))
    assert.ok(agent.session.snapshotEvents().some((event: any) => event.type === 'assistant/message' && JSON.stringify(event.data.message.content).includes('Recovered from durable history.')))
  } finally {
    await recovery.dispose()
    await h.ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
