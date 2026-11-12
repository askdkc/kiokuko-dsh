import assert from 'node:assert/strict'
import test from 'node:test'
import { LlmError, ProviderRequestId, type LlmFailure } from '@deepseek-ai/dsh-llm'
import { llmError } from '../../../src/dsh/llm-error.js'

test('custom errors retain classification, provider facts and cause', () => {
  const cause = new Error('cause')
  const options = { status: 429, providerRetryAfterMs: 1200, requestId: 'opaque-id' as any, cause }
  const error = llmError('redacted provider failure', 'CUSTOM_PROVIDER', options)
  assert.ok(error instanceof LlmError)
  assert.equal(error.code, 'CUSTOM_PROVIDER')
  assert.equal(error.cause, cause)
  assert.deepEqual(error.failure, { message: 'redacted provider failure', code: 'CUSTOM_PROVIDER', status: 429, providerRetryAfterMs: 1200, requestId: 'opaque-id' })
  assert.throws(() => llmError('failure', 'CUSTOM_PROVIDER', { status: 900 }))
})

test('fromFailure-capable SDK branch receives the complete failure and cause', () => {
  const previous=Object.getOwnPropertyDescriptor(LlmError,'fromFailure')
  let observed: unknown
  Object.defineProperty(LlmError,'fromFailure',{configurable:true,value(failure:any,options:any){
    observed={failure,options}
    return new (LlmError as any)(failure.message,failure.code,{...failure,...options})
  }})
  try {
    const cause=new Error('cause')
    const result=llmError('safe message','CUSTOM',{status:503,providerRetryAfterMs:25,requestId:'request' as any,cause})
    assert.deepEqual(observed,{failure:{message:'safe message',code:'CUSTOM',status:503,providerRetryAfterMs:25,requestId:'request'},options:{cause}})
    assert.equal(result.code,'CUSTOM')
    assert.equal(result.cause,cause)
  } finally {if(previous)Object.defineProperty(LlmError,'fromFailure',previous);else Reflect.deleteProperty(LlmError,'fromFailure')}
})


// Change only the optional factory capability; construction and validation still
// use the installed native class. Restore it even when an assertion fails.
function withFactory(factory: ((failure: LlmFailure, options?: ErrorOptions) => LlmError) | undefined, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(LlmError, 'fromFailure')
  Object.defineProperty(LlmError, 'fromFailure', { configurable: true, value: factory })
  try { run() } finally {
    if (original) Object.defineProperty(LlmError, 'fromFailure', original)
    else Reflect.deleteProperty(LlmError, 'fromFailure')
  }
}

for (const modern of [false, true]) test(`LlmError ${modern ? 'factory' : 'legacy'} path preserves native identity, facts and cause`, () => {
  let calls = 0
  const factory = function (this: typeof LlmError, failure: LlmFailure, options?: ErrorOptions) {
    calls++
    assert.equal(this, LlmError)
    assert.equal(Object.hasOwn(failure, 'cause'), false)
    return new LlmError(failure.message, failure.code as ConstructorParameters<typeof LlmError>[1], { ...failure, ...options })
  }
  withFactory(modern ? factory : undefined, () => {
    const cause = new Error('transport cause')
    const options = Object.freeze({ status: 429, providerRetryAfterMs: 1500, requestId: ProviderRequestId('compat-request'), cause })
    const error = llmError('Provider refused the request', 'CUSTOM_PROVIDER_FAILURE', options)
    assert.ok(error instanceof LlmError)
    assert.equal(error.name, 'LlmError')
    assert.equal(error.code, 'CUSTOM_PROVIDER_FAILURE')
    assert.equal(error.message, 'Provider refused the request')
    assert.equal(error.cause, cause)
    assert.deepEqual(error.failure, {
      message: 'Provider refused the request', code: 'CUSTOM_PROVIDER_FAILURE',
      status: 429, providerRetryAfterMs: 1500, requestId: 'compat-request',
    })
    assert.ok(Object.isFrozen(error.failure))
    assert.equal(options.cause, cause)
    const offload = llmError('Offload images', 'IMAGE_OFFLOAD_REQUIRED', { offloadImages: 2 })
    assert.deepEqual(offload.failure, { message: 'Offload images', code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 2 })
    assert.deepEqual(llmError('Budget reached', 'KIOKUKO_STEP_BUDGET_REACHED').failure,
      { message: 'Budget reached', code: 'KIOKUKO_STEP_BUDGET_REACHED' })
    // A full failure may be supplied as options by the harness; its original
    // message must not overwrite the separately redacted public message.
    const failure = Object.freeze({ message: 'private original', code: 'OTHER', status: 503 })
    assert.deepEqual(llmError('Safe diagnostic', 'PROVIDER_ERROR', failure).failure,
      { message: 'Safe diagnostic', code: 'PROVIDER_ERROR', status: 503 })
    assert.equal(calls, modern ? 4 : 0)
  })
})

test('LlmError factory failures propagate without retrying the legacy constructor', () => {
  const failure = new Error('factory refused input')
  let calls = 0
  withFactory(() => { calls++; throw failure }, () => {
    assert.throws(() => llmError('Failure', 'CUSTOM_PROVIDER_FAILURE'), error => error === failure)
    assert.equal(calls, 1)
  })
})

test('LlmError compatibility preserves native validation on the installed host', () => {
  assert.throws(() => llmError('', 'AUTH'), /message/u)
  assert.throws(() => llmError('Failure', ''), /code/u)
  assert.throws(() => llmError('Failure', 'AUTH', { status: 600 }), /status/u)
  assert.throws(() => llmError('Failure', 'RATE_LIMIT', { providerRetryAfterMs: NaN }), /providerRetryAfterMs/u)
})
