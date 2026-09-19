<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# Single-purpose implementation patterns

These patterns are repository- and language-agnostic contracts illustrated with TypeScript for concreteness. Translate them into the project's language, framework, error model, persistence layer, and test tools, and reuse existing project helpers before creating substitutes.

## 1. Hostile boundary, constrained private core

An exported operation may accept unconstrained input when it is the real trust boundary. Validate once, create an owned value, then call a constrained helper.

This Node example accepts arbitrary in-process objects. Reject Proxy objects before reflection and accessors without invoking them. Accept only plain records with enumerable own data properties; return an independent value. For already decoded data-only input, reuse its established normalization boundary instead.

<!-- example:parseWindow -->
```ts
import { isProxy } from 'node:util/types';

interface ValidatedWindow {
  readonly start: number;
  readonly limit: number;
}

export function parseWindow(value: unknown): ValidatedWindow {
  if (typeof value !== 'object' || value === null || isProxy(value)) {
    throw new Error('window must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid window prototype');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('start') || !keys.includes('limit')) throw new Error('invalid window fields');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const startField = descriptors.start!;
  const limitField = descriptors.limit!;
  if (!('value' in startField) || !startField.enumerable
    || !('value' in limitField) || !limitField.enumerable) throw new Error('window requires data properties');
  const start: unknown = startField.value;
  const limit: unknown = limitField.value;
  if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) throw new Error('window start is invalid');
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('window limit is invalid');
  return { start, limit };
}

function calculateEnd(window: ValidatedWindow): number {
  return window.start + window.limit;
}

export function endOfWindow(value: unknown): number {
  return calculateEnd(parseWindow(value));
}
```
<!-- /example:parseWindow -->

Use the project's error type and validation library where available. Do not make `calculateEnd` accept `unknown` or repeat transport validation throughout the domain.

## 2. Closed schema at a request boundary

Use a schema library the project already depends on; do not add one for a boundary the standard library can guard. The schema is the boundary: reject unknown fields when the protocol is closed, bound every collection and string, and require an explicit default for optional inputs. Internal helpers consume the validated output or a narrower domain value, never the raw transport shape.

The accepted representation is a plain data record containing strings, a dense ordinary string array, and an optional integer. Normalize this fixed shape without invoking getters or Proxy traps, then validate the owned data with the existing schema library. This example defaults `limit` only when its key is omitted; explicit `undefined` and `null` are invalid. Paths are non-empty strings of at most 4096 characters, with at most 100 paths. No filesystem access or path authorization is implied.

<!-- example:parseRequest -->
```ts
import { isProxy } from 'node:util/types';
import { z } from 'zod';

const requestSchema = z.object({
  requestId: z.string().min(1).max(256),
  paths: z.array(z.string().min(1).max(4096)).max(100),
  limit: z.number().int().min(1).max(100),
}).strict();
type Request = z.infer<typeof requestSchema>;

export function parseRequest(value: unknown): Request {
  const invalid = () => new Error('invalid request');
  if (typeof value !== 'object' || value === null || isProxy(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 3 || keys.some(key => key !== 'requestId' && key !== 'paths' && key !== 'limit')) throw invalid();
  const data: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
    data[key as string] = descriptor.value;
  }
  const paths = data.paths;
  if (typeof paths !== 'object' || paths === null || isProxy(paths)
    || !Array.isArray(paths) || Object.getPrototypeOf(paths) !== Array.prototype) throw invalid();
  const length: number = Object.getOwnPropertyDescriptor(paths, 'length')!.value;
  if (length > 100 || Reflect.ownKeys(paths).length !== length + 1) throw invalid();
  const ownedPaths: string[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(paths, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
      || typeof descriptor.value !== 'string') throw invalid();
    ownedPaths.push(descriptor.value);
  }
  data.paths = ownedPaths;
  if (!Object.hasOwn(data, 'limit')) data.limit = 20;
  const parsed = requestSchema.safeParse(data);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
```
<!-- /example:parseRequest -->

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

<!-- example:useResource -->
```ts
interface Resource { close(): Promise<void>; }

export async function useResource<T>(open: () => Promise<Resource>, operation: (r: Resource) => Promise<T>): Promise<T> {
  const resource = await open();
  let result: T;
  try {
    result = await operation(resource);
  } catch (operationFailure) {
    try {
      await resource.close();
    } catch (cleanupFailure) {
      throw new AggregateError([operationFailure, cleanupFailure], 'operation and cleanup failed');
    }
    throw operationFailure;
  }
  // Outside the operation catch: a failed close must never cause a second close.
  await resource.close();
  return result;
}
```
<!-- /example:useResource -->

Close exactly once after every successful open, including successful operations. Preserve thrown values even when they are `undefined`. Use the language's structured multi-error or error-chaining mechanism; Lisp's `unwind-protect` alone does not preserve both conditions. Forced worker termination and recovery belong to the host contract.

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
