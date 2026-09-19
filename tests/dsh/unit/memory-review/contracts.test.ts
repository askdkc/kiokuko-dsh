import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryReviewConfig,ReviewResult,FinalizerResult } from '../../../../src/memory/review/contracts.js'
import { captureRefusal } from '../../../../src/memory/capture-policy.js'
test('config enforces bounded integers and minimum <= interval',()=>{
  for(const value of [{turnInterval:3},{dailyCalls:0},{timeoutMs:Infinity},{maxInputBytes:1}])assert.equal(MemoryReviewConfig.safeParse(value).success,false)
  assert.equal(MemoryReviewConfig.parse({}).mode,'active')
})
test('review limits kinds at runtime while v3 finalizer retains all five',()=>{
  for(const kind of ['fact','decision','preference','lesson','reference']){
    const op={action:'add',kind,title:'Observed',body:'Grounded',evidenceIds:['e:1']}
    assert.equal(ReviewResult.safeParse({schemaVersion:1,proposals:[op]}).success,!['lesson','reference'].includes(kind))
    assert.ok(FinalizerResult.safeParse({schemaVersion:3,memoryOperations:[op]}).success)
  }
})
test('T30/T43 refusal aliases exclude; quoted, English and oversized input conservatively hold',()=>{
  assert.equal(captureRefusal('この会話を覚えないで')?.mode,'excluded')
  for(const text of ['例文:「保存しない」','please do not remember this','x'.repeat(200000)+'覚えないで','x'.repeat(1100000)])assert.equal(captureRefusal(text)?.mode,'held')
  assert.equal(captureRefusal('日本語で回答して'),undefined)
})
