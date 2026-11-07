import assert from 'node:assert/strict'
import test from 'node:test'
import {LispCodingPreparation} from '../../../../src/dsh/lisp/coding-preparation.js'
import {LispCodingCancelled} from '../../../../src/dsh/coding-question.js'
import {savedResultVersion} from '../../../../src/dsh/lisp/inspection.js'
import type {InspectionReceipt} from '../../../../src/dsh/lisp/prototype-review.js'
import {codingIntent} from '../../../../src/dsh/coding-workflow/intent.js'
function observe(f: ReturnType<typeof fixture>, name: string, args: Record<string, unknown>, result?: {ok?: boolean; operationId?: string; replay?: boolean}, inspection?: InspectionReceipt) {
  f.p.track(f.agent, name, args)?.(result, inspection)
}
function receipt(id: string, data = '', offset = 0, totalCharacters = 0, nextOffset: number | null = null): InspectionReceipt {
  return {version: savedResultVersion(JSON.stringify({ok:true, operationId:id})),
    page:{ok:true, state:'SUCCEEDED', resultOperationId:id, section:'result', offset, totalCharacters, nextOffset, data}}
}
function inspectComplete(f: ReturnType<typeof fixture>, id: string) {
  observe(f, 'lisp_inspect', {resultOperationId:id, section:'result'}, undefined, receipt(id))
}
function fixture(resultVersion: (id: string) => Promise<string | undefined> = async id => receipt(id).version) {
  let root='/one', enabled=false, choices=0, activations=0
  const agent={id:'agent', session:{id:'session'}}
  const input={agent,turn:1,task:'Implement src/parser.ts',taskType:'build' as const,signal:new AbortController().signal}
  const p=new LispCodingPreparation({
    identity:a=>({sessionId:(a as typeof agent).session.id,root}), enabled:()=>enabled,
    choose:async()=>{choices++;return {status:'answered',choice:'yes',answerRef:'human:choice'}},
    activate:async()=>{activations++;enabled=true}, resultVersion:(_agent, id)=>resultVersion(id),
  })
  return {p,agent,input,enabled:(v:boolean)=>{enabled=v},root:(v:string)=>{root=v},counts:()=>({choices,activations})}
}
async function protect(f: ReturnType<typeof fixture>) {
  await f.p.prepare(f.input)
  f.p.answered(f.agent, f.input.task, 'yes', f.p.choiceFor(f.agent, f.input.task)!.answerRef,'workflow:1')
}
test('early choice is once per request, native reads stay available and ON alone is unverified',async()=>{const f=fixture();await Promise.all([f.p.prepare(f.input),f.p.prepare(f.input)]);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef,'workflow:1');assert.equal(f.counts().choices,1);assert.equal((f.p.status(f.agent)as any).verified,false);assert.equal(f.p.denial(f.agent,'read',{}),undefined);assert.match(f.p.denial(f.agent,'bash',{})!,/LISP_PROTOTYPE_REQUIRED/u)})
test('only a successful fresh prototype followed by its actual complete saved result unlocks implementation', async () => {
  const f = fixture()
  await protect(f)
  observe(f, 'lisp_eval', {prototype:false}, {ok:true, operationId:'ordinary'})
  assert.match(f.p.denial(f.agent, 'edit', {})!, /PROTOTYPE/u)
  observe(f, 'lisp_eval', {prototype:true}, {ok:true, operationId:'fresh'})
  for (const args of [
    {resultOperationId:'wrong'},
    {resultOperationId:'fresh', section:'stdout'},
    {resultOperationId:'fresh', pointer:''},
    {resultOperationId:'fresh', pointer:'/value'},
  ]) {
    observe(f, 'lisp_inspect', args, undefined, receipt('fresh'))
    assert.match(f.p.denial(f.agent, 'write', {})!, /PROTOTYPE/u)
  }
  observe(f, 'lisp_inspect', {resultOperationId:'fresh', section:'result'})
  assert.match(f.p.denial(f.agent, 'write', {})!, /inspection_failed/u)
  inspectComplete(f, 'fresh')
  assert.equal(f.p.denial(f.agent, 'write', {}), undefined)
  assert.equal((f.p.status(f.agent) as any).verified, true)
})
test('two failures stop automatic prototype retries; explicit OFF releases the routine without claiming success',async()=>{const f=fixture();await f.p.prepare(f.input);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef,'workflow:1');for(let i=0;i<2;i++)observe(f,'lisp_eval',{prototype:true},{ok:false});assert.match(f.p.denial(f.agent,'lisp_eval',{prototype:true})!,/two attempts failed/u);f.p.manual(f.agent,false);f.enabled(false);assert.equal(f.p.denial(f.agent,'bash',{}),undefined);assert.equal((f.p.status(f.agent)as any).verified,false)})
test('research, conversation, quotes, negation and plan-only requests do not activate or gate Lisp',async()=>{for(const task of ['Explain the parser','コードは変更しないで。原因を調査して','実装計画だけ作って','> Implement this','Should we implement it?']){const f=fixture();f.enabled(true);await f.p.prepare({...f.input,task});assert.equal(f.counts().choices,0);assert.equal(f.counts().activations,0);assert.equal(f.p.denial(f.agent,'bash',{}),undefined)}})
test('session/root/agent separation and new requests cannot reuse the previous prototype',async()=>{const f=fixture();await f.p.prepare(f.input);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef,'workflow:1');assert.equal(f.p.choiceFor({...f.agent},f.input.task),undefined);f.root('/other');assert.equal(f.p.choiceFor(f.agent,f.input.task),undefined);assert.equal(f.p.denial(f.agent,'write',{}),undefined);f.root('/one');await f.p.prepare({...f.input,turn:2,task:'Implement src/other.ts'});assert.equal((f.p.status(f.agent)as any).verified,false);assert.equal(f.p.choiceFor(f.agent,f.input.task),undefined)})

