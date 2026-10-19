import { DecisionService } from '../../../src/dsh/decisions/service.js'
import { TypedDecisionsConfig } from '../../../src/dsh/decisions/config.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { encodeFiniteDomain, runMicroJudge, type FiniteDomainProblem } from '../../../src/dsh/decisions/micro-judge.js'
import { assessRequestIntent, buildIntentAssessmentBatch, compileIntentRelations } from '../../../src/dsh/decisions/intent-assessment.js'
import { createRequestIntentContext, validateMainModelRequestIntent, requestIntentReferenceIds } from '../../../src/dsh/decisions/request-intent.js'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
const signal=()=>new AbortController().signal
const problem:FiniteDomainProblem={domains:[{kind:'bool',values:[0,1]}],constraints:[],query:{variable:0}}
test('typed finite domains preserve unknown and reject integer truthiness and unbounded graphs',()=>{
  assert.equal(encodeFiniteDomain(problem),'200000 1 0 b 2 0 1 @0')
  assert.throws(()=>encodeFiniteDomain({...problem,query:{op:'and',args:[1,true]}}))
  assert.throws(()=>encodeFiniteDomain({...problem,domains:[{kind:'bool',values:[2]}]}))
  assert.throws(()=>encodeFiniteDomain({...problem,workBudget:0}))
  assert.throws(()=>encodeFiniteDomain({...problem,domains:Array(129).fill({kind:'bool',values:[0]})}))
})
test('independent source comparison uses a distinct purpose and source, not extraction probabilities',()=>{
  const context=createRequestIntentContext({task:'Explain why the implementation behaves this way. Do not edit files.',messageRefs:[{id:'human-1',digest:hash('human-1')}]})!
  const parsed=validateMainModelRequestIntent({relation:'new',action:'change',changeScope:'implementation',evidenceRefs:requestIntentReferenceIds(context)},context)
  assert.equal(parsed.ok,true);if(!parsed.ok)return
  const batch=buildIntentAssessmentBatch(context,parsed.decision)
  assert.equal(batch.purpose,'intent-semantic-match')
  assert.equal((batch.state as any).source.task,context.task)
  assert.equal((batch.state as any).candidate.action,'change')
  assert.equal(JSON.stringify(batch).includes('topProbability'),false)
  assert.equal(batch.questions.length,4)
  assert.doesNotThrow(()=>encodeFiniteDomain(compileIntentRelations(context,parsed.decision,'insufficient')))
})
test('missing or unsupported binary is explicit unavailable, never an allow',async t=>{
  const root=await mkdtemp(join(tmpdir(),'fd-missing-'));t.after(()=>rm(root,{recursive:true,force:true}))
  assert.deepEqual((await runMicroJudge(problem,hash('x'),signal(),{artifactRoot:root})).state,'unavailable')
  await writeFile(join(root,'manifest.json'),JSON.stringify({version:'kiokuko-fd-v1',artifacts:[]}))
  const result=await runMicroJudge(problem,hash('x'),signal(),{artifactRoot:root})
  assert.equal(result.state,'unavailable');if(result.state==='unavailable')assert.equal(result.reason,'unsupported_platform')
})
test('corrupt executable is rejected before spawning',async t=>{
  const root=await mkdtemp(join(tmpdir(),'fd-corrupt-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const file=`${process.platform}-${process.arch}/kiokuko-micro-judge`;await mkdir(join(root,`${process.platform}-${process.arch}`))
  await writeFile(join(root,file),'corruption',{mode:0o755})
  await writeFile(join(root,'manifest.json'),JSON.stringify({version:'kiokuko-fd-v1',artifacts:[{file,platform:process.platform,arch:process.arch,bytes:10,sha256:hash('different!'),nativeVerified:false}]}))
  const result=await runMicroJudge(problem,hash('x'),signal(),{artifactRoot:root})
  assert.equal(result.state,'unavailable');if(result.state==='unavailable')assert.equal(result.reason,'artifact_mismatch')
})
// These are deliberately required by the native Rust acceptance invocation, never skipped as proof.
if(process.env.KIOKUKO_REQUIRE_MICRO_JUDGE==='1') {
  const check=async(p:FiniteDomainProblem)=>{const r=await runMicroJudge(p,hash(JSON.stringify(p)),signal(),process.env.KIOKUKO_SKILL_PACKAGE_ROOT?{artifactRoot:join(process.env.KIOKUKO_SKILL_PACKAGE_ROOT,'micro-judge')}:{});assert.equal(r.state,'available',JSON.stringify(r));if(r.state!=='available')throw new Error('Rust unavailable');return r}
  test('actual packaged executable distinguishes all four complete statuses and incomplete budget exhaustion',async()=>{
    for(const [p,status] of [
      [{...problem,query:true},'entailed'],[{...problem,query:false},'refuted'],[problem,'undetermined'],[{...problem,constraints:[false]},'inconsistent'],[{...problem,workBudget:1},'resource_limit'],
    ] as [FiniteDomainProblem,string][]){const r=await check(p);assert.equal(r.result.status,status);assert.equal(r.result.complete,status!=='resource_limit');assert.equal(r.result.peakRssBytes,null)}
  })
  for(const [n,count]of [[4,2],[6,4],[8,92]])test(`actual Rust MRV ${n} queens has ${count} solutions`,async()=>{
    const constraints:FiniteDomainProblem['constraints']=[]
    for(let i=0;i<n!;i++)for(let j=i+1;j<n!;j++)constraints.push({op:'ne',args:[{variable:i},{variable:j}]},{op:'diag',args:[{variable:i},{variable:j},j-i]})
    const r=await check({domains:Array.from({length:n!},()=>({kind:'int',values:Array.from({length:n!},(_,i)=>i)})),constraints,query:true,workBudget:2000000})
    assert.equal(r.result.complete,true);assert.equal(r.result.solutions,count)
  })
  test('actual Rust agrees with an independent exhaustive oracle on 200 deterministic small problems',async()=>{
    let seed=7319;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed}
    for(let sample=0;sample<200;sample++){
      const count=2+next()%3,domains=Array.from({length:count},()=>({kind:'int' as const,values:[-1,0,1]}))
      const pairs=Array.from({length:next()%6},()=>({a:next()%count,b:next()%count,operation:next()%3}))
      const evaluate=(p:typeof pairs[number],v:number[])=>p.operation===0?v[p.a]===v[p.b]:p.operation===1?v[p.a]!==v[p.b]:v[p.a]!<v[p.b]!
      const query={a:next()%count,b:next()%count,operation:next()%3}
      let solutions=0,truth=0
      function enumerate(v:number[]){if(v.length===count){if(pairs.every(p=>evaluate(p,v))){solutions++;if(evaluate(query,v))truth++}return}for(const value of [-1,0,1])enumerate([...v,value])}
      enumerate([])
      const expression=(p:typeof query)=>({op:(['eq','ne','lt'] as const)[p.operation]!,args:[{variable:p.a},{variable:p.b}]})
      const result=(await check({domains,constraints:pairs.map(expression),query:expression(query)})).result
      assert.equal(result.complete,true,`sample ${sample}`);assert.equal(result.solutions,solutions,`sample ${sample}`);assert.equal(result.truth,truth,`sample ${sample}`)
      assert.equal(result.status,!solutions?'inconsistent':!truth?'refuted':truth===solutions?'entailed':'undetermined')
    }
  })
  test('all eight proposals with current Task and Goal fit the declared host bounds',async()=>{
    const context=createRequestIntentContext({task:'Adopt all proposals and implement them.',messageRefs:[{id:'h',digest:hash('h')}],
      activeGoal:{runId:'run',workflowRevision:1,goalRevision:1,scopeRevision:1,outOfScope:[],constraints:[]},
      activeTask:{taskId:'run',runId:'run',sessionId:'session',repositoryRoot:'/repo',type:'build',state:'Working',revision:1,generation:1,runStatus:'active',reason:'fixture',evidence:[],allowedOps:[],request:'Build',sourceSessionId:'session',resumedFromTerminal:false},
      proposals:Array.from({length:8},(_,i)=>({id:`p${i}`,revision:1,digest:hash(`proposal${i}`),text:`proposal${i}`}))})!
    const candidate=validateMainModelRequestIntent({relation:'scope_change',action:'change',changeScope:'implementation',evidenceRefs:requestIntentReferenceIds(context)},context)
    assert(candidate.ok);if(!candidate.ok)return
    const problem=compileIntentRelations(context,candidate.decision,'supported')
    assert.ok(problem.domains.length<=128);assert.equal((await check(problem)).result.status,'entailed')
  })
  test('host source/candidate relation graph detects stale source and preserves semantic unknown',async()=>{
    const context=createRequestIntentContext({task:'Change the implementation in src/example.ts.',messageRefs:[{id:'human-1',digest:hash('human-1')}]})!
    const c=validateMainModelRequestIntent({relation:'new',action:'change',changeScope:'implementation',evidenceRefs:requestIntentReferenceIds(context)},context)
    assert(c.ok);if(!c.ok)return
    assert.equal((await check(compileIntentRelations(context,c.decision,'supported'))).result.status,'entailed')
    assert.equal((await check(compileIntentRelations(context,c.decision,'contradicted'))).result.status,'refuted')
    assert.equal((await check(compileIntentRelations(context,c.decision,'insufficient'))).result.status,'undetermined')
    assert.equal((await check(compileIntentRelations({...context,task:'Other request'},c.decision,'supported'))).result.status,'refuted')
  })
}

for(const fault of ['malformed','version','digest','output_limit','timeout','process_failed'] as const)test(`subprocess ${fault} is explicit unavailable`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'fd-process-fault-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const file=`${process.platform}-${process.arch}/kiokuko-micro-judge`;await mkdir(join(root,`${process.platform}-${process.arch}`))
  const body=fault==='malformed'?`process.stdout.write('malformed')`:fault==='output_limit'?`process.stdout.write('x'.repeat(20000))`:fault==='timeout'?`setInterval(()=>{},1000)`:fault==='process_failed'?`process.exit(2)`:
    `let s='';for await(const chunk of process.stdin)s+=chunk;const f=s.split('\\t');console.log(JSON.stringify({version:${JSON.stringify(fault==='version'?'other':'kiokuko-fd-v1')},inputId:f[1],inputDigest:'${'0'.repeat(64)}',complete:true,status:'entailed',solutions:1,truth:1,nodes:1,work:1,elapsedMicros:1,peakRssBytes:null}))`
  const script=`#!${process.execPath}\n${body}\n`;await writeFile(join(root,file),script,{mode:0o755})
  await writeFile(join(root,'manifest.json'),JSON.stringify({version:'kiokuko-fd-v1',artifacts:[{file,platform:process.platform,arch:process.arch,bytes:Buffer.byteLength(script),sha256:hash(script),nativeVerified:false}]}))
  const result=await runMicroJudge(problem,hash('fault'),signal(),{artifactRoot:root,timeoutMs:100})
  assert.equal(result.state,'unavailable');if(result.state==='unavailable')assert.equal(result.reason,['malformed','version','digest'].includes(fault)?'malformed_response':fault)
})

test('explicit typed-decision OFF does not fabricate a solver verdict; missing enabled provider is unavailable',async()=>{
  const context=createRequestIntentContext({task:'Implement src/example.ts.',messageRefs:[{id:'current-user',digest:hash('current-user')}]})!
  const candidate=validateMainModelRequestIntent({relation:'new',action:'change',changeScope:'implementation',evidenceRefs:requestIntentReferenceIds(context)},context);assert(candidate.ok);if(!candidate.ok)return
  const service=new DecisionService(TypedDecisionsConfig.parse({mode:'off'}),()=>assert.fail('Explicit OFF must not contact a provider'))
  assert.equal(await assessRequestIntent(service,'disabled-intent',context,candidate.decision,signal()),undefined)
  const missing=await assessRequestIntent(undefined,'missing-provider',context,candidate.decision,signal())
  assert.equal(missing?.outcome,'unavailable');assert.equal(missing?.semantic,'unavailable')
})
