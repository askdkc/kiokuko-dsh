import { writeFile } from 'node:fs/promises'
import { createDshToolDefinitions } from '../src/dsh/tools.ts'
import { modelFacingInputSchema } from '../src/model-tools/registry.ts'
import { buildDshMessageSources, redactDshSourceText } from '../src/dsh/message-sources.ts'
import { reduceDshFinalizationLog } from '../src/dsh/session-memory-finalizer.ts'
import { buildFinalizationRequest } from '../src/dsh/finalization-request.ts'
import { requestSize } from '../src/dsh/efficiency.ts'

// Synthetic, reproducible display/request measurements. This makes no provider calls.
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
const compare = (baselineBytes, currentBytes) => ({ baselineBytes, currentBytes, savedBytes: baselineBytes - currentBytes })
const definitions = createDshToolDefinitions({ bind() { throw new Error('No tools execute in this evaluation') }, async execute() { throw new Error('No tools execute in this evaluation') } })
const visible = definitions.map(({ name, description, parameters }) => ({ name, description, parameters }))
const baseline = visible.map(definition => ({ ...definition, description: definition.name === 'enno_delegate' ? definition.description :
  `Kiokuko ${definition.name} semantic operation. Supply nested values as their native JSON types; never encode an object or array as a JSON string. Host identity, routing, lease, and idempotency fields are supplied by the dsh host. The result is a TurnOutcome: applied results carry the business response in value and the next-turn state in handoff; predictable rejections return retry or clarify without a tool transport error. The business payload contract is: ${JSON.stringify(modelFacingInputSchema(definition.name))}` }))
const memory = []
for (const [name, items] of [
  ['none', []],
  ['identical-summary-body', [{ title: '保存条件', summary: '検証に失敗した場合は保存せず、現在のrevisionを読み直す。', bodyPreview: '検証に失敗した場合は保存せず、現在のrevisionを読み直す。' }]],
  ['distinct-exception', [{ title: '保存条件', summary: '検証後に保存する。', bodyPreview: 'ただし、失敗または承認待ちなら保存しない。' }]],
]) {
  const sources = await buildDshMessageSources({ task: '', soulInSystemPrompt: true, intakeStatus: 'ready', nextAction: 'proceed',
    memoryPolicy: { memoryReasoningRequired: false, contextWithheld: false }, context: { untrusted: true, items } })
  memory.push({ name, ...compare(items.reduce((sum, item) => sum + bytes(redactDshSourceText([item.title, item.summary ?? '', item.bodyPreview].filter(Boolean).join('\n')) ?? ''), 0),
    sources.filter(source => source.kind === 'memory').reduce((sum, source) => sum + bytes(source.text), 0)) })
}
const finalization = []
for (const length of [0, 70_000, 250_000]) {
  const events = [
    { seq: 0, time: 0, type: 'turn/start' },
    { seq: 1, time: 1, type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'fixture' }, system: 'You are a coding assistant.', tools: visible } } },
    { seq: 2, time: 2, type: 'request/context', data: { contextWindow: 1_000_000 } },
    { seq: 3, time: 3, type: 'user/message', surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'Implement and verify the scoped change.' }], source: { kind: 'user' } } },
    { seq: 4, time: 4, type: 'tool/result', surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'tool-result', content: [{ type: 'text', text: `Inspected source. ${'x'.repeat(length)}` }] }] } } },
    { seq: 5, time: 5, type: 'assistant/message', surfaceOp: 'append', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Implemented and verified. No unresolved failures.' }] } } },
    { seq: 6, time: 6, type: 'turn/end' },
  ]
  async function* stream() { yield* events }
  const prepared = await reduceDshFinalizationLog(stream(), 0, 6, 'bounded_evidence')
  const job = { runId: 'fixture', dshSessionId: 'fixture', sourceStartSeq: 0, sourceEndSeq: 6 }
  const signal = new AbortController().signal
  const prefix = buildFinalizationRequest({ ...job, inputMode: 'prefix_reuse' }, prepared, signal)
  const bounded = buildFinalizationRequest({ ...job, inputMode: 'bounded_evidence' }, prepared, signal)
  finalization.push({ toolOutputChars: length, inputMode: bounded.inputMode, fallback: bounded.fallback ?? null,
    ...compare(requestSize(prefix.request).totalBytes, requestSize(bounded.request).totalBytes) })
}
const report = { format: 'kiokuko-dsh.efficiency-fixtures.v1', baseline: '6395f464 display contract; current business schemas',
  evidence: 'synthetic serialized inputs only', providerCalls: 0, tokenizer: null, tokensSaved: null, costSaved: null,
  schemas: compare(bytes(baseline), bytes(visible)), memory, finalization }
const json = `${JSON.stringify(report, null, 2)}\n`
if (process.argv.length > 2) {
  if (process.argv.length !== 4 || process.argv[2] !== '--output') throw new Error('Usage: npm run test:efficiency -- [--output report.json]')
  await writeFile(process.argv[3], json, { flag: 'w' })
}
process.stdout.write(json)
