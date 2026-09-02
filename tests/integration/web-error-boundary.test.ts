import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import { chunkSkillMarkdown } from '../../src/skills/chunking.js';
import { requirementForOfficialSkill } from '../../src/skills/official-catalog.js';
import { importSkillSnapshot } from '../../src/skills/store.js';
import { validateSkillSnapshot } from '../../src/skills/source/snapshot-validator.js';
import type { SkillCandidate } from '../../src/skills/types.js';
import { startWebServer } from '../../src/web/server.js';

async function rawRequest(port: number, target: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.once('connect', () => {
      socket.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.once('error', reject);
  });
}

function rawResponseBody(response: string): string {
  const separator = response.indexOf('\r\n\r\n');
  if (separator < 0) throw new Error('raw response has no header/body separator');
  return response.slice(separator + 4);
}

test('legacy Web malformed targets return a fixed 400 and the server remains usable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-web-malformed-target-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = openConnection(databasePath);
  migrateDatabase(database);
  database.close();

  const web = await startWebServer({ databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(directory, 'runtime') } });
  try {
    const address = web.server.address();
    assert.ok(address && typeof address !== 'string');
    const rawResponse = await rawRequest(address.port, 'http://[');
    const rawBody = rawResponseBody(rawResponse);

    assert.match(rawResponse, /^HTTP\/1\.1 400\b/u);
    assert.deepEqual(JSON.parse(rawBody), {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request is invalid',
        details: {},
      },
    });
    assert.equal(rawBody.includes('http://['), false);

    const health = await fetch(`${web.url}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  } finally {
    await web.close();
  }
});

test('legacy Web error responses sanitize typed Kiokuko error messages and details', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-web-error-boundary-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = openConnection(databasePath);
  migrateDatabase(database);
  const candidate: SkillCandidate = {
    id: 'fixture:sveltejs/ai-tools:svelte-code-writer',
    provider: 'fixture',
    name: 'svelte-code-writer',
    slug: 'svelte-code-writer',
    source: 'sveltejs/ai-tools',
    sourceType: 'github',
    installUrl: 'https://github.com/sveltejs/ai-tools',
    installs: 0,
    duplicate: false,
    officialStatus: 'unknown',
  };
  const requirement = requirementForOfficialSkill(candidate);
  assert.ok(requirement);
  const snapshot = validateSkillSnapshot({
    candidate,
    sourceCommit: 'a'.repeat(40),
    files: [{ path: 'skills/svelte-code-writer/SKILL.md', content: '---\nname: svelte-code-writer\ndescription: safe\n---\n# Svelte Code Writer\n', primary: true }],
  });
  const imported = importSkillSnapshot(database, snapshot, chunkSkillMarkdown({
    skillName: snapshot.frontmatter.name,
    sourcePath: snapshot.files[0]!.path,
    markdown: snapshot.files[0]!.content,
    summary: snapshot.frontmatter.description,
    stripFrontmatter: true,
  }), requirement);
  database.close();

  const web = await startWebServer({ databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(directory, 'runtime') } });
  const originalFetch = globalThis.fetch;
  try {
    const session = await originalFetch(web.url);
    const cookie = session.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const sentinel = 'private-typed-web-sentinel';
    globalThis.fetch = async () => {
      throw new KiokukoError('INTEGRITY_ERROR', sentinel, { debug: sentinel });
    };

    const response = await originalFetch(`${web.url}/api/skills/${encodeURIComponent(imported.skillId)}/refresh`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body.includes(sentinel), false);
    assert.deepEqual(JSON.parse(body).error, { code: 'INTEGRITY_ERROR', message: 'Internal integrity error', details: {} });
  } finally {
    globalThis.fetch = originalFetch;
    await web.close();
  }
});
