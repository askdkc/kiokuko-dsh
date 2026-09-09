import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseEpisodeDraft, episodeSignals, supportingEvidenceDigest, independentEpisodes, inductionKind, episodeSignature, MemoryEvolutionConfig } from '../../../../src/memory/evolution/contracts.js'
import { parseCapsule, episodeEvidenceForEvent } from '../../../../src/dsh/session-memory-finalizer.js'
import { draft, evidence, fixture, seed } from '../../integration/evolution/fixture.js'

test('native proof references reject unknown, assistant and wrong-kind verification', () => {
  assert.doesNotThrow(()=>parseEpisodeDraft(draft(),evidence('a')))
  const wrong=draft(); wrong.events[2]!.evidence=[1]
  assert.throws(()=>parseEpisodeDraft(wrong,evidence('a')),/unobserved_verification/)
  wrong.events[2]!.evidence=[999]; assert.throws(()=>parseEpisodeDraft(wrong,evidence('a')),/unknown_evidence/)
  assert.equal(episodeEvidenceForEvent({seq:1,time:0,type:'assistant/message',data:{message:{content:[{type:'text',text:'Tests passed'}]}}}),undefined)
  assert.equal(episodeEvidenceForEvent({seq:1,time:0,type:'user/message',data:{source:{kind:'plugin'},content:[{type:'text',text:'Old memory'}]}}),undefined)
  assert.equal(episodeSignals(draft(),evidence('a').map(e=>({...e,outcome:'unknown'}))).successful,false)
})
test('v2 episode failure can be isolated without rejecting valid v1 memories', () => {
  const raw={schemaVersion:2,memories:[],episode:{bad:true}}
  const result=parseCapsule(JSON.stringify(raw)); assert.deepEqual(result.capsule.memories,[])
  assert.throws(()=>parseEpisodeDraft(result.episode,[]))
  assert.deepEqual(parseCapsule('{"schemaVersion":1,"memories":[]}').capsule.memories,[])
  assert.throws(()=>parseCapsule(JSON.stringify({...raw,episode:'x'.repeat(65536)})),/65536/)
})
test('support requires independent runs and compatible exact anchors', () => {
  const {db}=fixture()
  try {
    const a=seed(db,'a'),b=seed(db,'b'),c=seed(db,'c')
    assert.equal(inductionKind([a,b]),undefined); assert.equal(inductionKind([a,b,c]),'positive')
    assert.equal(independentEpisodes([a,{...a,runId:'replay'}]).length,1)
    assert.equal(independentEpisodes([a,{...b,sessionId:a.sessionId}]).length,1)
    assert.equal(inductionKind([a,b,{...c,workspace:'project:other'}]),undefined)
    const changed=draft(); changed.anchors.version='3.47'
    assert.notEqual(episodeSignature(a.workspace,changed),a.signature)
    assert.equal(inductionKind([a,b,{...c,successful:false},{...a,runId:'copy',successful:false}]),'positive')
  } finally {db.close()}
})
test('concrete corrections qualify avoidance; generic or unsupported alternatives do not', () => {
  const {db}=fixture()
  try {
    const d=draft(); d.avoidance={trigger:d.applicability,avoid:'Retry with the write transaction open.',alternative:d.procedure,verification:d.verification,evidence:[3]}
    const e=seed(db,'recover',{draft:d}); assert.equal(inductionKind([e]),'avoidance')
    const unverified={...e,successful:false}; assert.equal(inductionKind([unverified]),undefined)
    d.avoidance.alternative='もっと確認する'; assert.equal(inductionKind([{...e,draft:d}]),undefined)
  } finally {db.close()}
})
test('evolution defaults to active and accepts explicit observation or shutdown within fixed budgets', () => {
  assert.equal(MemoryEvolutionConfig.parse({}).mode,'active')
  for (const mode of ['active','observe','off']) assert.equal(MemoryEvolutionConfig.parse({mode}).mode,mode)
  assert.throws(()=>MemoryEvolutionConfig.parse({dailyCalls:9}))
})
test('unrelated passing checks cannot support an invented procedure, and repeated decisions add no independence', () => {
  const d=draft();d.procedure='An action that was never executed.'
  const flags=episodeSignals(d,evidence('a'))
  assert.equal(flags.successful,true);assert.equal(flags.procedureSupported,false)
  const original=draft(),observations=evidence('a')
  const repeated={...original,events:[...original.events,{kind:'decision' as const,description:'Changed objective',evidence:[10]}]}
  assert.equal(supportingEvidenceDigest(original,observations),supportingEvidenceDigest(repeated,[...observations,{seq:10,kind:'user',text:'Different request ID and wording',outcome:'unknown'}]))
})
test('single concrete user correction supports avoidance without pretending a test passed', () => {
  const {db}=fixture()
  try {
    const d=draft(),observations=evidence('correction').map(e=>({...e,outcome:'unknown' as const}))
    observations[0]!.text+=' Do not retry while the writer is open. '+d.procedure
    d.events=[{kind:'correction',description:'Release writer before retrying.',evidence:[1]}]
    d.avoidance={trigger:d.applicability,avoid:'Retry while writer is open.',alternative:d.procedure,verification:d.verification,evidence:[1]}
    const e=seed(db,'correction',{draft:d,evidence:observations,outcome:'failed'})
    assert.equal(e.successful,false);assert.equal(inductionKind([e]),'avoidance')
  } finally {db.close()}
})
test('evaluation split and all authored inputs are frozen independently of model output', async () => {
  const root=new URL('../../../fixtures/evolution-evaluation/',import.meta.url)
  const raw=await readFile(new URL('scenarios.json',root),'utf8')
  const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'))
  const cases=JSON.parse(raw).scenarios
  assert.equal(createHash('sha256').update(raw).digest('hex'),manifest.sha256)
  assert.equal(cases.length,30); assert.equal(cases.flatMap((s:any)=>s.episodes).length,90)
  assert.equal(cases.flatMap((s:any)=>s.queries).length,120)
  assert.equal(cases.filter((s:any)=>s.split==='heldout').length,20)
})
