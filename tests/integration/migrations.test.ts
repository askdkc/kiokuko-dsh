import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { recordEntry, type EntryRecord } from '../../src/memory/entries.js';
import { listContextDeliveries, readContextDelivery } from '../../src/context/delivery.js';
import {
  inspectLegacyContextDelivery,
  inspectLegacyContextDeliveries,
  MAX_FINDINGS,
  type LegacyDeliveryRow,
} from '../../src/context/delivery-migration.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { CheckpointService, FeedbackService } from '../../src/gateway/checkpoint-service.js';
import { promoteLedgerProposal } from '../../src/ledger/promotion.js';
import { inspectLedger } from '../../src/ledger/maintenance.js';
import { canonicalContentHash, canonicalJson } from '../../src/serialization/validate.js';
import {
  CURRENT_MIGRATION_VERSIONS,
  CURRENT_SCHEMA_VERSION,
} from '../fixtures/current-migrations.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const initialMigrations = path.join(repositoryRoot, 'migrations');

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

const legacyScoreComponents = {
  status: 100,
  trust: 25,
  confidence: 18,
  retrieval: 10,
  taskAffinity: 0,
  recommendedTags: 0,
  scopeAffinity: 9,
  applicability: 0,
  pathOverlap: 0,
  errorSignature: 0,
  exactSignal: 0,
  feedback: 0,
  recency: 0,
  contradiction: 0,
} as const;

interface LegacyFixtureEntry {
  entryId: string;
  title: string;
  body: string;
  summary?: string | null;
}

interface LegacyFixtureOptions {
  prefix: string;
  entries: LegacyFixtureEntry[];
  characterBudget: number;
  characterCount: number;
  truncated?: boolean;
  maxMigrationVersion?: number;
}

async function copyMigrationRange(directory: string, firstVersion: number, lastVersion: number): Promise<void> {
  const migrationFiles = await readdir(initialMigrations);
  for (let version = firstVersion; version <= lastVersion; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = migrationFiles.find((candidate) => candidate.startsWith(`${prefix}_`));
    assert.ok(name);
    await copyFile(path.join(initialMigrations, name), path.join(directory, name));
  }
}

async function legacyDeliveryFixture(options: LegacyFixtureOptions) {
  const directory = await temporaryDirectory(options.prefix);
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await copyMigrationRange(migrationsDirectory, 1, options.maxMigrationVersion ?? 11);

  const database = openConnection(path.join(directory, 'data.sqlite3'));
  const workspace = `workspace:${options.prefix}`;
  const runId = `run-${options.prefix}`;
  const sessionId = `session-${options.prefix}`;
  const createdAt = '2026-08-24T00:00:00.000Z';
  const profile = { taskType: 'build', target: 'migration', expected: 'legacy replay', constraints: null } as const;
  const profileHash = canonicalContentHash(profile);
  const queryHash = 'b'.repeat(64);
  const deliveryId = `context-${canonicalContentHash({ runId, queryHash })}`;

  migrateDatabase(database, migrationsDirectory);
  database.prepare(`
    INSERT INTO ledger_runs (
      run_id, workspace, client_kind, client_version, source_session_id, parent_run_id,
      protocol_version, capture_profile, coverage_json, status, title, task_hash,
      metadata_json, last_sequence, last_source_sequence, started_at, ended_at, created_at, updated_at
    ) VALUES (?, ?, 'generic', '1.0.0', NULL, NULL, '1', 'standard', ?, 'active', 'Legacy migration', NULL, '{}', 0, NULL, ?, NULL, ?, ?)
  `).run(
    runId,
    workspace,
    canonicalJson({ approval: 'unavailable', command: 'unavailable', file: 'unavailable', run: 'declared', tool: 'unavailable' }),
    createdAt,
    createdAt,
    createdAt,
  );
  database.prepare(`
    INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
    VALUES (?, ?, 'Legacy migration', ?, 'ready', 0, ?, ?)
  `).run(sessionId, workspace, canonicalJson(profile), createdAt, createdAt);
  database.prepare(`
    INSERT INTO run_intakes (
      run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
      initial_profile_hash, recommended_tags_json, linked_at, finalized_at
    ) VALUES (?, ?, 'v2', 1, ?, ?, ?, ?, ?)
  `).run(
    runId,
    sessionId,
    canonicalJson({ taskType: 'client_supplied', target: 'client_supplied', expected: 'client_supplied', constraints: 'client_supplied' }),
    profileHash,
    canonicalJson(['bot:builder', 'skill:tdd']),
    createdAt,
    createdAt,
  );
  for (const entry of options.entries) {
    recordEntry(database, {
      workspace,
      kind: 'lesson',
      status: 'verified',
      trustLevel: 'source_verified',
      confidence: 0.9,
      title: entry.title,
      body: entry.body,
      ...(entry.summary === undefined ? {} : { summary: entry.summary }),
      createdBy: 'migration-test',
    }, { idFactory: () => entry.entryId, now: createdAt });
  }
  database.prepare(`
    INSERT INTO context_deliveries (
      delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
      policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at,
      score_schema_version
    ) VALUES (?, ?, 0, ?, ?, ?, 'context-ranking-v3', '{}', ?, ?, ?, ?, 2)
  `).run(
    deliveryId,
    runId,
    sessionId,
    profileHash,
    queryHash,
    options.characterBudget,
    options.characterCount,
    options.truncated === true ? 1 : 0,
    createdAt,
  );
  const insertEntry = database.prepare(`
    INSERT INTO context_delivery_entries (
      delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json, origin_scope
    ) VALUES (?, ?, 1, ?, ?, ?, 'project')
  `);
  for (const [index, entry] of options.entries.entries()) {
    insertEntry.run(
      deliveryId,
      entry.entryId,
      index + 1,
      canonicalJson(legacyScoreComponents),
      canonicalJson(['project_origin', 'verified']),
    );
  }
  return { database, databasePath: path.join(directory, 'data.sqlite3'), migrationsDirectory, workspace, runId, sessionId, profileHash, deliveryId, createdAt };
}

function databaseSnapshot(database: ReturnType<typeof openConnection>): unknown {
  const tables = database.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name
  `).all<{ name: string }>();
  return tables.map(({ name }) => ({
    name,
    rows: database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
  }));
}

const REVISION_IMMUTABILITY_TRIGGER = `CREATE TRIGGER entry_revisions_immutable_update
BEFORE UPDATE ON entry_revisions
BEGIN
    SELECT RAISE(ABORT, 'entry_revisions are immutable');
END`;

function installLegacyRevisionProjection(database: ReturnType<typeof openConnection>, entry: EntryRecord): void {
  const legacyTags = [...entry.tags].sort((left, right) => left.localeCompare(right));
  assert.notDeepEqual(legacyTags, entry.tags);
  const legacyHash = canonicalContentHash({
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    summary: entry.summary,
    scope: entry.scope,
    provenance: entry.provenance,
    tags: legacyTags,
  });
  database.exec('DROP TRIGGER entry_revisions_immutable_update');
  database.prepare('UPDATE entry_revisions SET content_hash = ? WHERE entry_id = ? AND revision = ?')
    .run(legacyHash, entry.id, entry.revision);
  database.prepare('DELETE FROM entry_revision_tags WHERE entry_id = ? AND revision = ?')
    .run(entry.id, entry.revision);
  const insertTag = database.prepare('INSERT INTO entry_revision_tags (entry_id, revision, tag) VALUES (?, ?, ?)');
  for (const tag of legacyTags) insertTag.run(entry.id, entry.revision, tag);
  const updateProjection = (table: 'entries_fts' | 'entries_trigram'): void => {
    database.prepare(`UPDATE ${table} SET tags_text = ? WHERE rowid = (SELECT rowid FROM entries WHERE id = ?)`)
      .run(legacyTags.join(' '), entry.id);
  };
  updateProjection('entries_fts');
  updateProjection('entries_trigram');
  database.exec(REVISION_IMMUTABILITY_TRIGGER);
}

async function applyContextDeliveryMigration(fixture: { database: ReturnType<typeof openConnection>; migrationsDirectory: string }) {
  await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(fixture.migrationsDirectory, '012_context_delivery_v4.sql'));
  return migrateDatabase(fixture.database, fixture.migrationsDirectory);
}

test('applies the initial migration and is idempotent', async () => {
  const directory = await temporaryDirectory('first');
  const databasePath = path.join(directory, 'data.sqlite3');
  const connection = openConnection(databasePath);
  try {
    const first = migrateDatabase(connection, initialMigrations);
    assert.deepEqual(first.applied, CURRENT_MIGRATION_VERSIONS);
    assert.equal(
      connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count,
      CURRENT_SCHEMA_VERSION,
    );
    for (const table of [
      'repositories',
      'repository_locations',
      'entries',
      'entry_revisions',
      'entry_revision_tags',
      'entry_links',
      'audit_events',
      'akinator_sessions',
      'akinator_answers',
      'knowledge_sources',
      'ledger_runs',
      'run_intakes',
      'intake_feedback',
      'ledger_events',
      'ledger_evidence',
      'context_deliveries',
      'context_delivery_entries',
      'context_feedback',
      'run_feedback',
      'ledger_memory_links',
      'ledger_purge_audit',
      'akinator_reasoning_paths',
      'repository_fingerprints',
      'external_skills',
      'external_skill_entries',
      'skill_discovery_cache',
      'skill_source_failure_cache',
      'skill_audit_failure_cache',
      'embedding_profiles',
      'embedding_runtime',
      'entry_embeddings',
      'embedding_jobs',
      'query_embeddings',
      'agent_task_skill_discovery_attempts',
      'enno_contracts',
      'enno_work_units',
      'enno_verifier_runs',
      'enno_operation_receipts',
      'enno_client_continuations',
      'enno_advisory_rounds',
      'enno_advisory_contributions',
      'entry_revision_hash_format',
    ]) {
      assert.equal(
        connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get<{ present: number }>(table)?.present,
        1,
        `missing ${table}`,
      );
    }
  } finally {
    connection.close();
  }

  const reopened = openConnection(databasePath);
  try {
    assert.deepEqual(migrateDatabase(reopened, initialMigrations).applied, []);
  } finally {
    reopened.close();
  }
});

test('migration 015 keys Skill discovery attempts by digest and bounds active budget reservations', async () => {
  const directory = await temporaryDirectory('skill-discovery-attempt-schema');
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    migrateDatabase(connection, initialMigrations);
    const timestamp = '2026-08-26T00:00:00.000Z';
    new LedgerStore(connection, { now: () => timestamp }).createRun({
      runId: 'run-skill-discovery-attempt',
      workspace: 'workspace:skill-discovery-attempt',
      protocolVersion: '1',
      client: { kind: 'test' },
      captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: {
        title: 'Validate discovery attempt schema',
        query: 'Validate discovery attempt schema',
        profileHints: { taskType: 'build', target: null, expected: null, constraints: null },
      },
      startedAt: timestamp,
    });
    const insert = connection.prepare(`
      INSERT INTO agent_task_skill_discovery_attempts (
        run_id, phase, request_digest,
        reserved_query_count, reserved_selection_count,
        consumed_query_count, consumed_selection_count,
        state, summary_json, failure_json, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const digest = 'a'.repeat(64);
    const started = (runId: string, phase: string, requestDigest: string, summary: string | null = null) =>
      insert.run(runId, phase, requestDigest, 3, 2, 0, 0, 'started', summary, null, timestamp, null);
    assert.throws(() => started('missing-run', 'intake', digest), /foreign key/iu);
    for (const invalidDigest of ['a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(63)}g`]) {
      assert.throws(() => started('run-skill-discovery-attempt', 'intake', invalidDigest), /check constraint/iu);
    }
    for (const budgets of [
      [1.5, 2, 0, 0],
      [3, 1.5, 0, 0],
      [3, 2, 1.5, 0],
      [3, 2, 0, 1.5],
    ]) {
      assert.throws(() => insert.run(
        'run-skill-discovery-attempt', 'intake', digest,
        ...budgets, 'started', null, null, timestamp, null,
      ), /check constraint/iu);
    }
    assert.throws(() => started('run-skill-discovery-attempt', 'other', digest), /check constraint/iu);
    assert.throws(() => insert.run('run-skill-discovery-attempt', 'intake', digest, 3, 2, 0, 0, 'waiting', null, null, timestamp, null), /check constraint/iu);
    assert.throws(() => started('run-skill-discovery-attempt', 'intake', digest, '{}'), /check constraint/iu);
    assert.throws(() => insert.run('run-skill-discovery-attempt', 'intake', digest, 3, 2, 0, 0, 'completed', null, null, timestamp, timestamp), /check constraint/iu);
    assert.throws(() => insert.run('run-skill-discovery-attempt', 'intake', digest, 3, 2, 0, 0, 'completed', '{}', '{}', timestamp, timestamp), /check constraint/iu);
    assert.throws(() => insert.run('run-skill-discovery-attempt', 'intake', digest, 3, 2, 0, 0, 'failed', null, null, timestamp, timestamp), /check constraint/iu);
    assert.throws(() => insert.run('run-skill-discovery-attempt', 'intake', digest, 3, 2, 0, 0, 'failed', '{}', '{}', timestamp, timestamp), /check constraint/iu);
    assert.throws(() => insert.run('run-skill-discovery-attempt', 'intake', digest, 3, 2, 0, 0, 'failed', null, '{}', timestamp, '2026-08-25T23:59:59.999Z'), /check constraint/iu);

    started('run-skill-discovery-attempt', 'intake', digest);
    assert.throws(() => started('run-skill-discovery-attempt', 'intake', digest), /unique constraint/iu);
    assert.throws(() => started('run-skill-discovery-attempt', 'intake', 'b'.repeat(64)), /unique constraint/iu);
    started('run-skill-discovery-attempt', 'zenki', digest);
    assert.throws(() => connection.prepare(`
      UPDATE agent_task_skill_discovery_attempts
      SET state = 'completed', finished_at = ?, consumed_query_count = 0, consumed_selection_count = 0
      WHERE run_id = 'run-skill-discovery-attempt' AND phase = 'intake' AND request_digest = ?
    `).run(timestamp, digest), /check constraint/iu);
    connection.prepare(`
      UPDATE agent_task_skill_discovery_attempts
      SET state = 'completed', summary_json = '{}', consumed_query_count = 0, consumed_selection_count = 0, finished_at = ?
      WHERE run_id = 'run-skill-discovery-attempt' AND phase = 'intake' AND request_digest = ?
    `).run(timestamp, digest);
    connection.prepare("DELETE FROM ledger_runs WHERE run_id = 'run-skill-discovery-attempt'").run();
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM agent_task_skill_discovery_attempts')
      .get<{ count: number }>()?.count, 0);
  } finally {
    connection.close();
  }
});

