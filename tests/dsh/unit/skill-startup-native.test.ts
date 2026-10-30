import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nativeSkillFixture } from '../helpers/skill-native.js'
import { nativeToolResults } from '../helpers/native-mock.js'
import { answerTaskStartup, STARTUP_FIXTURE_CHOICES } from '../helpers/task-startup-fixture.js'
import { isolateSkillHome } from '../helpers/skill-home.js'

isolateSkillHome()
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const packageRoot = process.env.KIOKUKO_SKILL_PACKAGE_ROOT
const available = existsSync(join(packages, '@deepseek-ai/dsh-tool-skill/lib/index.js'))
if (!available && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1') throw new Error('Skill startup regression requires the native runtime')

for (const mode of ['full', 'compiled'] as const) for (const skillToolPlacement of ['late', 'agent'] as const) test(`first native Skill call succeeds with ${mode}/${skillToolPlacement} registration, without task preparation`, { skip: !available, timeout: 60_000 }, async () => {
  const f = await nativeSkillFixture({ packages, ...(packageRoot ? { packageRoot } : {}), mode, skillToolPlacement, extra: { lisp: { enabled: true, sbclPath: 'must-not-start-sbcl' }, typedDecisions: { mode: 'off' } } })
  try {
    f.responses.push(
      f.mock.toolCallResponse('first-guidance', 'skill', { name: 'kiokuko-soul' }),
      f.mock.toolCallResponse('lisp-guidance', 'skill', { name: 'kiokuko-lisp' }),
      f.mock.textResponse('Only read the installed guidance; no implementation was performed.'),
    )
    await f.turn('Explain the installed guidance. Do not implement changes or start Lisp.')
    assert.equal(f.model.requests.length, 3)
    assert.equal(f.startupQuestions.length, 1)
    assert.equal(f.startupQuestions[0]!.selected, 'decision OFF / Lisp OFF')
    const results = nativeToolResults(f.model.requests.at(-1).messages)
    for (const [id, name] of [['first-guidance', 'kiokuko-soul'], ['lisp-guidance', 'kiokuko-lisp']]) {
      const result = results.find((entry: any) => entry.toolCallId === id)
      assert.equal(result?.isError, false, `${name}: first read must not require prepare_requested_work`)
      const rendered = result.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('')
      assert.ok(rendered.includes(`<skill_content name="${name}">`))
    }
    assert.ok(f.model.requests.every((request: any) => !request.tools.some((tool: any) => tool.name.startsWith('lisp_'))), 'reading Lisp guidance must not activate its execution tools')
    assert.equal(results.length, 2, 'only the two read calls execute; no preparation or implementation is injected')
  } finally { await f.close() }
})


test('Skill fixture rejects unknown, malformed and changed startup questions',()=>{
  const request={questions:[{id:`task-startup:${'a'.repeat(64)}:0000000000000001:${'b'.repeat(64)}`,header:'Kiokuko · 作業開始',question:'この作業で decision と Lisp を使いますか？',options:STARTUP_FIXTURE_CHOICES.map(label=>({label}))}]}
  for(const choice of STARTUP_FIXTURE_CHOICES)assert.equal(answerTaskStartup(request,choice).answers[0]!.selected[0],choice)
  assert.throws(()=>answerTaskStartup({questions:[{...request.questions[0],id:'unknown'}]},'decision OFF / Lisp OFF'))
  assert.throws(()=>answerTaskStartup({questions:[{...request.questions[0],id:'task-startup:invalid'}]},'decision OFF / Lisp OFF'))
  assert.throws(()=>answerTaskStartup({questions:[{...request.questions[0],options:[]}]},'decision OFF / Lisp OFF'))
  assert.throws(()=>answerTaskStartup({questions:[...request.questions,...request.questions]},'decision OFF / Lisp OFF'))
})

test('decision ON/Lisp OFF startup keeps native Skill execution available', {skip:!available,timeout:60000},async()=>{
  const f=await nativeSkillFixture({packages,...(packageRoot?{packageRoot}:{}),startupChoices:['decision ON / Lisp OFF'],
    extra:{lisp:{enabled:true,sbclPath:'must-not-start-sbcl'},typedDecisions:{mode:'off'}},
    hostPlugin:{name:'skill-no-real-credentials',apply(ctx:any){ctx.provide('credentials',{resolve:async()=>undefined,describe:async()=>({configured:false,writable:false})})}}})
  try{
    f.responses.push(f.mock.toolCallResponse('startup-skill','skill',{name:'kiokuko-soul'}),f.mock.textResponse('Read complete.'))
    await f.turn('Read the installed guidance without executing Lisp.')
    assert.equal(f.startupQuestions.length,1);assert.equal(f.startupQuestions[0]!.selected,'decision ON / Lisp OFF')
    assert.equal(nativeToolResults(f.model.requests.at(-1).messages).find((r:any)=>r.toolCallId==='startup-skill')!.isError,false)
    assert.ok(f.model.requests.every((r:any)=>!r.tools.some((tool:any)=>tool.name.startsWith('lisp_'))))
  }finally{await f.close()}
})

test('startup cancellation executes no Skill; a subsequent new task can select OFF and read it', {skip:!available,timeout:60000},async()=>{
  const f=await nativeSkillFixture({packages,...(packageRoot?{packageRoot}:{}),startupChoices:['取消・作業を保持','decision OFF / Lisp OFF'],
    extra:{lisp:{enabled:true,sbclPath:'must-not-start-sbcl'},typedDecisions:{mode:'off'}}})
  try{
    await f.turn('Read installed guidance after confirming the execution mode.')
    assert.equal(f.model.requests.length,0)
    assert.equal(nativeToolResults(f.agent.session.snapshotEvents().map((e:any)=>e.data)).length,0)
    assert.equal(f.agent.status, 'idle')
    const events = f.agent.session.snapshotEvents()
    assert.deepEqual(events.filter((e:any)=>e.type==='turn/end').at(-1)!.data.reason,{kind:'aborted',reason:{kind:'user'}})
    assert.ok(JSON.stringify(events).includes('Read installed guidance after confirming the execution mode.'), 'cancelled input remains in the native history')
    f.responses.push(f.mock.toolCallResponse('after-startup-cancel','skill',{name:'kiokuko-soul'}),f.mock.textResponse('Read complete.'))
    await f.turn('New task: read the installed guidance with both execution options OFF.')
    assert.equal(f.startupQuestions.length,2)
    assert.equal(nativeToolResults(f.model.requests.at(-1).messages).find((r:any)=>r.toolCallId==='after-startup-cancel')!.isError,false)
  }finally{await f.close()}
})
