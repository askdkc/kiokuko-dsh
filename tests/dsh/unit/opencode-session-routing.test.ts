import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { ConnectionSchema } from '../../../src/dsh/models/contracts.js';
import { openCodeSessionHeaders, openCodeSessionProvider } from '../../../src/dsh/models/opencode-session.js';
import { adapterBuiltinProviders, type PiAiProvider } from '../../../src/dsh/models/vendor/pi-ai.js';
import { connectionProfile } from '../../../src/dsh/models/profiles.js';

function protocolResponse(protocol: string): Response {
  const item = { id: 'message-fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'CONNECTED', annotations: [] }] };
  const events = protocol === 'responses' ? [
    { type: 'response.created', response: { id: 'response-fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'CONNECTED' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'response-fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ] : protocol === 'messages' ? [
    { type: 'message_start', message: { id: 'message-fixture', type: 'message', role: 'assistant', model: 'deepseek-v4.1-flash', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'CONNECTED' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] : [
    { id: 'completion-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'CONNECTED' }, finish_reason: null }] },
    { id: 'completion-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  return new Response(events.map(event => `${'type' in event ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

for (const route of ['zen', 'zen/go']) for (const protocol of ['chat-completions', 'responses', 'messages'] as const) {
  test(`owned custom OpenCode ${route} preserves session routing with ${protocol} on the unchanged DSH adapter`, async () => {
    const requests: Request[] = [];
    // Test-only fake transport: no actual network request or credential is used.
    const transport = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).origin, 'https://opencode.ai');
      requests.push(request);
      return protocolResponse(protocol);
    });
    try {
      const connection = ConnectionSchema.parse({ id: 'kiokuko-custom-go', kind: 'custom', name: 'Owned custom OpenCode', baseURL: `https://opencode.ai/${route}/v1`, protocol,
        models: [{ id: 'deepseek-v4.1-flash', name: 'Fixture', contextWindow: 262144, maxTokens: 1024, reasoning: false, image: false }] });
      const profile = connectionProfile(connection);
      const provider = profile.piProvider!;
      let capturedModel: Parameters<PiAiProvider['stream']>[0] | undefined;
      let capturedContext: Parameters<PiAiProvider['stream']>[1] | undefined;
      const monitored: PiAiProvider = { ...provider, streamSimple: (model, context, options) => { capturedModel = model; capturedContext = context; return provider.streamSimple(model, context, options); } };
      const monitoredProfile = { ...profile, piProvider: monitored };
      const adapter = new PiAiAdapter({ profiles: () => new Map([[connection.id, monitoredProfile]]), resolveApiKey: async () => 'synthetic-fixture-only',
        auth: { credentials: { read: async () => undefined, list: async () => [], modify: async (_id, fn) => fn(undefined), delete: async () => {} },
          authContext: { env: async () => undefined, fileExists: async () => false } } });
      for (const sessionId of ['conversation-a', 'conversation-a', 'conversation-b']) {
        const chunks = [];
        const options: GenerateOptions = { provider: connection.id, model: 'deepseek-v4.1-flash', sessionId: sessionId as NonNullable<GenerateOptions['sessionId']>,
          messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply with CONNECTED' }], source: { kind: 'user' } })] };
        for await (const chunk of adapter.stream(options)) chunks.push(chunk);
        const finish = chunks.at(-1);
        assert.ok(finish?.type === 'finish');
        assert.deepEqual(finish.reason, { kind: 'stop' });
        assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'CONNECTED'));
      }
      assert.equal(requests.length, 3);
      assert.deepEqual(requests.map(request => request.headers.get('x-opencode-session')), ['conversation-a', 'conversation-a', 'conversation-b']);
      assert.ok(requests.every(request => request.headers.has('user-agent')));
      assert.ok(capturedModel && capturedContext);
      const rawEvents = [];
      for await (const event of provider.stream(capturedModel, capturedContext, { apiKey: 'synthetic-fixture-only', sessionId: 'raw-conversation', maxTokens: 32 })) rawEvents.push(event);
      assert.equal(rawEvents.at(-1)?.type, 'done');
      assert.equal(requests.at(-1)!.headers.get('x-opencode-session'), 'raw-conversation');
    } finally { transport.mock.restore(); }
  });
}

test('session metadata preserves explicit mixed-case headers and leaves caller state unchanged', () => {
  const original = { 'X-OpenCode-Session': 'deployment-session', 'X-Tenant': 'synthetic' };
  assert.equal(openCodeSessionHeaders('conversation', original), original);
  const other = { 'X-Tenant': 'synthetic' };
  assert.deepEqual(openCodeSessionHeaders('conversation', other), { ...other, 'x-opencode-session': 'conversation' });
  assert.deepEqual(other, { 'X-Tenant': 'synthetic' });
  const suppressed = { 'X-OpenCode-Session': null };
  assert.equal(openCodeSessionHeaders('conversation', suppressed), suppressed);
});

test('one-shot transport identities are fresh UUIDs without changing application session state', () => {
  const first = openCodeSessionHeaders(undefined)['x-opencode-session'];
  const second = openCodeSessionHeaders(undefined)['x-opencode-session'];
  assert.match(first!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

test('OpenCode transport hooks do not attach routing metadata to other endpoints', () => {
  const original = adapterBuiltinProviders()[0]!;
  for (const endpoint of ['https://example.com/v1', 'https://opencode.ai.evil.invalid/zen/go/v1', 'https://opencode.ai/zen/go/v10', 'https://opencode.ai/other/v1', 'http://opencode.ai/zen/go/v1']) {
    assert.equal(openCodeSessionProvider(original, endpoint), original);
  }
});
