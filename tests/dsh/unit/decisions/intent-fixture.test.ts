import assert from 'node:assert/strict'
import test from 'node:test'
import { buildIntentAssessmentBatch } from '../../../../src/dsh/decisions/intent-assessment.js'
import { createRequestIntentContext, requestIntentReferenceIds, validateMainModelRequestIntent } from '../../../../src/dsh/decisions/request-intent.js'
import { semanticFixtureAnswers } from '../../helpers/intent-decision-fixture.js'
test('independent fixture contradicts wrong actions and abstains on an unknown original source',()=>{
 const task='Explain PLAN.md without changing it.',context=createRequestIntentContext({task,messageRefs:[{id:'human',digest:'a'.repeat(64)}]})!
 const candidate=validateMainModelRequestIntent({relation:'new',action:'change',changeScope:'document',evidenceRefs:requestIntentReferenceIds(context)},context)
 assert.ok(candidate.ok);if(!candidate.ok)return
 const batch=buildIntentAssessmentBatch(context,candidate.decision)
 assert.ok(semanticFixtureAnswers(batch,source=>source===task?{action:'answer'}:undefined)?.every(answer=>answer.status==='selected'&&answer.choiceId==='contradicted'))
 assert.ok(semanticFixtureAnswers(batch,()=>undefined)?.every(answer=>answer.status==='abstained'&&answer.reason==='insufficient'))
})
