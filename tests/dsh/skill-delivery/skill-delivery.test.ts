import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { deepSeekFixtureResponse, wireText } from '../helpers/deepseek-wire.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
const packageRoot = process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const enabled = Boolean(packages) && process.env.KIOKUKO_TEST_COMPILED_SKILLS === '1'
// Keep this opt-in suite outside e2e/: the mandatory native lifecycle runner
// discovers that directory and correctly rejects every skipped test. This
// dedicated job also avoids the general suite's build/pack artifact replacement.
const native = { skip: enabled ? false : 'run npm run test:skill-delivery', timeout: 60000 }
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !packages) throw new Error('Skill delivery requires the pinned native runtime')
const subject: typeof import('../../../src/dsh/index.js') = await import(packageRoot
  ? pathToFileURL(join(packageRoot,'dist/index.js')).href : '../../../src/dsh/index.js')
const artifact = enabled ? JSON.parse(await readFile(join(packageRoot ?? process.cwd(),'dist/dsh/skill-prompts.json'),'utf8')) : {resources:[]}
const content = (name: string) => artifact.resources.find((r: any) => r.id === `${name}/SKILL.md`).content as string
const names: string[] = artifact.resources.filter((r: any) => r.id.endsWith('/SKILL.md')).map((r: any) => r.id.slice(0,-'/SKILL.md'.length))
// Exact model-facing contract: protected Lisp, native reads and memory recovery.
const expectedLispTools = ['lisp_apply', 'lisp_call', 'lisp_cancel', 'lisp_compare', 'lisp_define', 'lisp_describe', 'lisp_eval',
  'lisp_hot_call', 'lisp_hot_contract', 'lisp_hot_deactivate', 'lisp_hot_install', 'lisp_hot_status',
  'lisp_inspect', 'lisp_observe', 'lisp_reset', 'lisp_stage', 'lisp_status', 'lisp_verify',
  'observation_read', 'prepare_requested_work', 'skill', 'task_memory_review']
const textOf = (request: any): string => [request.system ?? '', ...request.messages.flatMap((m: any) => m.content.flatMap((b: any) =>
  b.type === 'text' ? [b.text] : b.type === 'tool-result' ? b.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text) : []))].join('\n')
function requireBody(request: any, name: string) { assert.ok(textOf(request).includes(content(name)), `${name}: compiled body absent at adapter boundary`) }

function fixture(explicit: boolean|'prompt-only', mode: 'full'|'compiled' = 'compiled', extra: object = {}, nativeAnswer?: (request: any) => Promise<any>) {
  return nativeSkillFixture({ packages: packages!, ...(packageRoot ? { packageRoot } : {}), explicit, mode, extra, ...(nativeAnswer ? { nativeAnswer } : {}) })
}

for (const mode of ['full', 'compiled'] as const) for (const activation of ['enable', 'enable-task']) {
  test(`Lisp planning delivery: ${mode}, ${activation}, first/follow-up/reload`, {
    ...native, skip: !enabled || process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1', timeout: 180000,
  }, async () => {
    const f = await fixture(false, mode, { lisp: { executionMode: 'protected', enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 } })
    try {
      const source = await readFile(join(packageRoot ?? process.cwd(), 'skills/kiokuko-lisp/SKILL.md'), 'utf8')
      const expected = mode === 'full' ? source : content('kiokuko-lisp')
      const contract = source.match(/<!-- kiokuko:runtime prototype-driven-planning -->\n([\s\S]*?)\n<!-- \/kiokuko:runtime -->/u)?.[1]
      assert.ok(contract)
      const activated = await f.ctx.commands.execute(f.agent, `/kioku-lisp ${activation}`, [], new AbortController().signal)
      assert.equal(activated.result.kind, 'success', JSON.stringify(activated.result))
      for (let turn = 0; turn < 3; turn++) {
        if (turn === 2) await f.reload(mode)
        f.responses.push(f.mock.textResponse('現在の契約を確認しました。'))
        await f.turn('説明してください。')
        const request = f.model.requests.at(-1)
        assert.ok(textOf(request).includes(expected))
        const system = request.system ?? request.messages.filter((m: any) => m.role === 'system')
          .flatMap((m: any) => m.content.filter((block: any) => block.type === 'text').map((block: any) => block.text)).join('\n')
        assert.equal(system.split(contract).length - 1, 1, 'current system contract must appear exactly once')
      }
    } finally { await f.close() }
  })
}

