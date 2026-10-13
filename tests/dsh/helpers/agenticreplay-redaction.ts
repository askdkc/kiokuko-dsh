import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { agenticReplayFixture, chunks, collect, request, response } from './agenticreplay-fixture.js'
import { checkedRunDir } from '../../../src/dsh/agenticreplay-security.js'
import { loadAgenticReplayLibrary } from '../../../src/dsh/agenticreplay-libraries.js'
import { scanAgenticReplayTrace } from '../../../src/dsh/agenticreplay-files.js'

export async function captureRedactionCase(input: string, content: 'redacted'|'metadata', reasoning = false) {
  const f = await agenticReplayFixture({ capture:{content,reasoning}, maxTimelineEventsPerPage:2, shutdownDrainTimeoutMs:1000 })
  try {
    const body = `ordinary-visible-evidence\n${input}\nstatus=ok`
    const req = {...request, system:body, messages:[
      {role:'user',content:[{type:'text',text:body}]},
      {role:'assistant',content:[{type:'tool-call',id:'fixture-call',name:'fixture',arguments:{command:body}}]},
    ]}
    // The split passes through the middle of the secret, before final projection.
    const split = Math.floor(body.length/2)
    const values = response(body).flatMap<any>(chunk=>chunk.type==='text-delta' ? [{type:'text-delta',index:0,text:body.slice(0,split)},{type:'text-delta',index:0,text:body.slice(split)}] : [chunk])
    values.splice(values.length-1,0,...[
      {type:'reasoning-delta',index:1,text:`private-reasoning-evidence\n${input}`},
    ] as any[])
    assert.deepEqual(await collect(f.recorder.stream(f.binding,req,()=>chunks(values))),values)
    const exec = {token:Symbol(),callId:'case-call',rootCallId:'case-call',name:'fixture',arguments:{command:body}}
    const result = {isError:false,content:[{type:'text',text:body}]}
    f.recorder.preTool(f.binding,exec); f.recorder.toolDecision(exec,{kind:'allow'})
    f.recorder.toolDispatch(exec); f.recorder.toolDispatched(exec); f.recorder.toolResult(f.binding,exec,result)
    assert.equal(result.content[0]!.text,body)
    await f.recorder.shutdown()
    const row = (await f.reader.list(f.binding))[0]!
    assert.equal(row.state,'completed'); assert.equal(row.last_error_code,null)
    assert.equal(row.missing_event_count,0); assert.equal(row.unresolved_call_count,0)
    const dir=await checkedRunDir(f.root,row.agenticreplay_run_id)
    const {TraceReader}=await loadAgenticReplayLibrary('core')
    const native=await TraceReader.open(dir), events=await native.events()
    assert.equal(events.length,row.event_count)
    const schema=await loadAgenticReplayLibrary('schema')
    for(const event of events)(schema.assertEvent as (v:unknown)=>void)(event)
    const scan=await scanAgenticReplayTrace(dir,row.agenticreplay_run_id,f.config.maxHtmlExportInputBytes,f.config.maxHtmlExportEvents)
    ;(schema.assertManifest as (v:unknown)=>void)(scan.manifest)
    const files: {path:string;body:string}[]=[]
    async function walk(root:string) {
      for(const entry of await readdir(root,{withFileTypes:true})) {
        const path=join(root,entry.name)
        if(entry.isDirectory())await walk(path)
        else files.push({path,body:(await readFile(path)).toString('utf8')})
      }
    }
    await walk(dir)
    const shown:unknown[]=[];let cursor:string|undefined
    do {const page=await f.reader.show(f.binding,row.agenticreplay_run_id,cursor);shown.push(...page.events);cursor=page.cursor}while(cursor)
    assert.equal(shown.length,events.length)
    const html=await readFile(await f.reader.export(f.binding,row.agenticreplay_run_id),'utf8')
    const htmlText=html.replace(/&quot;/gu,'"').replace(/&#39;/gu,"'").replace(/&lt;/gu,'<').replace(/&gt;/gu,'>').replace(/&amp;/gu,'&')
    const embedded=[...html.matchAll(/data:[^"\s,]*;base64,([A-Za-z0-9+/=]+)/gu)].map(m=>Buffer.from(m[1]!,'base64').toString('utf8'))
    for(const match of htmlText.matchAll(/href="data:[^",]*,([^"\s]*)"/gu))embedded.push(decodeURIComponent(match[1]!))
    const inspect=(needle:string)=> {
      for(const event of events)assert.ok(!JSON.stringify(event).includes(needle),`${event.type}: ${needle}`)
      for(const file of files)assert.ok(!file.body.includes(needle),file.path)
      assert.ok(!JSON.stringify(shown).includes(needle));assert.ok(!html.includes(needle))
      for(const body of embedded)assert.ok(!body.includes(needle),'embedded export payload')
    }
    const requestEvent=events.find(e=>e.type==='model.request')!, model=events.find(e=>e.type==='model.response')!
    const call=events.find(e=>e.type==='tool.call')!, tool=events.find(e=>e.type==='tool.result')!
    for(const event of [requestEvent,model,call,tool])assert.ok(event)
    assert.deepEqual(model.causes,[requestEvent.seq]);assert.deepEqual(tool.causes,[call.seq])
    assert.equal(model.attrs!.input_tokens,12);assert.equal(model.attrs!.output_tokens,5)
    const persisted=files.map(f=>f.body).join('\n')
    if(content==='redacted') {
      assert.ok(persisted.includes('ordinary-visible-evidence'));assert.ok(html.includes('ordinary-visible-evidence'))
    } else {inspect('ordinary-visible-evidence');assert.equal(call.payload,undefined)}
    if(!reasoning || content==='metadata')inspect('private-reasoning-evidence')
    else assert.ok(persisted.includes('private-reasoning-evidence'))
    return {inspect,events,files,html,htmlText,persisted,blobCount:scan.manifest.counts!.blobs}
  } finally {await f.dispose()}
}
