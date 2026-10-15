import assert from 'node:assert/strict'
import test from 'node:test'
import { ManagedAgentExecutor } from '../../../src/dsh/orchestration/managed-agent-executor.js'

for (const rejectDisposal of [false, true]) test(`awaits exact activation disposal once after cancellation (${rejectDisposal ? 'rejects' : 'resolves'})`, async () => {
  let resolveResult!: (value: { output: unknown; stopReason: string }) => void
  const result = new Promise<{ output: unknown; stopReason: string }>(resolve => { resolveResult = resolve })
  let published!: () => void
  const publication = new Promise<void>(resolve => { published = resolve })
  let disposed = 0
  const parent = { id: 'parent', session: { id: 'parent' } } as any
  const child = { id: 'child', session: { id: 'child' } } as any
  const controller = new AbortController()
  const binding = {}
  let finishDisposal!: () => void
  const disposal = new Promise<void>((resolve, reject) => { finishDisposal = () => rejectDisposal ? reject(new Error('disposal failed')) : resolve() })
  let executor!: ManagedAgentExecutor<object>
  const backend = {
    startActivation: async () => {
      executor.created(child)
      published()
      return { childId: 'child', result, dispose: async () => { disposed++; await disposal } }
    },
  }
  const run = executor = new ManagedAgentExecutor(backend)
  const pending = run.execute(binding, {
    parent, prompt: [{ type: 'text', text: 'test' }], agentOptions: { provider: 'mock', model: 'mock' },
    maxDepth: 1, toolFilter: { allow: [] }, signal: controller.signal, label: 'test',
  }, async (value, receivedChild) => {
    assert.equal(receivedChild, child)
    return value
  })
  await publication
  controller.abort()
  resolveResult({ output: 'done', stopReason: 'completed' })
  let settled = false
  const observed = pending.then(value => { settled = true; return value }, error => { settled = true; throw error })
  const completion = rejectDisposal ? assert.rejects(observed, /disposal failed/) : observed
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'completion must await cancellation cleanup')
  finishDisposal()
  await completion
  assert.equal(disposed, 1)
})

for(const version of ['alpha.2','alpha.3'] as const)test(`native spawn ${version} restricts the exact child before publication`,async()=>{
 const seen:any[]=[],binding={},parent={id:'parent',ctx:{get:()=>({restrict(){throw new Error('Never restrict the parent')}})},session:{id:'parent'}} as any
 let executor:ManagedAgentExecutor<object>,spec:any
 const child={id:'child',session:{id:'child'},ctx:{get:()=>({restrict(filter:any){seen.push(filter);return()=>{}}})}} as any
 const backend={getProvider:()=>({capabilities:{agentOptions:true,depthLimit:true,...(version==='alpha.2'?{toolFilter:true}:{agentPreset:true})}}),
  async startActivation(input:any){spec=input;executor.created(child);if(version==='alpha.3')assert.deepEqual(seen,[{allow:[]}]);return {childId:'child',result:Promise.resolve({output:'done',stopReason:'completed'}),async dispose(){}}}}
 executor=new ManagedAgentExecutor(backend)
 await executor.execute(binding,{parent,prompt:[],agentOptions:{provider:'mock',model:'mock'},maxDepth:1,toolFilter:{allow:[]},signal:new AbortController().signal,label:'bounded'},async(_result,agent)=>{assert.equal(agent,child);assert.equal(executor.binding(child),binding)})
 if(version==='alpha.2'){assert.deepEqual(spec.request.toolFilter,{allow:[]});assert.deepEqual(seen,[])}else assert.equal('toolFilter'in spec.request,false)
})
for(const fault of ['parent-mask-unavailable','child-mask-unavailable','child-mask-rejects'] as const)test(`native scoped restriction fails closed: ${fault}`,async()=>{
 let starts=0,consumed=0;const parent={id:'parent',ctx:{get:()=>fault==='parent-mask-unavailable'?{}:{restrict(){return()=>{}}}}} as any
 const child={id:'child',session:{id:'child'},ctx:{get:()=>fault==='child-mask-unavailable'?{}:{restrict(){throw new Error('Native mask rejected')}}}} as any
 let executor:ManagedAgentExecutor<object>
 const backend={getProvider:()=>({capabilities:{agentOptions:true,depthLimit:true,agentPreset:true}}),async startActivation(){starts++;executor.created(child);return {childId:'child',result:Promise.resolve({output:'must not run',stopReason:'completed'}),async dispose(){}}}}
 executor=new ManagedAgentExecutor(backend)
 await assert.rejects(executor.execute({},{parent,prompt:[],agentOptions:{provider:'mock',model:'mock'},maxDepth:1,toolFilter:{allow:[]},signal:new AbortController().signal,label:'denied'},async()=>{consumed++}),/restriction|mask/i)
 assert.equal(consumed,0);assert.equal(starts,fault==='parent-mask-unavailable'?0:1);assert.equal(executor.binding(child),undefined)
})
