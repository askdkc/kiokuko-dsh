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
  const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(helper), '--crash', root], { encoding: 'utf8', timeout: 15000 })
  assert.equal(child.status, 73, child.stdout + child.stderr)
  assert.equal(readFileSync(join(root, 'effect-count.txt'), 'utf8'), '1')
  const { recoveryRuntime } = await import(helper.href)
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

test('partially retired runtime contexts survive process exit and repeated JSONL resume', async () => {
  const helper = new URL('../helpers/session-recovery-runtime.mjs', import.meta.url)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kiokuko-marker-recovery-')))
  const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(helper), '--legacy-crash', root], { encoding: 'utf8', timeout: 15000 })
  assert.equal(child.status,73,child.stdout+child.stderr)
  const { recoveryRuntime } = await import(helper.href)
  try {
    for(let round=0;round<2;round++) {
      const h=await recoveryRuntime(root)
      try {
        const {agent}=await h.ctx.agents.resume({resumeSessionId:'legacy-crashed'})
        const messages=agent.session.deriveMessages()
        assert.equal(messages.filter((m:any)=>m.source?.kind==='runtime-context').length,1)
        assert.equal(messages.filter((m:any)=>m.source?.kind==='user').length,50)
        const events=agent.session.snapshotEvents()
        assert.equal(events.filter((e:any)=>e.type==='user/message'&&e.data.source.kind==='runtime-context').length,50)
        const {retireLegacyRuntimeContexts}=await import('../../../src/dsh/harness/runtime-context.js')
        const seq=agent.session.seq;retireLegacyRuntimeContexts(agent.session);assert.equal(agent.session.seq,seq)
        await h.ctx.sessions.flush(agent.session)
      }finally{await h.ctx.fiber.dispose()}
    }
  } finally {rmSync(root,{recursive:true,force:true})}
})