test('cancelled choice cannot start effects and a session OFF does not revive the cancelled request',async()=>{
 const agent={id:'pending'},p=new LispCodingPreparation({identity:()=>({sessionId:'pending',root:'/one'}),enabled:()=>false,choose:async()=>({status:'cancelled',reason:'User cancelled'}),activate:async()=>{throw new Error('unanswered must not activate')},resultVersion:async()=>undefined})
 await assert.rejects(p.prepare({agent,turn:1,task:'Implement src/parser.ts',taskType:'build',signal:new AbortController().signal}),LispCodingCancelled)
 assert.match(p.denial(agent,'bash',{})!,/LISP_REQUEST_CANCELLED/u);assert.equal(p.denial(agent,'read',{}),undefined);p.manual(agent,false);assert.match(p.denial(agent,'bash',{})!,/LISP_REQUEST_CANCELLED/u);assert.equal((p.status(agent)as any).verified,false)
})
test('successful retries do not consume the failure budget or erase existing evidence',async()=>{
 const f=fixture();await f.p.prepare(f.input);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef,'workflow:1')
 observe(f,'lisp_eval',{prototype:true},{ok:true,operationId:'one'})
 observe(f,'lisp_eval',{prototype:true},{replay:true,operationId:'one'})
 assert.equal((f.p.status(f.agent)as any).phase,'result_pending');assert.equal((f.p.status(f.agent)as any).failures,0)
 for(const id of ['two','three']){assert.equal(f.p.denial(f.agent,'lisp_eval',{prototype:true}),undefined);observe(f,'lisp_eval',{prototype:true},{ok:true,operationId:id})}
 assert.equal((f.p.status(f.agent)as any).failures,0)
})

