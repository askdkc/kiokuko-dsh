import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { findSecret } from '../../src/memory/secrets.js';

const fixtureDirectory = path.resolve(import.meta.dirname, '../fixtures/client-events');

interface ClientEventFixture {
  schemaVersion: number;
  client: { kind: string; version: string };
  capture: { status: 'verified' | 'partial'; method: string };
  events: Array<Record<string, unknown>>;
}

async function loadFixture(name: string): Promise<ClientEventFixture> {
  return JSON.parse(await readFile(path.join(fixtureDirectory, name), 'utf8')) as ClientEventFixture;
}

function serialized(fixture: ClientEventFixture): string {
  return JSON.stringify(fixture);
}

test('client event fixtures are versioned, bounded, sanitized clean-room evidence', async () => {
  const fixtures = await Promise.all([
    loadFixture('codex-0.148.0.json'),
    loadFixture('claude-code-2.1.212.json'),
    loadFixture('opencode-1.18.18.json'),
  ]);

  assert.deepEqual(fixtures.map((fixture) => fixture.client.kind), ['codex', 'claude-code', 'opencode']);
  for (const fixture of fixtures) {
    assert.equal(fixture.schemaVersion, 1);
    assert.ok(fixture.client.version.length > 0);
    assert.ok(fixture.capture.method.length > 0);
    assert.ok(fixture.events.length > 0);
    const text = serialized(fixture);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 64 * 1024);
    assert.equal(findSecret(text), undefined);
    assert.doesNotMatch(text, /\/home\/|\\Users\\|transcript_path|reasoning|authorization|cookie/i);
  }
});

test('fixtures preserve only event categories observed in each clean-room run', async () => {
  const codex = await loadFixture('codex-0.148.0.json');
  assert.deepEqual(codex.events.map((event) => event.hookEventName), [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'SessionEnd',
  ]);

  const claude = await loadFixture('claude-code-2.1.212.json');
  assert.equal(claude.capture.status, 'partial');
  assert.deepEqual(claude.events.map((event) => event.hookEventName), [
    'SessionStart',
    'UserPromptSubmit',
    'SessionEnd',
  ]);

  const opencode = await loadFixture('opencode-1.18.18.json');
  assert.deepEqual(opencode.events.map((event) => event.channel), [
    'event',
    'tool.execute.before',
    'shell.env',
    'tool.execute.after',
    'event',
  ]);
});
