import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { BlockAssembler, LlmError, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { OpenCodeAdapter as Adapter } from '../../../src/dsh/models/vendor/opencode-adapter.js';

type Part = LanguageModelV4StreamPart;
let OpenCodeAdapter: typeof Adapter;
let scratch: string;
before(async () => {
  // Compile the actual adapter and codec, replacing only the SDK transport.
  // Keep disposable output in /tmp and explicitly reuse the installed dependencies.
  scratch = await mkdtemp(join(tmpdir(), 'opencode-lifecycle-'));
  await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(scratch,'node_modules'), 'dir');
  const outfile = join(scratch, 'adapter.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../../../src/dsh/models/vendor/opencode-adapter.ts', import.meta.url))],
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'synthetic-sdk-transport', setup(builder) {
      builder.onResolve({ filter: /\/opencode-transport\.js$/ }, () => ({ path: 'transport', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const createTransport = (...args) => ({ doStream: args[5] });', loader: 'js' }));
    } }] });
  ({ OpenCodeAdapter } = await import(pathToFileURL(outfile).href));
});
after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

const finish: Part = { type: 'finish', usage: { inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 0, text: undefined, reasoning: undefined } }, finishReason: { unified: 'tool-calls', raw: undefined } };
const start = (id = 'a', toolName = 'read'): Part => ({ type: 'tool-input-start', id, toolName });
const delta = (value = '{}', id = 'a'): Part => ({ type: 'tool-input-delta', id, delta: value });
const final = (input = '{}', toolCallId = 'a', toolName = 'read'): Part => ({ type: 'tool-call', toolCallId, toolName, input });
async function consume(parts: Part[]) {
  const model = { id: 'fixture', name: 'Fixture', protocol: 'chat' as const, contextWindow: 1024, maxTokens: 128, inputModalities: ['text' as const], toolCall: true, reasoning: false, temperature: false, efforts: [] };
  const adapter = new OpenCodeAdapter({ catalogs: new Map([['opencode', { models: () => [model], status: () => ({ excluded: [] }) }]]) as unknown as ConstructorParameters<typeof Adapter>[0]['catalogs'],
    store: { read: async () => ({ type: 'api_key', key: 'synthetic-only' }) } as unknown as ConstructorParameters<typeof Adapter>[0]['store'],
    fetcher: (async () => ({ stream: new ReadableStream<Part>({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }) })) as unknown as typeof fetch });
  const assembler = new BlockAssembler(); const chunks: StreamChunk[] = []; let error: unknown;
  try { for await (const chunk of adapter.stream({ provider: 'opencode', model: 'fixture', messages: [] })) { chunks.push(chunk); assembler.push(chunk); } } catch (caught) { error = caught; }
  return { assembler, chunks, error };
}
const malformed: Record<string, Part[]> = {
  'provider-executed delta-only tool': [{ type: 'tool-input-start', id: 'a', toolName: 'read', providerExecuted: true }, delta()],
  'provider-executed final tool': [{ type: 'tool-call', toolCallId: 'a', toolName: 'read', input: '{}', providerExecuted: true }],
  'duplicate active tool ID': [start(), delta(), start('a', 'write'), delta(), final('{}', 'a', 'write')],
  'duplicate ended tool ID': [final(), start(), delta()],
  'duplicate ended text ID': [{ type: 'text-start', id: 'a' }, { type: 'text-end', id: 'a' }, start(), delta()],
  'duplicate active text ID': [{ type: 'text-start', id: 'a' }, { type: 'text-start', id: 'a' }],
  'text delta into tool': [start(), { type: 'text-delta', id: 'a', delta: '{}' }, final()],
  'reasoning delta into text': [{ type: 'text-start', id: 'a' }, { type: 'reasoning-delta', id: 'a', delta: 'secret' }],
  'tool delta into reasoning': [{ type: 'reasoning-start', id: 'a' }, delta()],
  'text end into tool': [start(), delta(), { type: 'text-end', id: 'a' }, final()],
  'reasoning end into text': [{ type: 'text-start', id: 'a' }, { type: 'reasoning-end', id: 'a' }],
  'tool end into reasoning': [{ type: 'reasoning-start', id: 'a' }, { type: 'tool-input-end', id: 'a' }],
  'duplicate input end': [start(), delta(), { type: 'tool-input-end', id: 'a' }, { type: 'tool-input-end', id: 'a' }, final()],
  'conflicting final arguments': [start(), delta('{"path":"safe"}'), final('{"path":"different"}')],
  'empty conflicting final arguments': [start(), delta('{}'), final('')],
  'conflicting final identity': [start(), delta(), final('{}', 'a', 'write')],
  'duplicate final': [final(), final()],
  'unmatched delta': [delta()],
  'unmatched end': [{ type: 'tool-input-end', id: 'a' }],
  'delta after input end': [start(), delta(), { type: 'tool-input-end', id: 'a' }, delta()],
  'delta after completed text': [{ type: 'text-start', id: 'a' }, { type: 'text-end', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'late' }],
};
for (const [name, parts] of Object.entries(malformed)) test(`OpenCode rejects ${name} without a successful assembled finish`, async () => {
  const result = await consume([...parts, finish]);
  assert.ok(result.error instanceof LlmError, `expected protocol failure, got ${String(result.error)}`);
  assert.equal(result.error.code, 'PROTOCOL_ERROR');
  assert.equal(result.assembler.interruptedBlocks().some(block => block.type === 'tool-call'), false);
  assert.equal(result.chunks.some(chunk => chunk.type === 'finish'), false);
});
for (const [name, parts] of Object.entries({
  'matching streamed and final arguments': [start(), delta('{"p":'), delta('1}'), { type: 'tool-input-end', id: 'a' }, final('{"p":1}')],
  'final only': [final('{"p":1}')],
  'start and final without deltas': [start(), final('{"p":1}')],
  'empty delta and complete final': [start(), delta(''), final('{"p":1}')],
  'delta only': [start(), delta('{"p":1}')],
  'delta and input end without final': [start(), delta('{"p":1}'), { type: 'tool-input-end', id: 'a' }],
} satisfies Record<string, Part[]>)) test(`OpenCode preserves ${name}`, async () => {
  const result = await consume([...parts, finish]);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.assembler.finish, { kind: 'tool-calls' });
  assert.deepEqual(result.assembler.blocks(), [{ type: 'tool-call', id: 'a', name: 'read', arguments: '{"p":1}' }]);
});
test('OpenCode keeps distinct blocks and permits fresh IDs in a new dispatch', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await consume([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, final('{}', 'a'), final('{}', 'b'), finish]);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.assembler.blocks(), [{ type: 'text', text: 'ok' }, { type: 'tool-call', id: 'a', name: 'read', arguments: '{}' }, { type: 'tool-call', id: 'b', name: 'read', arguments: '{}' }]);
  }
});