test('migration 015 terminalizes legacy started discovery rows before adding the active-attempt index', async () => {
  const directory = await temporaryDirectory('skill-discovery-started-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await copyMigrationRange(migrationsDirectory, 1, 14);
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    migrateDatabase(connection, migrationsDirectory);
    const timestamp = '2026-08-26T00:00:00.000Z';
    new LedgerStore(connection, { now: () => timestamp }).createRun({
      runId: 'run-started-discovery-upgrade',
      workspace: 'workspace:started-discovery-upgrade',
      protocolVersion: '1',
      client: { kind: 'test' },
      captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: {
        title: 'Preserve started discovery row',
        query: 'Preserve started discovery row',
        profileHints: { taskType: 'build', target: null, expected: null, constraints: null },
      },
      startedAt: timestamp,
    });
    const insert = connection.prepare(`
      INSERT INTO agent_task_skill_discovery_attempts (
        run_id, phase, request_digest, state, summary_json, failure_json, started_at, finished_at
      ) VALUES (?, ?, ?, 'started', NULL, NULL, ?, NULL)
    `);
    insert.run('run-started-discovery-upgrade', 'intake', 'a'.repeat(64), timestamp);

    await copyFile(path.join(initialMigrations, '015_skill_discovery_attempt_digests.sql'), path.join(migrationsDirectory, '015_skill_discovery_attempt_digests.sql'));
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [15]);
    const rows = connection.prepare(`
      SELECT state, failure_json AS failureJson, reserved_query_count AS reservedQueries,
             consumed_query_count AS consumedQueries
      FROM agent_task_skill_discovery_attempts
      WHERE run_id = ? ORDER BY request_digest
    `).all<{ state: string; failureJson: string; reservedQueries: number; consumedQueries: number }>('run-started-discovery-upgrade')
      .map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { state: 'failed', failureJson: '{"kind":"kiokuko","code":"CONFLICT"}', reservedQueries: 3, consumedQueries: 3 },
    ]);
    assert.equal(connection.prepare(`
      SELECT COUNT(*) AS count FROM agent_task_skill_discovery_attempts WHERE state = 'started'
    `).get<{ count: number }>()?.count, 0);
  } finally {
    connection.close();
  }
});

test('migration 015 preserves legacy malformed-provider failures as terminal budget-consuming attempts', async () => {
  const directory = await temporaryDirectory('skill-discovery-provider-failure-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await copyMigrationRange(migrationsDirectory, 1, 14);
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    migrateDatabase(connection, migrationsDirectory);
    const timestamp = '2026-08-26T00:00:00.000Z';
    new LedgerStore(connection, { now: () => timestamp }).createRun({
      runId: 'run-provider-failure-upgrade',
      workspace: 'workspace:provider-failure-upgrade',
      protocolVersion: '1',
      client: { kind: 'test' },
      captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: {
        title: 'Preserve malformed provider failure',
        query: 'Preserve malformed provider failure',
        profileHints: { taskType: 'debug', target: null, expected: null, constraints: null },
      },
      startedAt: timestamp,
    });
    connection.prepare(`
      INSERT INTO agent_task_skill_discovery_attempts (
        run_id, phase, request_digest, state, summary_json, failure_json, started_at, finished_at
      ) VALUES (?, 'zenki', ?, 'failed', NULL, ?, ?, ?)
    `).run(
      'run-provider-failure-upgrade',
      'c'.repeat(64),
      '{"code":"registry_invalid_response","kind":"skill_provider","retryAfterSeconds":null}',
      timestamp,
      timestamp,
    );

    await copyFile(path.join(initialMigrations, '015_skill_discovery_attempt_digests.sql'), path.join(migrationsDirectory, '015_skill_discovery_attempt_digests.sql'));
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [15]);
    const preserved = connection.prepare(`
      SELECT phase, request_digest AS requestDigest, state, failure_json AS failureJson,
             reserved_query_count AS reservedQueries, consumed_query_count AS consumedQueries,
             reserved_selection_count AS reservedSelections, consumed_selection_count AS consumedSelections
      FROM agent_task_skill_discovery_attempts WHERE run_id = ?
    `).get('run-provider-failure-upgrade');
    assert.deepEqual(preserved === undefined ? undefined : { ...preserved }, {
      phase: 'zenki',
      requestDigest: 'c'.repeat(64),
      state: 'failed',
      failureJson: '{"code":"registry_invalid_response","kind":"skill_provider","retryAfterSeconds":null}',
      reservedQueries: 3,
      consumedQueries: 3,
      reservedSelections: 2,
      consumedSelections: 2,
    });
  } finally {
    connection.close();
  }
});

