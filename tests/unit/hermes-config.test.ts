import assert from 'node:assert/strict';
import test from 'node:test';
import { getHermesConfigPath } from '../../src/config/paths.js';
import { HERMES_MANAGED_MARKER, renderHermesConfig } from '../../src/setup/hermes-config.js';

function errorIdentity(callback: () => unknown): { code: string | undefined; message: string | undefined } {
  try {
    callback();
    return { code: undefined, message: undefined };
  } catch (error) {
    const typed = error as { code?: string; message?: string };
    return { code: typed.code, message: typed.message };
  }
}

test('renders Hermes MCP config while preserving comments, other servers, and top-level values', () => {
  const existing = [
    '# preserve this top-level comment',
    'model:',
    '  default: test-model',
    'mcp_servers:',
    '  # preserve this other server',
    '  other:',
    '    command: other-server',
    '    args: [serve]',
    '',
  ].join('\n');

  const result = renderHermesConfig(existing, '/opt/kiokuko');

  assert.equal(result.action, 'updated');
  assert.match(result.content, /preserve this top-level comment/);
  assert.match(result.content, /default: test-model/);
  assert.match(result.content, /preserve this other server/);
  assert.match(result.content, /other-server/);
  assert.match(result.content, /Managed by `kiokuko setup`\./);
  assert.match(result.content, /command: \/opt\/kiokuko/);
  assert.match(result.content, /- mcp/);
  assert.match(result.content, /KIOKUKO_SKILL_DISCOVERY: official/);
});

test('replays an exactly managed Hermes config unchanged', () => {
  const first = renderHermesConfig('model: test\n');
  const second = renderHermesConfig(first.content);

  assert.equal(second.action, 'unchanged');
  assert.equal(second.content, first.content);
});

test('rejects invalid YAML and non-mapping Hermes config shapes with fixed validation errors', () => {
  for (const existing of [
    'model: [unterminated',
    '- not-a-mapping\n',
    'mcp_servers: []\n',
    'mcp_servers: not-a-mapping\n',
  ]) {
    const identity = errorIdentity(() => renderHermesConfig(existing));
    assert.equal(identity.code, 'VALIDATION_ERROR');
    assert.equal(identity.message?.includes(existing), false);
    assert.equal(identity.message?.includes('/private/hermes/config.yaml'), false);
  }
});

test('updates the command of a canonical managed kiokuko server and remains idempotent', () => {
  const base = [
    '# preserve this top-level comment',
    'model: test',
    'mcp_servers:',
    '  other:',
    '    command: other-server',
    '    args: [serve]',
    '',
  ].join('\n');
  const managed = renderHermesConfig(base).content;

  const result = renderHermesConfig(managed, '/opt/homebrew/bin/kiokuko');
  assert.equal(result.action, 'updated');
  assert.match(result.content, /preserve this top-level comment/);
  assert.match(result.content, /command: \/opt\/homebrew\/bin\/kiokuko/);
  assert.match(result.content, /- mcp/);
  assert.match(result.content, /other-server/);
  assert.match(result.content, /Managed by `kiokuko setup`\./);
  assert.doesNotMatch(result.content, /enabled:/);
  assert.match(result.content, /KIOKUKO_SKILL_DISCOVERY: official/);

  const replay = renderHermesConfig(result.content, '/opt/homebrew/bin/kiokuko');
  assert.equal(replay.action, 'unchanged');
  assert.equal(replay.content, result.content);
});

test('preserves CRLF when migrating a managed Hermes command', () => {
  const managed = renderHermesConfig('model: test\r\n', 'kiokuko').content;
  const result = renderHermesConfig(managed, '/opt/homebrew/bin/kiokuko');

  assert.equal(result.action, 'updated');
  assert.match(result.content, /\r\n/);
  assert.equal(result.content.replaceAll('\r\n', '').includes('\n'), false);
  assert.match(result.content, /command: \/opt\/homebrew\/bin\/kiokuko/);
});

