import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCapabilityCatalog } from '../../src/akinator/capability-binding.js';
import { KiokukoError } from '../../src/errors.js';
import type { ContextBroker } from '../../src/context/broker.js';
import type { AgentRouteContext } from '../../src/server/routes/agent-runs.js';
import { createTask5Route } from '../../src/server/routes/task5.js';

const SOUL_CAPABILITIES = [{ kind: 'skill', name: 'kiokuko-soul' }] as const;

function routeContext(failure: unknown, taskType: unknown = 'build', intakeStatus: unknown = 'ready'): AgentRouteContext {
  return {
    broker: {
      async queryGated(): Promise<never> {
        throw failure;
      },
    } as unknown as ContextBroker,
    checkpointService: {
      async checkpoint() {
        return {
          characterBudget: 8_000,
          intakeStatus,
          taskProfile: {
            taskType,
            target: 'src/server/routes/task5.ts',
            expected: 'tests pass',
            constraints: null,
            source: 'akinator+ledger-revisions',
          },
        };
      },
      deliverNudge() {
        return null;
      },
    },
    service: {
      readRun() {
        return { title: 'Build the broker route', status: 'active', lastSequence: 1, metadata: bindCapabilityCatalog({}, undefined) };
      },
    },
    enqueueWrite: async <T>(operation: () => T | PromiseLike<T>): Promise<T> => operation(),
  } as unknown as AgentRouteContext;
}

const brokerFailures = () => [
  new KiokukoError('INTEGRITY_ERROR', 'broker integrity failure'),
  new TypeError('broker programmer failure'),
];

test('checkpoint enrichment propagates broker integrity and programmer failures unchanged', async () => {
  for (const failure of brokerFailures()) {
    const route = createTask5Route(routeContext(failure));
    await assert.rejects(
      async () => route({
        method: 'POST',
        url: new URL('http://127.0.0.1/api/v1/agent/runs/run-fail-close/checkpoints'),
        headers: { 'idempotency-key': 'checkpoint-fail-close' },
        rawHeaders: ['Idempotency-Key', 'checkpoint-fail-close'],
        body: { apiVersion: '1' },
      }),
      (error: unknown) => error === failure,
    );
  }
});

test('checkpoint enrichment ignores stale acknowledgement profile fields and uses the broker snapshot', async () => {
  const brokerResult = {
    status: 'ready',
    taskProfile: { taskType: 'build', target: 'src/server/routes/task5.ts', expected: 'tests pass', constraints: null },
    profileHash: 'a'.repeat(64),
    acceptedThrough: 1,
    intakeSessionId: 'intake-current',
    recommendedTags: [],
    projection: { current: true },
    context: null,
    recommendations: [],
  };
  const context = {
    broker: {
      async queryGated(_input: unknown, decide: (candidate: any) => { persist: boolean; value: unknown }) {
        const decision = decide(brokerResult);
        return { broker: brokerResult, value: decision.value };
      },
    },
    checkpointService: {
      async checkpoint() {
        return {
          characterBudget: 8_000,
          intakeStatus: 'active',
          taskProfile: {
            taskType: 'deployment',
            target: 'src/server/routes/task5.ts',
            expected: 'tests pass',
            constraints: null,
            source: 'akinator+ledger-revisions',
          },
        };
      },
      deliverNudge() {
        return null;
      },
    },
    service: {
      readRun() {
        return { title: 'Build the broker route', status: 'active', lastSequence: 1, metadata: bindCapabilityCatalog({}, SOUL_CAPABILITIES) };
      },
    },
    database: {
      prepare() {
        return { get: () => ({ count: 0 }) };
      },
    },
    enqueueWrite: async <T>(operation: () => T | PromiseLike<T>): Promise<T> => operation(),
  } as unknown as AgentRouteContext;
  const route = createTask5Route(context);
  const response = await route({
    method: 'POST',
    url: new URL('http://127.0.0.1/api/v1/agent/runs/run-current/checkpoints'),
    headers: { 'idempotency-key': 'checkpoint-current' },
    rawHeaders: ['Idempotency-Key', 'checkpoint-current'],
    body: { apiVersion: '1', capabilities: SOUL_CAPABILITIES },
  }) as any;

  assert.equal(response.data.intakeStatus, 'ready');
  assert.equal(response.data.taskProfile.taskType, 'build');
  assert.equal(response.data.profileHash, brokerResult.profileHash);
  assert.deepEqual(response.data.projection, brokerResult.projection);
  assert.equal(response.data.nextAction, 'proceed');
});