test('migration 016 preserves operation receipts and adds revision-bound advisory rounds', async () => {
  const directory = await temporaryDirectory('enno-advisory-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await copyMigrationRange(migrationsDirectory, 1, 15);
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  const timestamp = '2026-08-28T00:00:00.000Z';
  const runId = 'run-enno-advisory-upgrade';
  const workspace = 'workspace:enno-advisory-upgrade';
  const sessionId = 'session-enno-advisory-upgrade';
  const profile = { taskType: 'debug', target: 'src/add.ts', expected: 'tests pass', constraints: null } as const;
  try {
    migrateDatabase(connection, migrationsDirectory);
    new LedgerStore(connection, { now: () => timestamp }).createRun({
      runId, workspace, protocolVersion: '1', client: { kind: 'test' }, captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Preserve Enno receipt', query: 'Preserve Enno receipt', profileHints: profile },
      startedAt: timestamp,
    });
    connection.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES (?, ?, 'Preserve Enno receipt', ?, 'ready', 0, ?, ?)
    `).run(sessionId, workspace, canonicalJson(profile), timestamp, timestamp);
    connection.prepare(`
      INSERT INTO run_intakes (
        run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
        initial_profile_hash, recommended_tags_json, linked_at, finalized_at
      ) VALUES (?, ?, 'v2', 1, ?, ?, '[]', ?, ?)
    `).run(
      runId,
      sessionId,
      canonicalJson({ taskType: 'client_supplied', target: 'client_supplied', expected: 'client_supplied', constraints: 'client_supplied' }),
      canonicalContentHash(profile),
      timestamp,
      timestamp,
    );
    connection.prepare(`
      INSERT INTO enno_contracts (
        run_id, workspace, orchestration_session_id, repository_root, task_type, status,
        revision, confirmation_state, contract_json, handoff_json, intake_discovery_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, '/tmp/repository', 'debug', 'zenki_planning', 1, 'not_required', '{}', '{}', '{}', ?, ?)
    `).run(runId, workspace, sessionId, timestamp, timestamp);
    connection.prepare(`
      INSERT INTO enno_operation_receipts (
        run_id, operation, idempotency_key, request_digest, state, response_json, created_at, finished_at
      ) VALUES (?, 'plan_submit', 'legacy-plan', ?, 'completed', '{}', ?, ?)
    `).run(runId, 'a'.repeat(64), timestamp, timestamp);

    await copyFile(
      path.join(initialMigrations, '016_enno_advisory_rounds.sql'),
      path.join(migrationsDirectory, '016_enno_advisory_rounds.sql'),
    );
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [16]);

    const preservedReceipt = connection.prepare(`
      SELECT operation, idempotency_key AS idempotencyKey, state, response_json AS responseJson
      FROM enno_operation_receipts WHERE run_id = ?
    `).get<{ operation: string; idempotencyKey: string; state: string; responseJson: string }>(runId);
    assert.deepEqual(preservedReceipt === undefined ? undefined : { ...preservedReceipt }, {
      operation: 'plan_submit', idempotencyKey: 'legacy-plan', state: 'completed', responseJson: '{}',
    });
    assert.equal(
      connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'enno_operation_receipts_v15'").get(),
      undefined,
    );
    assert.doesNotThrow(() => connection.prepare(`
      INSERT INTO enno_operation_receipts (
        run_id, operation, idempotency_key, request_digest, state, response_json, created_at, finished_at
      ) VALUES (?, 'advice_submit', 'advice', ?, 'started', NULL, ?, NULL)
    `).run(runId, 'b'.repeat(64), timestamp));

    const insertRound = connection.prepare(`
      INSERT INTO enno_advisory_rounds (
        round_id, run_id, contract_revision, mutation_revision, phase, input_digest,
        policy_version, source, state, degraded, aggregate_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'host_reported', 'advice_submitted', 0, '{}', ?, ?)
    `);
    insertRound.run('round-upgrade', runId, 1, 0, 'planning', 'c'.repeat(64), timestamp, timestamp);
    assert.throws(
      () => insertRound.run('round-duplicate', runId, 1, 0, 'planning', 'c'.repeat(64), timestamp, timestamp),
      /unique constraint/iu,
    );
    assert.throws(
      () => insertRound.run('round-null-mutation', runId, 1, null, 'planning', 'd'.repeat(64), timestamp, timestamp),
      /not null constraint/iu,
    );
    const mutationRevision = connection.prepare("PRAGMA table_info('enno_advisory_rounds')")
      .all<{ name: string; notnull: number }>()
      .find(({ name }) => name === 'mutation_revision');
    assert.equal(mutationRevision?.notnull, 1);
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    connection.close();
  }
});

test('migration 017 adds verify_prepare and enforces integer storage for advisory revisions', async () => {
  const directory = await temporaryDirectory('enno-advisory-protocol-v2-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await copyMigrationRange(migrationsDirectory, 1, 16);
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  const timestamp = '2026-08-29T00:00:00.000Z';
  const runId = 'run-enno-advisory-v2';
  const workspace = 'workspace:enno-advisory-v2';
  const sessionId = 'session-enno-advisory-v2';
  const profile = { taskType: 'debug', target: 'src/add.ts', expected: 'tests pass', constraints: null } as const;
  try {
    migrateDatabase(connection, migrationsDirectory);
    new LedgerStore(connection, { now: () => timestamp }).createRun({
      runId, workspace, protocolVersion: '1', client: { kind: 'test' }, captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Preserve v2 receipt', query: 'Preserve v2 receipt', profileHints: profile },
      startedAt: timestamp,
    });
    connection.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES (?, ?, 'Preserve v2 receipt', ?, 'ready', 0, ?, ?)
    `).run(sessionId, workspace, canonicalJson(profile), timestamp, timestamp);
    connection.prepare(`
      INSERT INTO run_intakes (
        run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
        initial_profile_hash, recommended_tags_json, linked_at, finalized_at
      ) VALUES (?, ?, 'v2', 1, ?, ?, '[]', ?, ?)
    `).run(
      runId,
      sessionId,
      canonicalJson({ taskType: 'client_supplied', target: 'client_supplied', expected: 'client_supplied', constraints: 'client_supplied' }),
      canonicalContentHash(profile),
      timestamp,
      timestamp,
    );
    connection.prepare(`
      INSERT INTO enno_contracts (
        run_id, workspace, orchestration_session_id, repository_root, task_type, status,
        revision, confirmation_state, contract_json, handoff_json, intake_discovery_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, '/tmp/repository', 'debug', 'zenki_planning', 1, 'not_required', '{}', '{}', '{}', ?, ?)
    `).run(runId, workspace, sessionId, timestamp, timestamp);
    connection.prepare(`
      INSERT INTO enno_operation_receipts (
        run_id, operation, idempotency_key, request_digest, state, response_json, created_at, finished_at
      ) VALUES (?, 'advice_submit', 'legacy-advice', ?, 'completed', '{}', ?, ?)
    `).run(runId, 'a'.repeat(64), timestamp, timestamp);
    connection.prepare(`
      INSERT INTO enno_advisory_rounds (
        round_id, run_id, contract_revision, mutation_revision, phase, input_digest,
        policy_version, source, state, degraded, aggregate_json, created_at, updated_at
      ) VALUES (?, ?, 1, 0, 'planning', ?, 1, 'host_reported', 'advice_submitted', 0, '{}', ?, ?)
    `).run('round-v2', runId, 'b'.repeat(64), timestamp, timestamp);
    connection.prepare(`
      INSERT INTO enno_advisory_contributions (
        round_id, slot_id, slot_rank, outcome, contribution_json, created_at
      ) VALUES (?, ?, 0, 'completed', '{}', ?)
    `).run('round-v2', 'workunit_architect', timestamp);

    await copyFile(
      path.join(initialMigrations, '017_enno_advisory_protocol_v2.sql'),
      path.join(migrationsDirectory, '017_enno_advisory_protocol_v2.sql'),
    );
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [17]);

    const preservedReceipt = connection.prepare(`
      SELECT operation, idempotency_key AS idempotencyKey, state, response_json AS responseJson
      FROM enno_operation_receipts WHERE run_id = ? AND operation = 'advice_submit'
    `).get<{ operation: string; idempotencyKey: string; state: string; responseJson: string }>(runId);
    assert.deepEqual(preservedReceipt === undefined ? undefined : { ...preservedReceipt }, {
      operation: 'advice_submit', idempotencyKey: 'legacy-advice', state: 'completed', responseJson: '{}',
    });
    const preservedRound = connection.prepare(`
      SELECT round_id AS roundId, contract_revision AS contractRevision, mutation_revision AS mutationRevision,
             input_digest AS inputDigest, degraded FROM enno_advisory_rounds WHERE round_id = 'round-v2'
    `).get<{ roundId: string; contractRevision: number; mutationRevision: number; inputDigest: string; degraded: number }>();
    assert.deepEqual(preservedRound === undefined ? undefined : { ...preservedRound }, {
      roundId: 'round-v2', contractRevision: 1, mutationRevision: 0, inputDigest: 'b'.repeat(64), degraded: 0,
    });
    const preservedContributionCount = connection.prepare(
      "SELECT COUNT(*) AS count FROM enno_advisory_contributions WHERE round_id = 'round-v2' AND slot_rank = 0",
    ).get<{ count: number }>();
    assert.equal(preservedContributionCount?.count, 1);
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);

    const insertReceipt = connection.prepare(`
      INSERT INTO enno_operation_receipts (
        run_id, operation, idempotency_key, request_digest, state, response_json, created_at, finished_at
      ) VALUES (?, ?, ?, ?, 'started', NULL, ?, NULL)
    `);
    insertReceipt.run(runId, 'verify_prepare', 'verify', 'c'.repeat(64), timestamp);
    assert.throws(() => insertReceipt.run(runId, 'delete', 'invalid', 'd'.repeat(64), timestamp), /check constraint/iu);

    const insertRound = connection.prepare(`
      INSERT INTO enno_advisory_rounds (
        round_id, run_id, contract_revision, mutation_revision, phase, input_digest,
        policy_version, source, state, degraded, aggregate_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'host_reported', 'aggregated', 0, '{}', ?, ?)
    `);
    assert.throws(() => insertRound.run('round-fractional', runId, 1.5, 0, 'planning', 'e'.repeat(64), 1, timestamp, timestamp), /check constraint/iu);
    assert.throws(() => insertRound.run('round-fractional-mutation', runId, 1, 0.5, 'planning', 'f'.repeat(64), 1, timestamp, timestamp), /check constraint/iu);
    assert.throws(() => insertRound.run('round-fractional-policy', runId, 1, 0, 'planning', 'a'.repeat(64), 1.5, timestamp, timestamp), /check constraint/iu);

    const insertContribution = connection.prepare(`
      INSERT INTO enno_advisory_contributions (
        round_id, slot_id, slot_rank, outcome, contribution_json, created_at
      ) VALUES (?, ?, ?, 'completed', '{}', ?)
    `);
    assert.throws(() => insertContribution.run('round-v2', 'duplicate-rank', 1.5, timestamp), /check constraint/iu);
  } finally {
    connection.close();
  }
});

test('migration 018 makes the Enno client session mutable routing metadata', async () => {
  const directory = await temporaryDirectory('enno-repository-routing-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await copyMigrationRange(migrationsDirectory, 1, 17);
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  const timestamp = '2026-08-29T00:00:00.000Z';
  const runId = 'run-enno-repository-routing';
  const workspace = 'workspace:enno-repository-routing';
  const orchestrationId = 'orchestration-enno-repository-routing';
  const profile = { taskType: 'debug', target: 'src/add.ts', expected: 'tests pass', constraints: null } as const;
  try {
    migrateDatabase(connection, migrationsDirectory);
    new LedgerStore(connection, { now: () => timestamp }).createRun({
      runId, workspace, protocolVersion: '1', client: { kind: 'test' }, captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Resume repository routing', query: 'Resume repository routing', profileHints: profile },
      startedAt: timestamp,
    });
    connection.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES (?, ?, 'Resume repository routing', ?, 'ready', 0, ?, ?)
    `).run(orchestrationId, workspace, canonicalJson(profile), timestamp, timestamp);
    connection.prepare(`
      INSERT INTO run_intakes (
        run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
        initial_profile_hash, recommended_tags_json, linked_at, finalized_at
      ) VALUES (?, ?, 'v2', 1, ?, ?, '[]', ?, ?)
    `).run(
      runId,
      orchestrationId,
      canonicalJson({ taskType: 'client_supplied', target: 'client_supplied', expected: 'client_supplied', constraints: 'client_supplied' }),
      canonicalContentHash(profile),
      timestamp,
      timestamp,
    );
    connection.prepare(`
      INSERT INTO enno_contracts (
        run_id, workspace, orchestration_session_id, client_kind, client_version, client_session_id,
        repository_root, task_type, status, revision, confirmation_state,
        contract_json, handoff_json, intake_discovery_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'codex', '1.0.0', 'codex-old', '/tmp/repository', 'debug',
        'zenki_planning', 1, 'not_required', '{}', '{}', '{}', ?, ?)
    `).run(runId, workspace, orchestrationId, timestamp, timestamp);

    assert.throws(() => connection.prepare(`
      UPDATE enno_contracts SET client_session_id = 'codex-new' WHERE run_id = ?
    `).run(runId), /immutable/iu);

    await copyFile(
      path.join(initialMigrations, '018_enno_repository_routing.sql'),
      path.join(migrationsDirectory, '018_enno_repository_routing.sql'),
    );
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [18]);
    connection.prepare(`
      UPDATE enno_contracts
      SET client_kind = 'claude', client_version = NULL, client_session_id = 'claude-new'
      WHERE run_id = ?
    `).run(runId);
    const routing = connection.prepare(`
      SELECT client_kind AS clientKind, client_version AS clientVersion, client_session_id AS clientSessionId
      FROM enno_contracts WHERE run_id = ?
    `).get<{ clientKind: string; clientVersion: string | null; clientSessionId: string }>(runId);
    assert.deepEqual(routing === undefined ? undefined : { ...routing }, {
      clientKind: 'claude', clientVersion: null, clientSessionId: 'claude-new',
    });
    assert.equal(connection.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name = 'enno_client_binding_update_guard'
    `).get<{ count: number }>()?.count, 0);
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    connection.close();
  }
});

