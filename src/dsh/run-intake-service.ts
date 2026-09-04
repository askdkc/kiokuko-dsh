import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { executeIdempotentInTransaction } from './intake-idempotency.js';
import { sanitizeAnswer, sanitizeRunMetadata, sanitizeTask } from '../ledger/redaction.js';
import { validateTimestamp } from '../ledger/validate.js';
import {
  CAPTURE_PROFILES,
  COVERAGE_LEVELS,
  MAX_ID_LENGTH,
  type CaptureProfile,
  type Coverage,
  type JsonObject,
  type JsonValue,
  type LedgerEventInput,
  type LedgerEventType,
  type RunStatus,
  type TaskInput,
} from '../ledger/types.js';
import { LedgerStore } from '../ledger/store.js';
import { AKINATOR_POLICY_VERSION, profileHash } from '../akinator/domain.js';
import {
  answerAkinatorInTransaction,
  startAkinatorInTransaction,
} from '../akinator/service.js';
import {
  finalizeRunIntakeLink,
  insertRunIntakeLink,
  markRunIntakeProfileSource,
  readRunIntakeLink,
  type AkinatorProfileSources,
} from '../akinator/store.js';
import type { TaskProfile } from '../akinator/types.js';
import type { RunRecord } from '../ledger/types.js';
import {
  assertCapabilityCatalogBinding,
  bindCapabilityCatalog,
  capabilityCatalogDigest,
} from '../akinator/capability-binding.js';
import { containsDisallowedTextCharacters, normalizeTextLineEndings } from '../serialization/validate.js';

const PROFILE_FIELDS = ['taskType', 'target', 'expected', 'constraints'] as const;

type DshRunOpenRequest = {
  apiVersion: '1';
  workspace: string;
  task: TaskInput;
  captureProfile: CaptureProfile;
  coverage: Coverage;
  metadata: JsonObject;
  capabilities?: JsonValue;
  parentRunId?: string;
  startedAt?: string;
};

export interface DshRunIntakeResponse {
  runId: string;
  runStatus: RunStatus;
  intakeSessionId: string;
}

export interface DshRunIntakeServiceOptions {
  readonly now?: () => string;
  readonly home?: string;
  readonly runIdFactory?: () => string;
  readonly sessionIdFactory?: () => string;
  readonly eventIdFactory?: () => string;
  readonly onRunCreatedInTransaction?: (input: {
    readonly database: SqliteDatabase;
    readonly runId: string;
    readonly workspace: string;
    readonly dshSessionId: string;
    readonly now: string;
  }) => void;
}

interface DshRunAnswerOptions {
  readonly assertBeforeAnswer?: () => void;
}

function validation(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Invalid DSH run intake request');
}

function conflict(message = 'DSH run intake operation conflicts with the current run state'): never {
  throw new KiokukoError('CONFLICT', message);
}

function notFound(): never {
  throw new KiokukoError('NOT_FOUND', 'Ledger run not found');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isCanonicalArrayIndex(value: string): boolean {
  if (value === '0') return true;
  if (!/^[1-9]\d*$/u.test(value)) return false;
  const index = Number(value);
  return Number.isSafeInteger(index) && index < 4_294_967_295 && String(index) === value;
}

function assertJsonValue(value: unknown, ancestors = new WeakSet<object>()): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) validation();
    return;
  }
  if (typeof value !== 'object' || ancestors.has(value)) validation();
  ancestors.add(value);
  try {
    let keys: PropertyKey[];
    try {
      keys = Reflect.ownKeys(value);
    } catch {
      validation();
    }
    if (Array.isArray(value)) {
      for (const key of keys) {
        if (typeof key !== 'string' || (key !== 'length' && !isCanonicalArrayIndex(key))) validation();
      }
      for (const item of value) assertJsonValue(item, ancestors);
    } else {
      if (!isPlainObject(value)) validation();
      for (const key of keys) if (typeof key !== 'string') validation();
      for (const key of Object.keys(value)) assertJsonValue(value[key], ancestors);
    }
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    validation();
  } finally {
    ancestors.delete(value);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) validation();
  return value;
}

function jsonObject(value: unknown): JsonObject {
  assertJsonValue(value);
  if (!isPlainObject(value)) validation();
  return value as JsonObject;
}

function jsonResult<T>(value: T): JsonValue {
  assertJsonValue(value);
  return value as unknown as JsonValue;
}

function typedResult<T>(value: JsonValue): T {
  return value as unknown as T;
}

function executeIdempotentDshOperation<T>(database: SqliteDatabase, input: unknown, operation: () => T): T {
  return typedResult<T>(executeIdempotentInTransaction(database, input, () => jsonResult(operation())));
}

function knownFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((field) => !set.has(field))) validation();
}

function boundedString(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || containsDisallowedTextCharacters(value, multiline)) validation();
  return multiline ? normalizeTextLineEndings(value) : value;
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) validation();
  return value as T[number];
}

function nullableString(value: unknown, max: number, multiline = false): string | null {
  if (value === null) return null;
  return boundedString(value, max, multiline);
}

function optionalString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, max);
}

function profileHints(value: unknown): TaskInput['profileHints'] {
  if (value === undefined) return { taskType: null, target: null, expected: null, constraints: null };
  const input = object(value);
  knownFields(input, PROFILE_FIELDS);
  const taskType = input.taskType === undefined || input.taskType === null
    ? null
    : enumValue(input.taskType, ['build', 'debug', 'research', 'review', 'devops', 'writing', 'analysis', 'chat'] as const);
  const target = input.target === undefined ? null : nullableString(input.target, 16 * 1024);
  const expected = input.expected === undefined ? null : nullableString(input.expected, 16 * 1024, true);
  const constraints = input.constraints === undefined ? null : nullableString(input.constraints, 16 * 1024, true);
  return { taskType, target, expected, constraints };
}

function normalizeOpenRequest(value: unknown): DshRunOpenRequest {
  assertJsonValue(value);
  const input = object(value);
  knownFields(input, ['apiVersion', 'workspace', 'task', 'captureProfile', 'coverage', 'metadata', 'capabilities', 'parentRunId', 'startedAt']);
  if (input.apiVersion !== '1') validation();
  const workspace = boundedString(input.workspace, 16 * 1024);

  const taskInput = object(input.task);
  knownFields(taskInput, ['title', 'query', 'profileHints']);
  const task: TaskInput = {
    title: boundedString(taskInput.title, 16 * 1024, true),
    query: boundedString(taskInput.query, 16 * 1024, true),
    profileHints: profileHints(taskInput.profileHints),
  };

  const coverageInput = object(input.coverage);
  const coverageFields = ['run', 'tool', 'command', 'file', 'approval'] as const;
  knownFields(coverageInput, coverageFields);
  const coverage = {} as Coverage;
  for (const field of coverageFields) coverage[field] = enumValue(coverageInput[field], COVERAGE_LEVELS);

  const metadataValue = input.metadata === undefined ? {} : object(input.metadata);
  assertJsonValue(metadataValue);
  const metadata = metadataValue as JsonObject;
  const startedAt = optionalString(input.startedAt, 64);
  if (startedAt !== undefined) validateTimestamp(startedAt, 'startedAt');
  return {
    apiVersion: '1',
    workspace,
    task,
    captureProfile: enumValue(input.captureProfile, CAPTURE_PROFILES),
    coverage,
    metadata,
    ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities as JsonValue }),
    ...(input.parentRunId === undefined ? {} : { parentRunId: boundedString(input.parentRunId, MAX_ID_LENGTH) }),
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

function operationEnvelope(value: unknown): { idempotencyKey: string; dshSessionId: string; request: unknown } {
  assertJsonValue(value);
  const input = object(value);
  knownFields(input, ['idempotencyKey', 'dshSessionId', 'request']);
  return {
    idempotencyKey: boundedString(input.idempotencyKey, 256),
    dshSessionId: boundedString(input.dshSessionId, MAX_ID_LENGTH),
    request: input.request,
  };
}

function runEnvelope(value: unknown): { runId: string; idempotencyKey: string; request: unknown } {
  assertJsonValue(value);
  const input = object(value);
  knownFields(input, ['runId', 'idempotencyKey', 'request']);
  return {
    runId: boundedString(input.runId, MAX_ID_LENGTH),
    idempotencyKey: boundedString(input.idempotencyKey, 256),
    request: input.request,
  };
}

function answerRequest(value: unknown, workspace: string): {
  value: { apiVersion: '1'; questionId: string; value: string };
  capabilities?: JsonValue;
  hashRequest: JsonObject;
} {
  assertJsonValue(value);
  const input = object(value);
  knownFields(input, ['apiVersion', 'questionId', 'value', 'capabilities']);
  if (input.apiVersion !== '1') validation();
  const questionId = boundedString(input.questionId, MAX_ID_LENGTH);
  if (typeof input.value !== 'string') validation();
  const sanitized = sanitizeAnswer({ apiVersion: '1', questionId, value: input.value }, { workspace });
  if (typeof sanitized.value.value !== 'string') validation();
  const normalized = sanitized.value;
  const answer = { apiVersion: '1' as const, questionId: normalized.questionId, value: normalized.value as string };
  const capabilities = input.capabilities as JsonValue | undefined;
  return {
    value: answer,
    ...(capabilities === undefined ? {} : { capabilities }),
    hashRequest: jsonObject({
      ...answer,
      capabilityCatalogDigest: capabilityCatalogDigest(capabilities),
    }),
  };
}