test('a new formal Goal choice cannot borrow an earlier task prototype or omit preparation',async()=>{
 const f=fixture();await f.p.prepare(f.input);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef,'workflow:1');observe(f,'lisp_eval',{prototype:true},{ok:true,operationId:'old'});inspectComplete(f, 'old');assert.equal((f.p.status(f.agent)as any).verified,true)
 const before=f.p.binding(f.agent);f.p.answered(f.agent,'Implement a different public entry','yes','human:new-scope','workflow:1')
 assert.equal((f.p.status(f.agent)as any).verified,false);assert.notEqual(f.p.binding(f.agent),before);assert.match(f.p.denial(f.agent,'write',{})!,/PROTOTYPE/u)
 const fresh=fixture();fresh.enabled(true);fresh.p.answered(fresh.agent,'Implement an admitted task','yes','human:admitted-choice','workflow:1');assert.match(fresh.p.denial(fresh.agent,'bash',{})!,/PROTOTYPE/u)
})


test('late prototype and inspection results cannot cross a Goal or manual-route change', async () => {
  const f = fixture()
  await protect(f)
  const latePrototype = f.p.track(f.agent, 'lisp_eval', {prototype:true})!
  f.p.answered(f.agent, 'Implement next.ts', 'yes', 'human:next','workflow:1')
  latePrototype({ok:true, operationId:'old'})
  assert.equal((f.p.status(f.agent) as any).phase, 'prototype_required')
  assert.equal((f.p.status(f.agent) as any).attempts, 0)

  observe(f, 'lisp_eval', {prototype:true}, {ok:true, operationId:'current'})
  const lateInspection = f.p.track(f.agent, 'lisp_inspect', {resultOperationId:'current'})!
  const beforeManual = f.p.binding(f.agent)
  f.p.manual(f.agent, true)
  assert.notEqual(f.p.binding(f.agent), beforeManual)
  observe(f, 'lisp_eval', {prototype:true}, {ok:true, operationId:'current'})
  lateInspection(undefined, receipt('current'))
  assert.equal((f.p.status(f.agent) as any).verified, false)
  inspectComplete(f, 'current')
  assert.equal((f.p.status(f.agent) as any).verified, true)
})

test('the same recorded manual answer preserves an already reviewed prototype when Goal next reuses it',async()=>{
 const f=fixture();await f.p.prepare(f.input);f.p.answered(f.agent,f.input.task,'yes',f.p.choiceFor(f.agent,f.input.task)!.answerRef,'workflow:1');f.p.manual(f.agent,true,'human-command:one:enable')
 observe(f,'lisp_eval',{prototype:true},{ok:true,operationId:'fresh'})
 inspectComplete(f, 'fresh')
 const key=f.p.binding(f.agent);f.p.answered(f.agent,f.input.task,'yes','human-command:one:enable','workflow:1')
 assert.equal(f.p.binding(f.agent),key);assert.equal((f.p.status(f.agent)as any).verified,true)
 f.p.answered(f.agent, f.input.task, 'yes', 'human-command:one:enable', 'workflow:2')
 assert.notEqual(f.p.binding(f.agent), key, 'new scope cannot inherit review even with identical text and answer')
 assert.match(f.p.denial(f.agent, 'write', {})!, /prototype_required/u)
})

test('parallel pages are isolated from replacement prototypes and other sessions', async () => {
  const f = fixture(), other = fixture()
  await Promise.all([protect(f), protect(other)])
  other.agent.session.id = 'other-session'
  other.p.answered(other.agent, other.input.task, 'yes', 'human:choice', 'workflow:1')
  for (const owner of [f, other]) observe(owner, 'lisp_eval', {prototype:true}, {ok:true, operationId:'same-id'})
  const read = (owner: typeof f, offset: number) => owner.p.track(owner.agent, 'lisp_inspect', {resultOperationId:'same-id', offset})!
  const oldHead = read(f, 0), oldTail = read(f, 2)
  read(other, 0)(undefined, receipt('same-id', 'ab', 0, 4, 2))
  oldTail(undefined, receipt('same-id', 'cd', 2, 4))
  assert.match(f.p.denial(f.agent, 'write', {})!, /missing_ranges/u)
  assert.match(other.p.denial(other.agent, 'write', {})!, /end_unseen/u)

  const replacement = {ok:true, operationId:'same-id', value:'changed'}
  observe(f, 'lisp_eval', {prototype:true}, replacement)
  oldHead(undefined, receipt('same-id', 'ab', 0, 4, 2))
  read(f, 0)(undefined, receipt('same-id', 'ab', 0, 4, 2))
  assert.match(f.p.denial(f.agent, 'write', {})!, /result_version_mismatch/u)
  const version = savedResultVersion(JSON.stringify(replacement))
  const newHead = read(f, 0), newTail = read(f, 2)
  await Promise.all([
    Promise.resolve().then(() => newTail(undefined, {...receipt('same-id', 'yz', 2, 4), version})),
    Promise.resolve().then(() => newHead(undefined, {...receipt('same-id', 'wx', 0, 4, 2), version})),
  ])
  assert.equal(f.p.denial(f.agent, 'write', {}), undefined)
  assert.match(other.p.denial(other.agent, 'write', {})!, /result_pending/u)
})

