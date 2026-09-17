import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {z} from 'zod'

const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1]}
const digest=value=>createHash('sha256').update(value).digest('hex')
const fixtureText=await readFile(new URL('../tests/fixtures/skill-prompts/scenarios.json',import.meta.url),'utf8')
const fixtures=JSON.parse(fixtureText)
const configPath=arg('--config')
if(!configPath){console.log(JSON.stringify({status:'unmeasured',modelRequests:0,defaultMode:'full',reason:'Provide an explicit model, endpoint, credential reference and evaluation budget; no provider was contacted.'}));process.exit(0)}
const {DshSkillPrompts}=await import('../dist/dsh/skill-prompts.js')
const config=z.object({model:z.string().min(1).max(256),revision:z.string().min(1).max(256),baseURL:z.string().url(),apiKeyEnv:z.string().regex(/^[A-Z][A-Z0-9_]*$/),allowRemote:z.boolean(),maxRequests:z.number().int().min(1).max(500),maxTokens:z.number().int().positive(),maxDurationMs:z.number().int().min(1000).max(3600000),contextWindow:z.number().int().min(4096).max(1048576),maxOutputTokens:z.number().int().min(64).max(4096),temperature:z.number().min(0).max(2)}).strict().parse(JSON.parse(await readFile(configPath,'utf8')))
const endpoint=new URL(config.baseURL)
if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!['http:','https:'].includes(endpoint.protocol))throw new Error('Invalid evaluation endpoint')
if(!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)&&(!config.allowRemote||endpoint.protocol!=='https:'))throw new Error('Remote evaluation requires HTTPS and allowRemote:true')
const key=process.env[config.apiKeyEnv];if(!key)throw new Error('Evaluation credential is unavailable')
const output=resolve(arg('--output')??'skill-quality-results');await mkdir(output,{recursive:true})
const reportFile=join(output,'report.json');await writeFile(reportFile,JSON.stringify({status:'running'})+'\n',{flag:'wx'})
const baseline=JSON.parse(await readFile(new URL('../tests/fixtures/skill-prompts/baseline.json',import.meta.url),'utf8'))
const prompts=new DshSkillPrompts({mode:'compiled'})
const old=name=>baseline.resources.find(r=>r.path===`skills/${name==='natural-japanese-output'?'japanese-translation-for-oss-models':name}/SKILL.md`).content
const records=[],blind=[],signal=AbortSignal.timeout(config.maxDurationMs)
let reserved=0,status='measured'
outer:for(const scenario of fixtures.cases)for(let repeat=0;repeat<3;repeat++)for(const mode of repeat%2?['compiled','full']:['full','compiled']){
  const reserve=config.contextWindow+config.maxOutputTokens
  if(records.length>=config.maxRequests||reserved+reserve>config.maxTokens||signal.aborted){status='budget_exhausted';break outer}
  reserved+=reserve
  const system=(mode==='full'?scenario.skills.map(old):await Promise.all(scenario.skills.map(name=>prompts.require(name)))).join('\n\n')
  if(mode==='compiled'&&prompts.diagnostics().some(d=>d.fallback))throw new Error('Quality evaluation cannot treat fallback as compiled evidence')
  const body={model:config.model,messages:[{role:'system',content:system},{role:'user',content:scenario.prompt}],max_tokens:config.maxOutputTokens,temperature:config.temperature,stream:false}
  const record={case:scenario.id,repeat,mode,status:'failed',inputDigest:digest(JSON.stringify(body)),responseDigest:null,correct:false,usage:null};records.push(record)
  try{
    const response=await fetch(`${config.baseURL.replace(/\/$/,'')}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify(body),signal})
    if(!response.ok)throw new Error('provider_http_error')
    let data='';for await(const chunk of response.body){data+=Buffer.from(chunk).toString('utf8');if(Buffer.byteLength(data)>262144)throw new Error('response_limit')}
    const value=JSON.parse(data);if(value.model!==config.model)throw new Error('model_identity_changed')
    const answer=value.choices?.[0]?.message?.content;if(typeof answer!=='string'||value.choices[0].finish_reason!=='stop')throw new Error('incomplete_answer')
    record.responseDigest=digest(answer);record.status='completed';record.usage=value.usage??null
    if(scenario.japanese){
      try { record.correct=scenario.contains?answer.includes(scenario.contains):Object.entries(scenario.literal).every(([k,v])=>JSON.parse(answer)[k]===v) } catch { record.correct=false }
      blind.push({id:digest(`${scenario.id}:${repeat}:${mode}`).slice(0,16),prompt:scenario.prompt,answer,responseDigest:record.responseDigest})
    }else { try { record.correct=isDeepStrictEqual(JSON.parse(answer),scenario.expected) } catch { record.correct=false } }
  }catch{status=signal.aborted?'budget_exhausted':'failed';break outer}
}
const machine=mode=>records.filter(r=>r.mode===mode&&r.correct).length
const complete=records.length===fixtures.cases.length*6&&records.every(r=>r.status==='completed')
blind.sort((a,b)=>a.id.localeCompare(b.id))
await writeFile(join(output,'blind-review.json'),JSON.stringify({rubric:'Score natural Japanese 1–5; separately flag meaning, identifier, schema and modality violations. Mode is withheld; map by responseDigest after review.',items:blind},null,2)+'\n',{flag:'wx'})
const report={status,fixtureDigest:digest(fixtureText),model:config.model,revision:config.revision,repetitions:3,records,scope:'isolated contract behavior probes; production and serializer paths have separate native tests',gates:{complete,noRequiredViolations:complete&&records.every(r=>r.correct),compiledSuccessNotLower:complete&&machine('compiled')>=machine('full'),blindJapaneseReview:'pending'},eligibleForDefault:false,defaultMode:'full',note:'Default promotion also requires reviewed Japanese scores not lower than full, zero meaning violations, and passing native/packed delivery. This runner never changes configuration.'}
await writeFile(reportFile,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({status,requests:records.length,eligibleForDefault:false,report:reportFile}))
if(status!=='measured'||!complete)process.exitCode=1
