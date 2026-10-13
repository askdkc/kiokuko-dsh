import test from 'node:test'
import assert from 'node:assert/strict'
import { ObservationPack } from '../../../../src/dsh/observation-pack/service.js'
import { observationExcerpt, observationHandle, packedMessage, packedSource, textDigest } from '../../../../src/dsh/observation-pack/policy.js'
import { SessionProgress } from '../../../../src/dsh/semantic-compaction/progress.js'
import { requestSize } from '../../../../src/dsh/efficiency.js'
import type { SurfaceEvent, NativeTokenMeter } from '../../../../src/dsh/semantic-compaction/contracts.js'

function setup(text:string,mode:'auto'|'off'='auto',exposures=2) {
  const events:SurfaceEvent[]=[{seq:0,type:'tool/call',data:{callId:'source',name:'read'}},
    {seq:1,type:'tool/result',sourceEventSeqs:[0],data:{message:{id:'result',role:'tool',toolCallId:'source',source:{kind:'tool',callId:'source'},isError:false,content:[{type:'text',text}]}}}]
  for(let i=0;i<exposures;i++)events.push({seq:events.length,type:'assistant/message',data:{stream:[],message:{id:`exposure-${i}`,source:{kind:'model'},role:'assistant',content:[{type:'text',text:'continue'}]}}})
  const session:any={id:'budget-session',header:{version:4},surface:{nodes:[1]},get seq(){return events.length},eventAt:(seq:number)=>events[seq]}
  const definitions=new Map<string,any>(), tools={get:(name:string)=>definitions.get(name),schemas:()=>[...definitions.values()].map(({name,description,parameters})=>({name,description,parameters})),register:(def:any)=>{definitions.set(def.name,def);return()=>definitions.delete(def.name)}}
  const agent:any={session}, controller=new AbortController()
  const pack=new ObservationPack({get:()=>tools,on:()=>()=>{}},{mode},async()=>({owner:'fixture'}),controller.signal)
  const schemas=tools.schemas();pack.assembled(agent,schemas)
  // Eligibility uses serialized UTF-8 bytes, not a token measurement.
  const meter={estimateMessage:(message:unknown)=>Buffer.byteLength(JSON.stringify(message))} as NativeTokenMeter
  const candidates=pack.candidates(session,meter,new SessionProgress(session),false)
  const original=events[1]!, message=original.data.message
  const request=(messages:any[])=>({system:'Synthetic experiment',tools:schemas,messages})
  return {pack,session,original,message,schemas,candidates,request,read:(offset:number,limit=2000)=>definitions.get('observation_read').execute({handle:observationHandle(session.id,original),offset,limit},{agent,signal:controller.signal})}
}
for(const [name,text] of [['english','ordinary source material\n'.repeat(5000)],['japanese','日本語🙂𠮷 line\n'.repeat(5000)],['single-line','x'.repeat(120000)]] as const)test(`fixed ten-request byte budget: ${name}`,async t=>{
  const auto=setup(text),off=setup(text,'off')
  try{
    assert.deepEqual(auto.schemas,off.schemas)
    const replacement=auto.candidates[0]?.replacement??auto.message
    let autoBytes=0,offBytes=0
    for(let i=0;i<10;i++){
      autoBytes+=requestSize(auto.request([i<2?auto.message:replacement])).totalBytes
      offBytes+=requestSize(off.request([off.message])).totalBytes
    }
    assert.equal(off.candidates.length,0)
    if(name==='single-line'){assert.equal(auto.candidates.length,0);assert.equal(autoBytes,offBytes)}
    else{assert.equal(auto.candidates.length,1);assert.ok(autoBytes<=offBytes*.25);assert.ok(Buffer.byteLength(observationExcerpt(text).replace('\n…\n',''))<=1024)}
    assert.equal(auto.pack.stats.reads,0)
    t.diagnostic(JSON.stringify({name,requests:10,sourceBytes:Buffer.byteLength(text),packedBytes:Buffer.byteLength(JSON.stringify(replacement)),readerDefinitionBytes:requestSize(auto.request([])).toolsBytes,autoBytes,offBytes,reads:0,readBytes:0,usage:null}))
  }finally{auto.pack.stop();off.pack.stop()}
})
test('historical single-line sixty-page read-back costs more than retaining the source',async t=>{
  const text='x'.repeat(120000),f=setup(text)
  try{
    const legacy=packedMessage(f.session.id,f.original)
    assert.equal(packedSource(f.session,{seq:4,type:'tool/result',sourceEventSeqs:[1],data:{message:legacy}}),f.original)
    const baseline=requestSize(f.request([legacy])).totalBytes,history:any[]=[legacy]
    let extraBytes=0,joined='',pages=0
    for(let offset=0;offset<text.length;offset+=2000){
      const page=await f.read(offset);joined+=page.text;pages++
      assert.equal(page.digest,textDigest(text));assert.equal(page.bytes,120000)
      history.push({role:'assistant',content:[{type:'tool-call',id:`page-${pages}`,name:'observation_read',arguments:{handle:observationHandle(f.session.id,f.original),offset,limit:2000}}]},
        {role:'tool',toolCallId:`page-${pages}`,content:[{type:'text',text:JSON.stringify(page)}]})
      extraBytes+=requestSize(f.request(history)).totalBytes
    }
    assert.equal(joined,text);assert.equal(pages,60)
    extraBytes+=7*(requestSize(f.request(history)).totalBytes-baseline)
    const legacyTen=2*requestSize(f.request([f.message])).totalBytes+8*baseline
    const offTen=10*requestSize(f.request([f.message])).totalBytes
    assert.ok(legacyTen+extraBytes>offTen)
    assert.equal(f.candidates.length,0)
    t.diagnostic(JSON.stringify({requests:10+pages,sourceBytes:120000,readerDefinitionBytes:requestSize(f.request([])).toolsBytes,reads:f.pack.stats.reads,readBytes:f.pack.stats.readBytes,legacyBytes:legacyTen+extraBytes,offBytes:offTen,usage:null}))
  }finally{f.pack.stop()}
})
for(const n of [10239,10240,10241])for(const exposures of [1,2])test(`byte threshold independent of excerpt: ${n}/${exposures}`,()=>{
  const f=setup(('x\n'.repeat(6000)).slice(0,n),'auto',exposures)
  try{assert.equal(f.candidates.length,n>10240&&exposures===2?1:0)}finally{f.pack.stop()}
})
for(const text of ['HEAD\n'+'x'.repeat(120000)+'\nTAIL\n',' \n'.repeat(6000)])test('complete source lines remain eligible, including whitespace',()=>{
  const f=setup(text)
  try{assert.equal(f.candidates.length,1);assert.notEqual(observationExcerpt(text),'\n…\n')}finally{f.pack.stop()}
})