test('migration 019 preserves legacy Enno rows and marks old evidence as unbound', async () => {
  const directory = await temporaryDirectory('enno-execution-integrity-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await copyMigrationRange(migrationsDirectory, 1, 18);
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  const timestamp = '2026-08-29T00:00:00.000Z';
  const runId = 'run-enno-execution-integrity';
  const workspace = 'workspace:enno-execution-integrity';
  const orchestrationId = 'orchestration-enno-execution-integrity';
  const profile = { taskType: 'debug', target: 'src/add.ts', expected: 'tests pass', constraints: null } as const;
  try {
    migrateDatabase(connection, migrationsDirectory);
    new LedgerStore(connection, { now: () => timestamp }).createRun({
      runId, workspace, protocolVersion: '1', client: { kind: 'test' }, captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Upgrade Enno execution integrity', query: 'Upgrade Enno execution integrity', profileHints: profile },
      startedAt: timestamp,
    });
    connection.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES (?, ?, 'Upgrade Enno execution integrity', ?, 'ready', 0, ?, ?)
    `).run(orchestrationId, workspace, canonicalJson(profile), timestamp, timestamp);
    connection.prepare(`
      INSERT INTO run_intakes (
        run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
        initial_profile_hash, recommended_tags_json, linked_at, finalized_at
      ) VALUES (?, ?, 'v2', 1, ?, ?, '[]', ?, ?)
    `).run(
      runId,
      orchestrationId,
      canonicalJson({ taskType: 'client_supplied', target: 'client_supplied', expected: 'client_supplied', constraints: 'client_supplied' }),
      canonicalContentHash(profile),
      timestamp,
      timestamp,
    );
    connection.prepare(`
      INSERT INTO enno_contracts (
        run_id, workspace, orchestration_session_id, client_kind, client_version, client_session_id,
        repository_root, task_type, status, revision, confirmation_state,
        contract_json, handoff_json, intake_discovery_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'codex', '1.0.0', 'codex-owner', '/tmp/repository', 'debug',
        'goki_executing', 1, 'not_required', '{}', '{}', '{}', ?, ?)
    `).run(runId, workspace, orchestrationId, timestamp, timestamp);
    connection.prepare(`
      INSERT INTO enno_work_units (
        run_id, work_unit_id, contract_revision, order_index, work_unit_json,
        status, attempt_count, result_json, created_at, updated_at
      ) VALUES (?, 'repair', 1, 0, '{}', 'in_progress', 0, NULL, ?, ?)
    `).run(runId, timestamp, timestamp);
    connection.prepare(`
      INSERT INTO enno_operation_receipts (
        run_id, operation, idempotency_key, request_digest, state, response_json, created_at, finished_at
      ) VALUES (?, 'work_report', 'legacy-complete', ?, 'completed', '{}', ?, ?),
               (?, 'verify_prepare', 'legacy-started', ?, 'started', NULL, ?, NULL)
    `).run(runId, 'a'.repeat(64), timestamp, timestamp, runId, 'b'.repeat(64), timestamp);
    connection.prepare(`
      INSERT INTO enno_verifier_runs (
        verifier_run_id, run_id, work_unit_id, contract_revision, mutation_revision,
        verifier_id, verifier_json, status, exit_code, signal, duration_ms,
        stdout_preview, stderr_preview, stdout_digest, stderr_digest, started_at, finished_at
      ) VALUES
        ('legacy-passed', ?, NULL, 1, 0, 'final', '{}', 'passed', 0, NULL, 1, '', '', ?, ?, ?, ?),
        ('legacy-started', ?, NULL, 1, 0, 'final', '{}', 'started', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)
    `).run(runId, 'c'.repeat(64), 'd'.repeat(64), timestamp, timestamp, runId, timestamp);

    await copyFile(
      path.join(initialMigrations, '019_enno_execution_integrity.sql'),
      path.join(migrationsDirectory, '019_enno_execution_integrity.sql'),
    );
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [19]);
    assert.equal(connection.prepare('SELECT route_epoch AS routeEpoch FROM enno_contracts WHERE run_id = ?')
      .get<{ routeEpoch: number }>(runId)?.routeEpoch, 0);
    const receipts = connection.prepare(`
      SELECT idempotency_key AS idempotencyKey, state, owner_nonce AS ownerNonce,
             lease_expires_at AS leaseExpiresAt, failure_code AS failureCode
      FROM enno_operation_receipts WHERE run_id = ? ORDER BY idempotency_key
    `).all<{ idempotencyKey: string; state: string; ownerNonce: string | null; leaseExpiresAt: string | null; failureCode: string | null }>(runId)
      .map((row) => ({ ...row }));
    assert.deepEqual(receipts, [
      { idempotencyKey: 'legacy-complete', state: 'completed', ownerNonce: null, leaseExpiresAt: null, failureCode: null },
      { idempotencyKey: 'legacy-started', state: 'started', ownerNonce: 'legacy-owner-legacy-started', leaseExpiresAt: timestamp, failureCode: null },
    ]);
    const verifiers = connection.prepare(`
      SELECT verifier_run_id AS verifierRunId, status, owner_nonce AS ownerNonce,
             repository_state_policy_version AS policyVersion,
             pre_repository_digest AS preDigest, post_repository_digest AS postDigest
      FROM enno_verifier_runs ORDER BY verifier_run_id
    `).all<{ verifierRunId: string; status: string; ownerNonce: string | null; policyVersion: number | null; preDigest: string | null; postDigest: string | null }>()
      .map((row) => ({ ...row }));
    assert.deepEqual(verifiers, [
      { verifierRunId: 'legacy-passed', status: 'passed', ownerNonce: null, policyVersion: null, preDigest: null, postDigest: null },
      { verifierRunId: 'legacy-started', status: 'started', ownerNonce: 'legacy-owner-legacy-started', policyVersion: null, preDigest: null, postDigest: null },
    ]);
    assert.throws(() => connection.prepare(`
      UPDATE enno_operation_receipts SET state = 'unknown' WHERE run_id = ?
    `).run(runId), /check constraint/iu);
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    connection.close();
  }
});

test('migration 013 preserves every legacy discovery attempt as the intake phase', async () => {
  const directory = await temporaryDirectory('skill-discovery-phase-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await copyMigrationRange(migrationsDirectory, 1, 12);
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    migrateDatabase(connection, migrationsDirectory);
    const timestamp = '2026-08-28T00:00:00.000Z';
    new LedgerStore(connection, { now: () => timestamp }).createRun({
      runId: 'run-phase-upgrade', workspace: 'workspace:phase-upgrade', protocolVersion: '1',
      client: { kind: 'test' }, captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Preserve discovery', query: 'Preserve discovery', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
      startedAt: timestamp,
    });
    connection.prepare(`
      INSERT INTO agent_task_skill_discovery_attempts (
        run_id, request_digest, state, summary_json, failure_json, started_at, finished_at
      ) VALUES (?, ?, 'completed', '{}', NULL, ?, ?)
    `).run('run-phase-upgrade', 'b'.repeat(64), timestamp, timestamp);
    await copyFile(path.join(initialMigrations, '013_enno_oduno.sql'), path.join(migrationsDirectory, '013_enno_oduno.sql'));
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [13]);
    const preserved = connection.prepare(`
      SELECT phase, request_digest AS requestDigest, state, summary_json AS summaryJson
      FROM agent_task_skill_discovery_attempts WHERE run_id = ?
    `).get<{ phase: string; requestDigest: string; state: string; summaryJson: string }>('run-phase-upgrade');
    assert.deepEqual(preserved === undefined ? undefined : { ...preserved }, {
      phase: 'intake', requestDigest: 'b'.repeat(64), state: 'completed', summaryJson: '{}',
    });
  } finally {
    connection.close();
  }
});

test('migration 014 adds Oduno reflection phases and preserves legacy operation receipts', async () => {
  const directory = await temporaryDirectory('oduno-reflection-phase-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await copyMigrationRange(migrationsDirectory, 1, 13);
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    migrateDatabase(connection, migrationsDirectory);
    const timestamp = '2026-08-28T00:00:00.000Z';
    const runId = 'run-oduno-phase-upgrade';
    const workspace = 'workspace:oduno-phase-upgrade';
    const sessionId = 'session-oduno-phase-upgrade';
    const profile = { taskType: 'debug', target: 'src/add.ts', expected: 'tests pass', constraints: null } as const;
    new LedgerStore(connection, { now: () => timestamp }).createRun({
      runId, workspace, protocolVersion: '1', client: { kind: 'test' }, captureProfile: 'minimal',
      coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Preserve Enno receipt', query: 'Preserve Enno receipt', profileHints: profile },
      startedAt: timestamp,
    });
    connection.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES (?, ?, 'Preserve Enno receipt', ?, 'ready', 0, ?, ?)
    `).run(sessionId, workspace, canonicalJson(profile), timestamp, timestamp);
    connection.prepare(`
      INSERT INTO run_intakes (
        run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
        initial_profile_hash, recommended_tags_json, linked_at, finalized_at
      ) VALUES (?, ?, 'v2', 1, ?, ?, '[]', ?, ?)
    `).run(
      runId,
      sessionId,
      canonicalJson({ taskType: 'client_supplied', target: 'client_supplied', expected: 'client_supplied', constraints: 'client_supplied' }),
      canonicalContentHash(profile),
      timestamp,
      timestamp,
    );
    connection.prepare(`
      INSERT INTO enno_contracts (
        run_id, workspace, orchestration_session_id, repository_root, task_type, status,
        revision, confirmation_state, contract_json, handoff_json, intake_discovery_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, '/tmp/repository', 'debug', 'zenki_planning', 1, 'not_required', '{}', '{}', '{}', ?, ?)
    `).run(runId, workspace, sessionId, timestamp, timestamp);
    connection.prepare(`
      INSERT INTO enno_operation_receipts (
        run_id, operation, idempotency_key, request_digest, state, response_json, created_at, finished_at
      ) VALUES (?, 'plan_submit', 'legacy-plan', ?, 'completed', '{}', ?, ?)
    `).run(runId, 'a'.repeat(64), timestamp, timestamp);

    await copyFile(path.join(initialMigrations, '014_oduno_reflection_phases.sql'), path.join(migrationsDirectory, '014_oduno_reflection_phases.sql'));
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [14]);
    const preservedReceipt = connection.prepare(`
      SELECT operation, idempotency_key AS idempotencyKey, state, response_json AS responseJson
      FROM enno_operation_receipts WHERE run_id = ?
    `).get<{ operation: string; idempotencyKey: string; state: string; responseJson: string }>(runId);
    assert.deepEqual(preservedReceipt === undefined ? undefined : { ...preservedReceipt }, {
      operation: 'plan_submit', idempotencyKey: 'legacy-plan', state: 'completed', responseJson: '{}',
    });
    const columns = connection.prepare('PRAGMA table_info(enno_contracts)')
      .all<{ name: string }>().map((column) => column.name);
    assert.ok(columns.includes('phase'));
    assert.ok(columns.includes('ideal_json'));
    assert.ok(columns.includes('meditation_json'));
    const insertReceipt = connection.prepare(`
      INSERT INTO enno_operation_receipts (
        run_id, operation, idempotency_key, request_digest, state, response_json, created_at, finished_at
      ) VALUES (?, ?, ?, ?, 'started', NULL, ?, NULL)
    `);
    insertReceipt.run(runId, 'ideal_submit', 'ideal', 'b'.repeat(64), timestamp);
    insertReceipt.run(runId, 'meditation_submit', 'meditation', 'c'.repeat(64), timestamp);
    assert.throws(() => insertReceipt.run(runId, 'delete', 'invalid', 'd'.repeat(64), timestamp), /check constraint/iu);
    connection.prepare("UPDATE enno_contracts SET phase = 'oduno_ideal' WHERE run_id = ?").run(runId);
    assert.throws(() => connection.prepare("UPDATE enno_contracts SET phase = 'unknown' WHERE run_id = ?").run(runId), /check constraint/iu);
  } finally {
    connection.close();
  }
});

