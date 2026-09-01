import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { buildCli } from '../../src/cli.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { openConnection, SqliteVecLoadError } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { parseEmbeddingConfig, requireEnabledEmbeddingConfig } from '../../src/embedding/config.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { createEmbeddingProfile, createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { activateEmbeddingProfile, activateLocalEmbeddingProfile } from '../../src/embedding/store.js';
import {
  findMissingRepositoryLocations,
  registerRepositoryAndLocation,
  removeMissingRepositoryLocations,
} from '../../src/repository/binding.js';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-doctor-${prefix}-`));
  const databasePath = path.join(directory, 'kiokuko.sqlite3');
  const database = openConnection(databasePath);
  migrateDatabase(database);
  return { database, databasePath, directory };
}

function register(database: ReturnType<typeof openConnection>, name: string, canonicalRoot: string): void {
  registerRepositoryAndLocation(database, {
    repositoryId: `repo_doctor_${name}`,
    workspace: `project:doctor-${name}`,
    displayName: name,
    canonicalRoot,
    remoteFingerprint: null,
    bindingSchemaVersion: 1,
    agentTemplateVersion: 1,
  });
}

function locationCount(database: ReturnType<typeof openConnection>): number {
  return Number(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count ?? 0);
}

function ttyInput(answer: string): Readable & { isTTY?: boolean } {
  const input = Readable.from([answer]) as Readable & { isTTY?: boolean };
  input.isTTY = true;
  return input;
}

function ttyOutput(): Writable & { isTTY?: boolean; text: string } {
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  }) as Writable & { isTTY?: boolean; text: string };
  output.isTTY = true;
  Object.defineProperty(output, 'text', { get: () => text });
  return output;
}

async function invokeDoctor(
  databasePath: string,
  answer: string,
  json = false,
): Promise<{ stdout: string; prompt: string; response?: { data: Record<string, unknown>; ok: boolean } }> {
  let stdout = '';
  const originalWrite = process.stdout.write;
  const previousExitCode = process.exitCode;
  const output = ttyOutput();
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({
      doctorDatabasePath: databasePath,
      doctorInput: ttyInput(answer),
      doctorOutput: output,
    }).parseAsync(['node', 'kiokuko', 'doctor', ...(json ? ['--json'] : [])]);
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = previousExitCode;
  }
  return {
    stdout,
    prompt: output.text,
    ...(json ? { response: JSON.parse(stdout) as { data: Record<string, unknown>; ok: boolean } } : {}),
  };
}

test('missing-location cleanup removes only absent location rows and preserves repositories', async () => {
  const value = await temporaryDatabase('rows');
  const liveRoot = path.join(value.directory, 'live');
  const missingRoot = path.join(value.directory, 'missing');
  await mkdir(liveRoot);
  try {
    register(value.database, 'live', liveRoot);
    register(value.database, 'missing', missingRoot);
    const candidates = findMissingRepositoryLocations(value.database);
    assert.deepEqual(candidates.map((location) => location.canonicalRoot), [missingRoot]);

    const removed = removeMissingRepositoryLocations(value.database, candidates);
    assert.equal(removed, 1);
    assert.equal(locationCount(value.database), 1);
    assert.equal(
      Number(value.database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count ?? 0),
      2,
    );
    assert.equal(findMissingRepositoryLocations(value.database).length, 0);
  } finally {
    value.database.close();
  }
});

test('missing-location cleanup rechecks a root before deleting its registry row', async () => {
  const value = await temporaryDatabase('race');
  const root = path.join(value.directory, 'restored');
  try {
    register(value.database, 'restored', root);
    const candidates = findMissingRepositoryLocations(value.database);
    await mkdir(root);
    assert.equal(removeMissingRepositoryLocations(value.database, candidates), 0);
    assert.equal(locationCount(value.database), 1);
  } finally {
    value.database.close();
  }
});

test('interactive doctor removes confirmed missing locations and reports the rerun result', async () => {
  const value = await temporaryDatabase('confirm');
  try {
    register(value.database, 'missing', path.join(value.directory, 'missing'));
  } finally {
    value.database.close();
  }

  const result = await invokeDoctor(value.databasePath, '\n');
  assert.match(result.prompt, /Remove these stale locations\? \[Y\/n\]/u);
  assert.match(result.stdout, /Kiokuko doctor: OK/u);
  assert.match(result.stdout, /Removed 1 missing repository location/u);

  const database = openConnection(value.databasePath);
  try {
    assert.equal(locationCount(database), 0);
  } finally {
    database.close();
  }
});

test('declining interactive doctor cleanup preserves missing locations', async () => {
  const value = await temporaryDatabase('decline');
  try {
    register(value.database, 'missing', path.join(value.directory, 'missing'));
  } finally {
    value.database.close();
  }

  const result = await invokeDoctor(value.databasePath, 'n\n');
  assert.match(result.prompt, /Remove these stale locations\? \[Y\/n\]/u);
  assert.match(result.stdout, /Kiokuko doctor: FAILED/u);
  assert.match(result.stdout, /Failed checks: bindings\./u);
  assert.match(result.stdout, /\nrun kiokuko doctor --json for detailed output/u);

  const database = openConnection(value.databasePath);
  try {
    assert.equal(locationCount(database), 1);
  } finally {
    database.close();
  }
});

test('JSON doctor never prompts or cleans missing locations', async () => {
  const value = await temporaryDatabase('json');
  try {
    register(value.database, 'missing', path.join(value.directory, 'missing'));
  } finally {
    value.database.close();
  }

  const result = await invokeDoctor(value.databasePath, 'y\n', true);
  assert.equal(result.prompt, '');
  assert.equal(result.response?.ok, true);
  assert.equal((result.response?.data.checks as { bindings: { ok: boolean } }).bindings.ok, false);

  const database = openConnection(value.databasePath);
  try {
    assert.equal(locationCount(database), 1);
  } finally {
    database.close();
  }
});

test('doctor uses persisted local embedding settings and reports the selected backend', async () => {
  const value = await temporaryDatabase('local-embeddings');
  const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
  try {
    activateLocalEmbeddingProfile(value.database, profile, {
      replace: false,
      now: '2026-08-31T00:00:00.000Z',
    });
    value.database.prepare(`
      UPDATE embedding_settings
         SET mode = 'optional', provider_kind = 'local-transformers',
             preset_id = 'local-small', vector_backend = 'auto',
             setup_state = 'ready', updated_at = ?
       WHERE singleton = 1
    `).run('2026-08-31T00:00:00.000Z');
  } finally {
    value.database.close();
  }

  const result = await runDoctor({
    databasePath: value.databasePath,
    runtimeDescriptorPath: path.join(value.directory, 'runtime', 'server.json'),
  });

  assert.deepEqual(result.checks.embeddings, {
    ok: true,
    count: 0,
    detail: 'findings=0, mode=optional, backend=sqlite-vec',
  });
});

test('doctor reports a forced sqlite-vec backend that cannot be loaded', async () => {
  const value = await temporaryDatabase('forced-sqlite-vec');
  const embeddingEnvironment = {
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
    KIOKUKO_EMBEDDING_MODEL: 'doctor-test',
    KIOKUKO_EMBEDDING_DIMENSIONS: '3',
    KIOKUKO_EMBEDDING_DISTANCE_CEILING: '0.8',
    KIOKUKO_VECTOR_BACKEND: 'sqlite-vec',
  } satisfies NodeJS.ProcessEnv;
  try {
    const config = requireEnabledEmbeddingConfig(parseEmbeddingConfig(embeddingEnvironment));
    activateEmbeddingProfile(value.database, createEmbeddingProfile(config), {
      replace: false,
      now: '2026-08-31T00:00:00.000Z',
    });
  } finally {
    value.database.close();
  }

  let extensionOpenAttempts = 0;
  const result = await runDoctor({
    databasePath: value.databasePath,
    runtimeDescriptorPath: path.join(value.directory, 'runtime', 'server.json'),
    embeddingEnvironment,
  }, {
    openConnection: (databasePath, options) => {
      if (options?.sqliteVecLoader !== undefined) {
        extensionOpenAttempts += 1;
        throw new SqliteVecLoadError('sqlite-vec unavailable in doctor test');
      }
      return openConnection(databasePath, options);
    },
  });

  assert.equal(extensionOpenAttempts, 1);
  assert.deepEqual(result.checks.embeddings, {
    ok: false,
    count: 1,
    detail: 'findings=1, mode=optional, backend=sqlite-vec',
  });
});

async function withDoctorEnvironment<T>(
  dataDirectory: string,
  codexHome: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previousDataDirectory = process.env.KIOKUKO_DATA_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.KIOKUKO_DATA_DIR = dataDirectory;
  process.env.CODEX_HOME = codexHome;
  try {
    return await operation();
  } finally {
    if (previousDataDirectory === undefined) delete process.env.KIOKUKO_DATA_DIR;
    else process.env.KIOKUKO_DATA_DIR = previousDataDirectory;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
}

test('doctor reports an unmanaged Codex Kiokuko MCP identity', async () => {
  const value = await temporaryDatabase('codex-mcp-conflict');
  value.database.close();
  const codexHome = path.join(value.directory, 'codex-home');
  await mkdir(codexHome);
  await writeFile(
    path.join(codexHome, 'config.toml'),
    '[mcp_servers.kiokuko]\ncommand = "custom"\n',
  );

  const result = await withDoctorEnvironment(value.directory, codexHome, () => runDoctor());
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.codexMcp, {
    ok: false,
    count: 1,
    detail: 'config=conflict',
  });
});

test('doctor accepts the canonical Codex Kiokuko MCP identity', async () => {
  const value = await temporaryDatabase('codex-mcp-canonical');
  value.database.close();
  const codexHome = path.join(value.directory, 'codex-home');
  await mkdir(codexHome);
  await writeFile(
    path.join(codexHome, 'config.toml'),
    [
      '# BEGIN KIOKUKO MCP',
      '# Managed by `kiokuko setup`.',
      '[mcp_servers.kiokuko]',
      'command = "kiokuko"',
      'args = ["mcp"]',
      'enabled = true',
      'required = true',
      'env = { KIOKUKO_SKILL_DISCOVERY = "official" }',
      '# END KIOKUKO MCP',
      '',
    ].join('\n'),
  );

  const result = await withDoctorEnvironment(value.directory, codexHome, () => runDoctor());
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.codexMcp, {
    ok: true,
    count: 0,
    detail: 'config=canonical-or-not-configured',
  });
});
