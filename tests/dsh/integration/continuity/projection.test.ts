import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture } from '../../helpers/continuity.js'
import { DshExecutionSupport } from '../../../../src/dsh/execution-support.js'

test('compacted snapshot history cannot suppress the next request or resurrect another plugin', async () => {
  const f = await fixture()
  try {
    const old = f.support.projectMessages('session', [])[0]
    const events = [{ seq: 1, type: 'user/message', surfaceOp: 'append', data: old },
      { seq: 2, type: 'user/message', surfaceOp: { op: 'replace', start: 1, end: 1 }, data: { role: 'user', content: [{ type: 'text', text: 'compressed' }] } }]
    const session = { id: 'session', surface: { nodes: [2] }, eventAt: (seq: number) => events.find(e => e.seq === seq), snapshotEvents: () => events }
    await f.support.refresh({ ...f.binding, nativeSession: session }, false)
    const projected = f.support.projectMessages('session', [])
    assert.equal(projected.length, 1, 'must re-deliver after compaction')
    assert.match(projected[0].content[0].text, /根拠を示す/)
    assert.equal(f.support.projectMessages('session', []).length, 1, 'an uncommitted attempt is not delivery')
  } finally { await f.close() }
})

test('off and shadow have identical requests, DB work and guard counts; active replaces evidence, and reload removes it', async () => {
  const f = await fixture()
  const observations: any[] = []
  const shadow = new DshExecutionSupport(f.runtime, { continuity: { mode: 'shadow' }, observe: value => observations.push(value) })
  const active = new DshExecutionSupport(f.runtime, { continuity: { mode: 'active' } })
  try {
    f.read('range'); await f.assemble()
    await shadow.refresh(f.binding, false); await active.refresh(f.binding, false)
    assert.equal(shadow.text('session'), f.support.text('session'))
    assert.match(active.text('session'), /Continuity \(host projection/)
    assert.doesNotMatch(active.text('session'), /Recent evidence presentation/)
    const user = { id: 'human', role: 'user', content: [{ type: 'image', url: 'fixture' }, { type: 'text', text: '{{literal}}' }] }
    const snapshot = { id: 'current', role: 'user', source: { plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [{ name: 'other', text: 'CURRENT OTHER' }] } }
    const request = active.projectMessages('session', [user, snapshot])
    assert.equal(request[0], user)
    assert.match(request[1].content[0].text, /CURRENT OTHER/)
    assert.equal(active.projectMessages('session', request).length, 2)
    const off = new DshExecutionSupport(f.runtime)
    await off.refresh(f.binding, false)
    assert.doesNotMatch(off.projectMessages('session', request)[1].content[0].text, /Continuity \(host projection/)
    assert.match(off.text('session'), /根拠を示す/)
    assert.equal(f.db.prepare('SELECT json_extract(state_json, \'$.total\') AS total FROM dsh_exploration_states').get()!.total, 1)
    off.dispose()
  } finally { shadow.dispose(); active.dispose(); await f.close() }
})

test('active acquisition never reuses a previous full presentation; observer failure calls next once', async () => {
  const observations: any[] = []
  const f = await fixture({ continuity: { mode: 'active' }, observe: (value: any) => { observations.push(value); throw new Error('observer failure') } })
  try {
    f.read('full'); await f.assemble()
    f.stream([{ content: [{ type: 'tool-result', toolCallId: 'full', content: f.result.content }] }])
    await f.assemble()
    const messages = f.support.projectMessages('session', [])
    assert.match(messages[0].content[0].text, /Current request presentation is unknown/)
    assert.match(messages[0].content[0].text, /acquisition: full/)
    let calls = 0
    assert.equal(f.callbacks.get('llm/stream')!({ sessionId: 'session', messages }, () => { calls++; return 'stream' }), 'stream')
    assert.equal(calls, 1)
    assert.equal(observations.at(-1).copiesInRequest, 1)
    assert.deepEqual(Object.keys(observations.at(-1)).sort(), ['bytes', 'copiesInRequest', 'coverage', 'items', 'mode', 'omittedItems'])
    assert.equal(f.support.paused('session'), false)
  } finally { await f.close() }
})

test('shadow records numeric projection only at the final request seam and adds no text', async () => {
  const observations: any[] = []
  const f = await fixture({ continuity: { mode: 'shadow' }, observe: (value: any) => observations.push(value) })
  try {
    f.read('observed'); await f.assemble()
    const messages = f.support.projectMessages('session', [])
    f.stream(messages)
    assert.doesNotMatch(JSON.stringify(messages), /Continuity \(host projection/)
    assert.equal(observations.at(-1).copiesInRequest, 0)
    assert.ok(observations.at(-1).bytes <= 4096)
  } finally { await f.close() }
})

test('late refresh and delayed results cannot overwrite steering or mix sessions; terminal preserves results', async () => {
  const f = await fixture({ continuity: { mode: 'active' } })
  try {
    let release!: () => void
    f.wait(new Promise<void>(resolve => { release = resolve }))
    const old = f.support.refresh({ ...f.binding, task: 'done when: OLD' }, true)
    f.wait(undefined)
    await f.support.refresh({ ...f.binding, task: 'done when: NEW', generation: 'new' }, true)
    release(); await old
    assert.match(f.support.text('session'), /NEW/)
    assert.doesNotMatch(f.support.text('session'), /OLD/)
    assert.equal(f.support.text('another-session'), '')
    await f.support.refresh({ ...f.binding, terminal: true }, false)
    f.read('after-terminal'); await f.assemble()
    assert.match(f.support.text('session'), /Terminal state/)
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM dsh_execution_evidence').get()!.n, 0)
  } finally { await f.close() }
})

test('retained fallback respects compacted ranges and current sections without a surface API', async () => {
  const f = await fixture({ continuity: { mode: 'active' } })
  try {
    const old = f.support.projectMessages('session', [{ source: { plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [{ name: 'old', text: 'STALE OTHER' }] } }])[0]
    const events = [{ seq: 1, type: 'user/message', surfaceOp: 'append', data: old },
      { seq: 2, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, data: { content: [{ type: 'text', text: 'compressed' }] } }]
    await f.support.refresh({ ...f.binding, nativeSession: { snapshotEvents: () => events } }, false)
    const messages = f.support.projectMessages('session', [])
    assert.equal(messages.length, 1)
    assert.doesNotMatch(messages[0].content[0].text, /STALE OTHER/)
  } finally { await f.close() }
})

test('optional workspace resolution failure does not degrade the existing frame or exploration guard', async () => {
  const f = await fixture({ continuity: { mode: 'active' } })
  try {
    for (const id of ['a', 'b', 'c']) f.read(id)
    await f.assemble(); f.stream(); f.read('d'); await f.assemble()
    assert.equal(await f.support.pauseAtBoundary('session', async () => undefined), true)
    await f.support.refresh({ ...f.binding, cwd: f.root + '/removed-directory' }, false)
    assert.equal(f.support.paused('session'), true)
    assert.match(f.support.text('session'), /Continuity unavailable/)
    assert.match(f.support.text('session'), /根拠を示す/)
    assert.doesNotMatch(f.support.text('session'), /execution support is degraded/)
  } finally { await f.close() }
})