test('rejects a changed checksum for an applied migration', async () => {
  const directory = await temporaryDirectory('checksum');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  const migrationPath = path.join(migrationsDirectory, '001_initial.sql');
  await writeFile(migrationPath, 'CREATE TABLE checksum_fixture (id INTEGER PRIMARY KEY);\n');
  const databasePath = path.join(directory, 'data.sqlite3');
  const connection = openConnection(databasePath);
  try {
    migrateDatabase(connection, migrationsDirectory);
  } finally {
    connection.close();
  }
  await writeFile(migrationPath, 'CREATE TABLE checksum_fixture (id INTEGER PRIMARY KEY, value TEXT);\n');

  const reopened = openConnection(databasePath);
  try {
    assert.throws(() => migrateDatabase(reopened, migrationsDirectory), /checksum/i);
  } finally {
    reopened.close();
  }
});

test('migration 008 preserves project and global delivery rows while enabling ecosystem origin', async () => {
  const directory = await temporaryDirectory('migration-008-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  const migrationFiles = await readdir(initialMigrations);
  for (let version = 1; version <= 7; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = migrationFiles.find((candidate) => candidate.startsWith(`${prefix}_`));
    assert.ok(name);
    await copyFile(path.join(initialMigrations, name), path.join(migrationsDirectory, name));
  }
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [1, 2, 3, 4, 5, 6, 7]);
    const projectEntry = recordEntry(connection, {
      workspace: 'workspace:migration-project', kind: 'lesson', title: 'Project row', body: 'Keep the project row.',
    }, { idFactory: () => 'entry-migration-project', now: '2026-08-23T00:00:00.000Z' });
    const globalEntry = recordEntry(connection, {
      workspace: 'global', kind: 'lesson', title: 'Global row', body: 'Keep the global row.',
      scope: { visibility: 'global' },
    }, { idFactory: () => 'entry-migration-global', now: '2026-08-23T00:00:00.000Z' });
    const store = new LedgerStore(connection, { now: () => '2026-08-23T00:00:00.000Z' });
    store.createRun({
      runId: 'run-migration-008', workspace: 'workspace:migration-project', protocolVersion: '1', client: { kind: 'generic' }, captureProfile: 'minimal',
      coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
      task: { title: 'Upgrade', query: 'Upgrade delivery origins', profileHints: { taskType: 'build', target: null, expected: null, constraints: null } },
      startedAt: '2026-08-23T00:00:00.000Z',
    });
    connection.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash,
        query_hash, policy_version, external_sync_summary_json, char_budget,
        char_count, truncated, created_at
      ) VALUES ('delivery-migration-008', 'run-migration-008', 0, NULL, ?, ?, 'v2', '{}', 100, 0, 0, ?)
    `).run('a'.repeat(64), 'b'.repeat(64), '2026-08-23T00:00:00.000Z');
    const insert = connection.prepare(`
      INSERT INTO context_delivery_entries (
        delivery_id, entry_id, entry_revision, rank, score_components_json,
        selection_reason_json, origin_scope
      ) VALUES ('delivery-migration-008', ?, 1, ?, '{}', '[]', ?)
    `);
    insert.run(projectEntry.id, 1, 'project');
    insert.run(globalEntry.id, 2, 'global');
    connection.prepare(`
      INSERT INTO context_feedback (
        feedback_id, delivery_id, entry_id, run_id, verdict, comment,
        actor, idempotency_key, created_at
      ) VALUES (?, 'delivery-migration-008', ?, 'run-migration-008', 'helpful', NULL, ?, ?, ?)
    `).run('feedback-migration-project', projectEntry.id, 'project-user', 'c'.repeat(64), '2026-08-23T00:00:00.000Z');
    connection.prepare(`
      INSERT INTO context_feedback (
        feedback_id, delivery_id, entry_id, run_id, verdict, comment,
        actor, idempotency_key, created_at
      ) VALUES (?, 'delivery-migration-008', ?, 'run-migration-008', 'helpful', NULL, ?, ?, ?)
    `).run('feedback-migration-global', globalEntry.id, 'global-user', 'd'.repeat(64), '2026-08-23T00:00:00.000Z');

    await copyFile(path.join(initialMigrations, '008_federated_memory.sql'), path.join(migrationsDirectory, '008_federated_memory.sql'));
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [8]);
    assert.deepEqual(
      connection.prepare('SELECT entry_id, origin_scope FROM context_delivery_entries ORDER BY rank').all<Record<string, unknown>>().map((row) => ({ ...row })),
      [
        { entry_id: projectEntry.id, origin_scope: 'project' },
        { entry_id: globalEntry.id, origin_scope: 'global' },
      ],
    );
    assert.deepEqual(
      connection.prepare('SELECT feedback_id, entry_id FROM context_feedback ORDER BY feedback_id').all<Record<string, unknown>>().map((row) => ({ ...row })),
      [
        { feedback_id: 'feedback-migration-global', entry_id: globalEntry.id },
        { feedback_id: 'feedback-migration-project', entry_id: projectEntry.id },
      ],
    );
    assert.doesNotThrow(() => connection.prepare(`
      INSERT INTO context_delivery_entries (
        delivery_id, entry_id, entry_revision, rank, score_components_json,
        selection_reason_json, origin_scope
      ) VALUES ('delivery-migration-008', ?, 1, 3, '{}', '[]', 'ecosystem')
    `).run(recordEntry(connection, {
      workspace: 'workspace:migration-foreign', kind: 'lesson', title: 'Ecosystem row', body: 'Allow the ecosystem row.',
    }, { idFactory: () => 'entry-migration-ecosystem', now: '2026-08-23T00:00:00.000Z' }).id));
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    connection.close();
  }
});

test('migration 012 preserves historical character metadata when a legacy delivery has no items', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-empty-items',
    entries: [],
    characterBudget: 12_000,
    characterCount: 1_803,
  });
  try {
    assert.deepEqual((await applyContextDeliveryMigration(fixture)).applied, [12]);
    const delivery = readContextDelivery(fixture.database, { workspace: fixture.workspace, deliveryId: fixture.deliveryId });
    assert.equal(delivery.items.length, 0);
    assert.equal(delivery.charCount, 1_803);
  } finally {
    fixture.database.close();
  }
});

test('migration 012 preserves a historical count that differs from current entry content', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-opaque-count',
    entries: [{ entryId: 'entry-legacy-opaque-count', title: 'Legacy title', body: 'current body' }],
    characterBudget: 12_000,
    characterCount: 2_027,
  });
  try {
    assert.deepEqual((await applyContextDeliveryMigration(fixture)).applied, [12]);
    const delivery = readContextDelivery(fixture.database, { workspace: fixture.workspace, deliveryId: fixture.deliveryId });
    assert.equal(delivery.charCount, 2_027);
    assert.equal(delivery.items.length, 1);
    assert.equal(delivery.items[0]?.entryId, 'entry-legacy-opaque-count');
  } finally {
    fixture.database.close();
  }
});

test('migration 012 preserves legacy delivery rank gaps after migration 009 recovers an entry', async () => {
  const middleEntryId = 'entry-legacy-recovered-middle';
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-recovered-rank-gap',
    entries: [
      { entryId: 'entry-legacy-recovered-first', title: 'First entry', body: 'Keep the first entry.' },
      { entryId: middleEntryId, title: 'Unreadable entry', body: 'Migration 009 removes this entry.' },
      { entryId: 'entry-legacy-recovered-last', title: 'Last entry', body: 'Keep the last entry.' },
    ],
    characterBudget: 100,
    characterCount: 0,
    maxMigrationVersion: 8,
  });
  try {
    fixture.database.exec('DROP TRIGGER entry_revisions_immutable_update');
    fixture.database.prepare('UPDATE entry_revisions SET content_hash = ? WHERE entry_id = ? AND revision = 1')
      .run('0'.repeat(64), middleEntryId);
    fixture.database.exec(REVISION_IMMUTABILITY_TRIGGER);
    await copyMigrationRange(fixture.migrationsDirectory, 9, 12);

    const migrated = migrateDatabase(fixture.database, fixture.migrationsDirectory, {
      recoverInvalidStoredMemory: true,
    });

    assert.deepEqual(migrated.applied, [9, 10, 11, 12]);
    assert.equal(migrated.recoveredEntries, 1);
    assert.deepEqual(
      fixture.database.prepare('SELECT entry_id, rank FROM context_delivery_entries WHERE delivery_id = ? ORDER BY rank')
        .all<{ entry_id: string; rank: number }>(fixture.deliveryId).map((row) => ({ ...row })),
      [
        { entry_id: 'entry-legacy-recovered-first', rank: 1 },
        { entry_id: 'entry-legacy-recovered-last', rank: 3 },
      ],
    );
    assert.equal(fixture.database.prepare('SELECT 1 FROM entries WHERE id = ?').get(middleEntryId), undefined);
    assert.deepEqual(
      readContextDelivery(fixture.database, { workspace: fixture.workspace, deliveryId: fixture.deliveryId }).items
        .map((item) => ({ entryId: item.entryId, rank: item.rank })),
      [
        { entryId: 'entry-legacy-recovered-first', rank: 1 },
        { entryId: 'entry-legacy-recovered-last', rank: 3 },
      ],
    );
  } finally {
    fixture.database.close();
  }
});

test('legacy migration does not expand a bounded preview for an oversized source body', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-oversized-source',
    entries: [{ entryId: 'entry-legacy-oversized', title: 'Legacy title', body: 'x'.repeat(100_001) }],
    characterBudget: 7,
    characterCount: 7,
  });
  try {
    assert.deepEqual((await applyContextDeliveryMigration(fixture)).applied, [12]);
    const stored = fixture.database.prepare('SELECT char_budget, char_count FROM context_deliveries WHERE delivery_id = ?')
      .get<{ char_budget: number; char_count: number }>(fixture.deliveryId);
    assert.deepEqual({ ...stored }, { char_budget: 7, char_count: 7 });
  } finally {
    fixture.database.close();
  }
});

test('migration 012 rejects persisted legacy character counts outside their budget', async () => {
  for (const [suffix, characterCount] of [['negative', -1], ['over-budget', 101] as const]) {
    const fixture = await legacyDeliveryFixture({
      prefix: `migration-012-invalid-count-${suffix}`,
      entries: [],
      characterBudget: 100,
      characterCount: 0,
    });
    try {
      fixture.database.prepare('PRAGMA ignore_check_constraints = ON').run();
      fixture.database.prepare('UPDATE context_deliveries SET char_count = ? WHERE delivery_id = ?')
        .run(characterCount, fixture.deliveryId);
      await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(fixture.migrationsDirectory, '012_context_delivery_v4.sql'));
      assert.throws(
        () => migrateDatabase(fixture.database, fixture.migrationsDirectory),
        (error: unknown) => (error as { code?: string; details?: { stage?: string } }).code === 'INTEGRITY_ERROR'
          && (error as { details?: { stage?: string } }).details?.stage === 'legacy-delivery-character-range',
      );
      assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 11);
      assert.equal(fixture.database.prepare('SELECT char_count FROM context_deliveries WHERE delivery_id = ?').get<{ char_count: number }>(fixture.deliveryId)?.char_count, characterCount);
    } finally {
      fixture.database.close();
    }
  }
});

test('migration 012 rejects a legacy delivery whose identity does not match its policy', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-invalid-identity',
    entries: [],
    characterBudget: 100,
    characterCount: 0,
  });
  try {
    fixture.database.prepare('UPDATE context_deliveries SET delivery_id = ? WHERE delivery_id = ?')
      .run('context-forged-legacy-identity', fixture.deliveryId);
    await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(fixture.migrationsDirectory, '012_context_delivery_v4.sql'));
    assert.throws(
      () => migrateDatabase(fixture.database, fixture.migrationsDirectory),
      (error: unknown) => (error as { code?: string; details?: { stage?: string } }).code === 'INTEGRITY_ERROR'
        && (error as { details?: { stage?: string } }).details?.stage === 'legacy-delivery-identity',
    );
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 11);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE delivery_id = ?').get<{ count: number }>('context-forged-legacy-identity')?.count, 1);
  } finally {
    fixture.database.close();
  }
});

test('migration inspector rejects a missing exact legacy entry revision', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-missing-revision',
    entries: [{ entryId: 'entry-legacy-missing-revision', title: 'Legacy title', body: 'current body' }],
    characterBudget: 100,
    characterCount: 2,
  });
  try {
    fixture.database.prepare('PRAGMA foreign_keys = OFF').run();
    fixture.database.prepare('DELETE FROM entry_revisions WHERE entry_id = ? AND revision = 1')
      .run('entry-legacy-missing-revision');
    fixture.database.prepare('PRAGMA foreign_keys = ON').run();
    const row = fixture.database.prepare(`
      SELECT cd.delivery_id, cd.run_id, cd.policy_version, cd.score_schema_version,
             lr.workspace AS run_workspace
        FROM context_deliveries AS cd
        LEFT JOIN ledger_runs AS lr ON lr.run_id = cd.run_id
       WHERE cd.delivery_id = ?
    `).get<LegacyDeliveryRow>(fixture.deliveryId);
    assert.ok(row);
    assert.throws(
      () => inspectLegacyContextDelivery(fixture.database, row),
      (error: unknown) => (error as { code?: string; details?: { stage?: string } }).code === 'INTEGRITY_ERROR'
        && (error as { details?: { stage?: string } }).details?.stage === 'legacy-delivery-entry-revision',
    );
  } finally {
    fixture.database.close();
  }
});

test('doctor reports all invalid legacy deliveries without applying migration 012', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-doctor-invalid',
    entries: [],
    characterBudget: 100,
    characterCount: 0,
  });
  try {
    fixture.database.prepare('UPDATE context_deliveries SET delivery_id = ? WHERE delivery_id = ?')
      .run('context-forged-doctor-identity', fixture.deliveryId);
    fixture.database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash,
        query_hash, policy_version, external_sync_summary_json, char_budget, char_count,
        truncated, created_at, score_schema_version
      ) VALUES (?, ?, 0, ?, ?, ?, 'context-ranking-v3', '{}', 100, 0, 0, ?, 2)
    `).run(
      'context-forged-doctor-identity-2',
      fixture.runId,
      fixture.sessionId,
      fixture.profileHash,
      'c'.repeat(64),
      fixture.createdAt,
    );
    await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(fixture.migrationsDirectory, '012_context_delivery_v4.sql'));
    const report = await runDoctor({
      databasePath: fixture.databasePath,
      migrationsDirectory: fixture.migrationsDirectory,
      runtimeDescriptorPath: path.join(path.dirname(fixture.migrationsDirectory), 'runtime.json'),
    });
    assert.equal(report.ok, false);
    assert.equal(report.currentVersion, 12);
    assert.equal(report.legacyDeliveries.scanned, 2);
    assert.equal(report.legacyDeliveries.valid, 0);
    assert.equal(report.legacyDeliveries.invalid, 2);
    assert.equal(report.legacyDeliveries.scanTruncated, false);
    assert.equal(report.legacyDeliveries.findingsTruncated, false);
    assert.deepEqual(report.legacyDeliveries.findings, [
      {
        deliveryId: 'context-forged-doctor-identity',
        runId: fixture.runId,
        policyVersion: 'context-ranking-v3',
        stage: 'legacy-delivery-identity',
        code: 'INTEGRITY_ERROR',
      },
      {
        deliveryId: 'context-forged-doctor-identity-2',
        runId: fixture.runId,
        policyVersion: 'context-ranking-v3',
        stage: 'legacy-delivery-identity',
        code: 'INTEGRITY_ERROR',
      },
    ]);
    assert.equal(report.checks.legacyDeliveries.ok, false);
    assert.equal(report.checks.migrations.ok, false);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 11);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE run_id = ?').get<{ count: number }>(fixture.runId)?.count, 2);
  } finally {
    fixture.database.close();
  }
});

