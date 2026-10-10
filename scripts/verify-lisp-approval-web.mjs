// Packed Kiokuko, real native Plan tools and Web approval UI; disposable profile and scripted local model.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { transform } from 'esbuild'
const exec = promisify(execFile), root = resolve(import.meta.dirname, '..')
const base = await realpath(await mkdtemp(join(tmpdir(), 'lisp-approval-web-')))
const project = join(base, 'project'), receipts = join(base, 'receipts.jsonl')
const runtime = process.env.KIOKUKO_LISP_APPROVAL_RUNTIME ?? 'dsh-runtime'
const dsh = process.env.DSH_BIN ?? join(root, `tests/fixtures/${runtime}/node_modules/.bin/dsh`)
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
  console.log('Packed fixture installed')
  const fixture = join(base, 'fixture.mjs')
  await writeFile(join(project, 'change.txt'), 'before')
  await writeFile(join(project, 'package.json'), JSON.stringify({scripts:{typecheck:'node -e "process.exit(0)"', 'test:packages':'node -e "process.exit(0)"'}}))
  const mockPath=join(base,'mock.mjs')
  await writeFile(mockPath,(await transform(await readFile(join(root,'tests/dsh/helpers/native-mock.ts'),'utf8'),{loader:'ts',format:'esm'})).code)
  await writeFile(fixture, `import {appendFile} from 'node:fs/promises'; import {randomUUID} from 'node:crypto';
import * as llm from ${JSON.stringify(pathToFileURL(join(root,`tests/fixtures/${runtime}/node_modules/@deepseek-ai/dsh-llm/lib/index.js`)).href)};
import {nativeMock,nativeToolResults} from ${JSON.stringify(pathToFileURL(mockPath).href)};
export const name='lisp-approval-fixture'; export const inject=['workspaceRegistry','commands','tools','agents','llm'];
export async function apply(ctx){
const mock=nativeMock(llm), responses=[], attempts=[];
class FixtureAdapter extends mock.MockAdapter {
 async *stream(input){
  const attempt={purpose:input.purpose??'conversation',sessionId:input.sessionId,pending:responses.length,messages:input.messages.map(message=>({role:message.role,id:message.id,source:message.source?.kind,toolCallId:message.toolCallId,calls:(message.content??[]).filter(block=>block.type==='tool-call').map(block=>({id:block.id,name:block.name}))})).slice(-6)};
  attempts.push(attempt);
  try { yield* super.stream(input) } catch(error){attempt.error=String(error);throw error}
 }
}
const model=new FixtureAdapter(responses);ctx.llm.registerAdapter(['approval-fixture'],model);
await ctx.workspaceRegistry.create(${JSON.stringify(project)},'Lisp approval verification');
ctx.commands.register({name:'lisp-approval-fixture',description:'Approval acceptance',input:{hint:'seed | enable | apply | verify | packages'},handler:async request=>{
 const mode=request.rawInput.trim(); const agent=ctx.agents.get(request.agent.id); let result;
 if(responses.length) throw new Error('Unconsumed native fixture responses before '+mode+': '+JSON.stringify(attempts.slice(-5)));
 if(mode==='seed'){
 // The native loop establishes v4's protected system head before the user message.
 responses.push(()=>{result={kind:'success'};return mock.textResponse('Approval fixture ready')});
 agent.followup(llm.createUserMessage({content:[{type:'text',text:'Approval fixture'}],source:{kind:'user'}}));await agent.whenIdle();
 }
 else if(mode==='approval-status') result=(await ctx.commands.execute(agent,'/kioku-lisp approval status',[],request.signal)).result;
 else if(mode==='enable') result=(await ctx.commands.execute(agent,'/kioku-lisp enable',[],request.signal)).result;
 else if(mode==='approval-ask') result=(await ctx.commands.execute(agent,'/kioku-lisp approval ask',[],request.signal)).result;
 else {
 const code=mode.startsWith('apply')?'(kioku.files:propose-write "change.txt" "'+mode+'")':mode==='verify'?'(kioku.ci:verify :typecheck)':'(kioku.ci:verify :test :script "test:packages")';
 const callId=randomUUID();
 responses.push(...mock.prepareWork([mock.toolCallResponse(callId,'lisp_eval',{operationId:randomUUID(),code}),(input)=>{result=nativeToolResults(input.messages).find(value=>value.toolCallId===callId);return mock.textResponse('Fixture complete')}],'research',randomUUID()));
 agent.followup(llm.createUserMessage({content:[{type:'text',text:'Perform the requested repository verification using Lisp.'}],source:{kind:'user'}}));await agent.whenIdle();
 }
 if(result===undefined||responses.length) throw new Error('Native fixture '+mode+' did not complete its script: '+JSON.stringify(attempts.slice(-5)));
 await appendFile(${JSON.stringify(receipts)},JSON.stringify({mode,result})+'\\n'); return {kind:'success',text:'Recorded '+mode};
}});}
`)
  const patch = join(env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')
  await writeFile(patch, `- id: session-title-llm\n  disabled: true\n- id: agent-default-model\n  config: {provider: approval-fixture, model: mock}\n- id: kiokuko-dsh\n  config:\n    enabled: true\n    orca: {enabled: false}\n    memoryReview: {mode: off}\n    memoryEvolution: {mode: off}\n    memoryIndexReasoning: {mode: off}\n    lisp: {enabled: true}\n- insert:\n    - id: lisp-approval-fixture\n      name: ${JSON.stringify(fixture)}\n      inject: [workspaceRegistry, commands, tools, agents, sessionProjections, llm]\n`)
  const boot = async () => {
    logs = ''
    host = spawn(dsh, ['--profile', 'web', '--no-open', '--port', '0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [host.stdout, host.stderr]) stream.on('data', c => { logs += c })
    return await poll(() => logs.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0])
  }
  const url = await boot()
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  page = await browser.newPage()
  await page.goto(url)
  const welcome = page.getByRole('button', { name: 'Continue', exact: true })
  const credentials = page.getByRole('dialog', { name: 'Add an API key to get started', exact: true })
  // The mock provider can make credentials optional. Dismiss the dialog if it
  // appears during a later action, rather than racing a one-shot visibility check.
  await page.addLocatorHandler(credentials, async () => {
    await credentials.getByRole('button', { name: 'Configure later', exact: true }).click()
  })
  await welcome.or(credentials).first().waitFor()
  if (await welcome.isVisible()) await welcome.click()
  const conversation = page.locator('[data-conversation-content]:visible').first()
  const newSession = async () => {
    // Startup restores a session independently of New session. Wait for that
    // initial binding so its completion cannot masquerade as our navigation.
    const previous = await poll(() => conversation.getAttribute('data-conversation-session'))
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    // New session starts asynchronous navigation. Wait for its rendered binding
    // before filling the composer, or the replacement discards the first command.
    await poll(async () => {
      const current = await conversation.getAttribute('data-conversation-session')
      return current && current !== previous
        && await conversation.getAttribute('data-content-phase') !== 'settling'
    })
  }
  const editor = conversation.locator('[data-composer-input="true"][contenteditable="true"][data-phase="plain"]:visible').first()
  const command = async text => {
    await editor.fill(text)
    // The enabled button reflects the current draft and submits through DSH's
    // native input state machine without racing installation of the Enter keymap.
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
  }
  const records = async () => (await readFile(receipts, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
  await newSession()
  await command('/lisp-approval-fixture seed')
  await poll(async()=> (await records()).find(r=>r.mode==='seed'))
  assert.equal(await page.getByRole('combobox',{name:'Lisp approvals'}).count(),0,'ordinary chat has no global Lisp approval selector')
  await command('/lisp-approval-fixture enable')
  assert.equal((await poll(async () => (await records()).find(r => r.mode === 'enable'))).result.kind, 'success')
  await page.setViewportSize({width:390,height:844})
  await command('/lisp-approval-fixture approval-status')
  assert.match((await poll(async()=> (await records()).find(r=>r.mode==='approval-status'))).result.text,/ask/)
  await command('/lisp-approval-fixture apply-default')
  await page.getByText('Auto-approve all Lisp actions for this profile and continue',{exact:false}).first().waitFor()
  assert.equal(await readFile(join(project,'change.txt'),'utf8'),'before','default policy cannot write before consent')
  await page.keyboard.press('2'); await page.keyboard.press('Enter')
  const defaultDenied=await poll(async()=> (await records()).find(r=>r.mode==='apply-default'))
  assert.match(JSON.stringify(defaultDenied.result),/NOT_APPLIED/)
  assert.equal(await readFile(join(project,'change.txt'),'utf8'),'before','denial preserves existing bytes')
  // A later independent operation can explicitly enable profile auto-approval.
  await command('/lisp-approval-fixture apply')
  await page.getByText('Auto-approve all Lisp actions for this profile and continue', {exact:false}).first().waitFor()
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth),true,'approval fits narrow viewport')
  await page.keyboard.press('4')
  assert.equal(await page.getByRole('button',{name:/^4\. Auto-approve all Lisp actions/}).getAttribute('aria-pressed'),'true')
  await page.keyboard.press('Enter')
  const applied=await poll(async () => (await records()).find(r => r.mode === 'apply'))
  const resultValue = result => JSON.parse(result.content.find(block=>block.type==='text').text)
  const generation=resultValue(applied.result).generation
  const autoStatusCount=(await records()).length
  await command('/lisp-approval-fixture approval-status')
  const reported=await poll(async()=>{const rows=await records();return rows.length>autoStatusCount ? rows.at(-1).result : undefined})
  assert.match(reported.text,/auto/)
  assert.equal(await readFile(join(project,'change.txt'),'utf8'),'apply')
  for (const mode of ['apply-again','verify','packages']) {
    await command('/lisp-approval-fixture '+mode)
    const result=(await poll(async () => (await records()).find(r=>r.mode===mode))).result
    assert.ok(!result.isError,JSON.stringify(result))
    assert.equal(resultValue(result).generation,generation,'setting changes keep the current worker')
    assert.match(JSON.stringify(result),mode.startsWith('apply') ? /APPLIED/ : /SUCCEEDED/)
  }
  // A cold Host and new chat must consume the same persisted profile policy.
  await new Promise(resolve => { host.once('exit', resolve); host.kill('SIGTERM') })
  await page.goto(await boot())
  assert.doesNotMatch(logs, /stored log is corrupt|SessionFormatError/, 'cold restart accepts the native session log')
  await newSession()
  for (const mode of ['seed','enable']) {
    const count=(await records()).length
    await command('/lisp-approval-fixture '+mode)
    await poll(async()=> (await records()).length > count)
  }
  const statusCount=(await records()).length
  await command('/lisp-approval-fixture approval-status')
  assert.match((await poll(async()=>{const rows=await records();return rows.length>statusCount ? rows.at(-1).result : undefined})).text,/auto/)
  assert.equal(await page.getByRole('combobox',{name:'Lisp approvals'}).count(),0)
  const count=(await records()).length
  await command('/lisp-approval-fixture verify')
  assert.match(JSON.stringify(await poll(async()=>{const rows=await records();return rows.length>count ? rows.at(-1).result : undefined})),/SUCCEEDED/)
  const resetCount=(await records()).length
  await command('/lisp-approval-fixture approval-ask')
  assert.equal((await poll(async()=>{const rows=await records();return rows.length>resetCount ? rows.at(-1).result : undefined})).kind,'success')
  const deniedCount=(await records()).length
  await command('/lisp-approval-fixture verify')
  await page.getByText('Auto-approve all Lisp actions for this profile and continue',{exact:false}).first().waitFor()
  await page.keyboard.press('2'); await page.keyboard.press('Enter')
  const denied=await poll(async()=>{const rows=await records();return rows.length>deniedCount ? rows.at(-1) : undefined})
  assert.match(JSON.stringify(denied.result),/NOT_APPLIED/,'disabling auto-approval restores denial without execution')
  console.log(JSON.stringify({result:'passed',runtime,checks:['ordinary chat has no Lisp approval selector','fresh profile asks by default','denial preserves bytes','explicit enable and continue','file effect','multiple file changes','consecutive verifiers','cold restart and new chat','disable restores manual'],externalModelCalls:0}))

} catch (e) { console.error(await readFile(receipts,'utf8').catch(()=>'')); console.error(logs.slice(-5000)); if (page) console.error((await page.locator('body').innerText().catch(() => '')).slice(-4000)); throw e }
finally {
  await browser?.close()
  if (host && host.exitCode === null) { host.kill('SIGTERM'); await Promise.race([new Promise(r => host.once('exit', r)), new Promise(r => setTimeout(r, 5000))]); if (host.exitCode === null) host.kill('SIGKILL') }
  await rm(base, { recursive: true, force: true })
}