test('dispatch rejects content replacement or expiry after review', async () => {
  let version: string | undefined = receipt('saved').version
  const f = fixture(async () => version)
  await protect(f)
  observe(f, 'lisp_eval', {prototype:true}, {ok:true, operationId:'saved'})
  inspectComplete(f, 'saved')
  const next = async () => 'effect'
  assert.equal(await f.p.dispatch(f.agent, 'write', {}, undefined, undefined, next), 'effect')
  version = undefined
  await assert.rejects(f.p.dispatch(f.agent, 'write', {}, undefined, undefined, next), /result_version_mismatch/u)
  assert.match(f.p.denial(f.agent, 'write', {})!, /result_pending/u)
})

test('a replacement prototype cannot race an admitted write or lend it the old review', async () => {
  let finishVersionRead!: (version: string) => void
  const versionRead = new Promise<string>(resolve => { finishVersionRead = resolve })
  const f = fixture(() => versionRead)
  await protect(f)
  observe(f, 'lisp_eval', {prototype:true}, {ok:true, operationId:'saved'})
  inspectComplete(f, 'saved')
  const staleWrite = f.p.dispatch(f.agent, 'write', {}, undefined, undefined, async () => assert.fail('stale write'))
  const prototype = f.p.track(f.agent, 'lisp_eval', {prototype:true})!
  assert.match(f.p.denial(f.agent, 'write', {})!, /LISP_PROTOTYPE_BUSY/u)
  prototype({ok:true, operationId:'new'})
  finishVersionRead(receipt('saved').version)
  await assert.rejects(staleWrite, /review changed/u)
  assert.match(f.p.denial(f.agent, 'write', {})!, /result_pending/u)

  const current = fixture()
  await protect(current)
  observe(current, 'lisp_eval', {prototype:true}, {ok:true, operationId:'saved'})
  inspectComplete(current, 'saved')
  await current.p.dispatch(current.agent, 'write', {}, undefined, undefined, async () => {
    assert.throws(() => current.p.track(current.agent, 'lisp_eval', {prototype:true}), /active implementation tool/u)
  })
  assert.ok(current.p.track(current.agent, 'lisp_eval', {prototype:true}))
})

test('cancellation discards partial coverage and ignores in-flight pages', async () => {
  const f = fixture()
  await protect(f)
  observe(f, 'lisp_eval', {prototype:true}, {ok:true, operationId:'saved'})
  observe(f, 'lisp_inspect', {resultOperationId:'saved'}, undefined, receipt('saved', 'a', 0, 2, 1))
  const tail = f.p.track(f.agent, 'lisp_inspect', {resultOperationId:'saved', offset:1})!
  f.p.cancelled(f.agent, f.input.task)
  tail(undefined, receipt('saved', 'b', 1, 2))
  assert.match(f.p.denial(f.agent, 'write', {})!, /LISP_REQUEST_CANCELLED/u)
  assert.equal((f.p.status(f.agent) as any).operationId, null)
})
test('a positive request-intent decision offers ordinary Lisp for wording the deterministic detector misses',async()=>{
 const f=fixture();f.enabled(true)
 const task='Okay okay, improve this source base. What do you do to make that happen?'
 assert.equal(codingIntent(task),false)
 await f.p.prepare({...f.input,task,requestIntent:{relation:'new',action:'change',changeScope:'implementation',source:'decision-provider',policyVersion:'request-intent-task-state-v3',providerSent:true,evidence:{} as any} as any})
 assert.equal((f.p.status(f.agent)as any).phase,'selected')
 assert.equal(f.p.denial(f.agent,'read',{}),undefined)
 assert.equal(f.p.denial(f.agent,'bash',{}),undefined)
})

