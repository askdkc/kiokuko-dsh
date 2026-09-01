import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import { KiokukoError } from '../../src/errors.js';
import { renderOpenCodeConfig } from '../../src/setup/opencode-config.js';
import { renderCodexMcpConfig } from '../../src/setup/render.js';

test('Codex setup writes and preserves the external Skill discovery mode', () => {
  const official = renderCodexMcpConfig('', 'kiokuko');
  assert.match(official.content, /^required = true$/mu);
  assert.match(official.content, /env = \{ KIOKUKO_SKILL_DISCOVERY = "official" \}/u);

  const community = renderCodexMcpConfig(official.content, 'kiokuko', 'community');
  assert.match(community.content, /KIOKUKO_SKILL_DISCOVERY = "community"/u);
  assert.equal(renderCodexMcpConfig(community.content).action, 'unchanged');

  const disabled = renderCodexMcpConfig(community.content, 'kiokuko', 'off');
  assert.match(disabled.content, /KIOKUKO_SKILL_DISCOVERY = "off"/u);

  const relocated = renderCodexMcpConfig(disabled.content, '/opt/kiokuko', 'community');
  assert.equal(relocated.action, 'updated');
  assert.match(relocated.content, /command = "\/opt\/kiokuko"/u);
  assert.equal(renderCodexMcpConfig(relocated.content, '/opt/kiokuko').action, 'unchanged');
});

test('Codex setup upgrades only the exact previous managed block to required MCP', () => {
  const legacy = [
    'model = "keep"',
    '# BEGIN KIOKUKO MCP',
    '# Managed by `kiokuko setup`.',
    '[mcp_servers.kiokuko]',
    'command = "kiokuko"',
    'args = ["mcp"]',
    'enabled = true',
    'env = { KIOKUKO_SKILL_DISCOVERY = "community" }',
    '# END KIOKUKO MCP',
    '',
  ].join('\n');

  const upgraded = renderCodexMcpConfig(legacy);
  assert.equal(upgraded.action, 'updated');
  assert.match(upgraded.content, /^model = "keep"$/mu);
  assert.match(upgraded.content, /^required = true$/mu);
  assert.match(upgraded.content, /KIOKUKO_SKILL_DISCOVERY = "community"/u);
  assert.equal(renderCodexMcpConfig(upgraded.content).action, 'unchanged');
});

test('README entry points and English/Japanese docs carry the setup and trust contracts', () => {
  const requiredCore = [
    '[mcp_servers.kiokuko]',
    'command = "kiokuko"',
    'args = ["mcp"]',
    'enabled = true',
    'required = true',
  ].join('\n');
  assert.ok(renderCodexMcpConfig('').content.includes(requiredCore));

  for (const name of ['README.md', 'README.ja.md', 'README.zh-CN.md', 'README.ko.md']) {
    const readme = readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
    assert.match(readme, /Node\.js 24\.16\.0/u, name);
    assert.match(readme, /dsh plugin --profile web add @askdkc\/kiokuko/u, name);
    assert.match(readme, /docs\/dsh-plugin/u, name);
    assert.doesNotMatch(readme, /kiokuko setup/u, name);
  }

  const gettingStarted = readFileSync(new URL('../../docs/getting-started.md', import.meta.url), 'utf8');
  assert.ok(gettingStarted.includes(requiredCore));
  for (const contractTerm of [
    'required = false',
    'CONFLICT',
    'doctor is read-only',
  ]) assert.ok(gettingStarted.includes(contractTerm), `getting-started.md: ${contractTerm}`);

  const security = readFileSync(new URL('../../docs/security-and-trust.md', import.meta.url), 'utf8');
  for (const contractTerm of [
    'structuredContent.code',
    'structuredContent.retryable',
    'BACKPRESSURE',
    'ToolLifecycleContributor',
    'isError: true',
  ]) assert.ok(security.includes(contractTerm), `security-and-trust.md: ${contractTerm}`);
});

test('README and documentation index links resolve inside the repository', () => {
  const repositoryRoot = path.resolve(new URL('../..', import.meta.url).pathname);
  const sources = [
    'README.md',
    'README.ja.md',
    'README.zh-CN.md',
    'README.ko.md',
    'docs/README.md',
    'docs/README.ja.md',
  ];
  for (const relativeSource of sources) {
    const sourcePath = path.join(repositoryRoot, relativeSource);
    const content = readFileSync(sourcePath, 'utf8');
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1]!;
      if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
      const targetPath = target.split('#', 1)[0]!;
      assert.ok(existsSync(path.resolve(path.dirname(sourcePath), targetPath)), `${relativeSource}: ${target}`);
    }
  }
});

