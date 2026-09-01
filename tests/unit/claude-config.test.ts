import assert from 'node:assert/strict';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import { renderClaudeConfig } from '../../src/setup/claude-config.js';

test('adds a Claude Code user-scope stdio MCP server while preserving other JSON fields', () => {
  const existing = '{\n  "theme": "dark",\n  "mcpServers": {\n    "other": { "type": "http", "url": "https://example.test/mcp" }\n  }\n}\n';
  const rendered = renderClaudeConfig(existing, '/opt/kiokuko');
  const parsed = JSON.parse(rendered.content) as {
    theme: string;
    mcpServers: Record<string, unknown> & { kiokuko: unknown };
  };

  assert.equal(rendered.action, 'updated');
  assert.equal(parsed.theme, 'dark');
  assert.deepEqual(parsed.mcpServers.other, { type: 'http', url: 'https://example.test/mcp' });
  assert.deepEqual(parsed.mcpServers.kiokuko, {
    type: 'stdio',
    command: '/opt/kiokuko',
    args: ['mcp'],
    env: { KIOKUKO_SKILL_DISCOVERY: 'official' },
  });
  assert.equal(renderClaudeConfig(rendered.content, '/opt/kiokuko').action, 'unchanged');

  const updated = renderClaudeConfig(rendered.content, '/usr/local/bin/kiokuko');
  const updatedConfig = JSON.parse(updated.content) as {
    theme: string;
    mcpServers: Record<string, unknown> & { kiokuko: { command: string } };
  };
  assert.equal(updated.action, 'updated');
  assert.equal(updatedConfig.theme, 'dark');
  assert.deepEqual(updatedConfig.mcpServers.other, { type: 'http', url: 'https://example.test/mcp' });
  assert.equal(updatedConfig.mcpServers.kiokuko.command, '/usr/local/bin/kiokuko');
});

test('sets and preserves the selected external Skill discovery mode', () => {
  const community = renderClaudeConfig('{}\n', 'kiokuko', 'community');
  const parsed = JSON.parse(community.content) as {
    mcpServers: { kiokuko: { env: { KIOKUKO_SKILL_DISCOVERY: string } } };
  };
  assert.equal(parsed.mcpServers.kiokuko.env.KIOKUKO_SKILL_DISCOVERY, 'community');
  assert.equal(renderClaudeConfig(community.content).action, 'unchanged');

  const disabled = renderClaudeConfig(community.content, 'kiokuko', 'off');
  const disabledConfig = JSON.parse(disabled.content) as {
    mcpServers: { kiokuko: { env: { KIOKUKO_SKILL_DISCOVERY: string } } };
  };
  assert.equal(disabledConfig.mcpServers.kiokuko.env.KIOKUKO_SKILL_DISCOVERY, 'off');
});

test('rejects malformed Claude JSON instead of overwriting it', () => {
  for (const source of ['', ' \t\r\n', '{ "theme": }']) {
    assert.throws(
      () => renderClaudeConfig(source),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
});

test('rejects duplicate Claude JSON keys instead of normalizing one identity', () => {
  assert.throws(
    () => renderClaudeConfig('{"mcpServers":{},"mcpServers":{}}\n'),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});

test('rejects non-canonical or modified Claude kiokuko servers as conflicts', () => {
  const canonical = JSON.parse(renderClaudeConfig('{}\n').content) as {
    mcpServers: { kiokuko: Record<string, unknown> };
  };
  const variants: Record<string, unknown>[] = [
    { ...canonical.mcpServers.kiokuko, extra: true },
    { ...canonical.mcpServers.kiokuko, command: ['human-wrapper'] },
    { ...canonical.mcpServers.kiokuko, args: ['mcp', '--custom'] },
    { ...canonical.mcpServers.kiokuko, env: { KIOKUKO_SKILL_DISCOVERY: 'official', PATH: '/custom' } },
    { ...canonical.mcpServers.kiokuko, env: { KIOKUKO_SKILL_DISCOVERY: 'invalid' } },
  ];

  for (const kiokuko of variants) {
    const existing = `${JSON.stringify({ theme: 'keep', mcpServers: { other: { command: 'keep' }, kiokuko } }, null, 2)}\n`;
    assert.throws(
      () => renderClaudeConfig(existing, '/new/kiokuko'),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'CONFLICT'
        && !error.message.includes('/new/kiokuko'),
    );
  }
});

test('replaces only the conflicting Claude kiokuko server after authorization', () => {
  const existing = `${JSON.stringify({
    theme: 'keep',
    mcpServers: {
      other: { type: 'http', url: 'https://example.test/mcp' },
      kiokuko: { command: 'human-wrapper', args: ['serve'] },
    },
  }, null, 2)}\n`;
  const replaced = renderClaudeConfig(
    existing,
    '/opt/kiokuko',
    'community',
    { replaceConflictingIdentity: true },
  );
  const parsed = JSON.parse(replaced.content) as {
    theme: string;
    mcpServers: { other: unknown; kiokuko: unknown };
  };
  assert.equal(parsed.theme, 'keep');
  assert.deepEqual(parsed.mcpServers.other, { type: 'http', url: 'https://example.test/mcp' });
  assert.deepEqual(parsed.mcpServers.kiokuko, {
    type: 'stdio',
    command: '/opt/kiokuko',
    args: ['mcp'],
    env: { KIOKUKO_SKILL_DISCOVERY: 'community' },
  });
});

test('rejects invalid Claude MCP container and requested state without rewriting config', () => {
  for (const existing of ['{"mcpServers":[]}\n', '{"mcpServers":"custom"}\n']) {
    assert.throws(
      () => renderClaudeConfig(existing),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
  assert.throws(
    () => renderClaudeConfig('{}\n', ''),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => renderClaudeConfig('{}\n', 'kiokuko', 'official', { replaceConflictingIdentity: 'yes' as never }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});