for(const explicit of [false,true]) test(`compiled Skill delivery: production entrypoint (${explicit?'explicit':'native'} host), every native skill lookup`,native,async()=>{
  const f=await fixture(explicit)
  try {
    f.responses.push(f.mock.textResponse('説明します。'));await f.turn()
    requireBody(f.model.requests[0],'kiokuko-soul');requireBody(f.model.requests[0],'natural-japanese-output')
    f.responses.push(f.mock.toolCallResponse('prepare-skill-audit', 'prepare_requested_work', { taskType: 'research' }))
    for (const name of names) f.responses.push(f.mock.toolCallResponse(`load-${name}`, 'skill', { name }))
    f.responses.push(f.mock.textResponse('確認しました。'))
    await f.turn('Inspect every installed bundled Skill with the native skill tool and report its contents.')
    for(const name of names) {
      requireBody(f.model.requests.at(-1),name)
      const result = nativeToolResults(f.model.requests.at(-1).messages).find((block: any) => block.toolCallId === `load-${name}`)
      assert.equal(result?.isError, false, `${name}: native Skill reader must succeed`)
      assert.ok(result.content.some((block: any) => block.type === 'text' && block.text.includes(content(name))),
        `${name}: compiled body must arrive through the native tool result, not only automatic injection`)
    }
    assert.ok(artifact.resources.some((r:any)=>r.representation==='compiled'))
  } finally { await f.close() }
})

test('compiled Skill delivery: prompt-only entrypoint has reachable native prompt and Skill consumers',native,async()=>{
  const f=await fixture('prompt-only')
  try {
    f.responses.push(f.mock.toolCallResponse('read-lisp','skill',{name:'kiokuko-lisp'}),f.mock.textResponse('確認'))
    await f.turn();requireBody(f.model.requests[0],'kiokuko-soul');requireBody(f.model.requests.at(-1),'kiokuko-lisp')
  } finally {await f.close()}
})

test('compiled Skill delivery: reload, full rollback, model switch and compacted surface',native,async()=>{
  const f=await fixture(false)
  try {
    f.responses.push(f.mock.textResponse('初回'));await f.turn()
    const before=f.agent.session.snapshotEvents().length
    const nodes=[...f.agent.session.surface.nodes]
    for(const seq of nodes){const event=f.agent.session.eventAt(seq);if(event.type!=='user/message')continue
      f.agent.session.append('user/message',f.llm.createUserMessage({content:[{type:'text',text:'Earlier conversation compacted.'}],source:{kind:'plugin:test-compaction'}}),
        {surfaceOp:{op:'replace',startSeq:seq,endSeq:seq},sourceEventSeqs:[seq]})}
    f.responses.push(f.mock.textResponse('継続'));await f.turn();requireBody(f.model.requests.at(-1),'kiokuko-soul')
    assert.ok(f.agent.session.snapshotEvents().length>before)
    await f.reload('full');f.responses.push(f.mock.textResponse('全文'));await f.turn()
    const full=await readFile(join(packageRoot??process.cwd(),'skills/kiokuko-soul/SKILL.md'),'utf8')
    assert.ok(textOf(f.model.requests.at(-1)).includes(full))
    await f.reload('compiled');f.agent.options.model='gpt-fixture';f.responses.push(f.mock.textResponse('English'));await f.turn('Explain in English.')
    requireBody(f.model.requests.at(-1),'kiokuko-soul')
    const req=f.model.requests.at(-1)
    const system=req.system??req.messages.filter((m:any)=>m.role==='system').flatMap((m:any)=>m.content).map((b:any)=>b.text??'').join('\n')
    assert.ok(!system.includes(content('natural-japanese-output')))
  } finally { await f.close() }
})

test('delivery counterexample: artifact present but disconnected system injection fails the same assertion',native,async()=>{
  const f=await fixture(false)
  const disconnect=f.ctx.on('system-prompt/assemble',async(_a:any,_c:any,next:()=>Promise<any>)=>{const a=await next();return{...a,sections:a.sections.filter((s:any)=>s.name!=='kiokuko:soul')}} ,{prepend:true,global:true})
  try {
    f.responses.push(f.mock.textResponse('説明'));await f.turn()
    assert.throws(()=>requireBody(f.model.requests.at(-1),'kiokuko-soul'),/compiled body absent/u)
    requireBody(f.model.requests.at(-1),'natural-japanese-output')
  } finally {disconnect();await f.close()}
})

