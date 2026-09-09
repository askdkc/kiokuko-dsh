import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

test('the four-condition evaluation runs end to end; a contract mock never passes quality admission', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'evolution-evaluator-'))
  const baseUrl='http://127.0.0.1:1/v1'
  await writeFile(path.join(root,'mock.mjs'), `
    globalThis.fetch = async (url, request) => {
      const parsed = JSON.parse(request.body)
      const capsule = {schemaVersion:1,memories:[{kind:'reference',title:'Observed migration',body:'Migration was attempted.',summary:null,tags:[],confidence:0.5}]}
      const prompt = parsed.messages?.at(-1)?.content ?? ''
      if (!prompt.includes('SQLITE_BUSY')) capsule.memories=[]
      if (prompt.includes('schemaVersion:2') && prompt.includes('SQLITE_BUSY')) {
        const native = JSON.parse(prompt.split('\\n\\n').at(-1))
        const action = native.find(e=>e.kind==='action'), result = native.find(e=>e.kind==='result')
        capsule.schemaVersion=2
        capsule.episode={goal:native.find(e=>e.kind==='user').text.split('\\n')[0],applicability:'Unknown',anchors:{error:'unknown',tool:'unknown',target:'unknown',version:'unknown'},events:[{kind:'action',description:action.text,evidence:[action.seq]},{kind:'verification',description:result.text,evidence:[result.seq]}],procedure:action.text,verification:result.text,boundary:'Unknown',unresolved:[],avoidance:null}
      }
      const result = String(url).endsWith('/embeddings')
        ? {model:parsed.model,data:[{index:0,embedding:[1,0,0,0]}]}
        : {model:parsed.model,usage:{prompt_tokens:1,completion_tokens:1},choices:[{finish_reason:'stop',message:{content:JSON.stringify(capsule)}}]}
      return new Response(JSON.stringify(result), {headers:{'content-type':'application/json'}})
    }
  `)
  try {
    await writeFile(path.join(root,'config.json'),JSON.stringify({llm:{baseUrl,model:'contract-mock-not-real',revision:'contract-only',contextWindow:100000},embedding:{baseUrl,model:'contract-vector-not-real',revision:'contract-only',dimensions:4}}))
    const result=await new Promise<{code:number|null;output:string}>((resolve,reject)=>{
      const env={...process.env};delete env.NODE_TEST_CONTEXT
      const child=spawn(process.execPath,['--import',path.join(root,'mock.mjs'),'--import','tsx','scripts/run-evolution-evaluation.mjs','--config',path.join(root,'config.json'),'--output',root],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']})
      let output='';child.stdout.on('data',data=>{output+=data});child.stderr.on('data',data=>{output+=data})
      child.on('error',reject);child.on('exit',code=>resolve({code,output}))
    })
    assert.equal(result.code,0,result.output)
    const report=JSON.parse(await readFile(path.join(root,'report.json'),'utf8'))
    assert.equal(report.eligibleForActive,false);assert.equal(report.gates.semanticSafetyReviewed,false)
    assert.equal(report.metrics.length,8);assert.equal(report.fixture.queries,120)
    assert.ok(report.counters.llmCalls>=90);assert.ok(report.counters.embeddingCalls>0)
    assert.equal(report.metrics.find((m:any)=>m.condition==='full'&&m.split==='heldout').queries,80)
  } finally {await rm(root,{recursive:true,force:true})}
})
