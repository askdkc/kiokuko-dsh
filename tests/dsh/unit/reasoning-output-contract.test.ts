import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgenticReplayConfig } from '../../../src/dsh/config.js'
import { projectAgenticReplayJson, scrubAgenticReplayText } from '../../../src/dsh/agenticreplay-security.js'
import { projectBlocks, toolResultOutcome } from '../../../src/dsh/agenticreplay-event-mapper.js'
import { reduceDshFinalizationLog, type DshLogEvent } from '../../../src/dsh/session-memory-finalizer.js'
import { agenticReplayFixture, collect, chunks, request, response } from '../helpers/agenticreplay-fixture.js'

const raw = 'PRIVATE_RAW_MODEL_OUTPUT_21a8'
const signature = 'PRIVATE_MODEL_SIGNATURE_21a8'
const display = 'Display-ready reasoning.'

test('rc.5 upstream prepares display text while preserving the raw Body Slot input', async () => {
  const fixture = JSON.parse(await readFile('tests/fixtures/reasoning-slot-rc5.json', 'utf8'))
  const module = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(fixture.reasoningTextSource)).toString('base64'))
  const input = `<signature>${signature}</signature>\r\n\r\n${display}`
  const text = module.reasoningText(input)
  assert.equal(text, display)
  assert.match(fixture.reasoningRowPatch, /renderSlot\('conversation.chat.reasoning.body', \{ rawText, text, running \}\)/u)
  assert.match(fixture.slotContractPatch, /readonly rawText: string/u)
  assert.equal(module.reasoningText('<sign'), '')
  assert.equal(module.reasoningText('<signature>partial'), '')
  assert.equal(module.reasoningText(display), display)
})

test('redacted analysis preserves display fields but omits rawText and signatures without reading accessors', () => {
  const legacy = { text: display, running: false }
  assert.deepEqual(projectAgenticReplayJson(legacy, 4096), legacy)
  for (const rawText of [raw, '', null, { nested: raw }]) {
    assert.deepEqual(projectAgenticReplayJson({ ...legacy, rawText, signature }, 4096), legacy)
  }
  assert.deepEqual(projectAgenticReplayJson({ ...legacy, get rawText() { throw Error('must not read') } }, 4096), legacy)
  for (const text of [JSON.stringify({ text: display, rawText: raw, signature }), String.raw`{\"text\":\"display\",\"rawText\":\"${raw}\",\"signature\":\"${signature}\"}`]) {
    const safe = scrubAgenticReplayText(text)
    assert.ok(!safe.includes(raw)); assert.ok(!safe.includes(signature))
    assert.equal(scrubAgenticReplayText(safe), safe)
  }
  assert.equal(scrubAgenticReplayText('rawText is a field; signature is a field.'), 'rawText is a field; signature is a field.')
})

test('native model blocks retain their text contract and never infer rawText as a native replacement', () => {
  const config = AgenticReplayConfig.parse({ capture: { reasoning: false, content: 'redacted' } })
  const block = { type: 'text', text: 'Assistant explanation, not execution proof.', rawText: raw }
  assert.deepEqual(projectBlocks([block], config), [{ type: 'text', text: block.text }])
  assert.deepEqual(projectBlocks([{ type: 'reasoning', text: raw, rawText: signature }], config), [{ type: 'reasoning', omitted: true }])
  const optedIn = AgenticReplayConfig.parse({ capture: { reasoning: true, content: 'redacted' } })
  assert.deepEqual(projectBlocks([{ type: 'reasoning', text: 'native-original', rawText: 'not-a-native-field' }], optedIn), [{ type: 'reasoning', text: 'native-original' }])
  assert.equal(toolResultOutcome({ isError: true, content: [{ type: 'text', text: 'Tests passed.' }] }).is_error, true)
})

test('bounded memory evidence excludes nested raw display fields while leaving the source event unchanged', async () => {
  const data = { title: 'Observed goal', text: display, nested: { rawText: raw, signature, reasoning: 'PRIVATE_REASONING' } }
  const events: DshLogEvent[] = [
    { seq: 0, time: 0, type: 'turn/start' },
    { seq: 1, time: 1, type: 'request/header', data: { header: { config: { provider: 'mock', model: 'mock' }, system: '', tools: [] } } },
    { seq: 2, time: 2, type: 'goal/change', data },
    { seq: 3, time: 3, type: 'turn/end' },
  ]
  const before = structuredClone(events)
  async function* log() { yield* events }
  const reduced = await reduceDshFinalizationLog(log(), 0, 3, 'bounded_evidence')
  const wire = JSON.stringify([reduced.evidence, reduced.boundedEvidence])
  assert.match(wire, /Observed goal/u); assert.match(wire, /Display-ready/u)
  for (const value of [raw, signature, 'PRIVATE_REASONING']) assert.ok(!wire.includes(value))
  assert.deepEqual(events, before)
})

test('recorded analysis HTML export omits raw fields while preserving the original native stream', async () => {
  const f = await agenticReplayFixture({ capture: { content: 'redacted' } })
  try {
    const values = response(JSON.stringify({ text: display, rawText: raw, signature }))
    assert.deepEqual(await collect(f.recorder.stream(f.binding, request, () => chunks(values))), values)
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state, 'completed')
    const html = await readFile(await f.reader.export(f.binding, row.agenticreplay_run_id), 'utf8')
    assert.ok(html.includes(display))
    assert.ok(!html.includes(raw)); assert.ok(!html.includes(signature))
  } finally { await f.dispose() }
})

const nativeRoot = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
test('real upstream llm/stream waterfall preserves native text and applies analysis privacy', {
  skip: existsSync(join(nativeRoot, '@deepseek-ai/dsh-llm/lib/index.js')) ? false : 'native DSH fixture unavailable',
}, async () => {
  const [{ Context }, llm] = await Promise.all(['cordis', 'dsh-llm'].map(name => import(pathToFileURL(join(nativeRoot, '@deepseek-ai', name, 'lib/index.js')).href)))
  const f = await agenticReplayFixture({ capture: { content: 'redacted' } })
  const ctx = new Context()
  const reasoning = `<signature>${signature}</signature>\n${raw}`
  const values = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: reasoning },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
    ...response(JSON.stringify({ text: display, rawText: raw, signature })).map(value => 'index' in value ? { ...value, index: value.index + 1 } : value),
  ]
  let calls = 0
  class NativeFixtureAdapter extends llm.LlmAdapter {
    async listModels(provider: string) { return [{ provider, id: 'fixture', name: 'fixture' }] }
    async resolveModel(provider: string) { return { provider, id: 'fixture', name: 'fixture' } }
    async *stream() { yield* values }
  }
  try {
    await ctx.plugin(llm.default)
    const release = ctx.llm.registerAdapter(['reasoning-contract'], new NativeFixtureAdapter())
    const unhook = ctx.on('llm/stream', (options: any, next: () => AsyncIterable<any>) => {
      calls++; return f.recorder.stream(f.binding, options, next)
    }, { global: true })
    const seen = await collect(ctx.llm.stream({ ...request, provider: 'reasoning-contract', model: 'fixture', signal: new AbortController().signal }))
    assert.deepEqual(seen, values); assert.equal(calls, 1)
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    const html = await readFile(await f.reader.export(f.binding, row.agenticreplay_run_id), 'utf8')
    assert.ok(html.includes(display)); assert.ok(!html.includes(raw)); assert.ok(!html.includes(signature))
    unhook(); release()
  } finally { await ctx.fiber.dispose(); await f.dispose() }
})
