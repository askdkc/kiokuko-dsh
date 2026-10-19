// Only these exact synthetic sources have known meaning. No external model/API call.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
export async function intentDecisionWebFixture() {
  const calls=[]
  const sources=new Map([
    ['Save the requested note in change.txt using Lisp.',{action:'change',changeScope:'document'}],
    ['Verify the repository using Lisp. 通常実行で。',{action:'verify',changeScope:'unknown'}],
  ])
  const server=createServer(async(request,response)=>{
    try {
      assert.equal(request.method,'POST')
      let bytes='';for await(const chunk of request){bytes+=chunk;assert.ok(bytes.length<262144)}
      const body=JSON.parse(bytes),state=body.state,semantic=!!state?.source?.task
      const task=semantic?state.source.task:state?.currentUserMessage,expected=sources.get(task)
      calls.push({task,semantic,candidate:state?.candidate})
      const matches=expected&&state.candidate?.action===expected.action&&(expected.action!=='change'||state.candidate?.changeScope===expected.changeScope)
      const answers=Object.fromEntries(Object.entries(body.questions).map(([id,q])=>{
        const choice=semantic?(!expected?'insufficient':matches?'supported':'contradicted')
          :({'request-action':expected?.action,'request-change-scope':expected?.changeScope,'request-relation':expected?'new':undefined,'task-type':expected?.action==='change'?'writing':'review'})[id]
        assert.ok(choice&&Object.hasOwn(q.criteria,choice),'Unknown fixture question or original source')
        return [id,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(key=>[key,key===choice?1:0]))}]
      }))
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({model:body.model,answers}))
    }catch{response.writeHead(503);response.end()}
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  return {endpoint:`http://127.0.0.1:${server.address().port}`,calls,close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
}
