import assert from 'node:assert/strict'
import type { SqliteDatabase } from '../../../src/db/adapter.js'
import { readDecisionDiagnostics } from '../../../src/dsh/decisions/diagnostics.js'

/** Inspect the DB produced by the real native host. No diagnostic rows are seeded here. */
export function assertNativeDecisionDiagnostics(db: SqliteDatabase, sessionId: string, answered: boolean, assessed=false): void {
  const snapshot=readDecisionDiagnostics(db,sessionId)
  const questions=snapshot.attempts.flatMap(a=>a.events.filter(e=>e.kind==='question').map(e=>({attempt:a,event:e})))
  assert.equal(questions.length,1,'the actual native clarification must persist one question')
  const {attempt,event:question}=questions[0]!
  const answers=attempt.events.filter(e=>e.kind==='answer'),resumes=attempt.events.filter(e=>e.kind==='resume')
  assert.equal(answers.length,answered?1:0,'only the accepted UI response becomes an answer reference')
  if(answered) {
    assert.equal(answers[0]!.parentEventId,question.eventId)
    assert.ok(resumes.some(e=>e.parentEventId===answers[0]!.eventId),'recaptured native followup must point to its persisted answer')
  } else assert.equal(resumes.length,0)
  assert.equal(snapshot.metrics.falseStopRate,null,'a successful resume is not an independent correctness label')
  assert.equal(snapshot.metrics.evaluationRate,0)
  if(assessed){
    assert.equal(attempt.stages.semanticMatch,'observed');assert.equal(attempt.stages.detector,'observed')
    const detector=attempt.events.find(e=>e.kind==='detector')!
    assert.equal(detector.judge?.state,'available');assert.equal(detector.judge?.version,'kiokuko-fd-v1')
    assert.match(detector.judge?.binaryHash??'',/^[a-f0-9]{64}$/u);assert.match(detector.judge?.inputDigest??'',/^[a-f0-9]{64}$/u)
    const semantic=attempt.events.find(e=>e.kind==='semantic_match')!
    assert.equal(detector.parentEventId,semantic.eventId)
    assert.ok(semantic.evaluationDecisionId,'actual independent provider call must link to its observation')
  }else{
    assert.equal(attempt.stages.semanticMatch,'not_run');assert.equal(attempt.stages.detector,'not_run')
  }
  if(answered){
    const nextIds=resumes.flatMap(e=>e.nextDecisionId?[e.nextDecisionId]:[])
    assert.ok(nextIds.length>0,'accepted answer links to a new source attempt')
    assert.ok(snapshot.attempts.some(a=>nextIds.includes(String(a.decisionId))&&a.events.some(e=>e.kind==='detector'&&e.judge?.status==='entailed')),'the same lineage reaches the re-evaluated answer')
  }
  assert.ok(attempt.events.some(e=>e.kind==='extraction'))
  assert.ok(snapshot.attempts.flatMap(a=>a.providerAttempts).length>0,'actual provider observations must be linked by request reference')
}