function sourceMap(request: DshRunOpenRequest, profile: TaskProfile): AkinatorProfileSources {
  const sources: AkinatorProfileSources = {};
  const hints = request.task.profileHints;
  for (const field of PROFILE_FIELDS) {
    const supplied = hints[field];
    if (supplied !== null && supplied !== undefined) {
      sources[field] = 'client_supplied';
    } else if (field === 'taskType' && profile.taskType !== null) {
      sources[field] = 'inferred';
    }
  }
  return sources;
}

/**
 * DSH run intake: opens ledger runs bound to the authoritative DSH session
 * identity and drives the Akinator intake lifecycle to a ready state.
 */
export class DshRunIntakeService {
  private readonly options: DshRunIntakeServiceOptions;

  constructor(
    private readonly database: SqliteDatabase,
    options: DshRunIntakeServiceOptions = {},
  ) {
    this.options = options;
  }

  openRun(input: unknown): DshRunIntakeResponse {
    const envelope = operationEnvelope(input);
    const request = normalizeOpenRequest(envelope.request);
    const dshSessionId = envelope.dshSessionId;
    const task = sanitizeTask(request.task, { workspace: request.workspace, ...(this.options.home === undefined ? {} : { home: this.options.home }) }).value;
    const metadata = sanitizeRunMetadata(
      bindCapabilityCatalog(request.metadata, request.capabilities),
      { workspace: request.workspace, ...(this.options.home === undefined ? {} : { home: this.options.home }) },
    ).value as JsonObject;
    const hashRequest = jsonObject({
      apiVersion: '1',
      workspace: request.workspace,
      dshSessionId,
      task,
      captureProfile: request.captureProfile,
      coverage: request.coverage,
      metadata,
      ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
      ...(request.startedAt === undefined ? {} : { startedAt: request.startedAt }),
    });
    const now = this.currentTime();
    return withImmediateTransaction(this.database, () => executeIdempotentDshOperation(
      this.database,
      { scope: 'dsh.run.open', key: envelope.idempotencyKey, request: hashRequest, createdAt: now },
      () => {
        const runId = this.nextRunId();
        const sessionId = this.nextSessionId();
        const store = this.ledgerStore(request.workspace);
        const run = store.createRunInTransaction({
          runId,
          workspace: request.workspace,
          dshSessionId,
          protocolVersion: '1',
          captureProfile: request.captureProfile,
          coverage: request.coverage,
          task,
          metadata,
          ...(request.parentRunId === undefined ? {} : { parentRunId: request.parentRunId }),
          ...(request.startedAt === undefined ? {} : { startedAt: request.startedAt }),
        }, now);
        this.options.onRunCreatedInTransaction?.({
          database: this.database,
          runId,
          workspace: request.workspace,
          dshSessionId,
          now,
        });
        const result = startAkinatorInTransaction(this.database, {
          workspace: request.workspace,
          task: task.query,
          profileHints: task.profileHints,
          now,
          idFactory: () => sessionId,
        });
        insertRunIntakeLink(this.database, {
          runId,
          sessionId,
          workspace: request.workspace,
          policyVersion: AKINATOR_POLICY_VERSION,
          profileSchemaVersion: 1,
          profileSources: sourceMap(request, result.session.profile),
          initialProfileHash: null,
          recommendedTags: result.recommendedTags,
          linkedAt: now,
          finalizedAt: null,
        });
        const lifecycle: LedgerEventInput[] = [this.lifecycleEvent('intake.started', {
          intakeSessionId: sessionId,
          status: result.status,
          missingFields: result.missingFields,
        }, now)];
        let finalRun = run;
        if (result.status === 'ready' || result.status === 'exhausted') {
          lifecycle.push(this.lifecycleEvent(result.status === 'ready' ? 'intake.ready' : 'intake.exhausted', {
            profile: result.session.profile,
            profileHash: profileHash(result.session.profile),
            recommendedTags: result.recommendedTags,
            missingFields: result.missingFields,
          }, now));
          lifecycle.push(this.lifecycleEvent('run.started', {
            intakeStatus: result.status,
            profileHash: profileHash(result.session.profile),
            recommendedTags: result.recommendedTags,
          }, now));
        }
        store.appendBatchInTransaction(runId, { events: lifecycle });
        if (result.status === 'ready' || result.status === 'exhausted') {
          finalizeRunIntakeLink(this.database, {
            workspace: request.workspace,
            runId,
            profileHash: profileHash(result.session.profile),
            recommendedTags: result.recommendedTags,
            finalizedAt: now,
          });
          finalRun = store.updateRunStatusInTransaction(runId, 'active', now);
        }
        return { runId, runStatus: finalRun.status, intakeSessionId: sessionId };
      },
    ));
  }

