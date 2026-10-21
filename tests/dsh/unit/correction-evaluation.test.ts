import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
const {correctionMetrics,correctionEvaluation}=await import(new URL('../../../scripts/correction-evaluation.mjs',import.meta.url).href)
test('evaluation denominators include positive abstentions/outages as misses and all gold non-special cases',()=>{
  const row=(gold:string,actual:string,state='classified')=>({gold,actual,state,language:'fixture',elapsedMs:10,inputTokens:7,baseline:'reference'})
  const result=correctionMetrics([row('capability_compatibility','capability_compatibility'),row('capability_compatibility','uncertain','abstained'),
    row('capability_compatibility','uncertain','unavailable'),row('reference','capability_compatibility'),row('uncertain','uncertain','abstained')])
  assert.equal(result.specialPrecision,.5);assert.equal(result.specialRecall,1/3);assert.equal(result.falseSpecialRate,1/2)
  assert.equal(result.goldNonSpecial,2);assert.equal(result.providerFailureRate,.2);assert.equal(result.accuracy,.4)
  assert.equal(result.falseNonSpecial,2);assert.equal(result.trueNonSpecial,1);assert.equal(result.confusion.capability_compatibility.provider_failure,1)
  assert.equal(correctionMetrics([row('uncertain','uncertain','stale')]).accuracy,0)
  const baseline=correctionEvaluation([row('reference','reference')]).baseline
  assert.equal(baseline.latencyMs.mean,null);assert.equal(baseline.latencyMs.p50,null);assert.equal(baseline.inputTokens.total,0)
})
test('empty denominators are unavailable and cannot pass release gates',()=>{
  const result=correctionEvaluation([]);assert.equal(result.overall.specialPrecision,null);assert.equal(result.overall.specialRecall,null)
  assert.equal(result.overall.falseSpecialRate,null);assert.equal(result.gates.qualified,false)
})
test('held-out corpus is disjoint, balanced and aligned across the five declared languages',()=>{
  const corpus=JSON.parse(readFileSync(new URL('../../fixtures/correction-classification.json',import.meta.url),'utf8'))
  const development=new Set(corpus.development.map((x:any)=>x.id));assert.ok(corpus.heldOut.every((x:any)=>!development.has(x.id)))
  assert.equal(new Set(corpus.heldOut.map((x:any)=>x.id)).size,corpus.heldOut.length)
  assert.ok(corpus.heldOut.length*corpus.languages.length>=100)
  for(const group of [...corpus.development,...corpus.heldOut])assert.deepEqual(Object.keys(group.texts).sort(),[...corpus.languages].sort())
  const positive=corpus.heldOut.filter((x:any)=>x.gold==='capability_compatibility').length/corpus.heldOut.length
  assert.ok(positive>=.3&&positive<=.5)
  for(const category of ['negation','quotation','opposition','version-words-only','no-version-words','indirect','short-ambiguous','long-context','contradictory-summary','ci-prerequisite','legitimate-minimum'])
    assert.ok(corpus.heldOut.some((x:any)=>x.category===category),category)
})