test('delivery counterexample: disconnected native Skill reader is caught while automatic SOUL still arrives',native,async t=>{
  const f=await fixture(false)
  const original=subject.DshSkillPrompts.prototype.get
  const disconnect=t.mock.method(subject.DshSkillPrompts.prototype,'get',async function(this: InstanceType<typeof subject.DshSkillPrompts>,name:string,path?:string){
    return name==='kiokuko-lisp'?undefined:original.call(this,name,path)
  })
  try {
    f.responses.push(f.mock.toolCallResponse('prepare-disconnected-read', 'prepare_requested_work', { taskType: 'research' }),
      f.mock.toolCallResponse('disconnected-read','skill',{name:'kiokuko-lisp'}),f.mock.textResponse('取得できませんでした。'))
    await f.turn('Inspect the installed kiokuko-lisp Skill with the native skill tool and report its contents.')
    assert.equal(f.model.requests.length,3)
    const preparation = nativeToolResults(f.model.requests.at(-1).messages).find((block: any) => block.toolCallId === 'prepare-disconnected-read')
    assert.equal(preparation?.isError, false, 'the counterexample must reach the reader after real intake preparation')
    requireBody(f.model.requests.at(-1),'kiokuko-soul')
    assert.throws(()=>requireBody(f.model.requests.at(-1),'kiokuko-lisp'),/compiled body absent/u)
  } finally {disconnect.mock.restore();await f.close()}
})

test('Lisp task mode preserves on-demand preparation while blocking native mutation', native, async () => {
  const f = await fixture(false, 'compiled', { lisp: { executionMode: 'protected', enabled: true, sbclPath: 'must-not-start-sbcl' } })
  let writes = 0
  const resultOf = (request: any) => nativeToolResults(request.messages).at(-1)
  try {
    f.ctx.tools.register({ name: 'write', description: 'Blocked native mutation', parameters: { type: 'object' },
      output: { schema: {}, render: () => [] }, execute: async () => { writes++; return 'must not execute' } })
    assert.equal((await f.ctx.commands.execute(f.agent, '/kioku-lisp enable-task', [], new AbortController().signal)).result.kind, 'success')
    f.responses.push((request: any) => {
      assert.deepEqual(request.tools.map((tool: any) => tool.name).sort(), expectedLispTools)
      return f.mock.toolCallResponse('blocked-write', 'write', {})
    }, (request: any) => {
      assert.equal(resultOf(request).isError, true)
      return f.mock.toolCallResponse('prepare-lisp-status', 'prepare_requested_work', { taskType: 'research' })
    }, (request: any) => {
      assert.equal(resultOf(request).isError, false)
      assert.equal(JSON.parse(resultOf(request).content[0].text).prepared, true)
      return f.mock.toolCallResponse('read-lisp-status', 'lisp_status', {})
    }, (request: any) => {
      assert.equal(resultOf(request).isError, false)
      assert.equal(JSON.parse(resultOf(request).content[0].text).state, 'TASK_READY')
      return f.mock.textResponse('Verified protected task status.')
    })
    await f.turn('Inspect the protected Lisp task status using lisp_status and report its state.')
    assert.equal(writes, 0)
    assert.equal(f.model.requests.length, 4)
  } finally { await f.close() }
})

