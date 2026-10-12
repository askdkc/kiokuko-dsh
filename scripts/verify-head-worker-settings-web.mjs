// Real packed DSH Web settings, isolated profile and local-only model catalogs.
// No paid generation or real credentials: this acceptance verifies selection state only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
const exec = promisify(execFile), root = resolve(import.meta.dirname, '..');
const base = await mkdtemp(join(tmpdir(), 'kiokuko-pair-web-'));
const env = { ...process.env, HOME: join(base,'home'), DSH_HOME:join(base,'dsh'), KIOKUKO_DATA_DIR:join(base,'data'), npm_config_cache:join(base,'cache'), npm_config_store_dir:join(base,'pnpm-store'), PNPM_HOME:join(base,'pnpm'), XDG_DATA_HOME:join(base,'xdg-data'), XDG_CACHE_HOME:join(base,'cache'), DSH_AUTH_CREDENTIALS:join(base,'credentials.json') };
const project = join(base,'project'), dsh = process.env.DSH_BIN ?? join(root,'tests/fixtures/dsh-runtime/node_modules/.bin/dsh');
let host, browser, page, logs = '', generations = 0;
const endpoint = createServer((req,res) => { if(req.method !== 'GET') generations++; res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({data:[]})); });
async function poll(fn, timeout=60000) { const end=Date.now()+timeout; while(Date.now()<end) { const value=await fn(); if(value)return value; await new Promise(r=>setTimeout(r,100)); } throw new Error('Head/worker Web acceptance timed out'); }
async function stop() { if(!host)return; const child=host;host=undefined;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]); }
try {
  await new Promise(r=>endpoint.listen(0,'127.0.0.1',r));
  const baseURL=`http://127.0.0.1:${endpoint.address().port}/v1`;
  for(const name of ['home','dsh','data','project'])await mkdir(join(base,name));
  await exec('git',['init','-q'],{cwd:project});
  const archive=JSON.parse((await exec('npm',['pack','--ignore-scripts','--pack-destination',base,'--json'],{cwd:root,env})).stdout)[0].filename;
  console.log('Installing packed head/worker settings fixture');
  await exec(dsh,['plugin','--profile','web','add',join(base,archive),'--force'],{cwd:project,env,timeout:180000,maxBuffer:16*1024**2});
  const fixture=join(base,'fixture.mjs');
  await writeFile(fixture,`export const name='pair-settings-fixture';export const inject=['workspaceRegistry','llm'];export async function apply(ctx){const providers=ctx.llm.listProviders.bind(ctx.llm);ctx.llm.listProviders=()=>providers().filter(provider=>provider.id.startsWith('kiokuko-fixture-'));await ctx.workspaceRegistry.create(${JSON.stringify(project)},'Pair settings acceptance');}`);
  await writeFile(join(env.DSH_HOME,'profiles/web/cordis.patch.yml'),`- id: session-title-llm\n  disabled: true\n- id: kiokuko-dsh\n  config:\n    enabled: true\n    agenticReplay: {enabled: false}\n    memoryReview: {mode: off}\n    memoryEvolution: {mode: off}\n    memoryIndexReasoning: {mode: off}\n    autoGlobalization: {enabled: false}\n- insert:\n    - id: pair-settings-fixture\n      name: ${JSON.stringify(fixture)}\n      inject: [workspaceRegistry]\n`);
  const boot=async()=>{logs='';host=spawn(dsh,['--profile','web','--no-open','--port','0'],{cwd:project,env,stdio:['ignore','pipe','pipe']});for(const stream of [host.stdout,host.stderr])stream.on('data',chunk=>{logs+=chunk;});return poll(()=>logs.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0]);};
  let url=await boot();
  browser=await chromium.launch({headless:true,env:{...env,XDG_CONFIG_HOME:join(base,'browser-config')},...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  page=await browser.newPage({viewport:{width:1280,height:1100}});
  page.on('pageerror',error=>console.error('Browser:',error.message));
  await page.goto(url);
  const credentials=page.getByRole('dialog',{name:'Add an API key to get started',exact:true});
  await page.addLocatorHandler(credentials,()=>credentials.getByRole('button',{name:'Configure later',exact:true}).click());
  const welcome=page.getByRole('button',{name:'Continue',exact:true});
  await welcome.or(credentials).first().waitFor();
  for(let i=0;i<5&&await welcome.isVisible();i++){await welcome.click();await new Promise(r=>setTimeout(r,400));}
  const api=async(body,sessionId)=>page.evaluate(async({body,sessionId})=>{
    const response=await fetch('/api/kiokuko.models'+(sessionId?'?sessionId='+encodeURIComponent(sessionId):''),body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
    return {status:response.status,data:await response.json()};
  },{body,sessionId});
  const savedFile=join(env.DSH_HOME,'profiles/web/kiokuko-models.json');
  const snapshot=async()=>JSON.parse(await readFile(savedFile,'utf8'));
  const open=async()=>{await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Kiokuko Models',exact:true}).click();await page.getByRole('region',{name:'Kiokuko Models',exact:true}).waitFor();};
  await open();
  const panel=page.getByRole('region',{name:'Kiokuko Models',exact:true});
  const use=panel.getByRole('button',{name:'Use pair in current chat',exact:true}), saveDefault=panel.getByRole('button',{name:'Pair default for new chats',exact:true});
  assert.equal(await use.isEnabled(),false);assert.equal(await saveDefault.isEnabled(),false);
  await panel.getByText(/GPT-6.1-Sol の利用可能/).waitFor();
  const manual=id=>({id,name:id,contextWindow:262144,maxTokens:32768,reasoning:false,image:false});
  const connections=[{id:'kiokuko-fixture-head',kind:'custom',name:'Fixture Sol',baseURL,protocol:'chat-completions',models:[manual('gpt-6.1-sol')]},
    {id:'kiokuko-fixture-head-two',kind:'custom',name:'Second fixture Sol',baseURL,protocol:'chat-completions',models:[manual('gpt-6.1-sol')]},
    {id:'kiokuko-fixture-worker',kind:'deepseek',name:'Fixture Flash',baseURL,protocol:'chat-completions',models:[manual('deepseek-flash')]}];
  for(const connection of connections){const state=(await api()).data;assert.equal((await api({op:'save',connection,revision:state.revision})).status,200);assert.equal((await api({op:'key',id:connection.id,key:'isolated-fixture-key'})).status,200);}
  await panel.getByRole('button',{name:'Reload',exact:true}).click();
  const head=panel.getByLabel('Head connection · GPT-6.1-Sol',{exact:true}), worker=panel.getByLabel('Worker connection · DeepSeek V4.1 Flash',{exact:true});
  await poll(async()=>await head.locator('option').count()===3);
  assert.equal(await head.inputValue(),'','multiple providers must require an explicit choice');
  assert.equal(await saveDefault.isEnabled(),false);
  // Native catalogs may expose additional eligible worker connections. Select
  // both exact fixture providers rather than relying on a singleton default.
  const chooseHead=async(index=0)=>{
    await head.selectOption(JSON.stringify({provider:index===0?'kiokuko-fixture-head':'kiokuko-fixture-head-two',model:'gpt-6.1-sol'}));
    await worker.selectOption(JSON.stringify({provider:'kiokuko-fixture-worker',model:'deepseek-flash'}));
    assert.equal(await worker.inputValue(),JSON.stringify({provider:'kiokuko-fixture-worker',model:'deepseek-flash'}));
  };
  const before=(await api()).data.revision;
  await chooseHead();await panel.getByRole('button',{name:'Cancel pair changes',exact:true}).click();
  assert.equal(await head.inputValue(),'');assert.equal((await api()).data.revision,before,'cancel must not save');
  await chooseHead();await page.keyboard.press('Escape');await open();
  assert.equal(await head.inputValue(),'','closing the panel must discard an uncommitted draft');
  await chooseHead();await saveDefault.click();
  await panel.getByRole('status').filter({hasText:'Head/worker pair saved for new chats'}).waitFor();
  assert.equal((await snapshot()).defaultHeadWorker.head.provider,'kiokuko-fixture-head');
  // Current scope is independent of the profile default and freezes once seen.
  await page.keyboard.press('Escape');
  const conversation=page.locator('[data-conversation-content]:visible').first();
  let sessionId=await poll(()=>conversation.getAttribute('data-conversation-session'));
  await open();await chooseHead(1);await use.click();
  await panel.getByRole('status').filter({hasText:'Head/worker pair selected for this chat'}).waitFor();
  assert.equal((await snapshot()).sessionHeadWorkers[sessionId].head.provider,'kiokuko-fixture-head-two');
  assert.equal((await snapshot()).defaultHeadWorker.head.provider,'kiokuko-fixture-head');
  const previousSession=sessionId;
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'New session',exact:true}).first().click();
  sessionId=await poll(async()=>{const id=await conversation.getAttribute('data-conversation-session');return id&&id!==previousSession&&await conversation.getAttribute('data-content-phase')!=='settling'?id:undefined;});
  await open();
  await poll(async()=>JSON.parse(await head.inputValue()||'null')?.provider==='kiokuko-fixture-head');
  await chooseHead(1);await use.click();
  await panel.getByRole('status').filter({hasText:'Head/worker pair selected for this chat'}).waitFor();
  assert.equal((await snapshot()).sessionHeadWorkers[previousSession].head.provider,'kiokuko-fixture-head-two','new scope must preserve prior chat');
  assert.equal((await snapshot()).sessionHeadWorkers[sessionId].head.provider,'kiokuko-fixture-head-two');
  // A stale revision is rejected without silently moving a current selection.
  const stale=(await api()).data.revision;
  await panel.getByRole('button',{name:'Clear pair default',exact:true}).click();
  await panel.getByRole('status').filter({hasText:'Ordinary model default restored for new chats'}).waitFor();
  const bad=await api({op:'head-worker',configuration:null,scope:'current',sessionId,revision:stale});
  assert.equal(bad.status,400);assert.match(bad.data.error,/changed/);
  assert.equal((await snapshot()).sessionHeadWorkers[sessionId].head.provider,'kiokuko-fixture-head-two');
  await panel.getByRole('button',{name:'Disable pair in current chat',exact:true}).click();
  await panel.getByRole('status').filter({hasText:'Ordinary model selection restored for this chat'}).waitFor();
  assert.equal((await snapshot()).sessionHeadWorkers[sessionId],null);
  await chooseHead();await use.click();
  await panel.getByRole('status').filter({hasText:'Head/worker pair selected for this chat'}).waitFor();
  // Restart both page and actual host and inspect the same durable scope.
  await page.screenshot({path:join(base,'pair-settings.png')});
  await stop();url=await boot();await page.goto(url);
  // Native hydration restores the conversation and can remount the Settings
  // launcher. Open Settings only after that initial navigation has settled.
  await page.locator('[data-conversation-content]:visible').first().waitFor();
  await poll(async()=>await page.locator('[data-conversation-content]:visible').first().getAttribute('data-content-phase')!=='settling');
  await page.waitForLoadState('networkidle');
  await open();
  assert.equal((await api(undefined,sessionId)).data.headWorker.current.head.provider,'kiokuko-fixture-head');
  // Missing worker blocks new activation, while the saved pair remains visible.
  assert.equal((await api({op:'logout',id:'kiokuko-fixture-worker'})).status,200);
  await panel.getByRole('button',{name:'Reload',exact:true}).click();
  await panel.getByText(/DeepSeek V4.1 Flash の利用可能/).waitFor();
  assert.equal(await saveDefault.isEnabled(),false);assert.equal(await use.isEnabled(),false);
  assert.equal((await snapshot()).sessionHeadWorkers[sessionId].worker.provider,'kiokuko-fixture-worker');
  assert.equal(generations,0,'settings validation must not generate model requests');
  console.log(JSON.stringify({ok:true,checks:['missing-model disabled reasons','exact multiple-provider choice','cancel/close draft','current/default isolation','new-session navigation','stale revision rejection','disable/re-enable','native host restart persistence','no generation'],evidence:base}));
} catch(error) { console.error(logs.replace(/token=[^\s&]+/g,'token=[redacted]')); if(page)await page.screenshot({path:join(base,'failure.png')}).catch(()=>{}); console.error('Evidence:',base);throw error; }
finally {if(browser)await browser.close();await stop();await new Promise(r=>endpoint.close(r));if(process.env.KIOKUKO_KEEP_PAIR_WEB!=='1')await rm(base,{recursive:true,force:true});}