test('rejects the legacy managed shape instead of silently migrating it', () => {
  const current = renderHermesConfig('model: test\n').content;
  const legacy = current.replace('    env:\n      KIOKUKO_SKILL_DISCOVERY: official\n', '');
  const identity = errorIdentity(() => renderHermesConfig(legacy));
  assert.equal(identity.code, 'CONFLICT');
});

test('rejects an unmanaged or non-canonical kiokuko server as a conflict', () => {
  const unmanaged = [
    'mcp_servers:',
    '  kiokuko:',
    '    command: another-tool',
    '    args: [mcp]',
    '',
  ].join('\n');
  const unmanagedIdentity = errorIdentity(() => renderHermesConfig(unmanaged));
  assert.equal(unmanagedIdentity.code, 'CONFLICT');

  const managed = renderHermesConfig('model: test\n').content;
  for (const existing of [
    managed.replace('    env:\n', '    enabled: false\n    env:\n'),
    managed.replace('      - mcp\n', '      - something-else\n'),
    managed.replace('      KIOKUKO_SKILL_DISCOVERY: official\n', '      PATH: /custom\n'),
    managed.replace('      KIOKUKO_SKILL_DISCOVERY: official\n', '      KIOKUKO_SKILL_DISCOVERY: invalid\n'),
    managed.replace('    command: kiokuko\n', '    command: ""\n'),
    managed.replace('    command: kiokuko\n', '    command: "\\0"\n'),
    managed.replace(HERMES_MANAGED_MARKER, `copied prefix ${HERMES_MANAGED_MARKER}`),
    managed.replace(
      `  kiokuko:\n    # ${HERMES_MANAGED_MARKER}`,
      `  # ${HERMES_MANAGED_MARKER}\n  kiokuko:`,
    ),
  ]) {
    const identity = errorIdentity(() => renderHermesConfig(existing, 'different-kiokuko'));
    assert.equal(identity.code, 'CONFLICT');
  }
});

test('replaces only the conflicting Hermes kiokuko server after authorization', () => {
  const existing = [
    '# preserve top level',
    'model: keep',
    'mcp_servers:',
    '  other:',
    '    command: keep-other',
    '  kiokuko:',
    '    command: human-wrapper',
    '    args: [serve]',
    '',
  ].join('\n');
  const replaced = renderHermesConfig(
    existing,
    '/opt/kiokuko',
    'community',
    { replaceConflictingIdentity: true },
  );

  assert.match(replaced.content, /preserve top level/u);
  assert.match(replaced.content, /model: keep/u);
  assert.match(replaced.content, /command: keep-other/u);
  assert.doesNotMatch(replaced.content, /human-wrapper|\[serve\]/u);
  assert.match(replaced.content, /Managed by `kiokuko setup`\./u);
  assert.match(replaced.content, /command: \/opt\/kiokuko/u);
  assert.match(replaced.content, /KIOKUKO_SKILL_DISCOVERY: community/u);
  assert.equal(renderHermesConfig(replaced.content, '/opt/kiokuko').action, 'unchanged');
});

test('rejects invalid requested Hermes state with typed validation errors', () => {
  for (const callback of [
    () => renderHermesConfig('', '   '),
    () => renderHermesConfig('', 'kiokuko', 'invalid' as never),
    () => renderHermesConfig('', 'kiokuko', 'official', { replaceConflictingIdentity: 'yes' as never }),
  ]) {
    const identity = errorIdentity(callback);
    assert.equal(identity.code, 'VALIDATION_ERROR');
  }
});

test('preserves CRLF line endings when updating Hermes config', () => {
  const existing = 'model: test\r\nmcp_servers:\r\n  other:\r\n    command: other\r\n';
  const result = renderHermesConfig(existing);

  assert.match(result.content, /\r\n/);
  assert.equal(result.content.replaceAll('\r\n', '').includes('\n'), false);
});

test('resolves a profile-shaped Windows HERMES_HOME without consulting the sticky root', async () => {
  const configPath = await getHermesConfigPath({
    platform: 'win32',
    env: { HERMES_HOME: 'C:\\Users\\tester\\hermes\\profiles\\main' },
  });

  assert.equal(configPath, 'C:\\Users\\tester\\hermes\\profiles\\main\\config.yaml');
});
