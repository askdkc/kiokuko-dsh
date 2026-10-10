// Packed Kiokuko, real native Plan tools and Web approval UI; disposable profile, no model calls.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
const exec = promisify(execFile), root = resolve(import.meta.dirname, '..')
const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-plan-web-')))
const project = join(base, 'project'), receipts = join(base, 'receipts.jsonl')
const dsh = process.env.DSH_BIN ?? join(root, 'tests/fixtures/dsh-runtime/node_modules/.bin/dsh')
const env = { ...process.env, HOME: join(base, 'home'), DSH_HOME: join(base, 'dsh'), KIOKUKO_DATA_DIR: join(base, 'data'), npm_config_cache: join(base, 'cache') }
let host, browser, page, logs = ''
async function poll(fn, timeout = 60000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)) }
  throw new Error('Timed out waiting for Plan Web acceptance')
}
try {
  for (const dir of ['project', 'home', 'dsh', 'data']) await mkdir(join(base, dir))
  const packed = await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', base, '--json'], { cwd: root, env })
  console.log('Installing packed fixture')
  await exec(dsh, ['plugin', '--profile', 'web', 'add', join(base, JSON.parse(packed.stdout)[0].filename), '--force'], { cwd: project, env, timeout: 120000, maxBuffer: 16 * 1024 ** 2 })
  const fixture = join(base, 'fixture.mjs')
  await writeFile(fixture, `import {appendFile} from 'node:fs/promises'; import {randomUUID} from 'node:crypto';
import {agentEvents} from ${JSON.stringify(pathToFileURL(join(root,'tests/fixtures/dsh-runtime/node_modules/@deepseek-ai/dsh-agent/lib/index.js')).href)};
export const name='lisp-plan-fixture'; export const inject=['workspaceRegistry','commands','tools','agents','sessionProjections'];
export async function apply(ctx){
await ctx.workspaceRegistry.create(${JSON.stringify(project)},'Lisp Plan verification');
ctx.commands.register({name:'lisp-plan-fixture',description:'Native Plan acceptance without a model',input:{hint:'seed | enable | start | question | keep | approve'},handler:async request=>{
 const mode=request.rawInput.trim(); const agent=ctx.agents.get(request.agent.id); let result;
 if(mode==='seed'){agent.session.append('user/message',{id:randomUUID(),role:'user',content:[{type:'text',text:'Plan fixture'}],source:{kind:'user'}},{surfaceOp:'append'});await appendFile(${JSON.stringify(receipts)},JSON.stringify({mode})+'\\n');return {kind:'success',text:'Ready'};}
 if(mode==='enable'||mode==='start'){const executed=await ctx.commands.execute(agent,mode==='enable'?'/kioku-lisp enable-task':'/plan',[],request.signal);await appendFile(${JSON.stringify(receipts)},JSON.stringify({mode,result:executed.result})+'\\n');return {kind:'success',text:'Recorded '+mode};}
 const state=()=>ctx.sessionProjections.stateOf(agent.session,'plan');
 const name=mode==='question'?'ask_user_question':'exit_plan_mode';
 const args=mode==='question'?{questions:[{id:'choice',question:'Plan preference?',options:[{label:'Yes'},{label:'No'}]}]}:{plan:'# Lisp Plan acceptance\\n\\nPreserve protected effects.'};
 result=await ctx.tools.execute({name,arguments:args,callId:randomUUID(),agent:agent,signal:request.signal});
 const before=state();
 if(mode==='approve'&&!result.isError) await agentEvents(ctx,agent).waterfall('agent/pre-step',{messages:[],turn:1,step:1,signal:request.signal},async()=>({kind:'enter',messages:[]}));
 await appendFile(${JSON.stringify(receipts)},JSON.stringify({mode,isError:result.isError,value:result.value,content:result.content,before,after:state()})+'\\n');
 return {kind:'success',text:'Recorded '+mode};
}});}
`)
  const patch = join(base, 'patch.yml')
  await writeFile(patch, `- id: kiokuko-dsh\n  config:\n    enabled: true\n    orca: {enabled: false}\n    lisp: {enabled: true}\n- insert:\n    - id: lisp-plan-fixture\n      name: ${JSON.stringify(fixture)}\n      inject: [workspaceRegistry, commands, tools, agents, sessionProjections]\n`)
  host = spawn(dsh, ['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [host.stdout, host.stderr]) stream.on('data', c => { logs += c })
  const url = await poll(() => logs.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0])
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  page = await browser.newPage()
  await page.goto(url)
  const welcome = page.getByRole('button', { name: 'Continue', exact: true })
  const credentials = page.getByRole('dialog', { name: 'Add an API key to get started', exact: true })
  await welcome.or(credentials).first().waitFor()
  if (await welcome.isVisible()) await welcome.click()
  await credentials.getByRole('button', { name: 'Configure later', exact: true }).click()
  await credentials.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const editor = page.locator('[contenteditable="true"]:visible').first()
  const command = async text => { await editor.fill(text); await editor.press('Enter') }
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
  const question = await poll(async () => (await records()).find(r => r.mode === 'question'))
  assert.equal(question.isError, false); assert.deepEqual(question.value.answers, [{id:'choice',selected:['Yes']}]); assert.equal(question.after.active, true)
  await command('/lisp-plan-fixture keep')
  await page.getByText('Approve this plan and leave plan mode?', { exact: true }).waitFor()
  await page.keyboard.press('2'); await page.keyboard.press('Enter')
  const kept = await poll(async () => (await records()).find(r => r.mode === 'keep'))
  assert.equal(kept.isError, true); assert.match(JSON.stringify(kept.content), /keep planning/i); assert.equal(kept.after.active, true)
  await command('/lisp-plan-fixture approve')
  await page.getByText('Approve this plan and leave plan mode?', { exact: true }).waitFor()
  await page.getByText('Preserve protected effects.', {exact:true}).waitFor();
  await page.keyboard.press('3'); await page.keyboard.press('Enter')
  const approved = await poll(async () => (await records()).find(r => r.mode === 'approve'))
  assert.equal(approved.isError, false, JSON.stringify(approved)); assert.equal(approved.value.approved, true); assert.equal(approved.after.active, false)
  console.log(JSON.stringify({ result: 'passed', checks: ['native question', 'keep planning', 'approve'], package: 'packed', modelCalls: 0 }))
} catch (e) { console.error(logs.slice(-5000)); if (page) console.error((await page.locator('body').innerText().catch(() => '')).slice(-4000)); throw e }
finally {
  await browser?.close()
  if (host && host.exitCode === null) { host.kill('SIGTERM'); await Promise.race([new Promise(r => host.once('exit', r)), new Promise(r => setTimeout(r, 5000))]); if (host.exitCode === null) host.kill('SIGKILL') }
  await rm(base, { recursive: true, force: true })
}