test('Codex setup rejects non-canonical marked blocks instead of migrating them', () => {
  const canonical = renderCodexMcpConfig('model = "keep"\n').content;
  const managedBlock = canonical.slice(canonical.indexOf('# BEGIN KIOKUKO MCP'));
  const variants = [
    canonical.replace('env = { KIOKUKO_SKILL_DISCOVERY = "official" }\n', ''),
    canonical.replace('args = ["mcp"]', 'args = ["serve"]'),
    canonical.replace('enabled = true', 'enabled = false'),
    canonical.replace('required = true', 'required = false'),
    canonical.replace('enabled = true\nrequired = true', 'required = true\nenabled = true'),
    canonical.replace('required = true', 'required = true\nrequired = true'),
    canonical.replace('command = "kiokuko"', 'command = ""'),
    canonical.replace('env = { KIOKUKO_SKILL_DISCOVERY = "official" }', 'env = { KIOKUKO_SKILL_DISCOVERY = "official", PATH = "/custom" }'),
    canonical.replace('enabled = true', 'enabled = true\ncustom = true'),
    canonical.replace('# Managed by `kiokuko setup`.', '# copied markers around a human wrapper'),
    canonical.replace('command = "kiokuko"\nargs = ["mcp"]', 'command = "human-wrapper"\nargs = ["run", "kiokuko"]'),
    `${canonical}${managedBlock}`,
    canonical.replace('# BEGIN KIOKUKO MCP', '# human prefix # BEGIN KIOKUKO MCP'),
  ];

  for (const existing of variants) {
    assert.throws(
      () => renderCodexMcpConfig(existing, '/new/path'),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'CONFLICT'
        && !error.message.includes('/new/path'),
    );
  }
});

test('Codex setup replaces an unmanaged table only after explicit authorization', () => {
  const existing = [
    'model = "keep"',
    '[mcp_servers.other]',
    'command = "keep-other"',
    '[mcp_servers.kiokuko]',
    'command = "human-wrapper"',
    'args = ["run", "kiokuko"]',
    '[projects."/tmp/keep"]',
    'trust_level = "trusted"',
    '',
  ].join('\n');

  assert.throws(
    () => renderCodexMcpConfig(existing),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'CONFLICT'
      && Object.keys(error.details).length === 0,
  );

  const replaced = renderCodexMcpConfig(
    existing,
    '/opt/kiokuko',
    'community',
    { replaceConflictingIdentity: true },
  );
  assert.equal(replaced.action, 'created');
  assert.match(replaced.content, /^model = "keep"/u);
  assert.match(replaced.content, /\[mcp_servers\.other\]\ncommand = "keep-other"/u);
  assert.match(replaced.content, /\[projects\."\/tmp\/keep"\]\ntrust_level = "trusted"/u);
  assert.doesNotMatch(replaced.content, /human-wrapper/u);
  assert.match(replaced.content, /command = "\/opt\/kiokuko"/u);
  assert.match(replaced.content, /KIOKUKO_SKILL_DISCOVERY = "community"/u);
});

