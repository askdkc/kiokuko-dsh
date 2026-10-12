import assert from 'node:assert/strict'
import test from 'node:test'
import { selectExecution, ExecutionSelectionPending } from '../../../src/dsh/model-selection-ui.js'
import { HEAD_WORKER_LABEL } from '../../../src/dsh/head-worker-configuration.js'
import type { StoredExecutionSelection } from '../../../src/dsh/execution-selection.js'
const pair = { preset: 'gpt-6.1-sol-deepseek-v4.1-flash' as const, head: { provider: 'sol', model: 'gpt-6.1-sol' }, worker: { provider: 'flash', model: 'deepseek-flash' } }
const llm = { listProviders: () => [{id:'sol',name:'Sol'}, {id:'flash',name:'Flash',route:{provider:'flash',family:'deepseek' as const,connection:'api' as const,protocol:'chat-completions' as const}}],
  listModels: async (provider: string) => [{provider,id:provider==='sol'?'gpt-6.1-sol':'deepseek-flash',name:provider}], resolveCallConfig:async (b:any)=>b }
async function choose(mode: 'normal'|'enno', answer = 'この構成で開始', models = llm) {
  let stored: StoredExecutionSelection = {revision:0,value:{mode:'pending',status:'selecting'}}
  const cards: any[] = []
  const result = await selectExecution({ task:'Fix',stored,signal:new AbortController().signal,routes:[],llm:models,
    save:async(revision,value)=>stored={revision:revision+1,value}, questions:{ask:async request=>{
      const q=request.questions[0];cards.push(q)
      const selected=q.id==='enno-execution-mode'?(mode==='normal'?`通常実行: ${HEAD_WORKER_LABEL}`:'役小角を使う'):q.id==='enno-model-source'?HEAD_WORKER_LABEL:q.id==='head-worker-review'?answer:'取消・作業を保持'
      return {answers:[{id:q.id,selected:[selected]}]}
    }} }).catch(e=>{if(!(e instanceof ExecutionSelectionPending))throw e;return undefined})
  return {stored,result,cards}
}
test('normal explicitly chooses and durably saves pair, ordinary choice remains available',async()=>{
  const {result,cards}=await choose('normal')
  assert.deepEqual(result?.value.headWorker,pair);assert.equal(result?.value.mode,'normal');assert.equal(result?.value.status,'ready')
  assert.ok(cards[0].options.some((o:any)=>o.label==='通常実行'))
})
test('Enno explicitly chooses pair and preserves parent versus delegated role mapping',async()=>{
  const {result}=await choose('enno')
  assert.deepEqual(result?.value.headWorker,pair)
  assert.deepEqual(result?.value.configuration?.roles.worker,pair.worker)
  assert.deepEqual(result?.value.configuration?.roles.goki,pair.head)
})
test('cancel pair review never saves a ready pair or changes prior selection',async()=>{
  const {stored,result}=await choose('normal','取消・作業を保持')
  assert.equal(result,undefined);assert.equal(stored.value.headWorker,undefined);assert.equal(stored.value.status,'selecting')
})
test('unavailable pair gives explicit reason and no start choice or fallback',async()=>{
  const {stored,cards}=await choose('normal','この構成で開始',{...llm,listModels:async()=>[]})
  assert.equal(stored.value.headWorker,undefined)
  assert.ok(cards.some(q=>q.id==='head-worker-unavailable'&&q.detail.includes('利用可能な接続')))
})
test('a profile pair seeds new Enno review without changing an existing custom draft',async()=>{
  let stored:StoredExecutionSelection={revision:0,value:{mode:'enno',status:'selecting'}}
  const result=await selectExecution({task:'fix',stored,savedHeadWorker:pair,llm,routes:[],signal:new AbortController().signal,
    save:async(revision,value)=>stored={revision:revision+1,value},questions:{ask:async r=>({answers:[{id:r.questions[0].id,selected:['この構成で開始']}]})}})
  assert.deepEqual(result.value.headWorker,pair)
  assert.deepEqual(result.value.configuration?.roles.worker,pair.worker)
})
test('cancellation during final asynchronous catalog validation cannot authorize a pair',async()=>{
  for(const mode of ['normal','enno'] as const){
    const controller=new AbortController();let confirmed=false;const saved:StoredExecutionSelection[]=[]
    let stored:StoredExecutionSelection={revision:0,value:{mode:'pending',status:'selecting'}}
    await assert.rejects(selectExecution({task:'fix',stored,routes:[],signal:controller.signal,
      llm:{...llm,resolveCallConfig:async b=>{if(confirmed)controller.abort();return b}},
      save:async(revision,value)=>{stored={revision:revision+1,value};saved.push(stored);return stored},questions:{ask:async r=>{
        const id=r.questions[0].id;const choice=id==='enno-execution-mode'?(mode==='normal'?`通常実行: ${HEAD_WORKER_LABEL}`:'役小角を使う'):id==='enno-model-source'?HEAD_WORKER_LABEL:'この構成で開始'
        if(id==='head-worker-review')confirmed=true
        return {answers:[{id,selected:[choice]}]}
      }}}),ExecutionSelectionPending)
    assert.ok(saved.every(s=>s.value.status!=='ready'))
  }
})
test('durable selections reject mismatched Enno roles and Deep ownership for this preset',async()=>{
  const { ExecutionSelectionSchema }=await import('../../../src/dsh/execution-selection.js')
  const { headWorkerEnnoConfiguration }=await import('../../../src/dsh/head-worker-configuration.js')
  const configuration=headWorkerEnnoConfiguration(pair)
  configuration.roles.worker=pair.head
  assert.equal(ExecutionSelectionSchema.safeParse({mode:'enno',status:'ready',headWorker:pair,configuration}).success,false)
  assert.equal(ExecutionSelectionSchema.safeParse({mode:'deep-thinker',status:'selecting',headWorker:pair}).success,false)
})
