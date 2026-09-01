import assert from 'node:assert/strict';
import test from 'node:test';
import {
  databaseBackupIntegrityError,
  KiokukoError,
  exitCodeFor,
  storedMemoryIntegrityError,
  type ErrorCode,
} from '../../src/errors.js';
import { errorEnvelope, successEnvelope } from '../../src/serialization/envelope.js';

const legacyExitCodes: Array<[ErrorCode, number]> = [
  ['USAGE_ERROR', 2],
  ['VALIDATION_ERROR', 3],
  ['NOT_FOUND', 4],
  ['CONFLICT', 5],
  ['DATABASE_ERROR', 6],
  ['SECURITY_REJECTION', 7],
  ['INTEGRITY_ERROR', 8],
  ['PARTIAL_FAILURE', 9],
  ['NOT_IMPLEMENTED', 2],
];

test('preserves the existing success and error JSON envelope shapes', () => {
  assert.deepEqual(successEnvelope('recall', { items: [] }, { count: 0 }), {
    apiVersion: '1',
    ok: true,
    operation: 'recall',
    data: { items: [] },
    meta: { count: 0 },
  });
  assert.deepEqual(errorEnvelope('record', new KiokukoError('VALIDATION_ERROR', 'invalid input', { field: 'title' })), {
    apiVersion: '1',
    ok: false,
    operation: 'record',
    error: {
      code: 'VALIDATION_ERROR',
      message: 'invalid input',
      details: { field: 'title' },
    },
  });
});

test('redacts arbitrary errors from the public JSON envelope', () => {
  const sentinel = 'token=private-sentinel /Users/example/private/database.sqlite3';
  const envelope = errorEnvelope('skills.list', new Error(sentinel));

  assert.deepEqual(envelope, {
    apiVersion: '1',
    ok: false,
    operation: 'skills.list',
    error: {
      code: 'INTEGRITY_ERROR',
      message: 'Unexpected internal error',
      details: {},
    },
  });
  assert.equal(JSON.stringify(envelope).includes(sentinel), false);
});

test('provides recovery guidance for stored memory and backup integrity failures', () => {
  const memory = errorEnvelope('setup', storedMemoryIntegrityError());
  assert.match(memory.error.message, /could not automatically recover existing saved memory/u);
  assert.match(memory.error.message, /setup creates one automatically/u);
  assert.match(memory.error.message, /move the current database and any -wal, -shm, or -journal sidecar files aside/u);
  assert.match(memory.error.message, /cp .*<new-backup\.sqlite3>/u);
  assert.match(memory.error.message, /kiokuko setup/u);
  assert.match(memory.error.message, /-wal, -shm, or -journal/u);
  assert.match(memory.error.message, /Do not delete database rows manually/u);

  const backup = errorEnvelope('backup', databaseBackupIntegrityError(new Error('private cause')));
  assert.match(backup.error.message, /source database was not changed/u);
  assert.match(backup.error.message, /Node\.js is version 24\.16\.0 or newer/u);
  assert.equal(JSON.stringify(backup).includes('private cause'), false);
});

test('preserves every existing CLI exit-code mapping when server errors are added', () => {
  for (const [code, expected] of legacyExitCodes) {
    assert.equal(exitCodeFor(new KiokukoError(code, 'test')), expected, code);
  }
  assert.equal(exitCodeFor(new Error('unexpected')), 8);
});