for (const [name, streamed, complete, accepted] of [
  ['whitespace and object key order', '{"b": [1, {"y":true,"x":"ok"}], "a":null}', '{ "a": null, "b": [1,{"x":"ok","y":true}] }', true],
  ['escaped equivalent strings', '{"p":"a"}', '{"p":"\\u0061"}', true],
  ['decimal integer representation', '{"p":1.0}', '{"p":1}', true],
  ['positive exponent representation', '{"p":1e3}', '{"p":1000}', true],
  ['fraction and negative exponent', '{"p":0.00120}', '{"p":12E-4}', true],
  ['negative numeric representation', '{"p":-12.00e+2}', '{"p":-1200}', true],
  ['large exact integer equivalent', '{"p":9007199254740993.00}', '{"p":90071992547409930e-1}', true],
  ['negative zero equivalent', '{"p":-0.00e999}', '{"p":-0}', true],
  ['positive zero equivalent', '{"p":0e-999}', '{"p":0.00}', true],
  ['signed zero conflict', '{"p":-0}', '{"p":0}', false],
  ['overflow equivalent', '{"p":1e999}', '{"p":10e998}', true],
  ['overflow collision', '{"p":1e999}', '{"p":2e999}', false],
  ['underflow collision', '{"p":1e-999}', '{"p":2e-999}', false],
  ['decimal rounding collision', '{"p":0.10000000000000001}', '{"p":0.1}', false],
  ['negative sign conflict', '{"p":1}', '{"p":-1}', false],
  ['large integer precision collision', '{"p":9007199254740992}', '{"p":9007199254740993}', false],
  ['array ordering conflict', '{"p":[1,2]}', '{"p":[2,1]}', false],
  ['invalid final JSON', '{"p":1}', '{"p":1,}', false],
  ['invalid streamed JSON', '{"p":', '{"p":1}', false],
  ['duplicate-key alternative', '{"p":1,"p":2}', '{"p":2}', false],
] as const) test(`OpenCode argument comparison handles ${name}`, async () => {
  const result = await consume([start(), delta(streamed), final(complete), finish]);
  if (accepted) {
    assert.equal(result.error, undefined);
    assert.deepEqual(result.assembler.blocks(), [{ type: 'tool-call', id: 'a', name: 'read', arguments: streamed }]);
    assert.equal(result.chunks.some(chunk => chunk.type === 'finish'), true);
  } else {
    assert.ok(result.error instanceof LlmError);
    assert.equal(result.error.code, 'PROTOCOL_ERROR');
    assert.equal(result.chunks.some(chunk => chunk.type === 'finish'), false);
  }
});


test('HTTP 200 stream failure is a protocol failure, retains safe correlation and never becomes a completed response', async () => {
  const error=Object.assign(new Error('PRIVATE_PROVIDER_BODY'),{statusCode:200,responseHeaders:{'x-request-id':'fixture-request'}})
  const result=await consume([{type:'reasoning-start',id:'partial'},{type:'reasoning-delta',id:'partial',delta:'partial'},{type:'error',error}])
  assert.ok(result.error instanceof LlmError)
  assert.equal(result.error.code,'PROTOCOL_ERROR')
  assert.match(result.error.message,/stream.*HTTP 200/u)
  assert.doesNotMatch(result.error.message,/PRIVATE_PROVIDER_BODY|request failed/u)
  assert.equal(result.chunks.some(chunk=>chunk.type==='finish'),false)
})
