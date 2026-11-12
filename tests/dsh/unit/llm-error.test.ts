import assert from 'node:assert/strict'
import test from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
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
