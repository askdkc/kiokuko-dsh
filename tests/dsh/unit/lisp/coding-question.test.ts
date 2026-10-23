import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {askLispCodingQuestion, normalizeLispCodingAnswer, LispCodingCancelled} from '../../../../src/dsh/coding-question.js'
import {LispCodingPreparation} from '../../../../src/dsh/lisp/coding-preparation.js'
const request={questions:[{id:'question',question:'Lisp?'}]} as const
const response=(selected:string[], custom?:string)=>({answers:[{id:'question',selected,...custom===undefined?{}:{custom}}]})
for(const [value,status,choice] of [['1','answered','yes'],['１','answered','yes'],['Lispモードを使う（通常実行）','answered','yes'],['2','answered','no'],['3','cancelled',undefined],['使う','answered','yes'],['使わない','answered','no'],['取消・作業を保持','cancelled',undefined]] as const) test(`question normalizes ${value}`,()=>{
 const result=normalizeLispCodingAnswer(response([value]),'question');assert.equal(result.status,status);if(result.status==='answered')assert.equal(result.choice,choice)
})
test('Skip is terminal cancellation; malformed, mismatched and multiple answers are unavailable',()=>{
 assert.equal(normalizeLispCodingAnswer(response([]),'question').status,'cancelled')
 for(const value of [{}, {answers:[]},response(['invalid']),response(['1','2']),{answers:[{id:'old',selected:[]}]},{answers:[{id:'question'}]},response([], 'unrecognized')])assert.equal(normalizeLispCodingAnswer(value,'question').status,'unavailable')
})
test('provider cancellation is not engine failure and provider failure is not cancellation',async()=>{
 for(const [error,status] of [[Object.assign(new Error('closed'),{code:'ASK_CANCELLED'}),'cancelled'],[new Error('ASK_CANCELLED'),'unavailable'],[new Error('network unavailable'),'unavailable']] as const){
  const result=await askLispCodingQuestion({ask:async()=>{throw error}},request);assert.equal(result.status,status)
 }
 assert.deepEqual(await askLispCodingQuestion(undefined,request),{status:'unavailable',reason:'Question service is unavailable'})
})
test('a hidden card leaves the active ask pending until the host settles it',async()=>{
 let resolve!:(value:any)=>void,settled=false
 const promise=askLispCodingQuestion({ask:()=>new Promise(r=>{resolve=r})},request).then(value=>{settled=true;return value})
 await Promise.resolve();assert.equal(settled,false)
 resolve(response([]));assert.equal((await promise).status,'cancelled')
})
test('pinned DSH UI fixture distinguishes hide, ASK_CANCELLED and submitted Skip',async()=>{
 const path=join(process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(),'tests/fixtures/dsh-runtime/node_modules'),'@deepseek-ai/dsh-client-ui-user-questions/lib/client.js')
 const source=await readFile(path,'utf8')
 assert.match(source,/this\.dismissal === "hide"[\s\S]*?this\.#seat\?\.hide\(\)/u)
 assert.match(source,/waterfall\.reject\("ASK_CANCELLED"\)/u)
 assert.match(source,/if \(value\.skipped\) return \{\s*id: item.id,\s*selected: \[\]/u)
})
function preparation(){
 const agent={id:'agent'},input={agent,turn:1,task:'Implement parser.ts',taskType:'build' as const,signal:new AbortController().signal}
 let resolve!:(value:any)=>void,activations=0,questions=0,sessionId='session'
 const p=new LispCodingPreparation({identity:()=>({sessionId,root:'/root'}),enabled:()=>false,choose:()=>{questions++;return new Promise(r=>{resolve=r})},activate:async()=>{activations++}})
 return {agent,input,p,resolve:(value:any)=>resolve(value),counts:()=>({activations,questions}),session:(value:string)=>{sessionId=value}}
}
test('cancelled attempt cannot retry, run Lisp or auto Bash; next conversation clears only its request gate',async()=>{
 const f=preparation(),first=f.p.prepare(f.input);f.resolve({status:'cancelled',reason:'Skip'})
 await assert.rejects(first,LispCodingCancelled);await assert.rejects(f.p.prepare(f.input),LispCodingCancelled)
 assert.equal((f.p.status(f.agent) as any).phase,'cancelled');assert.deepEqual(f.counts(),{activations:0,questions:1})
 for(const tool of ['bash','lisp_eval','write'])assert.match(f.p.denial(f.agent,tool,{})!,/LISP_REQUEST_CANCELLED/u)
 assert.equal(f.p.denial(f.agent,'read',{}),undefined)
 await f.p.prepare({...f.input,turn:2,task:'Explain what happened'})
 assert.equal(f.p.denial(f.agent,'bash',{}),undefined)
 const next=f.p.prepare({...f.input,turn:3});f.resolve({status:'answered',choice:'no',answerRef:'new'});await next
 assert.deepEqual(f.counts(),{activations:0,questions:2})
})
test('late answers cannot alter a newer request, session or manual decision',async()=>{
 for(const change of ['request','session','manual'] as const){
  const f=preparation(),old=f.p.prepare(f.input),reject=assert.rejects(old,LispCodingCancelled)
  if(change==='request')await f.p.prepare({...f.input,turn:2,task:'Explain the parser'})
  if(change==='session')f.session('different')
  if(change==='manual')f.p.manual(f.agent,false)
  f.resolve({status:'answered',choice:'yes',answerRef:'old'});await reject
  assert.equal(f.counts().activations,0);assert.equal(f.p.denial(f.agent,'write',{}),undefined)
 }
})
test('a provider failure is unavailable, not pending or permission to use Bash',async()=>{
 const f=preparation(),attempt=f.p.prepare(f.input);f.resolve({status:'unavailable',reason:'network failure'})
 await assert.rejects(attempt,/network failure/u);assert.equal((f.p.status(f.agent) as any).phase,'unavailable')
 assert.match(f.p.denial(f.agent,'bash',{})!,/LISP_CHOICE_UNAVAILABLE/u)
})
test('ordinary yes is a convention; an explicit formal workflow keeps the protected prototype gate',async()=>{
 const f=preparation(),attempt=f.p.prepare(f.input);f.resolve({status:'answered',choice:'yes',answerRef:'yes'});await attempt
 assert.equal(f.p.denial(f.agent,'bash',{}),undefined);assert.equal((f.p.status(f.agent) as any).verified,false)
 // Enabled runtime is separate from permissions; formal workflow itself is covered
 // by coding-preparation tests, which enable the runtime before asserting the gate.
 assert.equal((f.p.status(f.agent) as any).phase,'selected')
})
