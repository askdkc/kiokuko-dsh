import assert from 'node:assert/strict'
import test from 'node:test'
import { selectExecution, ExecutionSelectionPending } from '../../../src/dsh/model-selection-ui.js'
import { HEAD_WORKER_LABEL } from '../../../src/dsh/head-worker-configuration.js'
import type { StoredExecutionSelection } from '../../../src/dsh/execution-selection.js'
const pair = { preset: 'gpt-6.1-sol-deepseek-v4.1-flash' as const, head: { provider: 'sol', model: 'gpt-6.1-sol' }, worker: { provider: 'flash', model: 'deepseek-flash' } }
const llm = { listProviders: () => [{id:'sol',name:'Sol'}, {id:'flash',name:'Flash',route:{provider:'flash',family:'deepseek' as const,connection:'api' as const,protocol:'chat-completions' as const}}],
  listModels: async (provider: string) => [{provider,id:provider==='sol'?'gpt-6.1-sol':'deepseek-flash',name:provider}], resolveCallConfig:async (b:any)=>b }
async function choose(answer = 'この構成で開始', models = llm, executionAnswer: string = `通常実行: ${HEAD_WORKER_LABEL}`) {  let stored: StoredExecutionSelection = {revision:0,value:{mode:'pending',status:'selecting'}}
  const cards: any[] = []
  const result = await selectExecution({ task:'Fix',stored,signal:new AbortController().signal,routes:[],llm:models,
    save:async(revision,value)=>stored={revision:revision+1,value}, questions:{ask:async request=>{
      const q=request.questions[0];cards.push(q)
      const selected=q.id==='execution-mode'?executionAnswer:q.id==='head-worker-review'?answer:'取消・作業を保持'
      return {answers:[{id:q.id,selected:[selected]}]}
    }} }).catch(e=>{if(!(e instanceof ExecutionSelectionPending))throw e;return undefined})
  return {stored,result,cards}
}
test('normal explicitly chooses and durably saves a pair; the ordinary choice remains available',async()=>{
  const {result,cards}=await choose()
  assert.deepEqual(result?.value.headWorker,pair);assert.equal(result?.value.mode,'normal');assert.equal(result?.value.status,'ready')
  assert.ok(cards[0].options.some((o:any)=>o.label==='通常実行'))
  const ordinary = await choose('この構成で開始', llm, '通常実行')
  assert.equal(ordinary.result?.value.headWorker,undefined);assert.equal(ordinary.result?.value.mode,'normal');assert.equal(ordinary.result?.value.status,'ready')
})
test('cancel pair review never saves a ready pair or changes prior selection',async()=>{
  const {stored,result}=await choose('取消・作業を保持')
  assert.equal(result,undefined);assert.equal(stored.value.headWorker,undefined);assert.equal(stored.value.status,'selecting')
})
test('unavailable pair gives explicit reason and no start choice or fallback',async()=>{
  const {stored,cards}=await choose('この構成で開始',{...llm,listModels:async()=>[]})
  assert.equal(stored.value.headWorker,undefined)
  assert.ok(cards.some(q=>q.id==='head-worker-unavailable'))
})
