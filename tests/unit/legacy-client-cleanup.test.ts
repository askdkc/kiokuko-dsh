import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertExactLegacyOpenCodeLoopGuard,
  cleanupLegacyClaudePromptHook,
} from '../../src/setup/legacy-client-cleanup.js';
import {
  LEGACY_CLAUDE_PROMPT_HOOK,
  legacyOpenCodeLoopGuardFixture,
} from '../fixtures/legacy-client-cleanup.js';

test('removes one exact legacy Claude prompt hook and preserves unrelated settings', () => {
  const source = `${JSON.stringify({
    permissions: { allow: ['Read'] },
    hooks: {
      UserPromptSubmit: [
        { matcher: 'human', hooks: [{ type: 'command', command: 'echo keep' }] },
        { hooks: [LEGACY_CLAUDE_PROMPT_HOOK] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
    },
  }, null, 2)}\n`;

  const cleaned = cleanupLegacyClaudePromptHook(source);
  const parsed = JSON.parse(cleaned) as { permissions: object; hooks: Record<string, Array<{ hooks: unknown[] }>> };
  assert.deepEqual(parsed.permissions, { allow: ['Read'] });
  assert.deepEqual(parsed.hooks.UserPromptSubmit, [{ matcher: 'human', hooks: [{ type: 'command', command: 'echo keep' }] }]);
  assert.deepEqual(parsed.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo stop' }] }]);
  assert.equal(cleanupLegacyClaudePromptHook(cleaned), cleaned);
});

test('fails closed for malformed, partial, relocated, modified, or duplicate legacy Claude hook identities', () => {
  const settings = (event: string, handlers: unknown[]) => JSON.stringify({ hooks: { [event]: [{ hooks: handlers }] } });
  for (const source of [
    '{"hooks":[]}',
    settings('UserPromptSubmit', [{ type: 'mcp_tool', server: 'kiokuko' }]),
    settings('UserPromptSubmit', [{
      type: 'mcp_tool',
      timeout: 5,
      statusMessage: LEGACY_CLAUDE_PROMPT_HOOK.statusMessage,
      input: LEGACY_CLAUDE_PROMPT_HOOK.input,
    }]),
    settings('UserPromptSubmit', [{ ...LEGACY_CLAUDE_PROMPT_HOOK, timeout: 9 }]),
    settings('Stop', [LEGACY_CLAUDE_PROMPT_HOOK]),
    settings('UserPromptSubmit', [LEGACY_CLAUDE_PROMPT_HOOK, LEGACY_CLAUDE_PROMPT_HOOK]),
  ]) {
    assert.throws(() => cleanupLegacyClaudePromptHook(source), /Claude settings|legacy Kiokuko prompt hook/u);
  }
});

test('legacy cleanup rejects duplicate JSON identities', () => {
  assert.throws(
    () => cleanupLegacyClaudePromptHook('{"hooks":{},"hooks":{}}'),
    /unique keys/u,
  );
});

test('recognizes only byte-exact legacy OpenCode guard variants', () => {
  const exact = legacyOpenCodeLoopGuardFixture();
  assert.doesNotThrow(() => assertExactLegacyOpenCodeLoopGuard(exact));
  assert.throws(() => assertExactLegacyOpenCodeLoopGuard(`${exact}\n// modified\n`), /modified/u);
  assert.throws(() => assertExactLegacyOpenCodeLoopGuard('export const HumanPlugin = async () => ({})\n'), /unmanaged/u);
});
