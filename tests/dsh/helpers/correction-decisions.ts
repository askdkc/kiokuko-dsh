import assert from 'node:assert/strict'
import {createServer} from 'node:http'
/** Scripted known-input transport fixture. Never a semantic-quality benchmark. */
export async function correctionDecisionFixture(expectedBody:string,options:{choice?:'capability_compatibility'|'reference'|'uncertain'|'unavailable';mode?:'shadow'|'auto'}={}){
  let calls=0
  const intents=new Map([
    ['Explain Rust compiler compatibility. Do not change files.',{action:'answer',changeScope:'unknown',taskType:'research'}],
    ['Fix Rust compiler compatibility in scripts/check.mjs. 通常実行で。',{action:'change',changeScope:'implementation',taskType:'build'}],
    ['Verify Rust compiler capabilities and fix scripts/check.mjs. 通常実行で。',{action:'change',changeScope:'implementation',taskType:'build'}],
  ])
  const server=createServer(async(request,response)=>{
    try{
      let text='';for await(const chunk of request){text+=chunk;assert.ok(text.length<262144)}
      const body=JSON.parse(text)
      const semantic=body.state?.policy==='correction-meaning-v1'
      const source=body.state?.source?.task??body.state?.currentUserMessage??body.state?.task,truth=intents.get(source)
      if(!semantic&&!truth){response.writeHead(503);response.end();return}
      if(semantic){assert.equal(body.state.correction.body,expectedBody);assert.deepEqual(Object.keys(body.questions),['correction-rule']);calls++}
      if(semantic&&options.choice==='unavailable'){response.writeHead(503);response.end();return}
      const candidate=body.state?.candidate
      const matches=truth&&candidate?.action===truth.action&&(truth.action!=='change'||candidate?.changeScope===truth.changeScope)
      const answers=Object.fromEntries(Object.entries(body.questions).map(([id,q]:[string,any])=>{
        const choice=semantic?(options.choice??'capability_compatibility'):candidate?(matches?'supported':'contradicted'):
          ({'request-action':truth!.action,'request-change-scope':truth!.changeScope,'request-relation':'new','task-type':truth!.taskType} as Record<string,string>)[id]
        assert.ok(choice&&Object.hasOwn(q.criteria,choice),'Unknown independent fixture question')
        return [id,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0]))}]
      }))
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({model:body.model,answers}))
    }catch{response.writeHead(503);response.end()}
  })
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const address=server.address();assert.ok(address&&typeof address!=='string')
  return {configuration:{provider:'nimble',nimble:{endpoint:`http://127.0.0.1:${address.port}`,model:'independent-correction-fixture'},correctionClassification:{mode:options.mode??'auto'}},
    calls:()=>calls,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}}
}
