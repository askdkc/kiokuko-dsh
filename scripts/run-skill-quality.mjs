import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {parseEvaluationConfig,createEvaluationBudget} from './skill-evaluation-config.mjs'

const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]}
const digest=value=>createHash('sha256').update(value).digest('hex')
const pstack=process.argv.includes('--pstack')
const fixtureText=await readFile(new URL(pstack?'../tests/fixtures/skill-prompts/pstack-scenarios.json':'../tests/fixtures/skill-prompts/scenarios.json',import.meta.url),'utf8')
const fixtures=JSON.parse(fixtureText)
const configPath=arg('--config')
if(!configPath){console.log(JSON.stringify({status:'unmeasured',modelRequests:0,defaultMode:'full',reason:'Provide an explicit model, endpoint, credential reference and evaluation budget; no provider was contacted.'}));process.exit(0)}
const {DshSkillPrompts}=await import('../dist/dsh/skill-prompts.js')
const config=parseEvaluationConfig(JSON.parse(await readFile(configPath,'utf8')))
const key=process.env[config.apiKeyEnv];if(!key)throw new Error('Evaluation credential is unavailable')
const output=resolve(arg('--output')??'skill-quality-results');await mkdir(output,{recursive:true})
const reportFile=join(output,'report.json');await writeFile(reportFile,JSON.stringify({status:'running'})+'\n',{flag:'wx'})
const baseline=JSON.parse(await readFile(new URL(pstack?'../tests/fixtures/skill-prompts/pstack-baseline.json':'../tests/fixtures/skill-prompts/baseline.json',import.meta.url),'utf8'))
const prompts=new DshSkillPrompts({mode:'compiled'})
const addedSkills=new Set(['investigate','architecture','review','benchmark','verification','skill-authoring','technical-writing'].map(name=>`kiokuko-${name}`))
const old=name=>{
  const source=baseline.resources.find(r=>r.path===`skills/${name==='natural-japanese-output'?'japanese-translation-for-oss-models':name}/SKILL.md`)
  if(source)return source.content
  if(pstack&&addedSkills.has(name))return ''
  throw new Error(`Missing baseline Skill: ${name}`)
}
const fullPrompts=new DshSkillPrompts({mode:'full'})
const modes=pstack?['baseline-full','candidate-full','compiled']:['full','compiled']
const records=[],blind=[],signal=AbortSignal.timeout(config.maxDurationMs)
const budget=createEvaluationBudget(config)
let status='measured'
outer:for(const scenario of fixtures.cases)for(let repeat=0;repeat<3;repeat++)for(const mode of modes.map((_,i)=>modes[(i+repeat)%modes.length])){
  if(signal.aborted||!budget.reserve()){status='budget_exhausted';break outer}
  const system=(mode==='full'||mode==='baseline-full'?scenario.skills.map(old):await Promise.all(scenario.skills.map(name=>(mode==='candidate-full'?fullPrompts:prompts).require(name)))).join('\n\n')
  if(mode==='compiled'&&prompts.diagnostics().some(d=>d.fallback))throw new Error('Quality evaluation cannot treat fallback as compiled evidence')
  const body={model:config.model,messages:[{role:'system',content:system},{role:'user',content:scenario.prompt}],max_tokens:config.maxOutputTokens,temperature:config.temperature,stream:false}
  const started=Date.now()
  const record={systemBytes:Buffer.byteLength(system),elapsedMs:null,case:scenario.id,repeat,mode,status:'failed',inputDigest:digest(JSON.stringify(body)),responseDigest:null,correct:false,usage:null};records.push(record)
  try{
    const response=await fetch(`${config.baseURL.replace(/\/$/,'')}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify(body),signal})
    if(!response.ok)throw new Error('provider_http_error')
    let data='';for await(const chunk of response.body){data+=Buffer.from(chunk).toString('utf8');if(Buffer.byteLength(data)>262144)throw new Error('response_limit')}
    const value=JSON.parse(data);if(value.model!==config.model)throw new Error('model_identity_changed')
    const answer=value.choices?.[0]?.message?.content;if(typeof answer!=='string'||value.choices[0].finish_reason!=='stop')throw new Error('incomplete_answer')
    record.elapsedMs=Date.now()-started;record.responseDigest=digest(answer);record.status='completed';record.usage=value.usage??null
    if(scenario.japanese){
      try { record.correct=scenario.contains?answer.includes(scenario.contains):Object.entries(scenario.literal).every(([k,v])=>JSON.parse(answer)[k]===v) } catch { record.correct=false }
      blind.push({id:digest(`${scenario.id}:${repeat}:${mode}`).slice(0,16),prompt:scenario.prompt,answer,responseDigest:record.responseDigest})
    }else { try { record.correct=isDeepStrictEqual(JSON.parse(answer),scenario.expected) } catch { record.correct=false } }
  }catch{status=signal.aborted?'budget_exhausted':'failed';break outer}
}
const machine=mode=>records.filter(r=>r.mode===mode&&r.correct).length
const complete=records.length===fixtures.cases.length*3*modes.length&&records.every(r=>r.status==='completed')
blind.sort((a,b)=>a.id.localeCompare(b.id))
await writeFile(join(output,'blind-review.json'),JSON.stringify({rubric:'Score natural Japanese 1–5; separately flag meaning, identifier, schema and modality violations. Mode is withheld; map by responseDigest after review.',items:blind},null,2)+'\n',{flag:'wx'})
const report={status,fixtureDigest:digest(fixtureText),model:config.model,revision:config.revision,repetitions:3,records,scope:'isolated contract behavior probes; production and serializer paths have separate native tests',gates:{complete,noRequiredViolations:complete&&records.every(r=>r.correct),compiledSuccessNotLower:complete&&machine('compiled')>=machine(pstack?'baseline-full':'full'),candidateSuccessNotLower:!pstack||machine('candidate-full')>=machine('baseline-full'),blindJapaneseReview:'pending'},eligibleForDefault:false,defaultMode:'full',note:'Default promotion also requires reviewed Japanese scores not lower than full, zero meaning violations, and passing native/packed delivery. This runner never changes configuration.'}
await writeFile(reportFile,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({status,requests:records.length,eligibleForDefault:false,report:reportFile}))
if(status!=='measured'||!complete||(pstack&&!report.gates.noRequiredViolations))process.exitCode=1