test('compiled Skill delivery: protected Lisp enable and lisp_describe reach the native model',{
  ...native,skip:!enabled||process.env.KIOKUKO_REQUIRE_LISP_RUNTIME!=='1',timeout:180000,
},async()=>{
  const f=await fixture(false,'compiled',{lisp:{executionMode:'protected',enabled:true,sbclPath:process.env.KIOKUKO_LISP_SBCL??'sbcl',startupTimeoutMs:60000}})
  try {
    const enabled=await f.ctx.commands.execute(f.agent,'/kioku-lisp enable',[],new AbortController().signal)
    assert.equal(enabled.result.kind,'success',JSON.stringify(enabled.result))
    const skill = await readFile(join(packageRoot ?? process.cwd(), 'skills/kiokuko-lisp/SKILL.md'), 'utf8')
    const toolkit = skill.slice(skill.indexOf('## Task toolkit example')).match(/```lisp\n([\s\S]*?)\n```/u)?.[1]
    assert.ok(toolkit, 'the shipped task toolkit example must be present')
    f.responses.push(
      f.mock.toolCallResponse('prepare-task-tools', 'prepare_requested_work', { taskType: 'research' }),
      f.mock.toolCallResponse('describe-lisp','lisp_describe',{operationId:'describe-guide'}),
      f.mock.toolCallResponse('define-task-tools', 'lisp_eval', { operationId: 'define-task-tools', code: `${toolkit}\n(replace-once "value=0" "0" "42")` }),
      f.mock.toolCallResponse('describe-task-tool', 'lisp_describe', { operationId: 'describe-task-tool', symbol: 'kioku.user::replace-once' }),
      f.mock.toolCallResponse('reuse-task-tool', 'lisp_eval', { operationId: 'reuse-task-tool', code: '(replace-once "value=0" "0" "10")' }),
      f.mock.textResponse('Lisp APIを確認しました。'))
    await f.turn('Use protected Lisp to define, describe and verify the replace-once task toolkit helper.')
    assert.equal(f.model.requests.length,6,'native requests must prepare, define, discover and reuse the task toolkit')
    requireBody(f.model.requests[0],'kiokuko-lisp')
    const hotContract = f.model.requests[0].tools.find((tool: any) => tool.name === 'lisp_hot_contract')
    assert.match(hotContract.description, /current host approval policy/u)
    assert.ok(textOf(f.model.requests[0]).includes('See lisp_hot_* schemas.'))
    const last=f.model.requests.at(-1)
    const results=nativeToolResults(last.messages)
    assert.ok(results.some((b:any)=>b.content.some((c:any)=>c.type==='text'&&JSON.parse(c.text).api?.verify&&JSON.parse(c.text).guide===undefined)), 'lisp_describe delivers a concise API without duplicating the injected guide')
    const outcomes = results.flatMap((b: any) => b.content.filter((c: any) => c.type === 'text').map((c: any) => JSON.parse(c.text)))
    assert.ok(outcomes.some((result: any) => result.ok && result.value?.json === 'value=42'))
    assert.ok(outcomes.some((result: any) => result.ok && result.value?.json === 'value=10'))
    assert.ok(outcomes.some((result: any) => result.ok && result.value?.documentation?.includes('exactly one nonempty literal')))
    for (const request of [f.model.requests[0], last]) assert.deepEqual(request.tools.map((t:any)=>t.name).sort(), expectedLispTools,
      'the first request exposes protected Lisp, native readers and memory review, never blocked mutations')
  } finally {await f.close()}
})

test('Lisp selected during initial admission executes shared functions without switching mode', {
  ...native, skip: !enabled || process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1', timeout: 180000,
}, async () => {
  const asked: string[] = []
  const f = await fixture(false, 'compiled', { lisp: { executionMode: 'protected', enabled: true, sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 } }, async request => {
    const q = request.questions[0]
    asked.push(q.id)
    if (q.id === 'taskType') return { answers: [{ id: q.id, selected: ['debug'] }] }
    if (q.id === 'lisp-coding-mode') return { answers: [{ id: q.id, selected: ['Lispモードを使う（通常実行）'] }] }
    if (q.id.startsWith('lisp-hot-')) return { answers: [{ id: q.id, selected: [q.intent.approve] }] }
    throw new Error(`Unexpected admission question: ${JSON.stringify(q)}`)
  })
  try {
    // These tools are visible when native assembly begins, before the choice.
    for (const name of ['bash', 'write']) f.ctx.tools.register({ name, description: name, parameters: { type: 'object' },
      output: { schema: {}, render: () => [] }, execute: async () => { throw new Error('blocked tool must never execute') } })
    const resultOf = (request: any) => {
      const block = nativeToolResults(request.messages).at(-1)
      return JSON.parse(block.content.find((b: any) => b.type === 'text').text)
    }
    f.responses.push(f.mock.toolCallResponse('prepare-initial-lisp', 'prepare_requested_work', { taskType: 'debug' }),
      f.mock.toolCallResponse('initial-lisp', 'lisp_describe', { operationId: 'initial-guide' }),
      f.mock.toolCallResponse('initial-contract', 'lisp_hot_contract', { operationId: 'initial-contract', name: 'add-one', description: 'Add one',
        inputSchema: { type: 'integer' }, outputSchema: { type: 'integer' }, properties: [{ input: 1, expected: 2 }] }),
      (request: any) => {
        const contract = resultOf(request)
        assert.equal(contract.ok, true, JSON.stringify(contract))
        return f.mock.toolCallResponse('install-shared', 'lisp_hot_install', { operationId: 'install-shared', name: 'add-one',
          contractRef: contract.contractRef, expectedRevision: 0, source: '(lambda (input) (+ input 1))' })
      },
      (request: any) => {
        assert.equal(resultOf(request).revision, 1, JSON.stringify(resultOf(request)))
        return f.mock.toolCallResponse('call-shared', 'lisp_hot_call', { operationId: 'call-shared', name: 'add-one', input: 41 })
      },
      (request: any) => {
        assert.equal(resultOf(request).value, 42, JSON.stringify(resultOf(request)))
        return f.mock.toolCallResponse('legacy-eval', 'lisp_eval', { operationId: 'legacy-eval', code: '(+ 20 22)' })
      }, f.mock.textResponse('Verified.'))
    await f.turn('Fix the failing implementation in src/main.js and verify that its tests pass.')
    assert.equal(f.model.requests.length, 7, JSON.stringify(f.agent.session.snapshotEvents().slice(-6)))
    assert.ok(f.model.requests[0].tools.some((tool: any) => tool.name === 'prepare_requested_work'))
    for (const request of f.model.requests.slice(1)) {
      requireBody(request, 'kiokuko-lisp')
      assert.deepEqual(request.tools.map((tool: any) => tool.name).sort(), expectedLispTools)
    }
    assert.equal(resultOf(f.model.requests.at(-1)).ok, true, JSON.stringify(resultOf(f.model.requests.at(-1))))
    assert.equal(asked.filter(id => id === 'lisp-coding-mode').length, 1)
  } finally { await f.close() }
})

