import assert from 'node:assert/strict';
import test from 'node:test';
import { renderEnnoStopHook, renderOpenCodeEnnoPlugin } from '../../src/setup/enno-client-config.js';

test('Codex and Claude Stop hooks preserve user handlers and remove only the exact managed handler', () => {
  const existing = JSON.stringify({
    theme: 'keep',
    hooks: { Stop: [{ matcher: 'user', hooks: [{ type: 'command', command: 'user-hook' }] }] },
  }, null, 2) + '\n';
  const codex = renderEnnoStopHook(existing, 'codex', 'kiokuko', 'on');
  const parsed = JSON.parse(codex.content!) as {
    theme: string;
    hooks: { Stop: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
  };
  assert.equal(parsed.theme, 'keep');
  assert.equal(parsed.hooks.Stop.length, 2);
  assert.equal(parsed.hooks.Stop[0]?.hooks[0]?.command, 'user-hook');
  assert.equal(parsed.hooks.Stop[1]?.hooks[0]?.command, 'kiokuko enno hook --client codex --input-json -');
  assert.equal(renderEnnoStopHook(codex.content, 'codex', 'kiokuko', 'on').action, 'unchanged');

  const removed = renderEnnoStopHook(codex.content, 'codex', 'kiokuko', 'off');
  const after = JSON.parse(removed.content!) as typeof parsed;
  assert.equal(after.theme, 'keep');
  assert.deepEqual(after.hooks.Stop, parsed.hooks.Stop.slice(0, 1));

  const claude = renderEnnoStopHook(undefined, 'claude', 'kiokuko', 'on');
  assert.match(claude.content!, /enno hook --client claude/u);
  assert.doesNotMatch(claude.content!, /statusMessage/u);
});

test('Stop hook setup rejects modified identities, duplicate identities, and shell-like executables', () => {
  const modified = JSON.stringify({ hooks: { Stop: [{ hooks: [{
    type: 'command', command: 'kiokuko enno hook --client codex --input-json -', timeout: 99,
  }] }] } });
  assert.throws(() => renderEnnoStopHook(modified, 'codex', 'kiokuko', 'on'), /modified|unmanaged/iu);
  assert.throws(() => renderEnnoStopHook(undefined, 'codex', 'kiokuko; touch bad', 'on'), /shell metacharacters/iu);
});

test('OpenCode plugin is byte-owned, idempotent, bounded, and removable without restoring retired identity', () => {
  const created = renderOpenCodeEnnoPlugin(undefined, 'kiokuko', 'on');
  assert.equal(created.action, 'created');
  assert.match(created.content!, /session\.idle/u);
  assert.match(created.content!, /processedIdles = new Map/u);
  assert.match(created.content!, /client\.session\.get/u);
  assert.match(created.content!, /parentID/u);
  assert.match(created.content!, /client\.session\.messages/u);
  assert.match(created.content!, /10000/u);
  assert.doesNotMatch(created.content!, /kiokuko-loop-guard/u);
  assert.equal(renderOpenCodeEnnoPlugin(created.content, 'kiokuko', 'on').action, 'unchanged');
  assert.equal(renderOpenCodeEnnoPlugin(created.content, 'kiokuko', 'off').action, 'deleted');
  assert.throws(() => renderOpenCodeEnnoPlugin(`${created.content}// changed\n`, 'kiokuko', 'off'), /modified/iu);
  assert.throws(() => renderOpenCodeEnnoPlugin('export const userPlugin = 1;\n', 'kiokuko', 'on'), /unmanaged/iu);
});

test('OpenCode plugin ignores child sessions and deduplicates one idle event without suppressing the next turn', async () => {
  const rendered = renderOpenCodeEnnoPlugin(undefined, 'kiokuko', 'on').content!;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(rendered).toString('base64')}`;
  const pluginModule = await import(moduleUrl) as {
    KiokukoEnnoOduno(input: { client: object; directory: string }): Promise<{
      event(input: { event: object }): Promise<void>;
    }>;
  };
  let spawnCount = 0;
  let promptCount = 0;
  let terminalMessageId = 'assistant-1';
  const originalBun = (globalThis as { Bun?: unknown }).Bun;
  (globalThis as { Bun?: unknown }).Bun = {
    spawn: () => {
      spawnCount += 1;
      return {
        stdin: { write() {}, end() {} },
        stdout: new Response(JSON.stringify({ continue: true, reason: 'continue' })).body,
        stderr: new Response('').body,
        kill() {},
      };
    },
  };
  try {
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({
          data: path.id === 'child' ? { id: 'child', parentID: 'root' } : { id: path.id },
        }),
        messages: async () => ({ data: [{ info: { id: terminalMessageId } }] }),
        prompt: async () => { promptCount += 1; },
      },
    };
    const firstRegistration = await pluginModule.KiokukoEnnoOduno({ client, directory: '/repo' });
    const secondRegistration = await pluginModule.KiokukoEnnoOduno({ client, directory: '/repo' });
    const idle = (sessionID: string) => ({ type: 'session.idle', properties: { sessionID } });

    await firstRegistration.event({ event: idle('child') });
    assert.equal(spawnCount, 0);

    await firstRegistration.event({ event: idle('root') });
    await secondRegistration.event({ event: idle('root') });
    assert.equal(spawnCount, 1);
    assert.equal(promptCount, 1);

    terminalMessageId = 'assistant-2';
    await firstRegistration.event({ event: idle('root') });
    assert.equal(spawnCount, 2);
    assert.equal(promptCount, 2);
  } finally {
    (globalThis as { Bun?: unknown }).Bun = originalBun;
  }
});
