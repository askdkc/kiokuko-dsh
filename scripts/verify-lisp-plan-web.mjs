import { newSessionForTest } from './browser-session.mjs'
import { selectedDshRuntime } from './dsh-fixture-identity.mjs'
import { declineOptionalMemoryOffers } from './lib/web-test-navigation.mjs';
import { webTestPort } from './test-web-port.mjs';
import { completeVerification } from './verification-completion.mjs';
// Packed Kiokuko, native agent-loop Plan tools and Web approval UI; scripted local generation.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { build, transform } from 'esbuild'
const exec = promisify(execFile), root = resolve(import.meta.dirname, '..')
const selected = selectedDshRuntime(root)
const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-plan-web-')))
const project = join(base, 'project'), receipts = join(base, 'receipts.jsonl')
const dsh = selected.environment.DSH_BIN
const env = { ...selected.environment, HOME: join(base, 'home'), DSH_HOME: join(base, 'dsh'), KIOKUKO_DATA_DIR: join(base, 'data'), npm_config_cache: join(base, 'cache') }
let host, browser, page, logs = ''
async function poll(fn, timeout = 60000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)) }
  throw new Error('Timed out waiting for Plan Web acceptance')
}
try {
  for (const dir of ['project', 'home', 'dsh', 'data']) await mkdir(join(base, dir))
  const packed = process.env.KIOKUKO_VERIFY_TARBALL ? {stdout:await readFile(process.env.KIOKUKO_VERIFY_PACK_METADATA,'utf8')} : await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', base, '--json'], { cwd: root, env })
  console.log('Installing packed fixture')
  await exec(dsh, ['plugin', '--profile', 'web', 'add', process.env.KIOKUKO_VERIFY_TARBALL ?? join(base, JSON.parse(packed.stdout)[0].filename), '--force'], { cwd: project, env, timeout: 120000, maxBuffer: 16 * 1024 ** 2 })
  const fixture = join(base, 'fixture.mjs')
  const mockPath = join(base, 'mock.mjs')
  await writeFile(mockPath, (await transform(await readFile(join(root,'tests/dsh/helpers/native-mock.ts'),'utf8'), {loader:'ts',format:'esm'})).code)
  const planPath = join(base, 'plan-script.mjs')
  await build({ entryPoints: [join(root, 'tests/dsh/helpers/plan-script.ts')], outfile: planPath, bundle: true, platform: 'node', format: 'esm' })
  await writeFile(fixture, `import {appendFile} from 'node:fs/promises'; import {randomUUID} from 'node:crypto';
import * as llm from ${JSON.stringify(pathToFileURL(join(selected.packageRoot,'@deepseek-ai/dsh-llm/lib/index.js')).href)};
import {nativeMock,nativeToolResults} from ${JSON.stringify(pathToFileURL(mockPath).href)};
import {planPreparation} from ${JSON.stringify(pathToFileURL(planPath).href)};
export const name='lisp-plan-fixture'; export const inject=['workspaceRegistry','commands','tools','agents','sessionProjections','llm'];
export async function apply(ctx){
const mock=nativeMock(llm),responses=[];ctx.llm.registerAdapter(['plan-fixture'],new mock.MockAdapter(responses));
await ctx.workspaceRegistry.create(${JSON.stringify(project)},'Lisp Plan verification');
ctx.commands.register({name:'lisp-plan-fixture',description:'Native Plan acceptance with scripted generation',input:{hint:'seed | enable | start | question | keep | approve'},handler:async request=>{
 const mode=request.rawInput.trim(); const agent=ctx.agents.get(request.agent.id); let result;
 if(mode==='seed'){responses.push(mock.textResponse('Plan fixture ready'));agent.followup(llm.createUserMessage({content:[{type:'text',text:'Plan fixture'}],source:{kind:'user'}}));await agent.whenIdle();await appendFile(${JSON.stringify(receipts)},JSON.stringify({mode})+'\\n');return {kind:'success',text:'Ready'};}
 if(mode==='enable'||mode==='start'){const executed=await ctx.commands.execute(agent,mode==='enable'?'/kioku-lisp enable-task':'/plan',[],request.signal);await appendFile(${JSON.stringify(receipts)},JSON.stringify({mode,result:executed.result})+'\\n');return {kind:'success',text:'Recorded '+mode};}
 const state=()=>ctx.sessionProjections.stateOf(agent.session,'plan');
 const name=mode==='question'?'ask_user_question':'exit_plan_mode';
 const args=mode==='question'?{questions:[{id:'choice',question:'Plan preference?',options:[{label:'Yes'},{label:'No'}]}]}:{plan:'# Lisp Plan acceptance\\n\\nPreserve protected effects.'};
 const before=state(),callId=randomUUID(),prepareId=randomUUID();let settled;
 const off=ctx.on('tools/result',async(execution,value)=>{if(execution.callId===callId)settled=value;if(execution.callId===prepareId)await appendFile(${JSON.stringify(receipts)},JSON.stringify({mode,stage:'preparation',isError:value.isError,prepared:value.value?.prepared,status:value.value?.status,relation:value.value?.requestIntent?.relation,action:value.value?.requestIntent?.action})+'\\n')});
 responses.push(...mock.prepareWork([mock.toolCallResponse(callId,name,args),(input)=>{result=nativeToolResults(input.messages).find(value=>value.toolCallId===callId);return mock.textResponse('Plan fixture recorded '+mode)}],'research',prepareId,planPreparation(mock,prepareId,mode)));
 try{agent.followup(llm.createUserMessage({content:[{type:'text',text:'Plan the repository workflow using Lisp. Do not implement changes. 通常実行で。'}],source:{kind:'user'}}));await agent.whenIdle();}finally{off()}
 if(!result||!settled||responses.length)throw Error('Incomplete native Plan fixture '+mode);
 await appendFile(${JSON.stringify(receipts)},JSON.stringify({mode,isError:settled.isError,value:settled.value,content:result.content,before,after:state()})+'\\n');
 return {kind:'success',text:'Recorded '+mode};
}});}
`)
  const patch = join(base, 'patch.yml')
  await writeFile(patch, `- id: session-title-llm\n  disabled: true\n- id: agent-default-model\n  config: {provider: plan-fixture, model: mock}\n- id: kiokuko-dsh\n  config:\n    enabled: true\n    agenticReplay: {enabled: false}\n    lisp: {enabled: true}\n- insert:\n    - id: lisp-plan-fixture\n      name: ${JSON.stringify(fixture)}\n      inject: [workspaceRegistry, commands, tools, agents, sessionProjections, llm]\n`)
  host = spawn(dsh, ['--profile', 'web', '--patch', patch, '--no-open', '--port', webTestPort()], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [host.stdout, host.stderr]) stream.on('data', c => { logs += c })
  const url = await poll(() => logs.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0])
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  page = await browser.newPage()
  await declineOptionalMemoryOffers(page)
  await page.goto(url)
  const welcome = page.getByRole('button', { name: 'Continue', exact: true })
  const credentials = page.getByRole('dialog', { name: 'Add an API key to get started', exact: true })
  await page.addLocatorHandler(credentials, () => credentials.getByRole('button', { name: 'Configure later', exact: true }).click())
  await welcome.or(credentials).first().waitFor()
  if (await welcome.isVisible()) await welcome.click()
  const conversation = page.locator('[data-conversation-content]:visible').first()
  await newSessionForTest(page, conversation, poll)
  const editor = conversation.locator('[data-composer-input="true"][contenteditable="true"][data-phase="plain"]:visible').first()
  const command = async text => { await editor.fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click() }
  const records = async () => (await readFile(receipts, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
  await command('/lisp-plan-fixture seed')
  await poll(async () => (await records()).find(r => r.mode === 'seed'))
  await command('/lisp-plan-fixture enable')
  assert.equal((await poll(async () => (await records()).find(r => r.mode === 'enable'))).result.kind, 'success')
  await command('/lisp-plan-fixture start')
  assert.equal((await poll(async () => (await records()).find(r => r.mode === 'start'))).result.kind, 'success')
  await command('/lisp-plan-fixture question')
  await page.getByText('Plan preference?', { exact: true }).waitFor()
  await page.keyboard.press('1'); await page.keyboard.press('Enter')
  const question = await poll(async () => (await records()).find(r => r.mode === 'question' && !r.stage))
  assert.equal(question.isError, false); assert.deepEqual(question.value.answers, [{id:'choice',selected:['Yes']}]); assert.equal(question.after.active, true)
  await command('/lisp-plan-fixture keep')
  await page.getByText('Approve this plan and leave plan mode?', { exact: true }).waitFor()
  await page.keyboard.press('2'); await page.keyboard.press('Enter')
  const kept = await poll(async () => (await records()).find(r => r.mode === 'keep' && !r.stage))
  assert.equal(kept.isError, true); assert.match(JSON.stringify(kept.content), /keep planning/i); assert.equal(kept.after.active, true)
  await command('/lisp-plan-fixture approve')
  await page.getByText('Approve this plan and leave plan mode?', { exact: true }).waitFor()
  await page.getByText('Preserve protected effects.', {exact:true}).waitFor();
  await page.keyboard.press('3'); await page.keyboard.press('Enter')
  const approved = await poll(async () => (await records()).find(r => r.mode === 'approve' && !r.stage))
  assert.equal(approved.isError, false, JSON.stringify(approved)); assert.equal(approved.value.approved, true); assert.equal(approved.after.active, false)
  console.log(JSON.stringify({ result: 'passed', checks: ['native question', 'keep planning', 'approve'], package: 'packed', externalModelCalls: 0 }))
} catch (e) { console.error((await readFile(receipts,'utf8').catch(()=>'' )).slice(-4000)); console.error(logs.slice(-5000).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')); if (page) console.error((await page.locator('body').innerText().catch(() => '')).slice(-4000)); throw e }
finally {
  await browser?.close()
  if (host && host.exitCode === null) { host.kill('SIGTERM'); await Promise.race([new Promise(r => host.once('exit', r)), new Promise(r => setTimeout(r, 5000))]); if (host.exitCode === null) host.kill('SIGKILL') }
  await rm(base, { recursive: true, force: true })
}

completeVerification({});