test('doctor preflights invalid legacy deliveries from database version 10', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-doctor-version-10',
    entries: [],
    characterBudget: 100,
    characterCount: 0,
  });
  try {
    // Migration 011 is additive, so removing its marker simulates the same
    // persisted delivery schema with databaseVersion=10 and pending [11, 12].
    fixture.database.prepare('DELETE FROM schema_migrations WHERE version = 11').run();
    fixture.database.prepare('UPDATE context_deliveries SET delivery_id = ? WHERE delivery_id = ?')
      .run('context-forged-doctor-version-10-1', fixture.deliveryId);
    fixture.database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash,
        query_hash, policy_version, external_sync_summary_json, char_budget, char_count,
        truncated, created_at, score_schema_version
      ) VALUES (?, ?, 0, ?, ?, ?, 'context-ranking-v3', '{}', 100, 0, 0, ?, 2)
    `).run(
      'context-forged-doctor-version-10-2',
      fixture.runId,
      fixture.sessionId,
      fixture.profileHash,
      'c'.repeat(64),
      fixture.createdAt,
    );
    await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(fixture.migrationsDirectory, '012_context_delivery_v4.sql'));

    const report = await runDoctor({
      databasePath: fixture.databasePath,
      migrationsDirectory: fixture.migrationsDirectory,
      runtimeDescriptorPath: path.join(path.dirname(fixture.migrationsDirectory), 'runtime.json'),
    });

    assert.equal(report.ok, false);
    assert.equal(report.currentVersion, 12);
    assert.equal(report.legacyDeliveries.scanned, 2);
    assert.equal(report.legacyDeliveries.valid, 0);
    assert.equal(report.legacyDeliveries.invalid, 2);
    assert.equal(report.legacyDeliveries.scanTruncated, false);
    assert.equal(report.legacyDeliveries.findingsTruncated, false);
    assert.deepEqual(report.legacyDeliveries.findings.map((finding) => finding.deliveryId), [
      'context-forged-doctor-version-10-1',
      'context-forged-doctor-version-10-2',
    ]);
    assert.equal(report.checks.migrations.ok, false);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 10);
  } finally {
    fixture.database.close();
  }
});

test('doctor preflights invalid legacy deliveries from released database version 8', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-doctor-version-8',
    entries: [],
    characterBudget: 100,
    characterCount: 0,
    maxMigrationVersion: 8,
  });
  try {
    fixture.database.prepare('UPDATE context_deliveries SET delivery_id = ? WHERE delivery_id = ?')
      .run('context-forged-doctor-version-8-1', fixture.deliveryId);
    fixture.database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash,
        query_hash, policy_version, external_sync_summary_json, char_budget, char_count,
        truncated, created_at, score_schema_version
      ) VALUES (?, ?, 0, ?, ?, ?, 'context-ranking-v3', '{}', 100, 0, 0, ?, 2)
    `).run(
      'context-forged-doctor-version-8-2',
      fixture.runId,
      fixture.sessionId,
      fixture.profileHash,
      'c'.repeat(64),
      fixture.createdAt,
    );
    await copyMigrationRange(fixture.migrationsDirectory, 9, 12);
    const before = databaseSnapshot(fixture.database);

    const report = await runDoctor({
      databasePath: fixture.databasePath,
      migrationsDirectory: fixture.migrationsDirectory,
      runtimeDescriptorPath: path.join(path.dirname(fixture.migrationsDirectory), 'runtime.json'),
    });

    assert.equal(report.ok, false);
    assert.equal(report.currentVersion, 12);
    assert.equal(report.legacyDeliveries.scanned, 2);
    assert.equal(report.legacyDeliveries.valid, 0);
    assert.equal(report.legacyDeliveries.invalid, 2);
    assert.equal(report.legacyDeliveries.scanTruncated, false);
    assert.equal(report.legacyDeliveries.findingsTruncated, false);
    assert.deepEqual(report.legacyDeliveries.findings.map((finding) => finding.deliveryId), [
      'context-forged-doctor-version-8-1',
      'context-forged-doctor-version-8-2',
    ]);
    assert.equal(report.checks.legacyDeliveries.ok, false);
    assert.equal(report.checks.migrations.ok, false);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 8);
    assert.deepEqual(databaseSnapshot(fixture.database), before);
  } finally {
    fixture.database.close();
  }
});

test('reports a missing nudge table after migration 010 is applied', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-010-missing-nudge-table',
    entries: [],
    characterBudget: 100,
    characterCount: 0,
  });
  try {
    assert.deepEqual((await applyContextDeliveryMigration(fixture)).applied, [12]);
    fixture.database.exec('DROP TABLE nudge_deliveries');

    const ledger = inspectLedger(fixture.database);
    assert.equal(ledger.ok, false);
    assert.equal(ledger.checks.nudgeDeliveries.ok, false);
    assert.deepEqual(ledger.checks.nudgeDeliveries.findings, [
      { check: 'nudgeDeliveries', kind: 'missing_table', category: 'nudge_deliveries' },
    ]);

    const report = await runDoctor({
      databasePath: fixture.databasePath,
      migrationsDirectory: fixture.migrationsDirectory,
      runtimeDescriptorPath: path.join(path.dirname(fixture.migrationsDirectory), 'runtime.json'),
    });
    assert.equal(report.ok, false);
    assert.equal(report.checks.nudgeDeliveries.ok, false);
    assert.equal(report.checks.nudgeDeliveries.count, 1);
    assert.match(report.checks.nudgeDeliveries.detail ?? '', /findings=1/u);
    assert.deepEqual(
      fixture.database.prepare('SELECT version FROM schema_migrations WHERE version IN (10, 12) ORDER BY version')
        .all<{ version: number }>().map((row) => row.version),
      [10, 12],
    );
  } finally {
    fixture.database.close();
  }
});

test('defers current memory-format checks for a version 8 preflight', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-009-deferred-version-8',
    entries: [],
    characterBudget: 100,
    characterCount: 0,
    maxMigrationVersion: 8,
  });
  try {
    const entry = recordEntry(fixture.database, {
      workspace: fixture.workspace,
      kind: 'lesson',
      status: 'verified',
      trustLevel: 'source_verified',
      confidence: 0.9,
      title: 'Released locale ordering',
      body: 'The pre-migration revision uses its released locale-sensitive tag order.',
      tags: ['Z', 'a'],
      createdBy: 'migration-test',
    }, { idFactory: () => 'entry-legacy-locale-order', now: fixture.createdAt });
    installLegacyRevisionProjection(fixture.database, entry);
    fixture.database.prepare('UPDATE context_deliveries SET delivery_id = ? WHERE delivery_id = ?')
      .run('context-forged-deferred-version-8', fixture.deliveryId);
    await copyMigrationRange(fixture.migrationsDirectory, 9, 12);
    const before = databaseSnapshot(fixture.database);

    const report = await runDoctor({
      databasePath: fixture.databasePath,
      migrationsDirectory: fixture.migrationsDirectory,
      runtimeDescriptorPath: path.join(path.dirname(fixture.migrationsDirectory), 'runtime.json'),
    });

    assert.equal(report.ok, false);
    assert.equal(report.currentVersion, 12);
    assert.equal(report.checks.legacyDeliveries.ok, false);
    assert.equal(report.checks.revisionHashes.ok, true);
    assert.equal(report.checks.revisionHashes.count, 0);
    assert.match(report.checks.revisionHashes.detail ?? '', /deferred until migration 009/u);
    assert.equal(report.checks.fts.ok, true);
    assert.equal(report.checks.fts.count, 0);
    assert.match(report.checks.fts.detail ?? '', /currentMismatches=deferred until migration 009/u);
    assert.equal(report.checks.hybridSearch.ok, true);
    assert.equal(report.checks.hybridSearch.count, 0);
    assert.match(report.checks.hybridSearch.detail ?? '', /deferred until migration 009/u);
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 8);
    assert.deepEqual(databaseSnapshot(fixture.database), before);
  } finally {
    fixture.database.close();
  }
});

