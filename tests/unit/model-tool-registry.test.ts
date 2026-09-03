import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MODEL_TOOL_CONTRACTS,
  MODEL_TOOL_OPERATION_NAMES,
  type ModelToolOperationName,
} from '../../src/model-tools/contracts.js';
import {
  MODEL_TOOL_REGISTRY,
  modelFacingInputSchema,
  modelToolContract,
} from '../../src/model-tools/registry.js';

test('model tool registry contains the exact transport-neutral operation set', () => {
  assert.equal(MODEL_TOOL_CONTRACTS.length, 14);
  assert.deepEqual(
    MODEL_TOOL_CONTRACTS.map((contract) => contract.name),
    [...MODEL_TOOL_OPERATION_NAMES],
  );
  assert.equal(new Set(MODEL_TOOL_CONTRACTS.map((contract) => contract.name)).size, 14);
  assert.equal(Object.keys(MODEL_TOOL_REGISTRY).length, 14);
  for (const name of MODEL_TOOL_OPERATION_NAMES) {
    assert.equal(modelToolContract(name).owner, 'kiokuko-core');
  }
});

test('model-facing projections exclude host-owned identity and execution fields', () => {
  const hostOwned = new Set([
    'runId',
    'workspace',
    'orchestrationId',
    'resumeToken',
    'expectedRevision',
    'idempotencyKey',
    'leaseToken',
    'routeEpoch',
  ]);

  for (const name of MODEL_TOOL_OPERATION_NAMES) {
    const contract = modelToolContract(name);
    const schema = modelFacingInputSchema(name);
    const properties = schema.properties;
    const propertyNames = typeof properties === 'object' && properties !== null && !Array.isArray(properties)
      ? Object.keys(properties)
      : [];
    assert.deepEqual(
      propertyNames.filter((property) => hostOwned.has(property)),
      [],
      `${name} exposes host-owned identity fields`,
    );
    for (const field of contract.hostOwnedFields) assert.equal(propertyNames.includes(field), false, `${name}.${field}`);
  }

  assert.deepEqual(
    Object.keys(modelFacingInputSchema('enno_work_report').properties as object),
    ['result'],
  );
  assert.deepEqual(
    Object.keys(modelFacingInputSchema('enno_finish').properties as object),
    ['advisoryDisposition', 'review'],
  );
});

test('host-only operations have no model-facing input properties', () => {
  const hostOnly: readonly ModelToolOperationName[] = [
    'task_prepare',
    'task_answer',
    'enno_advice_submit',
    'enno_advice_read',
    'enno_answer',
    'enno_verify_prepare',
    'curator_globalize',
  ];
  for (const name of hostOnly) {
    const properties = modelFacingInputSchema(name).properties;
    assert.deepEqual(properties, {}, `${name} must remain host-only`);
  }
});
