import {completeVerification} from './verification-completion.mjs';
// Packed plugin + published DSH Web + Chromium. Only model generation is scripted.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { transform } from 'esbuild'

const exec = promisify(execFile), root = resolve(import.meta.dirname, '..')
const base = await realpath(await mkdtemp(join(tmpdir(), 'coding-web-')))
const project = join(base, 'project'), receipts = join(base, 'receipts.jsonl')
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(root, 'tests/fixtures/dsh-runtime/node_modules')
const dsh = join(packages, '.bin/dsh')
const env = { ...process.env, HOME: join(base, 'home'), DSH_HOME: join(base, 'dsh'), KIOKUKO_DATA_DIR: join(base, 'data'), npm_config_cache: join(base, 'cache') }
let host, browser, page, logs = ''
async function poll(fn, timeout = 60000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('Timed out waiting for coding Web acceptance')
}
try {
  for (const directory of ['project','home','dsh','data']) await mkdir(join(base, directory))
  await mkdir(join(project, 'src'))
  const packed = process.env.KIOKUKO_VERIFY_TARBALL ? JSON.parse(await readFile(process.env.KIOKUKO_VERIFY_PACK_METADATA,'utf8'))[0] : JSON.parse((await exec('npm', ['pack','--ignore-scripts','--pack-destination',base,'--json'], {cwd:root,env})).stdout)[0]
  await exec(dsh, ['plugin','--profile','web','add',process.env.KIOKUKO_VERIFY_TARBALL ?? join(base,packed.filename),'--force'], {cwd:project,env,timeout:120000,maxBuffer:16*1024**2})
  const mockPath = join(base, 'mock.mjs'), fixture = join(base, 'fixture.mjs')
  await writeFile(mockPath, (await transform(await readFile(join(root,'tests/dsh/helpers/native-mock.ts'),'utf8'), {loader:'ts',format:'esm'})).code)
  const definition = {
    goal:{goalId:'parser-goal',revision:1,ideal:'The user runs the parser command with 41 and sees 42',target:'src/parser.mjs',outOfScope:['Publishing'],constraints:['Preserve numeric inputs'],requestBasis:'Implement the parser command',criterionIds:['user-entry']},
    items:[{itemId:'parser',change:'Implement the parser command and regression assertions',dependsOn:[],criterionIds:['regression'],goalCriterionIds:['user-entry']}],
    criteria:[{criterionId:'regression',revision:1,outcome:'The parser adds one to numeric input',procedure:'Run the selected parser assertions',expected:'All assertions pass without skips',evidence:'selected_tests'},
      {criterionId:'user-entry',revision:1,outcome:'The user invokes the CLI and sees 42',procedure:'Launch the public CLI after item checks',expected:'CLI output is 42',evidence:'selected_tests'}],
  }
  const program = "export const parse = n => Number(n)+1;\nif(process.argv[1]?.endsWith('parser.mjs')) console.log(parse(process.argv[2]));\n"
  const check = "import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {parse} from './parser.mjs';test('numeric regression',()=>assert.equal(parse('41'),42));test('ordinary CLI entry',()=>assert.equal(execFileSync(process.execPath,['src/parser.mjs','41'],{encoding:'utf8'}).trim(),'42'));\n"
  await writeFile(fixture, `import {appendFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import * as llm from ${JSON.stringify(pathToFileURL(join(packages,'@deepseek-ai/dsh-llm/lib/index.js')).href)};
import {nativeMock,nativeToolResults} from ${JSON.stringify(pathToFileURL(mockPath).href)};
export const name='coding-web-fixture',inject=['workspaceRegistry','commands','tools','agents','llm'];
export async function apply(ctx){
const mock=nativeMock(llm),responses=[];ctx.llm.registerAdapter(['coding-fixture'],new mock.MockAdapter(responses));
await ctx.workspaceRegistry.create(${JSON.stringify(project)},'Coding verification');
const value=(request,id)=>{const result=nativeToolResults(request.messages).filter(r=>r.toolCallId===id).at(-1);if(!result||result.isError)throw Error(JSON.stringify(result));return JSON.parse(result.content.filter(b=>b.type==='text').map(b=>b.text).join(''))};
const definition=${JSON.stringify(definition)},command='node --test --test-reporter=tap src/parser.test.mjs';
ctx.commands.register({name:'coding-fixture',description:'Isolated coding acceptance',input:{hint:'seed | complete | pending | resume'},handler:async request=>{
const mode=request.rawInput.trim(),agent=ctx.agents.get(request.agent.id),prefix=randomUUID();let result;
if(responses.length)throw Error('Unconsumed fixture script');
if(mode==='seed'){responses.push(()=>{result={ready:true};return mock.textResponse('Fixture ready')});}
else {
const call=(id,name,args)=>responses.push(mock.toolCallResponse(prefix+id,name,args));
const prepare=(relation)=>request=>{const text=request.messages.flatMap(m=>m.source?.sections??[]).filter(s=>s.name==='on-demand-intake').at(-1)?.text;const json=text?.split('Current request references and same-session work (host-bound, advisory only):\\n')[1]?.split('\\n')[0];if(!json)throw Error('Missing current host references');return mock.toolCallResponse(prefix+'prepare','prepare_requested_work',{requestIntent:{relation,action:'change',changeScope:'implementation',evidenceRefs:JSON.parse(json).references}})};
if(mode!=='resume'){
 responses.push(prepare('new'),r=>{const result=value(r,prefix+'prepare');if(!result.prepared)throw Error('Preparation failed');return mock.toolCallResponse(prefix+'status','coding_workflow',{action:'status'})},(r)=>mock.toolCallResponse(prefix+'propose','coding_workflow_apply',{action:'propose',expectedRevision:value(r,prefix+'status').revision,definition}));
}else {responses.push(prepare('same_scope_continuation'));call('reopen','coding_workflow',{action:'next'});}
if(mode==='complete'){
 call('program','kioku_write',{path:'src/parser.mjs',content:${JSON.stringify(program)}});call('test','kioku_write',{path:'src/parser.test.mjs',content:${JSON.stringify(check)}});
 for(const id of ['regression','user-entry'])responses.push(r=>mock.toolCallResponse(prefix+'bind-'+id,'task_completion',{action:'bind',criterionId:'coding:'+value(r,prefix+'propose').workflowId+':'+id,method:{kind:'native_command',command,cwd:'.',sourcePaths:['src/parser.mjs','src/parser.test.mjs'],assertion:'selected_tests_pass'}}));
 call('item-check','kioku_exec',{command});call('goal-check','kioku_exec',{command});
}
call('final','coding_workflow',{action:'status'});
responses.push(r=>{result=value(r,prefix+'final');return mock.textResponse(mode==='complete'?'Goal achieved: the ordinary CLI returned 42.':'The Goal is preserved; implementation awaits this task’s choice.')});
}
agent.followup(llm.createUserMessage({source:{kind:'user'},content:[{type:'text',text:mode==='seed'?'Fixture ready':mode==='resume'?'Continue the current task without changing its scope.':'Implement src/parser.mjs so its public command adds one to numeric input. 通常実行で。'}]}));
await agent.whenIdle();if(result===undefined||responses.length)throw Error('Incomplete fixture script');await appendFile(${JSON.stringify(receipts)},JSON.stringify({mode,result})+'\\n');return {kind:'success',text:'Recorded '+mode};
}});}
`)
  await writeFile(join(env.DSH_HOME,'profiles/web/cordis.patch.yml'), `- id: session-title-llm
  disabled: true
- id: agent-default-model
  config: {provider: coding-fixture, model: mock}
- id: kiokuko-dsh
  config:
    enabled: true
    agenticReplay: {enabled: false}
    typedDecisions: {mode: off}
    memoryReview: {mode: off}
    memoryEvolution: {mode: off}
    memoryIndexReasoning: {mode: off}
    answerReview: {mode: off}
    modelAutoMode: {mode: off}
    lisp: {enabled: false}
- insert:
    - id: coding-web-fixture
      name: ${JSON.stringify(fixture)}
      inject: [workspaceRegistry, commands, tools, agents, llm]
`)
  const launch = async (port = '0') => {
    logs = ''
    host = spawn(dsh,['--profile','web','--no-open','--port',port],{cwd:project,env,stdio:['ignore','pipe','pipe']})
    for (const stream of [host.stdout,host.stderr]) stream.on('data',chunk=>{logs+=chunk})
    return poll(()=>logs.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0])
  }
  const url = await launch()
  browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})})
  page = await browser.newPage(); await page.goto(url)
  const welcome = page.getByRole('button',{name:'Continue',exact:true}), credentials=page.getByRole('dialog',{name:'Add an API key to get started',exact:true})
  await page.addLocatorHandler(credentials,()=>credentials.getByRole('button',{name:'Configure later',exact:true}).click())
  await welcome.or(credentials).first().waitFor();if(await welcome.isVisible())await welcome.click()
  const conversation = page.locator('[data-conversation-content]:visible').first()
  const newSession = async()=>{
    const old = await poll(()=>conversation.getAttribute('data-conversation-session'))
    await page.getByRole('button',{name:'New session',exact:true}).first().click()
    await poll(async()=>{const id=await conversation.getAttribute('data-conversation-session');return id&&id!==old&&await conversation.getAttribute('data-content-phase')!=='settling'})
  }
  const records=async()=>(await readFile(receipts,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse)
  const command=async(mode)=>{const editor=conversation.locator('[data-composer-input="true"][contenteditable="true"][data-phase="plain"]:visible').first();const send=page.getByRole('button',{name:'Send message',exact:true});await poll(async()=>{await editor.fill('/coding-fixture '+mode);return send.isEnabled()});await send.click()}
  const expectRecoveredGoal=async()=>{const mode=page.getByText('この作業をどう実行しますか？',{exact:true}),goal=page.locator('[data-coding-goal]');await mode.or(goal).first().waitFor();assert.equal(await mode.isVisible(),false,'existing pending coding Goal must not request a new execution mode')}
  await newSession();await command('seed');await poll(async()=>(await records()).find(r=>r.mode==='seed'))
  await page.setViewportSize({width:390,height:844});await command('complete')
  const goal=page.locator('[data-coding-goal]')
  await goal.waitFor();assert.match(await goal.innerText(),/CLI|parser command/);assert.match(await goal.innerText(),/確認/)
  assert.equal(await readFile(join(project,'src/parser.mjs'),'utf8').catch(()=>undefined),undefined,'no file before human choice')
  await page.keyboard.press('2');await page.keyboard.press('Enter')
  const completed=await poll(async()=>(await records()).find(r=>r.mode==='complete'))
  assert.equal(completed.result.state,'completed');assert.equal(completed.result.assessment.verified,true)
  assert.equal((await exec(process.execPath,['src/parser.mjs','41'],{cwd:project})).stdout.trim(),'42')
  await newSession();await command('pending');await goal.waitFor()
  await page.getByRole('button',{name:'質問を閉じる',exact:true}).click()
  const pending=await poll(async()=>(await records()).find(r=>r.mode==='pending'))
  const pendingSessionId=await conversation.getAttribute('data-conversation-session')
  assert.equal(pending.result.choice.state,'cancelled');assert.equal(pending.result.assessment.verified,false)
  const oldPort = new URL(url).port
  host.kill('SIGTERM');await new Promise(resolve=>host.once('exit',resolve))
  await page.goto(await launch(oldPort));await poll(async()=>await conversation.getAttribute('data-conversation-session')&&await conversation.getAttribute('data-content-phase')==='active')
  assert.equal(await conversation.getAttribute('data-conversation-session'),pendingSessionId,'browser reopens the cancelled native session after restart')
  assert.equal(await goal.count(),0,'host restart must not reopen cancelled implementation')
  await command('resume')
  const executionMode=page.getByText('この作業をどう実行しますか？',{exact:true})
  await executionMode.waitFor()
  assert.equal(await goal.count(),0,'explicit continuation still requires a fresh native execution choice')
  await page.keyboard.press('1');await page.keyboard.press('Enter')
  const resumed=await poll(async()=>(await records()).find(r=>r.mode==='resume'))
  assert.notEqual(resumed.result.workflowId,pending.result.workflowId,'explicit request must not revive the cancelled workflow')
  assert.notEqual(resumed.result.choice.questionId,pending.result.choice.questionId,'replacement work has a fresh choice identity')
  assert.equal(resumed.result.state,'preparing');assert.equal(resumed.result.choice.state,'pending')
  assert.equal(resumed.result.items.length,0);assert.equal(resumed.result.assessment.verified,false)
  assert.equal(await readFile(join(project,'src/parser.mjs'),'utf8'),program,'cancel and replacement admission preserve the existing implementation')
  assert.equal(await goal.count(),0,'replacement admission must not start implementation or reopen the cancelled Goal')
  console.log(JSON.stringify({result:'passed',runtime:JSON.parse(await readFile(join(packages,'@deepseek-ai/dsh/package.json'),'utf8')).version,package:packed.filename,checks:['Goal before effects','keyboard no','ordinary CLI artifact','current item and final evidence','close cancels normally','host restart does not reopen cancellation','explicit continuation requires a fresh native execution choice','replacement task has fresh identity and no effects'],externalModelCalls:0}))
} catch(error) {
  console.error(logs.slice(-4000));console.error((await readFile(receipts,'utf8').catch(()=>'' )).slice(-1500));if(page)console.error((await page.locator('body').innerText().catch(()=>'' )).slice(-2500));throw error
} finally {
  await browser?.close()
  if(host&&host.exitCode===null){host.kill('SIGTERM');await Promise.race([new Promise(resolve=>host.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);if(host.exitCode===null)host.kill('SIGKILL')}
  await rm(base,{recursive:true,force:true})
}

completeVerification({});