test('Codex setup replaces a legacy marked block and preserves unrelated TOML', () => {
  const legacy = [
    'model = "keep"',
    '# BEGIN KIOKUKO MCP',
    '# Managed by `kiokuko setup`.',
    '[mcp_servers.kiokuko]',
    'command = "old-kiokuko"',
    'args = ["mcp"]',
    'enabled = true',
    '# END KIOKUKO MCP',
    '[mcp_servers.other]',
    'command = "keep-other"',
    '',
  ].join('\n');

  const replaced = renderCodexMcpConfig(
    legacy,
    'kiokuko',
    'official',
    { replaceConflictingIdentity: true },
  );
  assert.match(replaced.content, /^model = "keep"/u);
  assert.match(replaced.content, /\[mcp_servers\.other\]\ncommand = "keep-other"/u);
  assert.doesNotMatch(replaced.content, /old-kiokuko/u);
  assert.equal((replaced.content.match(/# BEGIN KIOKUKO MCP/gu) ?? []).length, 1);
});

test('Codex setup replaces an orphaned end marker only after explicit authorization', () => {
  const existing = [
    'model = "keep"',
    '# END KIOKUKO MCP',
    '',
  ].join('\n');

  assert.throws(
    () => renderCodexMcpConfig(existing),
    (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
  );

  const replaced = renderCodexMcpConfig(
    existing,
    'kiokuko',
    'official',
    { replaceConflictingIdentity: true },
  );
  assert.match(replaced.content, /^model = "keep"/u);
  assert.equal((replaced.content.match(/# BEGIN KIOKUKO MCP/gu) ?? []).length, 1);
  assert.equal((replaced.content.match(/# END KIOKUKO MCP/gu) ?? []).length, 1);
});

test('Codex setup replaces an orphaned begin marker only after explicit authorization', () => {
  const existing = [
    'model = "keep"',
    '# BEGIN KIOKUKO MCP',
    '',
  ].join('\n');

  assert.throws(
    () => renderCodexMcpConfig(existing),
    (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
  );

  const replaced = renderCodexMcpConfig(
    existing,
    'kiokuko',
    'official',
    { replaceConflictingIdentity: true },
  );
  assert.match(replaced.content, /^model = "keep"/u);
  assert.equal((replaced.content.match(/# BEGIN KIOKUKO MCP/gu) ?? []).length, 1);
  assert.equal((replaced.content.match(/# END KIOKUKO MCP/gu) ?? []).length, 1);
});

test('Codex setup refuses to remove an orphaned marker embedded in another line', () => {
  const existing = 'model = "keep" # END KIOKUKO MCP\n';
  assert.throws(
    () => renderCodexMcpConfig(
      existing,
      'kiokuko',
      'official',
      { replaceConflictingIdentity: true },
    ),
    (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
  );
});

test('Codex setup replaces only Kiokuko from a shared inline MCP table', () => {
  const sharedStatement = 'mcp_servers = { kiokuko = { command = "custom" }, other = { command = "keep" } }\n';
  const replaced = renderCodexMcpConfig(sharedStatement, 'kiokuko', 'official', { replaceConflictingIdentity: true });
  assert.match(replaced.content, /other = \{ command = "keep" \}/u);
  assert.doesNotMatch(replaced.content, /command = "custom"/u);
  assert.match(replaced.content, /# BEGIN KIOKUKO MCP/u);
});

test('Codex setup refuses to delete unrelated TOML copied inside Kiokuko markers', () => {
  const mixedBlock = [
    '# BEGIN KIOKUKO MCP',
    '[mcp_servers.kiokuko]',
    'command = "custom"',
    '[projects."/tmp/keep"]',
    'trust_level = "trusted"',
    '# END KIOKUKO MCP',
    '',
  ].join('\n');
  assert.throws(
    () => renderCodexMcpConfig(
      mixedBlock,
      'kiokuko',
      'official',
      { replaceConflictingIdentity: true },
    ),
    (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
  );
});

test('Codex setup rejects invalid requested state without rendering it', () => {
  assert.throws(
    () => renderCodexMcpConfig('', '   '),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => renderCodexMcpConfig('', 'kiokuko', 'invalid' as never),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => renderCodexMcpConfig('', 'kiokuko', 'official', { replaceConflictingIdentity: 'yes' as never }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});

test('Codex setup validates complete TOML and rejects alternate Kiokuko identities', () => {
  assert.doesNotThrow(() => renderCodexMcpConfig([
    'model = "gpt-5"',
    'features = ["one", "two"]',
    '[projects."/tmp/example"]',
    'trust_level = "trusted"',
    '',
  ].join('\n')));
  for (const source of [
    '[a]\na.b = 1\n',
    '[a.b]\nx = 1\n[a]\ny = 2\n',
    '[[a]]\nx = 1\n[[a]]\nx = 2\n',
  ]) assert.doesNotThrow(() => renderCodexMcpConfig(source));
  assert.throws(
    () => renderCodexMcpConfig('model = ["unterminated"\n'),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
  for (const source of [
    'a = 1\n[a]\nb = 2\n',
    'a = { b = 1 }\n[a]\nc = 2\n',
    'a.b = 1\n[a]\nc = 2\n',
    '[a]\nb.c = 1\n[a.b]\nd = 2\n',
    'a = 1\na.b = 2\n',
    'a.b = 1\na = 2\n',
    'a = { b = 1, b.c = 2 }\n',
    'a = []\n[[a]]\nb = 2\n',
    '[[a]]\nb = 1\n[a]\nc = 2\n',
    'x = """\\q"""\n',
    'x = 1979-99-99\n',
    'x = 1979-02-29\n',
  ]) {
    assert.throws(
      () => renderCodexMcpConfig(source),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
  for (const source of [
    'mcp_servers.kiokuko.command = "human"\n',
    'mcp_servers = { kiokuko = { command = "human" } }\n',
    '["mcp_servers"."kiokuko"]\ncommand = "human"\n',
  ]) {
    assert.throws(
      () => renderCodexMcpConfig(source),
      (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
    );
  }
});

test('OpenCode setup rejects duplicate JSONC keys', () => {
  assert.throws(
    () => renderOpenCodeConfig('{"mcp":{},"mcp":{}}\n'),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});

test('OpenCode setup rejects present empty JSONC instead of treating it as a missing file', () => {
  for (const source of ['', ' \t\r\n']) {
    assert.throws(
      () => renderOpenCodeConfig(source),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
});

test('OpenCode setup writes and preserves the external Skill discovery mode', () => {
  const existing = '{\n  // keep\n  "theme": "dark"\n}\n';
  const community = renderOpenCodeConfig(existing, 'kiokuko', 'community');
  const parsed = parse(community.content) as {
    theme: string;
    mcp: { kiokuko: { environment: { KIOKUKO_SKILL_DISCOVERY: string } } };
  };
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.mcp.kiokuko.environment.KIOKUKO_SKILL_DISCOVERY, 'community');
  assert.match(community.content, /\/\/ keep/u);
  assert.equal(renderOpenCodeConfig(community.content).action, 'unchanged');

  const updated = renderOpenCodeConfig(community.content, '/usr/local/bin/kiokuko');
  const updatedConfig = parse(updated.content) as {
    theme: string;
    mcp: { kiokuko: { command: string[] } };
  };
  assert.equal(updated.action, 'updated');
  assert.equal(updatedConfig.theme, 'dark');
  assert.deepEqual(updatedConfig.mcp.kiokuko.command, ['/usr/local/bin/kiokuko', 'mcp']);
});

test('OpenCode setup rejects non-canonical or modified kiokuko servers as conflicts', () => {
  const canonical = parse(renderOpenCodeConfig('{}\n').content) as {
    mcp: { kiokuko: Record<string, unknown> };
  };
  const variants: Record<string, unknown>[] = [
    { ...canonical.mcp.kiokuko, extra: true },
    { ...canonical.mcp.kiokuko, type: 'remote' },
    { ...canonical.mcp.kiokuko, command: ['human-wrapper', 'serve'] },
    { ...canonical.mcp.kiokuko, command: ['kiokuko', 'mcp', '--custom'] },
    { ...canonical.mcp.kiokuko, enabled: false },
    { ...canonical.mcp.kiokuko, environment: { KIOKUKO_SKILL_DISCOVERY: 'official', PATH: '/custom' } },
    { ...canonical.mcp.kiokuko, environment: { KIOKUKO_SKILL_DISCOVERY: 'invalid' } },
  ];

  for (const kiokuko of variants) {
    const existing = `${JSON.stringify({ theme: 'keep', mcp: { other: { command: ['keep'] }, kiokuko } }, null, 2)}\n`;
    assert.throws(
      () => renderOpenCodeConfig(existing, '/new/kiokuko'),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'CONFLICT'
        && !error.message.includes('/new/kiokuko'),
    );
  }
});

test('OpenCode setup replaces only the conflicting kiokuko server after authorization', () => {
  const existing = [
    '{',
    '  // keep this comment',
    '  "theme": "keep",',
    '  "mcp": {',
    '    "other": { "command": ["keep"] },',
    '    "kiokuko": { "type": "remote", "environment": { "KIOKUKO_SKILL_DISCOVERY": "community" } }',
    '  }',
    '}',
    '',
  ].join('\n');

  const replaced = renderOpenCodeConfig(
    existing,
    '/opt/kiokuko',
    undefined,
    { replaceConflictingIdentity: true },
  );
  const parsed = parse(replaced.content) as {
    theme: string;
    mcp: { other: unknown; kiokuko: unknown };
  };
  assert.equal(parsed.theme, 'keep');
  assert.deepEqual(parsed.mcp.other, { command: ['keep'] });
  assert.deepEqual(parsed.mcp.kiokuko, {
    type: 'local',
    command: ['/opt/kiokuko', 'mcp'],
    enabled: true,
    environment: { KIOKUKO_SKILL_DISCOVERY: 'official' },
  });
  assert.match(replaced.content, /keep this comment/u);
});

test('OpenCode setup rejects invalid MCP container and requested state without rewriting config', () => {
  for (const existing of ['{"mcp":[]}\n', '{"mcp":"custom"}\n']) {
    assert.throws(
      () => renderOpenCodeConfig(existing),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
  assert.throws(
    () => renderOpenCodeConfig('{}\n', ''),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => renderOpenCodeConfig('{}\n', 'kiokuko', 'official', { replaceConflictingIdentity: 'yes' as never }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});