test('rejects legacy deliveries whose intake session row is missing', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-missing-intake-session',
    entries: [],
    characterBudget: 100,
    characterCount: 0,
  });
  try {
    fixture.database.exec('PRAGMA foreign_keys = OFF');
    fixture.database.prepare('DELETE FROM akinator_sessions WHERE id = ?').run(fixture.sessionId);
    fixture.database.exec('PRAGMA foreign_keys = ON');
    const row = fixture.database.prepare(`
      SELECT cd.delivery_id, cd.run_id, cd.policy_version, cd.score_schema_version,
             lr.workspace AS run_workspace
        FROM context_deliveries AS cd
        LEFT JOIN ledger_runs AS lr ON lr.run_id = cd.run_id
       WHERE cd.delivery_id = ?
    `).get<LegacyDeliveryRow>(fixture.deliveryId);
    assert.ok(row);
    const assertIntegrity = (operation: () => unknown): void => {
      assert.throws(operation, (error: unknown) => (error as { code?: unknown }).code === 'INTEGRITY_ERROR');
    };

    assertIntegrity(() => readContextDelivery(fixture.database, {
      workspace: fixture.workspace,
      deliveryId: fixture.deliveryId,
    }));
    assertIntegrity(() => listContextDeliveries(fixture.database, {
      workspace: fixture.workspace,
      runId: fixture.runId,
      limit: 10,
    }));
    assert.throws(
      () => inspectLegacyContextDelivery(fixture.database, row),
      (error: unknown) => {
        const typed = error as { code?: string; details?: { stage?: string } };
        return typed.code === 'INTEGRITY_ERROR' && typed.details?.stage === 'legacy-delivery-profile-binding';
      },
    );

    const beforeMigration = databaseSnapshot(fixture.database);
    await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(fixture.migrationsDirectory, '012_context_delivery_v4.sql'));
    assertIntegrity(() => migrateDatabase(fixture.database, fixture.migrationsDirectory));
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 11);
    assert.deepEqual(databaseSnapshot(fixture.database), beforeMigration);
  } finally {
    fixture.database.close();
  }
});

