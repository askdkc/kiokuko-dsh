<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# Single-purpose implementation patterns

These patterns are repository- and language-agnostic contracts illustrated with TypeScript for concreteness. Translate them into the project's language, framework, error model, persistence layer, and test tools, and reuse existing project helpers before creating substitutes.

## 1. Hostile boundary, constrained private core

An exported operation may accept unconstrained input when it is the real trust boundary. Validate once, create an owned value, then call a constrained helper.

```ts
interface ValidatedWindow {
  readonly start: number;
  readonly limit: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseWindow(value: unknown): ValidatedWindow {
  if (!isPlainRecord(value)) throw new Error('window must be an object');
  if (typeof value.start !== 'number' || !Number.isInteger(value.start) || value.start < 0) {
    throw new Error('window start is invalid');
  }
  if (typeof value.limit !== 'number' || !Number.isInteger(value.limit)
    || value.limit < 1 || value.limit > 100) {
    throw new Error('window limit is invalid');
  }
  return { start: value.start, limit: value.limit };
}

function calculateEnd(window: ValidatedWindow): number {
  return window.start + window.limit;
}

export function endOfWindow(value: unknown): number {
  return calculateEnd(parseWindow(value));
}
```

Use the project's error type and validation library where available. Do not make `calculateEnd` accept `unknown` or repeat transport validation throughout the domain.

## 2. Closed schema at a request boundary

Use a schema library the project already depends on; do not add one for a boundary the standard library can guard. The schema is the boundary: reject unknown fields when the protocol is closed, bound every collection and string, and require an explicit default for optional inputs. Internal helpers consume the validated output or a narrower domain value, never the raw transport shape.

```ts
const parseRequest: (value: unknown) => Request = (value) => {
  if (!isPlainRecord(value)) throw new Error('request must be an object');
  return {
    requestId: requireBoundedString(value.requestId, 1, 256),
    paths: requirePathArray(value.paths, 100),
    limit: optionalInt(value.limit, 1, 100) ?? 20,
  };
};
```

## 3. Exact optional values

Omit absent optional properties rather than assigning ambiguous placeholders.

```ts
interface Candidate {
  readonly id: string;
  readonly description?: string;
}

function candidate(id: string, description: string | undefined): Candidate {
  return {
    id,
    ...(description === undefined ? {} : { description }),
  };
}
```

Use the equivalent convention in languages that distinguish missing, null, and empty values.

## 4. Immutable transformation

Return a new value and leave the caller's input untouched, unless mutation is the explicit API contract. When the transformation is the change being made, prove it with a check that compares the input before and after and asserts the result is a different object.

## 5. Explicit variable dependencies

Keep time and randomness out of pure ranking, hashing, transition, and validation functions.

```ts
interface Dependencies {
  readonly now: () => string;
  readonly createId: () => string;
}

interface CreatedRecord {
  readonly id: string;
  readonly createdAt: string;
}

function createRecord(dependencies: Dependencies): CreatedRecord {
  return {
    id: dependencies.createId(),
    createdAt: dependencies.now(),
  };
}
```

Production composition supplies real dependencies; tests supply deterministic ones.

## 6. Transaction-agnostic store, transaction-owning use case

The store performs persistence. The service or use case owns the atomic operation.

```ts
type Transaction = { execute(sql: string, parameters: readonly unknown[]): void };

function insertItem(transaction: Transaction, id: string, value: string): void {
  transaction.execute('INSERT INTO items (id, value) VALUES (?, ?)', [id, value]);
}

function createItem(runTransaction: (operation: (t: Transaction) => void) => void, id: string): void {
  runTransaction((transaction) => {
    insertItem(transaction, id, 'value');
    transaction.execute('INSERT INTO audit_events (event_type, target_id) VALUES (?, ?)', ['item_created', id]);
  });
}
```

Do not let `insertItem` start its own transaction if it must compose with other writes. Do not call a provider or perform unrelated slow I/O inside the transaction.