test('checkpoint exact replay rejects a terminal run before invoking the stale mutation acknowledgement', async () => {
  let checkpointCalled = false;
  let brokerCalled = false;
  const context = {
    service: {
      readRun() {
        return { title: 'Closed run', status: 'completed', lastSequence: 2, metadata: bindCapabilityCatalog({}, []) };
      },
    },
    checkpointService: {
      checkpoint() {
        checkpointCalled = true;
        throw new Error('checkpoint must not run');
      },
    },
    broker: {
      queryGated() {
        brokerCalled = true;
        throw new Error('broker must not run');
      },
    },
    enqueueWrite: async <T>(operation: () => T | PromiseLike<T>): Promise<T> => operation(),
  } as unknown as AgentRouteContext;
  const route = createTask5Route(context);
  await assert.rejects(async () => route({
    method: 'POST',
    url: new URL('http://127.0.0.1/api/v1/agent/runs/run-terminal/checkpoints'),
    headers: { 'idempotency-key': 'checkpoint-terminal' },
    rawHeaders: ['Idempotency-Key', 'checkpoint-terminal'],
    body: { apiVersion: '1', capabilities: [] },
  }), (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT');
  assert.equal(checkpointCalled, false);
  assert.equal(brokerCalled, false);
});

test('checkpoint preserves exhausted intake and does not apply the ready-only memory-reasoning gate', async () => {
  let persistRequested: boolean | undefined;
  const brokerResult = {
    status: 'exhausted',
    taskProfile: { taskType: 'build', target: null, expected: null, constraints: null },
    profileHash: 'a'.repeat(64),
    acceptedThrough: 1,
    intakeSessionId: 'intake-exhausted',
    recommendedTags: [],
    projection: { current: true },
    context: null,
    recommendations: [],
  };
  const context = {
    broker: {
      async queryGated(_input: unknown, decide: (candidate: any) => { persist: boolean; value: unknown }) {
        const decision = decide(brokerResult);
        persistRequested = decision.persist;
        return { broker: brokerResult, value: decision.value };
      },
    },
    checkpointService: {
      async checkpoint() {
        return {
          characterBudget: 8_000,
          intakeStatus: 'exhausted',
          taskProfile: {
            taskType: 'build',
            target: null,
            expected: null,
            constraints: null,
            source: 'akinator+ledger-revisions',
          },
        };
      },
      deliverNudge() {
        return null;
      },
    },
    service: {
      readRun() {
        return { title: 'Build the broker route', status: 'active', lastSequence: 1, metadata: bindCapabilityCatalog({}, SOUL_CAPABILITIES) };
      },
    },
    database: {},
    enqueueWrite: async <T>(operation: () => T | PromiseLike<T>): Promise<T> => operation(),
  } as unknown as AgentRouteContext;
  const route = createTask5Route(context);
  const response = await route({
    method: 'POST',
    url: new URL('http://127.0.0.1/api/v1/agent/runs/run-exhausted/checkpoints'),
    headers: { 'idempotency-key': 'checkpoint-exhausted' },
    rawHeaders: ['Idempotency-Key', 'checkpoint-exhausted'],
    body: { apiVersion: '1', capabilities: SOUL_CAPABILITIES },
  }) as any;

  assert.equal(persistRequested, true);
  assert.equal(response.data.intakeStatus, 'exhausted');
  assert.equal(response.data.nextAction, 'proceed');
  assert.equal(response.data.context, null);
  assert.equal(response.data.capabilities.recommendations.some((item: { name: string }) => item.name === 'memory-reasoning'), false);
});