test('legacy inspection distinguishes finding truncation from scan truncation', async () => {
  const fixture = await legacyDeliveryFixture({
    prefix: 'migration-012-finding-truncation',
    entries: [],
    characterBudget: 100,
    characterCount: 0,
  });
  try {
    const insert = fixture.database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash,
        query_hash, policy_version, external_sync_summary_json, char_budget, char_count,
        truncated, created_at, score_schema_version
      ) VALUES (?, ?, 0, ?, ?, ?, 'context-ranking-v3', '{}', 100, 0, 0, ?, 2)
    `);
    for (let index = 0; index <= MAX_FINDINGS; index += 1) {
      insert.run(
        `context-invalid-finding-${String(index).padStart(3, '0')}`,
        fixture.runId,
        fixture.sessionId,
        fixture.profileHash,
        'c'.repeat(64),
        fixture.createdAt,
      );
    }

    const inspection = inspectLegacyContextDeliveries(fixture.database);
    assert.equal(inspection.scanned, MAX_FINDINGS + 2);
    assert.equal(inspection.valid, 1);
    assert.equal(inspection.invalid, MAX_FINDINGS + 1);
    assert.equal(inspection.findings.length, MAX_FINDINGS);
    assert.equal(inspection.scanTruncated, false);
    assert.equal(inspection.findingsTruncated, true);

    await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(fixture.migrationsDirectory, '012_context_delivery_v4.sql'));
    const report = await runDoctor({
      databasePath: fixture.databasePath,
      migrationsDirectory: fixture.migrationsDirectory,
      runtimeDescriptorPath: path.join(path.dirname(fixture.migrationsDirectory), 'runtime.json'),
    });
    assert.equal(report.legacyDeliveries.findingsTruncated, true);
    assert.equal(report.legacyDeliveries.scanTruncated, false);
    assert.equal(report.checks.legacyDeliveries.ok, false);
    assert.equal(report.checks.legacyDeliveries.count, MAX_FINDINGS + 2);
    assert.match(report.checks.legacyDeliveries.detail ?? '', /findingsTruncated=true/u);
  } finally {
    fixture.database.close();
  }
});

test('migration 012 validates legacy scoped delivery accounting without changing identity or references', async () => {
  const directory = await temporaryDirectory('migration-012-context-delivery');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  const migrationFiles = await readdir(initialMigrations);
  for (let version = 1; version <= 11; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = migrationFiles.find((candidate) => candidate.startsWith(`${prefix}_`));
    assert.ok(name);
    await copyFile(path.join(initialMigrations, name), path.join(migrationsDirectory, name));
  }
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  const workspace = 'workspace:migration-012';
  const runId = 'run-migration-012';
  const sessionId = 'session-migration-012';
  const entryId = 'entry-migration-012';
  const createdAt = '2026-08-24T00:00:00.000Z';
  const profile = { taskType: 'build', target: 'migration', expected: 'current format', constraints: null } as const;
  const profileHash = canonicalContentHash(profile);
  const legacyProfileHash = canonicalContentHash({ ...profile, target: 'legacy caller supplied profile' });
  const queryHash = 'b'.repeat(64);
  const legacyDeliveryId = `context-${canonicalContentHash({ runId, queryHash })}`;
  try {
    assert.deepEqual(migrateDatabase(database, migrationsDirectory).applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    database.prepare(`
      INSERT INTO ledger_runs (
        run_id, workspace, client_kind, client_version, source_session_id, parent_run_id,
        protocol_version, capture_profile, coverage_json, status, title, task_hash,
        metadata_json, last_sequence, last_source_sequence, started_at, ended_at, created_at, updated_at
      ) VALUES (?, ?, 'generic', '1.0.0', NULL, NULL, '1', 'standard', ?, 'active', 'Migration 012', NULL, '{}', 0, NULL, ?, NULL, ?, ?)
    `).run(
      runId,
      workspace,
      canonicalJson({ approval: 'unavailable', command: 'unavailable', file: 'unavailable', run: 'declared', tool: 'unavailable' }),
      createdAt,
      createdAt,
      createdAt,
    );
    database.prepare(`
      INSERT INTO akinator_sessions (id, workspace, task_text, profile_json, status, question_count, created_at, updated_at)
      VALUES (?, ?, 'Migration 012', ?, 'ready', 0, ?, ?)
    `).run(sessionId, workspace, canonicalJson(profile), createdAt, createdAt);
    database.prepare(`
      INSERT INTO run_intakes (
        run_id, session_id, policy_version, profile_schema_version, profile_sources_json,
        initial_profile_hash, recommended_tags_json, linked_at, finalized_at
      ) VALUES (?, ?, 'v2', 1, ?, ?, ?, ?, ?)
    `).run(
      runId,
      sessionId,
      canonicalJson({ taskType: 'client_supplied', target: 'client_supplied', expected: 'client_supplied', constraints: 'client_supplied' }),
      profileHash,
      canonicalJson(['bot:builder', 'skill:tdd']),
      createdAt,
      createdAt,
    );
    const proposalEventId = 'proposal-migration-012';
    const proposal = {
      kind: 'lesson',
      title: 'Promoted migration proposal',
      body: 'A historical promotion reference must remain resolvable.',
      summary: null,
      scope: {},
      tags: [],
    } as const;
    new LedgerStore(database, { now: () => createdAt }).appendBatch(runId, {
      events: [{ eventId: proposalEventId, eventType: 'memory.proposed', actor: 'agent', occurredAt: createdAt, payload: proposal }],
    });
    recordEntry(database, {
      workspace,
      kind: 'lesson',
      status: 'verified',
      trustLevel: 'source_verified',
      confidence: 0.9,
      title: 'Migration delivery entry',
      body: 'Preserve this delivery while upgrading its identity.',
      createdBy: 'migration-test',
    }, { idFactory: () => entryId, now: createdAt });
    database.prepare(`
      INSERT INTO context_deliveries (
        delivery_id, run_id, through_sequence, intake_session_id, task_profile_hash, query_hash,
        policy_version, external_sync_summary_json, char_budget, char_count, truncated, created_at,
        score_schema_version
      ) VALUES (?, ?, 1, ?, ?, ?, 'context-ranking-v3', '{}', 1000, 52, 0, ?, 2)
    `).run(legacyDeliveryId, runId, sessionId, legacyProfileHash, queryHash, createdAt);
    database.prepare(`
      INSERT INTO context_delivery_entries (
        delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json, origin_scope
      ) VALUES (?, ?, 1, 1, ?, ?, 'project')
    `).run(
      legacyDeliveryId,
      entryId,
      canonicalJson({
        status: 100,
        trust: 25,
        confidence: 18,
        retrieval: 10,
        taskAffinity: 0,
        recommendedTags: 0,
        scopeAffinity: 9,
        applicability: 0,
        pathOverlap: 0,
        errorSignature: 0,
        exactSignal: 0,
        feedback: 0,
        recency: 0,
        contradiction: 0,
      }),
      canonicalJson(['project_origin', 'verified']),
    );
    database.prepare(`
      INSERT INTO context_feedback (
        feedback_id, delivery_id, entry_id, run_id, verdict, comment, actor, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, 'helpful', NULL, 'operator', ?, ?)
    `).run('feedback-migration-012', legacyDeliveryId, entryId, runId, 'c'.repeat(64), createdAt);
    database.prepare(`
      INSERT INTO ledger_memory_links (link_id, run_id, event_id, delivery_id, entry_id, created_at)
      VALUES (?, ?, NULL, ?, ?, ?)
    `).run('link-migration-012', runId, legacyDeliveryId, entryId, createdAt);
    database.prepare(`
      INSERT INTO ledger_purge_audit (
        purge_id, run_id, event_id, delivery_id, entry_id, target_type, target_id, actor, reason, created_at
      ) VALUES (?, ?, NULL, ?, NULL, 'delivery', ?, 'operator', 'migration test', ?)
    `).run('purge-migration-012', runId, legacyDeliveryId, legacyDeliveryId, createdAt);

    const promoted = promoteLedgerProposal(database, {
      workspace,
      runId,
      proposalEventId,
      deliveryId: legacyDeliveryId,
      actor: 'operator',
      createdAt,
      confirmed: true,
    });
    const promotionReference = promoted.entry.provenance.reference;
    assert.equal(typeof promotionReference, 'string');
    assert.equal(JSON.parse(promotionReference as string).deliveryId, legacyDeliveryId);

    const checkpoint = new CheckpointService(database, () => createdAt).checkpoint({
      runId,
      idempotencyKey: 'checkpoint-migration-012',
      request: {
        apiVersion: '1',
        contextFeedback: [{
          feedbackId: 'feedback-migration-012-checkpoint',
          deliveryId: legacyDeliveryId,
          entryId,
          verdict: 'helpful',
        }],
      },
    });
    assert.equal(checkpoint.acceptedThrough, 2);

    const standaloneFeedback = new FeedbackService(database, () => createdAt).feedback({
      runId,
      idempotencyKey: 'feedback-migration-012-standalone-key',
      request: {
        apiVersion: '1',
        category: 'context',
        feedbackId: 'feedback-migration-012-standalone',
        deliveryId: legacyDeliveryId,
        entryId,
        verdict: 'helpful',
      },
    });
    assert.equal((standaloneFeedback.record as { deliveryId: string }).deliveryId, legacyDeliveryId);
    assert.equal(new LedgerStore(database).verifyChain(runId), true);

    await copyFile(path.join(initialMigrations, '012_context_delivery_v4.sql'), path.join(migrationsDirectory, '012_context_delivery_v4.sql'));
    assert.deepEqual(migrateDatabase(database, migrationsDirectory).applied, [12]);
    const migrated = database.prepare(`
      SELECT delivery_id, task_profile_hash, policy_version, score_schema_version, char_budget, char_count, truncated
        FROM context_deliveries WHERE run_id = ?
    `).get<Record<string, unknown>>(runId);
    assert.ok(migrated);
    assert.equal(migrated.delivery_id, legacyDeliveryId);
    assert.equal(migrated.task_profile_hash, legacyProfileHash);
    assert.equal(migrated.policy_version, 'context-ranking-v3');
    assert.equal(migrated.score_schema_version, 2);
    assert.equal(migrated.char_count, 52);
    assert.equal(migrated.truncated, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_deliveries WHERE delivery_id = ?').get<{ count: number }>(legacyDeliveryId)?.count, 1);
    assert.equal(database.prepare('SELECT delivery_id FROM context_feedback WHERE feedback_id = ?').get<{ delivery_id: string }>('feedback-migration-012')?.delivery_id, legacyDeliveryId);
    assert.equal(database.prepare('SELECT delivery_id FROM ledger_memory_links WHERE link_id = ?').get<{ delivery_id: string }>('link-migration-012')?.delivery_id, legacyDeliveryId);
    assert.deepEqual(
      { ...database.prepare('SELECT delivery_id, target_id FROM ledger_purge_audit WHERE purge_id = ?').get('purge-migration-012') },
      { delivery_id: legacyDeliveryId, target_id: legacyDeliveryId },
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM context_feedback WHERE delivery_id = ?').get<{ count: number }>(legacyDeliveryId)?.count, 3);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_memory_links WHERE delivery_id = ?').get<{ count: number }>(legacyDeliveryId)?.count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM gateway_idempotency WHERE response_json LIKE ?').get<{ count: number }>(`%${legacyDeliveryId}%`)?.count, 1);
    const feedbackEvent = database.prepare(`
      SELECT payload_json FROM ledger_events WHERE run_id = ? AND event_type = 'context.feedback'
    `).get<{ payload_json: string }>(runId);
    assert.ok(feedbackEvent);
    assert.match(feedbackEvent.payload_json, new RegExp(legacyDeliveryId));
    const promotedReference = database.prepare(`
      SELECT r.provenance_json FROM entries AS e
      JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
      WHERE e.id = ?
    `).get<{ provenance_json: string }>(promoted.entry.id);
    assert.ok(promotedReference);
    assert.equal(JSON.parse(promotedReference.provenance_json).reference.includes(legacyDeliveryId), true);
    assert.equal(new LedgerStore(database).verifyChain(runId), true);
    assert.doesNotThrow(() => readContextDelivery(database, { workspace, deliveryId: legacyDeliveryId }));
  } finally {
    database.close();
  }
});

test('migration 009 preserves v8 knowledge sources and rolls back a failed upgrade atomically', async () => {
  const directory = await temporaryDirectory('migration-009-upgrade');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  const migrationFiles = await readdir(initialMigrations);
  for (let version = 1; version <= 8; version += 1) {
    const prefix = String(version).padStart(3, '0');
    const name = migrationFiles.find((candidate) => candidate.startsWith(`${prefix}_`));
    assert.ok(name);
    await copyFile(path.join(initialMigrations, name), path.join(migrationsDirectory, name));
  }
  const migration009 = await readFile(path.join(initialMigrations, '009_external_skill_discovery.sql'), 'utf8');
  const migration009Path = path.join(migrationsDirectory, '009_external_skill_discovery.sql');
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  const expectedKnowledgeSource = {
    source_id: 'legacy-knowledge-source',
    repository_url: 'https://github.com/example/legacy-knowledge.git',
    ref_name: 'release/v8',
    commit_sha: '0123456789abcdef0123456789abcdef01234567',
    document_count: 7,
    last_synced_at: '2026-08-23T01:02:03.000Z',
  };
  const expectedKnowledgeSources = [expectedKnowledgeSource];
  const knowledgeSources = () => connection.prepare(`
    SELECT source_id, repository_url, ref_name, commit_sha, document_count, last_synced_at
    FROM knowledge_sources
    ORDER BY source_id
  `).all<Record<string, unknown>>().map((row) => ({ ...row }));

  try {
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [1, 2, 3, 4, 5, 6, 7, 8]);
    connection.prepare(`
      INSERT INTO knowledge_sources (
        source_id, repository_url, ref_name, commit_sha, document_count, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      expectedKnowledgeSource.source_id,
      expectedKnowledgeSource.repository_url,
      expectedKnowledgeSource.ref_name,
      expectedKnowledgeSource.commit_sha,
      expectedKnowledgeSource.document_count,
      expectedKnowledgeSource.last_synced_at,
    );
    assert.deepEqual(knowledgeSources(), expectedKnowledgeSources);

    await writeFile(
      migration009Path,
      `${migration009}\nSELECT missing_column FROM migration_009_forced_failure;\n`,
    );
    assert.throws(() => migrateDatabase(connection, migrationsDirectory), /migration_009_forced_failure|no such table/i);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 8);
    for (const table of ['external_skill_generation_clock', 'external_skill_generation_tokens', 'external_skills', 'external_skill_entries', 'skill_discovery_cache', 'skill_source_failure_cache', 'skill_audit_failure_cache', 'agent_task_skill_discovery_attempts', 'entry_revision_hash_format']) {
      assert.equal(
        connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        undefined,
        `${table} survived the failed migration`,
      );
    }
    assert.deepEqual(knowledgeSources(), expectedKnowledgeSources);
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);

    await writeFile(migration009Path, migration009);
    assert.deepEqual(migrateDatabase(connection, migrationsDirectory).applied, [9]);
    assert.deepEqual(knowledgeSources(), expectedKnowledgeSources);
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, 9);
    for (const table of ['external_skill_generation_clock', 'external_skill_generation_tokens', 'external_skills', 'external_skill_entries', 'skill_discovery_cache', 'skill_source_failure_cache', 'skill_audit_failure_cache', 'agent_task_skill_discovery_attempts', 'entry_revision_hash_format']) {
      assert.equal(
        connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get<{ present: number }>(table)?.present,
        1,
        `missing ${table}`,
      );
    }

    const token = connection.prepare('INSERT INTO external_skill_generation_tokens DEFAULT VALUES RETURNING generation').get<{ generation: number }>();
    assert.equal(token?.generation, 1);
    connection.prepare('UPDATE external_skill_generation_clock SET value = ? WHERE singleton = 1').run(token!.generation);
    connection.prepare(`
      INSERT INTO external_skills (
        skill_id, provider, source_type, source_locator, slug, name, install_url,
        official_status, duplicate, installs, state, source_workspace,
        first_seen_at, last_seen_at, last_checked_at, generation
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      'github:example/skills:test',
      'fixture',
      'github',
      'example/skills',
      'test',
      'Test Skill',
      'unknown',
      'discovered',
      'external-skills:example/skills',
      '2026-08-23T01:02:03.000Z',
      '2026-08-23T01:02:03.000Z',
      '2026-08-23T01:02:03.000Z',
      1,
    );
    assert.throws(() => connection.prepare(`
      INSERT INTO external_skill_entries (
        skill_id, source_path, chunk_index, entry_id, entry_revision,
        content_hash, primary_document, active, imported_at
      ) VALUES (?, ?, 0, ?, 1, ?, 1, 1, ?)
    `).run(
      'github:example/skills:test',
      'skills/test/SKILL.md',
      'missing-entry',
      'a'.repeat(64),
      '2026-08-23T01:02:03.000Z',
    ), /foreign key/i);
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(knowledgeSources(), expectedKnowledgeSources);
  } finally {
    connection.close();
  }
});

test('rejects a database created by a newer migration set without changing it', async () => {
  const directory = await temporaryDirectory('future-version');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await writeFile(path.join(migrationsDirectory, '001_initial.sql'), 'CREATE TABLE future_fixture (id INTEGER PRIMARY KEY);\n');
  const databasePath = path.join(directory, 'data.sqlite3');
  const connection = openConnection(databasePath);
  try {
    migrateDatabase(connection, migrationsDirectory);
    connection.prepare(`
      INSERT INTO schema_migrations (version, name, checksum, applied_at)
      VALUES (2, '002_from_the_future.sql', ?, ?)
    `).run('f'.repeat(64), '2026-08-21T00:00:00.000Z');
    const before = connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count;
    assert.throws(
      () => migrateDatabase(connection, migrationsDirectory),
      (error: unknown) => (error as { code?: string }).code === 'INTEGRITY_ERROR' && /newer/i.test((error as Error).message),
    );
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count, before);
  } finally {
    connection.close();
  }
});

test('rolls back the complete migration when SQL fails', async () => {
  const directory = await temporaryDirectory('rollback');
  const migrationsDirectory = path.join(directory, 'migrations');
  await mkdir(migrationsDirectory);
  await writeFile(
    path.join(migrationsDirectory, '001_broken.sql'),
    'CREATE TABLE should_rollback (id INTEGER PRIMARY KEY);\nSELECT missing_column FROM missing_table;\n',
  );
  const connection = openConnection(path.join(directory, 'data.sqlite3'));
  try {
    assert.throws(() => migrateDatabase(connection, migrationsDirectory), /missing_table|no such/i);
    assert.equal(
      connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get(),
      undefined,
    );
    assert.equal(
      connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get(),
      undefined,
    );
  } finally {
    connection.close();
  }
});

test('concurrent processes initialize one migration exactly once', async () => {
  const directory = await temporaryDirectory('concurrent');
  const databasePath = path.join(directory, 'data.sqlite3');
  const script = `
    import { openConnection } from './src/db/connection.ts';
    import { migrateDatabase } from './src/db/migrate.ts';
    const connection = openConnection(process.env.KIOKUKO_DATABASE);
    try { migrateDatabase(connection, process.env.KIOKUKO_MIGRATIONS); } finally { connection.close(); }
  `;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      execFileAsync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            KIOKUKO_DATABASE: databasePath,
            KIOKUKO_MIGRATIONS: initialMigrations,
          },
        },
      ),
    ),
  );

  const connection = openConnection(databasePath);
  try {
    assert.equal(
      connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get<{ count: number }>()?.count,
      CURRENT_SCHEMA_VERSION,
    );
  } finally {
    connection.close();
  }
});

test('migration assets are package-relative and checksumable as files', async () => {
  const sql = await readFile(path.join(initialMigrations, '001_initial.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE repositories/);
});