## 7. Validate stored data before domain use

Driver types and generated models are not always runtime proof, especially across migrations or external storage.

```ts
interface StoredItem {
  readonly id: string;
  readonly revision: number;
}

function parseStoredItem(row: Record<string, unknown> | undefined): StoredItem {
  if (row === undefined) throw new Error('Item not found');
  if (typeof row.id !== 'string'
    || typeof row.revision !== 'number'
    || !Number.isInteger(row.revision)
    || row.revision < 1) {
    throw new Error('Stored item is invalid');
  }
  return { id: row.id, revision: row.revision };
}
```

Do not include malformed row contents in a public error.

## 8. Safe public error mapping

Public messages should be stable. Keep only allowlisted bounded details.

```ts
interface PublicFailure {
  readonly code: 'busy' | 'invalid' | 'internal';
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

function publicFailure(error: unknown): PublicFailure {
  if (isBusyFailure(error)) {
    return {
      code: 'busy',
      message: 'Service is busy',
      retryAfterSeconds: clampRetryDelay(error.retryAfterSeconds),
    };
  }
  if (isValidationFailure(error)) {
    return { code: 'invalid', message: 'Request is invalid' };
  }
  return { code: 'internal', message: 'Internal error' };
}
```

Do not copy unknown exception messages, submitted values, credentials, URLs with secret query parameters, or provider bodies into public output.

## 9. Preserve operation and cleanup failures

When both fail, retain both failures without replacing the primary one.

```ts
async function useResource<T>(open: () => Promise<Resource>, operation: (r: Resource) => Promise<T>): Promise<T> {
  const resource = await open();
  try {
    return await operation(resource);
  } catch (operationFailure) {
    try {
      await resource.close();
    } catch (cleanupFailure) {
      throw new AggregateError([operationFailure, cleanupFailure], 'operation and cleanup failed');
    }
    throw operationFailure;
  }
}
```

Use the language's structured multi-error or error-chaining mechanism where possible.

## 10. Classify failures by structured fields

Prefer error types, codes, status values, or discriminated variants over message matching. A guard should check the structured field and its value, never a substring of the message: an unrelated exception containing "busy" or "timeout" is not retryable.

```ts
function isRetryableFailure(error: unknown): error is RetryableFailure {
  return error instanceof Error
    && 'code' in error && error.code === 'temporarily_unavailable'
    && 'retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number';
}
```

## 11. Immutable replay identity

Bind every field that changes the meaning of an idempotent operation.

```ts
interface BoundRequest {
  readonly operation: string;
  readonly subjectId: string;
  readonly expectedRevision: number;
  readonly mode: 'validate' | 'apply';
}

function replayMatches(left: BoundRequest, right: BoundRequest): boolean {
  return left.operation === right.operation
    && left.subjectId === right.subjectId
    && left.expectedRevision === right.expectedRevision
    && left.mode === right.mode;
}
```

Reusing an identity with changed bound input is a conflict, not a second mutation.

## 12. Compare-and-swap filesystem changes

When concurrent changes or independently owned files must be protected, a plain write, rename, or delete is insufficient. Use the project's atomic compare-and-swap helper, and make the contract explicit about expected content, expected file and parent-directory identity, alternate paths that must remain absent, restrictive mode, reverse-order rollback, and an explicit ambiguous-cleanup failure.

## 13. Secret non-echo

Assert that rejected input is not echoed: submit a sentinel value, trigger the validation failure, and assert the error message does not contain the sentinel.

## 14. Deterministic output

For canonical order, hashes, manifests, and rankings, construct semantically equivalent inputs with different insertion order and assert identical output.

## 15. Verification sequence

Run commands that actually exist in the repository:

1. the narrowest test covering the changed contract;
2. relevant integration tests;
3. type or static checks;
4. the broader test suite when shared behavior changed;
5. build and package checks when distribution changed.

Report skipped commands and failures exactly. Do not invent a lint, formatter, build, or test command that the project does not define.