test('Lisp workflow reaches the next model request through native approval, evidence paging, plugin restart and exact replay', {
  ...native, skip: !enabled || process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1', timeout: 180000,
}, async () => {
  let approvals = 0, observedDetail = ''
  const f = await fixture(false, 'compiled', { lisp: { executionMode: 'protected', enabled: true, approvalMode: 'ask', sbclPath: process.env.KIOKUKO_LISP_SBCL ?? 'sbcl', startupTimeoutMs: 60000 } }, async request => {
    const q = request.questions[0]
    if (q.id === 'taskType') return { answers: [{ id: q.id, selected: ['chat'] }] }
    assert.match(q.id, /^batch-/u); assert.equal(request.agent.id, 'skill-main')
    approvals++; observedDetail = q.detail
    return { answers: [{ id: q.id, selected: [q.intent.approve] }] }
  })
  const latestResult = (request: any) => {
    const block = nativeToolResults(request.messages).at(-1)
    return JSON.parse(block.content.find((b: any) => b.type === 'text').text)
  }
  const args = { operationId: 'workflow-batch', code: '(kioku.files:propose-write "a.txt" "new-a") (kioku.files:propose-write "b.txt" "new-b") (write-string (make-string 12000 :initial-element #\\a)) :done' }
  let hostId = ''
  try {
    await writeFile(join(f.dir, 'a.txt'), 'old-a'); await writeFile(join(f.dir, 'b.txt'), 'old-b')
    assert.equal((await f.ctx.commands.execute(f.agent, '/kioku-lisp enable', [], new AbortController().signal)).result.kind, 'success')
    f.responses.push(f.mock.toolCallResponse('prepare-workflow', 'prepare_requested_work', { taskType: 'research' }),
      f.mock.toolCallResponse('workflow-write', 'lisp_eval', args), (request: any) => {
      const result = latestResult(request); hostId = result.operationId
      assert.equal(result.changeSummary.states.APPLIED, 2); assert.equal(result.proposals, undefined)
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16384)
      const { tool, ...inspection } = result.inspect
      return f.mock.toolCallResponse('workflow-read', tool, { operationId: 'read-output', ...inspection })
    }, (request: any) => {
      const result = latestResult(request)
      assert.equal(result.data, 'a'.repeat(2000)); assert.equal(result.nextOffset, 2000)
      return f.mock.textResponse('適用と結果取得を確認しました。')
    })
    await f.turn('Use protected Lisp to update a.txt and b.txt, inspect the output, and verify the recorded changes.')
    assert.equal(approvals, 1); assert.match(observedDetail, /a\.txt/u); assert.match(observedDetail, /b\.txt/u)
    assert.match(observedDetail, /-old-a\n\+new-a/u); assert.match(observedDetail, /-old-b\n\+new-b/u)
    const before = (await stat(join(f.dir, 'a.txt'))).mtimeMs
    await f.reload('compiled')
    assert.equal((await f.ctx.commands.execute(f.agent, '/kioku-lisp recover', [], new AbortController().signal)).result.kind, 'success')
    const firstAfterRecovery = f.model.requests.length
    f.responses.push(f.mock.toolCallResponse('prepare-workflow-recovery', 'prepare_requested_work', { taskType: 'research' }), (request: any) => {
      assert.deepEqual(request.tools.map((tool: any) => tool.name).sort(), expectedLispTools)
      return f.mock.toolCallResponse('workflow-replay', 'lisp_eval', args)
    }, (request: any) => {
      const result = latestResult(request)
      assert.equal(result.replay, true); assert.equal(result.operationId, hostId); assert.equal(result.changeSummary.states.APPLIED, 2)
      return f.mock.toolCallResponse('workflow-receipts', 'lisp_inspect', { operationId: 'read-receipts', resultOperationId: hostId, section: 'changes' })
    }, (request: any) => {
      const receipts = JSON.parse(latestResult(request).data)
      assert.equal(receipts.length, 2); assert.ok(receipts.every((r: any) => r.state === 'APPLIED'))
      return f.mock.textResponse('再開後も再適用せず履歴を確認できました。')
    })
    await f.turn()
    requireBody(f.model.requests[firstAfterRecovery], 'kiokuko-lisp')
    assert.equal(approvals, 1); assert.equal((await stat(join(f.dir, 'a.txt'))).mtimeMs, before)
    assert.equal(await readFile(join(f.dir, 'a.txt'), 'utf8'), 'new-a'); assert.equal(await readFile(join(f.dir, 'b.txt'), 'utf8'), 'new-b')
  } finally { await f.close() }
})

