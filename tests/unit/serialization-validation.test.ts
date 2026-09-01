import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import {
  canonicalContentHash,
  canonicalEntryRevisionContentHash,
  validateRecordInput,
  type EntryRevisionHashInput,
  type JsonObject,
} from '../../src/serialization/validate.js';
import { assertStrictJsonSyntax, MAX_STRICT_JSON_DEPTH, parseStrictJson } from '../../src/setup/strict-json.js';

const TAGS = ['漢', 'z', 'ä', '😀', 'a', 'å', 'ä'];
const PROVENANCE = {
  type: 'agent_observation',
  reference: '日本語/Ångström',
  sourcePaths: ['src/ä.ts', 'src/漢.ts'],
};

const STRICT_JSON_OPTIONS = { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false } as const;

function assertStrictJsonRejected(source: string): void {
  assert.throws(
    () => parseStrictJson(source, STRICT_JSON_OPTIONS, 'strict-json-sentinel'),
    (error: unknown) => error instanceof KiokukoError
      && error.code === 'VALIDATION_ERROR'
      && error.message === 'strict-json-sentinel',
  );
}

test('strict JSON parsing rejects BOMs, duplicate identities, and non-finite numeric literals', () => {
  for (const source of [
    '\uFEFF{"value":1}',
    '{"identity":"first","identity":"second"}',
    '{"\\u0069d":"first","id":"second"}',
    '{"nested":{"identity":"first","identity":"second"}}',
    '{"value":1e999}',
    '{"value":-1e999}',
    '{"value":"\\ud800"}',
    '{"value":"\\udc00"}',
    '{"\\ud800":"value"}',
  ]) assertStrictJsonRejected(source);

  assert.deepEqual(parseStrictJson('{"value":1.25,"marker":"\uFEFF"}', STRICT_JSON_OPTIONS, 'strict-json-sentinel'), {
    value: 1.25,
    marker: '\uFEFF',
  });
});

test('strict JSON depth is explicitly bounded before recursive parser work', () => {
  const atLimit = `${'['.repeat(MAX_STRICT_JSON_DEPTH)}0${']'.repeat(MAX_STRICT_JSON_DEPTH)}`;
  const overLimit = `${'['.repeat(MAX_STRICT_JSON_DEPTH + 1)}0${']'.repeat(MAX_STRICT_JSON_DEPTH + 1)}`;
  const pathological = `${'['.repeat(20_000)}0${']'.repeat(20_000)}`;

  assert.doesNotThrow(() => assertStrictJsonSyntax(atLimit, STRICT_JSON_OPTIONS, 'strict-json-sentinel'));
  assertStrictJsonRejected(overLimit);
  assertStrictJsonRejected(pathological);
});

function revisionHashInput(scope: JsonObject, provenance: JsonObject = PROVENANCE): EntryRevisionHashInput {
  const validated = validateRecordInput({
    workspace: 'project:portable-hash',
    kind: 'lesson',
    title: 'Portable tag hashing',
    body: 'Persist identical bytes on every host locale.',
    summary: null,
    scope,
    provenance,
    tags: TAGS,
    createdBy: 'test',
    actor: 'test',
  });
  return validated;
}

function hashUnderLocale(locale: string): { tags: string[]; hash: string } {
  const moduleUrl = new URL('../../src/serialization/validate.ts', import.meta.url).href;
  const script = `
    import { canonicalEntryRevisionContentHash, validateRecordInput } from ${JSON.stringify(moduleUrl)};
    const input = validateRecordInput(${JSON.stringify({
      workspace: 'project:portable-hash',
      kind: 'lesson',
      title: 'Portable tag hashing',
      body: 'Persist identical bytes on every host locale.',
      summary: null,
      scope: { schemaVersion: 3, visibility: 'project', retrievalScope: 'project-only' },
      provenance: PROVENANCE,
      tags: TAGS,
      createdBy: 'test',
      actor: 'test',
    })});
    process.stdout.write(JSON.stringify({ tags: input.tags, hash: canonicalEntryRevisionContentHash(input) }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, LANG: locale, LC_ALL: locale },
  })) as { tags: string[]; hash: string };
}

test('canonical persisted tags and revision hashes do not depend on the process locale', () => {
  const results = [
    hashUnderLocale('en_US.UTF-8'),
    hashUnderLocale('sv_SE.UTF-8'),
    hashUnderLocale('zh_CN.UTF-8'),
  ];

  for (const result of results) {
    assert.deepEqual(result.tags, ['a', 'z', 'ä', 'å', '漢', '😀']);
    assert.equal(result.hash, results[0]!.hash);
  }
});

test('the canonical revision hash has no locale-order compatibility verifier', () => {
  const legacyTagOrder = [...new Set(TAGS)].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const versioned = revisionHashInput({ schemaVersion: 2, visibility: 'project' });
  const legacyHash = canonicalContentHash({
    kind: versioned.kind,
    title: versioned.title,
    body: versioned.body,
    summary: versioned.summary,
    scope: versioned.scope,
    provenance: versioned.provenance,
    tags: legacyTagOrder,
  });
  assert.notEqual(legacyHash, canonicalEntryRevisionContentHash(versioned));
});
