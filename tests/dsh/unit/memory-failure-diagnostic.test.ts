import assert from 'node:assert/strict';
import test from 'node:test';
import { KiokukoError } from '../../../src/errors.js';
import { failedFinalizationPatch, memoryFailureDiagnostic, memoryStreamFailure } from '../../../src/dsh/memory-failure.js';

test('known operational errors retain bounded explanatory text instead of duplicating their code', () => {
  const failure = memoryFailureDiagnostic(new KiokukoError('SERVICE_UNAVAILABLE', 'DSH session query service is unavailable for memory finalization'));
  assert.equal(failure.code, 'SERVICE_UNAVAILABLE');
  assert.match(failure.message, /session query service/);
  assert.notEqual(failure.message, failure.code);
  assert.equal(memoryFailureDiagnostic(new Error('x'.repeat(9000))).message.length, 2000);
});
for (const unsafe of ['api_key=short-fixture', 'Authorization: Basic fixture-secret', 'Authorization: Bearer fixture-secret', 'cookie: session=fixture-secret', 'https://alice:fixture-secret@host.invalid/v1?token=short-fixture', 'access_token="quoted fixture-secret"', 'sk-abcdefghijklmnopqrstuvwxyz', 'API key fixture-secret', 'token fixture-secret']) {
  test(`diagnostics omit credential-bearing input for fixture ${unsafe.split(/[:=]/)[0]}`, () => {
    const projected = JSON.stringify(memoryFailureDiagnostic(Object.assign(new Error(`SQLITE_BUSY: ${unsafe}`), { code: 'DATABASE_ERROR', request: { private: 'NEVER COPY REQUEST BODY' }, stack: 'NEVER COPY STACK' })));
    assert.match(projected, /SQLITE_BUSY/);
    assert.doesNotMatch(projected, /short-fixture|fixture-secret|abcdefghijklmnopqrstuvwxyz|NEVER COPY/);
  });
}
test('arbitrary error codes and invalid statuses cannot smuggle untrusted details into diagnostics', () => {
  assert.deepEqual(memoryFailureDiagnostic({ code: 'api_key=fixture-secret', message: 'Operation failed', status: 999 }), { code: 'FINALIZATION_FAILED', message: 'Operation failed' });
  assert.equal(memoryFailureDiagnostic(new SyntaxError('Unexpected token at position 17')).code, 'INVALID_MODEL_JSON');
  assert.equal(memoryFailureDiagnostic({ name: 'ZodError', message: 'Expected memories array' }).code, 'INVALID_MODEL_OUTPUT');
});
test('a provider error finish preserves its safe classification and status', () => {
  const failure = memoryFailureDiagnostic(memoryStreamFailure({ kind: 'error', failure: { code: 'INVALID_REQUEST', status: 400, message: 'Session header required; api_key=short-fixture' } }));
  assert.equal(failure.code, 'LLM_INVALID_REQUEST');
  assert.match(failure.message, /HTTP 400: Session header required/);
  assert.doesNotMatch(failure.message, /short-fixture/);
});
for (const [kind, expected] of [['aborted', 'LLM_ABORTED'], ['length', 'LLM_OUTPUT_LIMIT'], ['tool-calls', 'LLM_UNEXPECTED_TOOL_CALLS'], [undefined, 'LLM_MISSING_FINISH']] as const) {
  test(`non-successful ${kind ?? 'missing'} finish remains classified as ${expected}`, () => {
    assert.equal(memoryFailureDiagnostic(memoryStreamFailure(kind ? { kind } : undefined)).code, expected);
  });
}

test('failed finalization storage fields retain the explanation and cannot mark another claim or a completed job', () => {
  const error = new KiokukoError('SERVICE_UNAVAILABLE', 'Session query service is unavailable; token=short-fixture');
  const patch = failedFinalizationPatch({ status: 'processing', claim_nonce: 'owned-claim' }, 'owned-claim', error);
  assert.ok(patch);
  assert.equal(patch.status, 'failed');
  assert.equal(patch.last_error_code, 'SERVICE_UNAVAILABLE');
  assert.match(patch.last_error_message, /Session query service is unavailable/);
  assert.notEqual(patch.last_error_message, patch.last_error_code);
  assert.doesNotMatch(patch.last_error_message, /short-fixture/);
  assert.equal(patch.claim_nonce, null);
  assert.equal(failedFinalizationPatch({ status: 'processing', claim_nonce: '' }, '', error), undefined);
  for (const current of [undefined, { status: 'completed', claim_nonce: 'owned-claim' }, { status: 'processing', claim_nonce: 'new-owner' }, { status: 'failed', claim_nonce: 'owned-claim' }]) {
    assert.equal(failedFinalizationPatch(current, 'owned-claim', error), undefined);
  }
});