test('compiled Skill delivery: real DeepSeek serializer sends the bodies in the HTTP payload',native,async t=>{
  const f=await fixture(false)
  const provider=await import(pathToFileURL(join(packages!,'@deepseek-ai/dsh-llm-deepseek/lib/index.js')).href)
  const wire:any[]=[]
  const http=t.mock.method(globalThis,'fetch',async(url:any,options:any)=>{
    assert.ok(['https://skill-delivery.invalid/chat/completions','https://skill-delivery.invalid/v1/messages'].includes(String(url)))
    wire.push(JSON.parse(options.body))
    return deepSeekFixtureResponse(String(url), wire.at(-1).model, { text: '確認しました。' })
  })
  const adapter=new provider.DeepSeekAdapter({options:()=>provider.resolveAdapterOptions({baseURL:'https://skill-delivery.invalid',thinking:'disabled',reasoningEffort:'off'}),resolveApiKey:async()=> 'fixture-key',resolveAuth:async()=>({headers:{Authorization:'Bearer fixture-key'}}),resolveUserId:()=> 'fixture-user',prepareExtensions:async()=>({fields:{},accept:async()=>{}})})
  const off=f.ctx.llm.registerAdapter(['deepseek-official'],adapter)
  try {
    f.agent.options.provider='deepseek-official';f.agent.options.model='deepseek-v4-pro'
    await f.turn()
    assert.ok(wire.length>0)
    const sent=wireText(wire[0])
    assert.ok(sent.includes(content('kiokuko-soul')))
    assert.ok(sent.includes(content('natural-japanese-output')))
    assert.equal(sent.split(content('kiokuko-soul')).length-1,1)
    assert.equal(sent.split(content('natural-japanese-output')).length-1,1)
  } finally {off();http.mock.restore();await f.close()}
})

for (const taskMode of [false, true]) for (const representation of ['compiled', 'full'] as const) test(`Lisp ${taskMode ? 'task' : 'persistent'} ${representation} delivers auto policy on activation, follow-up and reload`, {
  ...native, skip: !enabled || (!taskMode && process.env.KIOKUKO_REQUIRE_LISP_RUNTIME !== '1'), timeout: 180000,
}, async () => {
  const f = await fixture(false, representation, {lisp:{executionMode:'protected',enabled:true, approvalMode:'auto', startupTimeoutMs:60000}})
  const enable = () => f.ctx.commands.execute(f.agent, taskMode ? '/kioku-lisp enable-task' : '/kioku-lisp enable', [], new AbortController().signal)
  try {
    assert.equal((await enable()).result.kind, 'success')
    for (const phase of ['activation', 'follow-up', 'reload']) {
      if (phase === 'reload') { await f.reload(representation); assert.equal((await enable()).result.kind, 'success') }
      f.responses.push(f.mock.textResponse('Policy received.'))
      await f.turn('Explain the current Lisp approval policy without executing anything.')
      const delivered = textOf(f.model.requests.at(-1))
      assert.match(delivered, /Lisp execution mode: protected; approval mode: auto \(entire profile\)/)
      assert.match(delivered, /Do not ask permission to submit, resubmit, run verification or apply changes/)
    }
  } finally { await f.close() }
})