  answerIntake(input: unknown, options: DshRunAnswerOptions = {}): DshRunIntakeResponse {
    const envelope = runEnvelope(input);
    const initialRun = this.requireRun(envelope.runId);
    const request = answerRequest(envelope.request, initialRun.workspace);
    assertCapabilityCatalogBinding(initialRun.metadata, request.capabilities);
    const now = this.currentTime();
    return withImmediateTransaction(this.database, () => {
      options.assertBeforeAnswer?.();
      return executeIdempotentDshOperation(
        this.database,
        { scope: this.scopedOperation('answer', envelope.runId), key: envelope.idempotencyKey, request: request.hashRequest, createdAt: now },
        () => {
          const run = this.requireRun(envelope.runId);
          const link = readRunIntakeLink(this.database, { workspace: run.workspace, runId: run.runId });
          const mutation = answerAkinatorInTransaction(this.database, {
            workspace: run.workspace,
            sessionId: link.sessionId,
            questionId: request.value.questionId as keyof TaskProfile,
            value: request.value.value,
            now,
          });
          if (mutation.replayed) {
            const currentRun = this.requireRun(run.runId);
            return { runId: run.runId, runStatus: currentRun.status, intakeSessionId: link.sessionId };
          }
          if (run.status !== 'intake') conflict('Run is not waiting for intake');
          markRunIntakeProfileSource(this.database, {
            workspace: run.workspace,
            runId: run.runId,
            field: request.value.questionId as keyof TaskProfile,
          });
          const events: LedgerEventInput[] = [this.lifecycleEvent('intake.answered', {
            questionId: request.value.questionId,
            value: request.value.value,
          }, now)];
          if (mutation.result.status === 'ready' || mutation.result.status === 'exhausted') {
            events.push(this.lifecycleEvent(mutation.result.status === 'ready' ? 'intake.ready' : 'intake.exhausted', {
              profile: mutation.result.session.profile,
              profileHash: profileHash(mutation.result.session.profile),
              recommendedTags: mutation.result.recommendedTags,
              missingFields: mutation.result.missingFields,
            }, now));
            events.push(this.lifecycleEvent('run.started', {
              intakeStatus: mutation.result.status,
              profileHash: profileHash(mutation.result.session.profile),
              recommendedTags: mutation.result.recommendedTags,
            }, now));
          }
          this.ledgerStore(run.workspace).appendBatchInTransaction(run.runId, { events });
          let finalRun = this.requireRun(run.runId);
          if (mutation.result.status === 'ready' || mutation.result.status === 'exhausted') {
            finalizeRunIntakeLink(this.database, {
              workspace: run.workspace,
              runId: run.runId,
              profileHash: profileHash(mutation.result.session.profile),
              recommendedTags: mutation.result.recommendedTags,
              finalizedAt: now,
            });
            finalRun = this.ledgerStore(run.workspace).updateRunStatusInTransaction(run.runId, 'active', now);
          }
          return { runId: run.runId, runStatus: finalRun.status, intakeSessionId: link.sessionId };
        },
      );
    });
  }

  private lifecycleEvent(eventType: LedgerEventType, payload: unknown, occurredAt: string): LedgerEventInput {
    return {
      eventId: this.nextEventId(),
      eventType,
      actor: 'kiokuko-dsh',
      occurredAt,
      payload: jsonResult(payload),
    };
  }

  private ledgerStore(workspace: string): LedgerStore {
    return new LedgerStore(this.database, {
      now: () => this.currentTime(),
      workspace,
      ...(this.options.home === undefined ? {} : { home: this.options.home }),
    });
  }

  private requireRun(runId: string): RunRecord {
    const run = new LedgerStore(this.database).readRun(runId);
    if (!run) return notFound();
    return run;
  }

  private scopedOperation(operation: string, runId: string): string {
    const digest = createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32);
    return `dsh.${operation}.${digest}`;
  }

  private currentTime(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private nextRunId(): string {
    return this.options.runIdFactory?.() ?? randomUUID();
  }

  private nextSessionId(): string {
    return this.options.sessionIdFactory?.() ?? randomUUID();
  }

  private nextEventId(): string {
    return this.options.eventIdFactory?.() ?? randomUUID();
  }
}
