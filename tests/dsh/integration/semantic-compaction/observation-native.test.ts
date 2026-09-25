import { collectReviewEvidence } from '../../../../src/memory/review/evidence.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SemanticCompactionCoordinator } from '../../../../src/dsh/semantic-compaction/coordinator.js'
import { plainResult, OBSERVATION_MARKER, ObservationReadInput } from '../../../../src/dsh/observation-pack/policy.js'
import { reduceDshFinalizationLog } from '../../../../src/dsh/session-memory-finalizer.js'
import { decisions } from '../../helpers/semantic-compaction.js'
import { nativeMock } from '../../helpers/native-mock.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name === 'cordis' ? name : `dsh-${name}`, 'lib/index.js')).href)
const [cordis, llm, sessions, projection, prompt, tools, registry, loop, meter, compaction, fsLocal, fsTools] = await Promise.all(['cordis', 'llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'agent-loop', 'token-meter', 'compaction-basic', 'fs-local', 'tool-fs'].map(load))

for (const mode of ['auto', 'off'] as const) test(`native read -> two full requests -> pack -> middle-page read -> actual write (${mode})`, async t => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'observation-native-'))), ctx = new cordis.Context(), fibers: any[] = []
  const source = Array.from({ length: 600 }, (_, i) => `line ${i}: ${i === 300 ? '中央の根拠🙂𠮷=verified' : 'ordinary source material'.repeat(2)}`).join('\n')
  await writeFile(join(root, 'source.txt'), source)
  const mock = nativeMock(llm), script: any[] = [], full: string[] = []
  let original = '', handle = '', offset = 0
  const resultText = (request: any, id = 'source-read') => request.messages.flatMap((m: any) => m.role === 'tool' && m.toolCallId === id
    ? [m.content[0]?.text]
    : m.content.filter((b: any) => b.type === 'tool-result' && b.toolCallId === id).map((b: any) => b.content[0]?.text))
    .find((text: any) => typeof text === 'string')
  script.push(mock.toolCallResponse('source-read', 'read', { file_path: 'source.txt' }))
  for (let n = 0; n < 2; n++) script.push((request: any) => {
    const text = resultText(request); full.push(text); assert.ok(text.includes('中央の根拠🙂𠮷=verified')); assert.ok(!text.includes(OBSERVATION_MARKER)); original = text
    return mock.textResponse('Next stage.')
  })
  script.push((request: any) => {
    const text = resultText(request)
    if (mode === 'off') { assert.equal(text, original); return mock.toolCallResponse('evidence-write', 'write', { file_path: 'answer.txt', content: original.slice(original.indexOf('中央の根拠')).split('\n')[0] }) }
    assert.ok(text.startsWith(OBSERVATION_MARKER), 'the third native request must receive a packed result')
    assert.ok(!text.includes('中央の根拠'))
    handle = JSON.parse(text.split('\n')[1]).handle
    offset = Array.from(original.slice(0, original.indexOf('中央の根拠'))).length
    return mock.toolCallResponse('middle-read', 'observation_read', { handle, offset, limit: 100 })
  })
  if (mode === 'auto') {
    script.push((request: any) => {
      const page = JSON.parse(resultText(request, 'middle-read')); assert.ok(page.text.startsWith('中央の根拠🙂𠮷=verified')); assert.equal(page.nextOffset, offset + 100)
      return mock.toolCallResponse('evidence-write', 'write', { file_path: 'answer.txt', content: page.text.split('\n')[0] })
    })
    script.push(mock.textResponse('Evidence written.'))
    script.push((request: any) => { assert.equal(resultText(request), original); return mock.textResponse('Reader hidden: original restored.') })
  }
  else script.push(mock.textResponse('Evidence written.'))
  class Provider extends mock.MockAdapter { override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 200000 } } } }
  const provider = new Provider(script)
  for (const plugin of [llm, sessions, projection, prompt, tools, registry, meter]) fibers.push(await ctx.plugin(plugin.default, plugin === prompt ? { persona: '' } : undefined))
  fibers.push(await ctx.plugin(loop.default, { agents: [] }))
  fibers.push(await ctx.plugin(compaction.default, { thresholdRatio: .8, retainTokens: 1000 }))
  fibers.push(await ctx.plugin(fsLocal.default, { cwd: root })); fibers.push(await ctx.plugin(fsTools))
  ctx.llm.registerAdapter(['mock'], provider)
  const d = decisions({ mode: 'off' }), coordinator = new SemanticCompactionCoordinator(ctx, d.service, root, { mode })
  const agentHandle = await ctx.agents.create({ sessionId: sessions.SessionId('observation-native'), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } })
  const agent = agentHandle.agent
  const run = async () => {
    agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } })); await agent.whenIdle()
    const end = agent.session.snapshotEvents().filter((e: any) => e.type === 'turn/end').at(-1)
    assert.equal(end?.data.reason.kind, 'completed', JSON.stringify(end))
  }
  try {
    await run(); await run(); await run(); assert.equal(full.length, 2); assert.equal(d.calls.length, 0)
    assert.equal(await readFile(join(root, 'answer.txt'), 'utf8'), '中央の根拠🙂𠮷=verified')
    const measured = { mode, requests: provider.requests.length, requestBytes: provider.requests.reduce((n: number, r: any) => n + Buffer.byteLength(JSON.stringify({ messages: r.messages, tools: r.tools })), 0), nativeTokens: ctx.tokenMeter.measure(agent.session).totalTokens, ...(d.service.status() as any).observationPack.metrics }
    assert.equal(measured.nativeRequestAttempts, provider.requests.length)
    assert.ok(measured.nativeRequestBytes > measured.requestBytes, 'native metrics include the system field as well as messages and tool definitions')
    const events = agent.session.snapshotEvents(), originalEvent = events.find((e: any) => plainResult(e)?.text === original)
    assert.ok(originalEvent.sourceEventSeqs.length === 1)
    if (mode === 'auto') {
      assert.equal(await readFile(join(root, 'answer.txt'), 'utf8'), '中央の根拠🙂𠮷=verified')
      const replacement = events.find((e: any) => plainResult(e)?.text.startsWith(OBSERVATION_MARKER))
      assert.deepEqual(replacement.sourceEventSeqs, [originalEvent.seq])
      const definition = ctx.tools.get('observation_read', agent), signal = new AbortController().signal
      const page = await definition.execute({ handle, offset, limit: 10 }, { agent, signal })
      assert.equal(Array.from(page.text).length, 10)
      assert.equal(page.text, Array.from(original).slice(offset, offset + 10).join(''))
      await assert.rejects(definition.execute({ handle: handle.slice(0, -1) + (handle.endsWith('a') ? 'b' : 'a') }, { agent, signal }))
      assert.equal(ObservationReadInput.safeParse({ handle, sessionId: 'other' }).success, false)
      assert.equal(ObservationReadInput.safeParse({ handle, limit: 2001 }).success, false)
      const other = await ctx.agents.create({ sessionId: sessions.SessionId('observation-other'), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } })
      try { await assert.rejects(definition.execute({ handle }, { agent: other.agent, signal })) } finally { await other.dispose() }
      const log = events as any[]
      const start = log.find(e => e.type === 'turn/start').seq, end = log.filter(e => e.type === 'turn/end').at(-1).seq
      const review = await collectReviewEvidence((async function* () { yield* log })(), 262144)
      assert.equal(review.filter(e => e.sourceSeqs.includes(originalEvent.seq)).length, 1)
      assert.ok(!review.some(e => e.sourceSeqs.includes(replacement.seq)))
      const reduced = await reduceDshFinalizationLog((async function* () { yield* log })(), start, end, 'bounded_evidence')
      assert.ok(!reduced.episodeEvidence!.some(e => e.seq === replacement.seq), 'replacement is not a second execution')
      const hide = agent.ctx.get('tools').restrict({ deny: ['observation_read'] })
      try { await run() } finally { hide() }
      assert.equal((d.service.status() as any).observationPack.metrics.restored, 1)
    }
    t.diagnostic(JSON.stringify(measured))
  } finally { coordinator.stop(); await coordinator.drain(); await agentHandle.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
