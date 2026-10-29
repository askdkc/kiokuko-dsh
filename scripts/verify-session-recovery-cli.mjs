/** Packaged CLI acceptance against the disposable Web fixture's loopback endpoint. */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
const [dshArg,cliArg,pluginArg,metadataArg,runtimeArg='/tmp/kiokuko-current-runtime/package.json']=process.argv.slice(2)
assert.ok(dshArg&&cliArg&&pluginArg&&metadataArg)
const metadata=JSON.parse(readFileSync(metadataArg,'utf8'))
assert.ok(metadata.root.startsWith(realpathSync('/tmp')+'/krverify-'))
const root=realpathSync(mkdtempSync('/tmp/krverify-cli-'))
const dsh=resolve(dshArg)
const env={PATH:process.env.PATH,SHELL:process.env.SHELL??'/bin/sh',HOME:join(root,'home'),USERPROFILE:join(root,'home'),DSH_HOME:join(root,'dsh'),KIOKUKO_DATA_DIR:join(root,'data'),DSH_TELEMETRY_MODE:'DISABLED',DSH_CLI_LANG:'en',TERM:'xterm-256color',LANG:'en_US.UTF-8',NODE_ENV:'production',npm_config_cache:join(root,'cache'),KIOKUKO_RECOVERY_EVENTS:join(root,'events.jsonl'),KIOKUKO_RECOVERY_READY:join(root,'ready.json')}
for(const dir of [env.HOME,env.DSH_HOME,env.KIOKUKO_DATA_DIR,join(root,'project')])mkdirSync(dir,{recursive:true})
console.log(JSON.stringify({root,stage:'install'}))
for(const spec of [`@askdkc/dsh-cli@file:${resolve(cliArg)}`,`kiokuko-dsh@file:${resolve(pluginArg)}`])execFileSync(process.execPath,[dsh,'plugin','--profile','dsh-cli','add',spec,'--ignore-scripts'],{env,cwd:join(root,'project'),stdio:'pipe',timeout:180000})
writeFileSync(join(root,'dsh/profiles/dsh-cli/kiokuko-models.json'),JSON.stringify(metadata.config))
mkdirSync(join(root,'dsh/dsh-auth'),{recursive:true});writeFileSync(join(root,'dsh/dsh-auth/credentials.json'),JSON.stringify({version:1,providers:{'kiokuko-opencode-go-a5676c4f':{type:'api_key',key:'synthetic-recovery-only'}}}),{mode:0o600})
execFileSync(process.execPath,[fileURLToPath(new URL('./session-recovery-seed.mjs',import.meta.url)),root],{env:{...env,KIOKUKO_DSH_PACKAGE_ROOT:join(resolve(runtimeArg),'../node_modules')},stdio:'pipe',timeout:20000})
const patch=join(root,'probe.patch.yml')
writeFileSync(patch,JSON.stringify([
{id:'kiokuko-dsh',config:{enabled:true,typedDecisions:{mode:'off'},memoryReview:{mode:'off'},memoryEvolution:{mode:'off'},agenticReplay:{enabled:false},lisp:{enabled:false}}},
{id:'agent-default-model',config:{provider:'kiokuko-opencode-go-a5676c4f',model:'fixture'}},
{insert:[{id:'session-recovery-fixture',name:fileURLToPath(new URL('./session-recovery-web-fixture.mjs',import.meta.url))}]},
{id:'dsh-cli',config:{provider:'kiokuko-opencode-go-a5676c4f',model:'fixture',cwd:join(root,'project'),fullscreen:true,terminalImages:false,smoothStreaming:false,whale:false,activity:false}}
]))
const req=createRequire(resolve(runtimeArg)),pty=req('node-pty'),{Terminal}=req('@xterm/headless')
const terminal=new Terminal({cols:150,rows:45,scrollback:5000,allowProposedApi:true})
const child=pty.spawn(process.execPath,[dsh,'--profile','dsh-cli','--patch',patch,'--resume','33333333-3333-4333-a333-333333333333'],{cwd:join(root,'project'),env,name:'xterm-256color',cols:150,rows:45})
let output='',exit,frame=0
terminal.onData(data=>{if(!exit)child.write(data)})
child.onData(data=>{output+=data;terminal.write(data,()=>{frame++})})
child.onExit(value=>{exit=value})
const screen=()=>Array.from({length:45},(_,index)=>terminal.buffer.active.getLine(terminal.buffer.active.baseY+index)?.translateToString(true)??'').join('\n')
const events=()=>{try{return readFileSync(env.KIOKUKO_RECOVERY_EVENTS,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)}catch{return[]}}
const composer=()=>{const rows=screen().split('\n'),index=rows.findLastIndex(row=>row.includes('⌸ ❯ '));if(index<0)return undefined;const end=rows.findIndex((row,i)=>i>index&&row.includes('╰'));if(end<0)return undefined;return rows.slice(index,end).map((row,i)=>(i===0?row.slice(row.indexOf('❯ ')+2):row).replace(/\s*⛶\s*$/,'').trim()).join('')}
async function until(predicate,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(predicate())return;assert.equal(exit,undefined,'CLI exited before '+label);await new Promise(done=>setTimeout(done,40))}throw new Error(label+'\n'+screen())}
async function line(text){await until(()=>composer()==='','empty composer');const previous=frame;child.write(text);await until(()=>frame>previous&&composer()===text,'echo '+text);await new Promise(done=>setTimeout(done,220));child.write('\r')}
async function command(text){const offset=events().length;await line(text);await until(()=>events().slice(offset).some(value=>value.event.type==='command/done'),'command '+text);const done=events().slice(offset).find(value=>value.event.type==='command/done');assert.equal(done.event.data.kind,'success',done.event.data.text);return done.event.data.text}
try{
 await until(()=>composer()===''&&screen().includes('Interrupted'),'resumed interrupted conversation')
 const initial=events().filter(value=>value.event.type==='assistant/message').length
 const status=JSON.parse(await command('/kioku-recover status'))
 assert.equal(status.interrupted,true);assert.equal(status.model.provider,'kiokuko-opencode-go-a5676c4f');assert.equal(status.modelAvailable,true);assert.equal(status.unknownCalls.length,1)
 await until(()=>screen().includes('"interrupted":true'),'visible status')
 await command('/kioku-recover continue')
 await until(()=>events().filter(value=>value.event.type==='assistant/message').length>initial&&screen().includes('RECOVERY_CONTINUE_OK'),'continued response')
 const continued=events().filter(value=>value.event.type==='assistant/message').at(-1)
 assert.equal(continued.event.data.message.source.provider,'kiokuko-opencode-go-a5676c4f')
 const count=events().filter(value=>value.event.type==='assistant/message').length
 const result=await command('/kioku-recover new')
 const target=/^\/resume ([0-9a-f-]{36})/.exec(result)?.[1];assert.ok(target,result)
 await until(()=>screen().includes('/resume '+target),'visible new session ID')
 assert.equal(events().filter(value=>value.event.type==='assistant/message').length,count,'new must not request a model response')
 await line('/resume '+target)
 await until(()=>composer()===''&&!screen().includes('Inspect the local recovery fixture; preserve existing files.'),'empty new conversation')
 const offset=events().length
 await line('Inspect the local recovery fixture; preserve existing files.')
 await until(()=>events().slice(offset).some(value=>value.sessionId===target&&value.event.type==='assistant/message')&&screen().includes('RECOVERY_CONTINUE_OK'),'new conversation response')
 assert.ok(events().filter(value=>value.event.type==='tool/call').every(value=>value.sessionId!==target),'the new conversation never replays the old tool call')
 await line('/exit');await until(()=>exit,'normal exit',15000);assert.equal(exit.exitCode,0)
 const report={status:'passed',root,checks:['saved provider restored on native CLI startup','interrupted session resumed','status visible','continuation response on the saved provider','fresh session ID visible','fresh session waits for explicit send','new conversation response','normal exit']}
 writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}finally{writeFileSync(join(root,'terminal.log'),output);writeFileSync(join(root,'screen.txt'),screen());if(!exit)child.kill('SIGTERM');terminal.dispose()}
