import test from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { fixture, history } from '../../helpers/semantic-compaction.js'
import { SemanticCompactionCoordinator } from '../../../../src/dsh/semantic-compaction/coordinator.js'
import { observationExcerpt, observationHandle, plainResult, packedSource, OBSERVATION_MARKER } from '../../../../src/dsh/observation-pack/policy.js'
import { selectCandidates } from '../../../../src/dsh/semantic-compaction/policy.js'
import { Config } from '../../../../src/dsh/config.js'
import { CoreConfig } from '../../../../src/dsh/core/host.js'

function setup(tool = 'read', mode: 'auto' | 'off' = 'auto') {
  const events = history('先頭🙂\n' + 'body material\n'.repeat(1200) + '末尾𠮷\n', tool)
  events.splice(7, 0, { seq: 7, type: 'tool/call', data: { callId: 'call-1', name: tool } }); events.forEach((e, i) => { e.seq = i })
  events[8]!.sourceEventSeqs = [7]
  for (const seq of [11, 12]) events[seq] = { seq, type: 'assistant/message', data: { stream: [], message: { id: `full-${seq}`, role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'continue' }] } } }
  const f = fixture({ events, mode: 'off' }); f.coordinator.stop(); f.nodes.splice(f.nodes.indexOf(7), 1)
  const definitions = new Map<string, any>(), listeners = new Map<string, Function>(), originalOn = f.agent.ctx.on
  f.services.tools = { get: (name: string) => definitions.get(name), schemas: () => [...definitions.values()].map(({ name, description, parameters }) => ({ name, description, parameters })), register: (def: any) => { definitions.set(def.name, def); return () => definitions.delete(def.name) } }
  f.agent.ctx.on = (name: string, fn: Function) => name === 'system-prompt/assemble' ? (listeners.set(name, fn), () => {}) : originalOn(name, fn)
  f.ctx.on = (name: string, fn: Function) => { listeners.set(name, fn); return () => {} }
  f.coordinator = new SemanticCompactionCoordinator(f.ctx, f.service, realpathSync(process.cwd()), { mode })
  const assemble = () => listeners.get('system-prompt/assemble')!({}, {}, async () => ({ variables: {}, tools: f.services.tools.schemas() }))
  const original = f.events[8]!, handle = observationHandle(f.session.id, original)
  return { ...f, definitions, listeners, assemble, original, handle, read: (args: unknown, agent = f.agent) => definitions.get('observation_read').execute(args, { agent, signal: new AbortController().signal }) }
}
test('pack, exact Unicode pages, off-mode historical reader, no second pack, restore without native auto', async () => {
  const f = setup()
  try {
    await f.assemble(); await f.step()
    const packed = f.events.at(-1)!; assert.equal(packedSource(f.session, packed), f.original)
    assert.ok(plainResult(packed)!.text.startsWith(OBSERVATION_MARKER)); assert.equal(f.calls.length, 0)
    const seq = f.session.seq; await f.step(); assert.equal(f.session.seq, seq)
    const original = plainResult(f.original)!.text, page = await f.read({ handle: f.handle, offset: 2, limit: 2000 })
    assert.equal(page.text, Array.from(original).slice(2, 2002).join('')); assert.equal(page.nextOffset, 2002)
    await assert.rejects(f.read({ handle: f.handle, offset: 1.5 })); await assert.rejects(f.read({ handle: f.handle, limit: 2001 }))
    await assert.rejects(f.read({ handle: f.handle, path: '/tmp/other' })); await assert.rejects(f.read({ handle: f.handle, offset: 999999 }))
    const reader = f.definitions.get('observation_read'); f.definitions.delete('observation_read'); f.services.compaction.config.auto = false
    await f.assemble(); await f.step(); assert.equal(plainResult(f.events.at(-1)!)!.text, original)
    f.definitions.set('observation_read', reader)
    assert.equal((await f.read({ handle: f.handle, offset: Array.from(original).length })).nextOffset, null)
  } finally { f.coordinator.stop() }
  const off = setup('read', 'off')
  try { await off.assemble(); await off.step(); assert.equal(off.events.length, 15); assert.equal((await off.read({ handle: off.handle })).text.length > 0, true) } finally { off.coordinator.stop() }
})
for (const kind of ['ok', 'nonzero', 'unknown', 'background', 'mismatch', 'aborted', 'denied'] as const) test(`Bash structured proof: ${kind}`, async () => {
  const f = setup('bash'), block = f.original.data.message.content[0]
  const value: any = { kind: 'foreground', exitCode: 0, timedOut: false, aborted: false }
  if (kind === 'nonzero') value.exitCode = 7
  if (kind === 'background') value.kind = 'background'
  if (kind === 'aborted') value.aborted = true
  if (kind === 'denied') value.sandbox = { denied: true }
  try {
    if (kind !== 'unknown') f.listeners.get('tools/result')!({ name: 'bash', callId: 'call-1', agent: f.agent }, { value, isError: false, content: kind === 'mismatch' ? [{ type: 'text', text: 'different' }] : block.content })
    await f.assemble(); await f.step()
    assert.equal(f.events.some(e => plainResult(e)?.text.startsWith(OBSERVATION_MARKER)), kind === 'ok')
  } finally { f.coordinator.stop() }
})
for (const kind of ['child', 'hidden', 'error', 'multi', 'interrupted', 'native-off', 'lisp_eval'] as const) test(`packing retains protected result: ${kind}`, async () => {
  const f = setup(kind === 'lisp_eval' ? kind : 'read')
  if (kind === 'child') f.session.header.parentSession = 'parent'
  if (kind === 'hidden') f.definitions.delete('observation_read')
  if (kind === 'error') f.original.data.message.content[0].isError = true
  if (kind === 'multi') f.original.data.message.content[0].content.push({ type: 'text', text: 'extra' })
  if (kind === 'interrupted') { f.events[12]!.data.interrupted = true; f.coordinator.stop(); f.coordinator = new SemanticCompactionCoordinator(f.ctx, f.service, realpathSync(process.cwd())) }
  if (kind === 'native-off') f.services.compaction.config.auto = false
  try { await f.assemble(); await f.step(); assert.equal(f.events.length, 15) } finally { f.coordinator.stop() }
})
test('partial pack append fails closed; reload skips the orphan prune marker', async () => {
  const f = setup(), append = f.session.append
  f.session.append = (type: string, ...args: any[]) => { if (type === 'tool/result') throw new Error('disk failure'); return append(type, ...args) }
  try {
    await f.assemble(); await assert.rejects(f.step(), /0 confirmed replacements/)
    const seq = f.session.seq; await f.step(); assert.equal(f.session.seq, seq)
    f.coordinator.stop(); f.session.append = append
    f.coordinator = new SemanticCompactionCoordinator(f.ctx, f.service, realpathSync(process.cwd()))
    await f.assemble(); await f.step(); assert.equal(f.session.seq, seq)
  } finally { f.coordinator.stop() }
})
test('excerpts preserve complete lines and a 1 KiB combined line budget', () => {
  const text = '日本語🙂\n'.repeat(1000), excerpt = observationExcerpt(text)
  assert.ok(Buffer.byteLength(excerpt.replace('\n…\n', '')) <= 1024)
  assert.equal(observationExcerpt('x'.repeat(20000)), '\n…\n')
})
test('suite and standalone core share defaults and independent opt-outs', () => {
  for (const schema of [Config, CoreConfig]) {
    const config = schema.parse({})
    assert.deepEqual(config.observationPack, { mode: 'auto' })
    assert.deepEqual(config.semanticCompaction, { mode: 'auto', preemptive: true, budgetMs: 5000 })
    const disabled = schema.parse({ observationPack: { mode: 'off' }, semanticCompaction: { preemptive: false } })
    assert.equal(disabled.semanticCompaction.mode, 'auto'); assert.equal(disabled.semanticCompaction.preemptive, false)
  }
})
test('native call provenance is eligible for semantic shortening; replacement provenance is not', () => {
  const f = setup()
  try {
    const surface = f.nodes.map(seq => f.events[seq]!)
    assert.equal(selectCandidates(surface, f.meter, new Map(), seq => f.events[seq]).length, 1)
    f.original.sourceEventSeqs = [8]
    assert.equal(selectCandidates(surface, f.meter, new Map(), seq => f.events[seq]).length, 0)
  } finally { f.coordinator.stop() }
})
test('a bound child restores inherited parent handles and cannot read across session identity', async () => {
  const f = setup()
  try {
    await f.assemble(); await f.step()
    f.session.id = 'child'; f.session.header.parentSession = 'semantic-session'
    f.coordinator.attach(f.agent, async () => ({ child: 'bound' }))
    await assert.rejects(f.read({ handle: f.handle }), /this session/)
    await f.step()
    assert.equal(plainResult(f.events.at(-1)!)!.text, plainResult(f.original)!.text)
  } finally { f.coordinator.stop() }
})
test('reloading with packing disabled retains exact historical handles and avoids a second replacement', async () => {
  const f = setup()
  try {
    await f.assemble(); await f.step()
    const seq = f.session.seq
    f.coordinator.stop(); await f.coordinator.drain()
    f.coordinator = new SemanticCompactionCoordinator(f.ctx, f.service, realpathSync(process.cwd()), { mode: 'off' })
    await f.assemble(); await f.step()
    assert.equal(f.session.seq, seq)
    assert.equal((await f.read({ handle: f.handle, offset: 9000, limit: 500 })).text, Array.from(plainResult(f.original)!.text).slice(9000, 9500).join(''))
  } finally { f.coordinator.stop(); await f.coordinator.drain() }
})
test('unsupported native history APIs remain a no-op', async () => {
  const f = setup()
  try {
    f.session.header.version = 2
    delete f.session.surface
    await f.step()
    assert.equal(f.events.length, 15)
  } finally { f.coordinator.stop() }
})