test('an unresolved decision keeps the deterministic coding fallback and does not gate conversation',async()=>{
 const unresolved={relation:'unknown',action:'unknown',changeScope:'unknown',source:'unresolved',policyVersion:'request-intent-task-state-v3',providerSent:false,evidence:{} as any} as any
 const f=fixture();f.enabled(true)
 await f.p.prepare({...f.input,task:'Implement src/parser.ts',requestIntent:unresolved})
 assert.equal(f.p.denial(f.agent,'bash',{}),undefined)
 const g=fixture();g.enabled(true)
 await g.p.prepare({...g.input,task:'Explain the parser',requestIntent:unresolved})
 assert.equal(g.p.denial(g.agent,'bash',{}),undefined)
})

test('an explicitly selected manual session skips the early question without requiring a prototype',async()=>{
 const agent={id:'enabled-agent',session:{id:'enabled-session'}}
 let choices=0,activations=0
 const p=new LispCodingPreparation({
  identity:()=>({sessionId:'enabled-session',root:'/one'}),
  enabled:()=>true,
  selected:async()=>true,
  choose:async()=>{choices++;return{status:'answered',choice:'yes',answerRef:'enabled-session:test'}},
  activate:async()=>{activations++},resultVersion:async()=>undefined,
 })
 await p.prepare({agent,turn:1,task:'Implement src/parser.ts',taskType:'build',signal:new AbortController().signal})
 assert.equal(choices,0);assert.equal(activations,1)
 assert.equal((p.status(agent)as any).phase,'selected')
 assert.equal(p.denial(agent,'bash',{}),undefined)
})


test('an enabled runtime without a manual preference asks for each new task',async()=>{
 const agent={id:'task-agent'},answers:string[]=[]
 const p=new LispCodingPreparation({identity:()=>({sessionId:'session',root:'/one'}),enabled:()=>true,selected:async()=>false,
  choose:async input=>{answers.push(input.task);return {status:'answered',choice:answers.length===1?'yes':'no',answerRef:`human:${answers.length}`}},activate:async()=>{},resultVersion:async()=>undefined})
 const signal=new AbortController().signal
 await p.prepare({agent,turn:1,task:'Implement first.ts',taskType:'build',signal})
 assert.equal(p.denial(agent,'write',{}),undefined)
 await p.prepare({agent,turn:2,task:'Implement second.ts',taskType:'build',signal})
 assert.deepEqual(answers,['Implement first.ts','Implement second.ts'])
 assert.equal(p.choiceFor(agent,'Implement second.ts')?.choice,'no')
 assert.equal(p.denial(agent,'write',{}),undefined)
})

for (const choice of ['yes', 'no'] as const)
  test(`Lisp status is lossless JSON before a prototype operation: ${choice}`, async () => {
    const f = fixture()
    await f.p.prepare(f.input)
    f.p.answered(f.agent, f.input.task, choice, 'human:status','workflow:1')
    const status = f.p.status(f.agent)
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status)
    assert.equal((status as any).operationId, null)
  })


test('ordinary coding metadata never enrolls a selected session in the protected prototype protocol', async () => {
  const f = fixture()
  await f.p.prepare(f.input)
  f.p.answered(f.agent, f.input.task, 'yes', 'ordinary-task-choice', 'optional-workflow:1', false)
  assert.equal(f.p.denial(f.agent, 'lisp_eval', {code:'(+ 20 22)'}), undefined)
  assert.equal(f.p.denial(f.agent, 'kioku_write', {}), undefined)
  assert.equal((f.p.status(f.agent) as any).phase, 'selected')
})
