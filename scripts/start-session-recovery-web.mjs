/** Isolated packaged Web acceptance. Never reads the user's settings or keys. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { createServer as httpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
const [dshArg, pluginArg, mode = 'normal'] = process.argv.slice(2)
assert.ok(dshArg && pluginArg)
assert.ok(['normal','failed-core'].includes(mode))
const root = realpathSync(mkdtempSync('/tmp/krverify-'))
const env = {PATH:process.env.PATH,SHELL:process.env.SHELL??'/bin/sh',HOME:join(root,'home'),USERPROFILE:join(root,'home'),DSH_HOME:join(root,'dsh'),KIOKUKO_DATA_DIR:join(root,'data'),DSH_TELEMETRY_MODE:'DISABLED',KIOKUKO_RECOVERY_READY:join(root,'ready.json'),KIOKUKO_RECOVERY_EVENTS:join(root,'events.jsonl'),npm_config_cache:join(root,'cache'),TERM:'xterm-256color',NODE_ENV:'production',DSH_CLI_LANG:'en'}
for(const dir of [env.HOME,env.DSH_HOME,env.KIOKUKO_DATA_DIR,join(root,'project')])mkdirSync(dir,{recursive:true})
let requests=0
const server=httpServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk
  if(req.method!=='POST'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'fixture'}]}));return}
  const body=JSON.parse(raw);requests++;writeFileSync(join(root,'requests.json'),JSON.stringify({requests,last:body}))
  const text='RECOVERY_CONTINUE_OK'
  res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'recovery-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'recovery-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const endpoint=`http://127.0.0.1:${server.address().port}/v1`
const dsh=resolve(dshArg)
execFileSync(process.execPath,[dsh,'plugin','--profile','web','add',`kiokuko-dsh@file:${resolve(pluginArg)}`,'--ignore-scripts'],{env,cwd:join(root,'project'),stdio:'pipe',timeout:180000})
const config={version:1,revision:1,connections:[{id:'kiokuko-opencode-go-a5676c4f',kind:'custom',name:'Persisted recovery fixture',baseURL:endpoint,protocol:'chat-completions',serviceTier:'standard',models:[{id:'fixture',name:'Recovery fixture',contextWindow:131072,maxTokens:1024,reasoning:false,image:false}]}]}
writeFileSync(join(root,'dsh/profiles/web/kiokuko-models.json'),JSON.stringify(config))
mkdirSync(join(root,'dsh/dsh-auth'),{recursive:true});writeFileSync(join(root,'dsh/dsh-auth/credentials.json'),JSON.stringify({version:1,providers:{'kiokuko-opencode-go-a5676c4f':{type:'api_key',key:'synthetic-recovery-only'}}}),{mode:0o600})
execFileSync(process.execPath,[fileURLToPath(new URL('./session-recovery-seed.mjs',import.meta.url)),root],{env:{...env,KIOKUKO_DSH_PACKAGE_ROOT:process.env.KIOKUKO_DSH_PACKAGE_ROOT??'/tmp/kiokuko-current-runtime/node_modules'},stdio:'pipe',timeout:20000})
const port=await new Promise(done=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>done(p))})})
const patch=join(root,'probe.patch.yml')
writeFileSync(patch,YAML.stringify([{id:'kiokuko-dsh',config:{enabled:true,typedDecisions:{mode:'off'},memoryReview:{mode:'off'},memoryEvolution:{mode:'off'},agenticReplay:{enabled:false},lisp:{enabled:false}}},{id:'session-title-llm',disabled:true},{id:'agent-default-model',config:{provider:'kiokuko-opencode-go-a5676c4f',model:'fixture'}},{insert:[{id:'session-recovery-fixture',name:fileURLToPath(new URL('./session-recovery-web-fixture.mjs',import.meta.url))}]}]))
if(mode==='failed-core'){env.KIOKUKO_DATA_DIR=join(root,'blocked-data');writeFileSync(env.KIOKUKO_DATA_DIR,'deliberately not a directory')}
const child=spawn(process.execPath,[dsh,'--profile','web','--patch',patch,'--port',String(port),'--no-open'],{env,cwd:join(root,'project'),stdio:['ignore','pipe','pipe']})
let logs='';for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>{logs+=chunk;writeFileSync(join(root,'host.log'),logs)})
writeFileSync('/tmp/kiokuko-recovery-web-current.json',JSON.stringify({root,pid:child.pid,parentPid:process.pid,port,url:`http://127.0.0.1:${port}/`,endpoint,env,config,dsh,plugin:resolve(pluginArg),mode}))
console.log(JSON.stringify({root,pid:child.pid,url:`http://127.0.0.1:${port}/`,mode}))
const stop=()=>child.kill('SIGTERM');process.on('SIGTERM',stop);process.on('SIGINT',stop)
child.on('exit',(code,signal)=>{server.close();console.log(JSON.stringify({code,signal,root}));process.exit(code??(signal?1:0))})
