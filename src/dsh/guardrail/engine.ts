import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveGuardrail } from '../../../scripts/guardrail-artifacts.mjs'
import { canonicalContentHash } from '../../serialization/validate.js'
import { observeProcessResult, type HostProcessResult } from '../execution-result.js'
import { registerStructuredObservation, markUncertainProtocolResult, sha } from './evidence.js'
import { PROTOCOL_ISSUER, type ProtocolObservation, type ProtocolReceipt, type ProtocolState } from './contracts.js'
const exec = promisify(execFile)
const environmentTemplate = {PATH:'<host-node-directory>:/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',HOME:'<fresh-private>/home',TMPDIR:'<fresh-private>/tmp',XDG_CONFIG_HOME:'<fresh-private>/config',XDG_CACHE_HOME:'<fresh-private>/cache'}
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
export function protocolRuntime() {
  const engine = resolveGuardrail(packageRoot)
  const runner = path.join(packageRoot, 'guardrail/node-runner.mjs')
  const supervisor=path.join(packageRoot,'lisp/supervisor.mjs')
  const runtimeDigest = canonicalContentHash({supervisor:sha(readFileSync(supervisor)),node:sha(readFileSync(process.execPath)),version:process.version,platform:process.platform,arch:process.arch,engine:engine.engineDigest,protocol:engine.protocolFileDigest,runner:sha(readFileSync(runner)),environment:environmentTemplate})
  return {...engine,runner,supervisor,runtimeDigest}
}
function flat(output: string, tag: string): Record<string, string | number | boolean> {
  if (output.length > 8192 || !output.trim().startsWith(`(${tag} `)) throw Error('Malformed bounded engine response')
  const tokens = output.trim().match(/\(|\)|"(?:\\.|[^"\\])*"|[^\s()]+/gu) ?? []
  if (tokens[0] !== '(' || tokens[1] !== tag || tokens.at(-1) !== ')' || tokens.length % 2 !== 1) throw Error('Malformed bounded engine fields')
  const value: Record<string,string|number|boolean> = {}
  for (let i=2;i<tokens.length-1;i+=2) {
    const key=tokens[i]!, text=tokens[i+1]!
    if (!/^:[a-z0-9-]+$/u.test(key) || key in value) throw Error('Unknown/duplicate engine field')
    value[key] = text.startsWith('"') ? JSON.parse(text) : text === 't' ? true : text === 'nil' ? false : /^\d+$/u.test(text) ? Number(text) : (()=>{throw Error('Invalid bounded engine value')})()
  }
  return value
}
/** Serialize only the host-validated receipt. Structural validity alone is not authority. */
export function serializeProtocolEvidence(state: ProtocolState, receipt: ProtocolReceipt, phase: 'verify-red' | 'verify-green' | 'report'): string {
  if(state.schema!==2||receipt.schema!==2)throw Error('rebind-required: unsupported protocol evidence schema')
  const quote=(value:string)=>JSON.stringify(value), empty=canonicalContentHash({model:null}), snapshot=receipt.snapshot
  const fields=`:source ${quote(receipt.sourceDigest)} :tests ${quote(receipt.testDigest)} :command ${quote(receipt.commandDigest)} :runtime ${quote(receipt.runtimeDigest)}`
  const generations=`:worker-generation ${quote(receipt.workerGeneration)} :protocol-generation ${state.generation} :lease-generation ${state.lease.generation}`
  const artifact=(name:string,id:string,digest:string,outcome:string,exit:number,assertions:number,status:string,provenance:string,supporting:string[])=>`(${name} :id ${quote(id)} :digest ${quote(digest)} ${generations} ${fields} :outcome :${outcome} :exit ${exit} :assertions ${assertions} :status :${status} :provenance :${provenance} :supporting (${supporting.map(quote).join(' ')}) :history () :state-digest ${quote(receipt.sourceDigest)})`
  const support=snapshot.executions.find(operation=>operation.receipt===receipt.ownedReceiptDigest)
  if(!support)throw Error('Protocol receipt has no journal supporting operation')
  const artifacts=[artifact('test-spec',receipt.id,receipt.digest,receipt.outcome,receipt.exit,receipt.assertions,'observed','execution-backed',[support.id])]
  if(phase!=='verify-red')artifacts.push(artifact('patch',`patch:${state.recipeId}:${state.generation}`,canonicalContentHash({edits:state.edits,source:state.source}),'produced',0,0,'applied','state-derived',[]))
  const executions=snapshot.executions.map(operation=>`(execution :id ${quote(operation.id)} :scope ${quote(operation.scope)} :parent ${quote(operation.parent)} :sequence ${operation.sequence} :route :${operation.route} :kind :${operation.kind} :state :${operation.state} :outcome :${operation.outcome} :request ${quote(operation.request)} :runtime ${quote(operation.runtime)} :receipt ${quote(operation.receipt)} :worker-generation ${quote(operation.workerGeneration)} :protocol-generation ${operation.protocolGeneration} :lease-generation ${operation.leaseGeneration})`)
  return `(evidence :schema 2 :authority "kiokuko-dsh" :issuer ${quote(PROTOCOL_ISSUER)} :task ${quote(state.lease.taskId)} :revision ${state.lease.revision} ${generations} :scope ${quote(snapshot.scope)} :collector (:version ${snapshot.version} :complete ${snapshot.complete?'t':'nil'} :count ${snapshot.count} :unresolved ${snapshot.unresolved} :digest ${quote(snapshot.digest)}) :executions (${executions.join(' ')}) ${fields} :model-provider "none" :model-name "none" :model-parameters ${quote(empty)} :transcript ${quote(empty)} :artifacts (${artifacts.join(' ')}))\n`
}
export async function checkProtocol(state: ProtocolState, receipt: ProtocolReceipt, phase: 'verify-red' | 'verify-green' | 'report', signal?: AbortSignal): Promise<boolean> {
  const runtime=protocolRuntime()
  if(runtime.runtimeDigest!==receipt.runtimeDigest||runtime.runtimeDigest!==state.runtimeDigest)throw Error('Protocol runtime changed; rebind the unit')
  const captured=serializeProtocolEvidence(state,receipt,phase)
  const directory=await mkdtemp(path.join(tmpdir(),'kiokuko-guardrail-'))
  try {
    const evidence=path.join(directory,'evidence.lisp');await writeFile(evidence,captured,{mode:0o600})
    const options={cwd:directory,env:{LANG:'C.UTF-8'},timeout:10_000,maxBuffer:16_384,...(signal?{signal}:{})}
    const validation=flat((await exec(runtime.binary,['validate',runtime.protocol],options)).stdout,'protocol')
    let output:string,exit=0
    try{output=(await exec(runtime.binary,['check',runtime.protocol,phase,evidence],options)).stdout}
    catch(error){const failure=error as {code?:unknown;stdout?:unknown};if(failure.code!==3||typeof failure.stdout!=='string')throw Error(`Protocol engine unavailable or rejected bounded input: ${String(error)}`);exit=3;output=failure.stdout}
    const result=flat(output,'decision')
    const expected=[':allow',':phase',':next',':task',':authority-revision',':issuer',':protocol-sha256',':evidence-sha256',':engine-version',':engine-sha256'].sort()
    if(JSON.stringify(Object.keys(result).sort())!==JSON.stringify(expected)||result[':allow']!==(exit===0)||result[':phase']!==phase||result[':task']!==state.lease.taskId||result[':authority-revision']!==state.lease.revision||result[':issuer']!==PROTOCOL_ISSUER||result[':protocol-sha256']!==validation[':protocol-sha256']||result[':evidence-sha256']!==sha(captured)||result[':engine-sha256']!==runtime.engineDigest||result[':engine-version']!==runtime.version)throw Error('Protocol decision does not bind the captured authority and inputs')
    const expectedNext=phase==='verify-red'?(exit===0?'implement':'write-tests'):phase==='verify-green'?(exit===0?'report':'implement'):':done'
    if(result[':next']!==expectedNext)throw Error('Unexpected protocol transition')
    return exit===0
  } finally { await rm(directory,{recursive:true,force:true}) }
}
/** The enrolled path uses this exact host runner, never caller stdout as proof. */
export function runProtocolTests(state: ProtocolState, operationId: string, signal: AbortSignal, timeoutMs:number,onStarted:(()=>void)|undefined, authorizeLaunch:(launch:()=>ReturnType<typeof spawn>)=>ReturnType<typeof spawn>): Promise<HostProcessResult> {
  const runtime=protocolRuntime(), supervisor=runtime.supervisor
  if(runtime.runtimeDigest!==state.runtimeDigest)throw Error('Protocol runtime changed; rebind the unit')
  signal.throwIfAborted()
  return new Promise(resolve=>{
    const directory=mkdtempSync(path.join(tmpdir(),'kiokuko-protocol-env-'))
    const env={PATH:path.dirname(process.execPath)+':/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'UTC',HOME:path.join(directory,'home'),TMPDIR:path.join(directory,'tmp'),XDG_CONFIG_HOME:path.join(directory,'config'),XDG_CACHE_HOME:path.join(directory,'cache')}
    for(const key of ['HOME','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME'] as const)mkdirSync(env[key],{mode:0o700})
    const environmentDigest=canonicalContentHash(env)
    const input={files:state.recipe.testPaths.map(file=>path.join(state.lease.repositoryRoot,file)),operationId,runtimeDigest:runtime.runtimeDigest,environmentDigest,timeoutMs}
    const launch={command:process.execPath,args:[runtime.runner,JSON.stringify(input)],cwd:state.cwd,group:process.platform!=='win32',protocol:true,report:true}
    let spawned:ReturnType<typeof spawn>|undefined,launchError=''
    try { authorizeLaunch(()=>{spawned=spawn(process.execPath,[supervisor,JSON.stringify(launch)],{cwd:state.cwd,env,stdio:['pipe','pipe','pipe','pipe','pipe']});return spawned}) }
    catch(error){
      if(!spawned){rmSync(directory,{recursive:true,force:true});throw error}
      launchError=`Protocol launch transaction outcome is uncertain: ${String(error)}`
    }
    const child=spawned!
    let terminal='',channel='',output='',timedOut=false,capped=false,error=launchError,started=!!launchError
    if(launchError)onStarted?.()
    const stop=()=>{try{child.kill('SIGTERM')}catch{}}
    const timer=setTimeout(()=>{timedOut=true;stop()},timeoutMs)
    const abort=()=>stop();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)stop()
    child.stdio[4]?.on('data',(chunk:Buffer)=>{terminal+=chunk.toString();if(terminal.length>1024){capped=true;stop()}if(!started&&terminal.includes('"processStarted":true')){started=true;onStarted?.()}})
    child.stdio[3]?.on('data',(chunk:Buffer)=>{channel+=chunk.toString();if(channel.length>65536){capped=true;stop()}})
    const collect=(chunk:Buffer)=>{output+=chunk.toString();if(Buffer.byteLength(output)>4*1024*1024){output=output.slice(0,4*1024*1024);capped=true;stop()}}
    child.stdout?.on('data',collect);child.stderr?.on('data',collect);child.on('error',cause=>{error=cause.message})
    if(launchError){child.stdin?.end();stop()}
    child.on('close',()=>{
      clearTimeout(timer);signal.removeEventListener('abort',abort);rmSync(directory,{recursive:true,force:true})
      let exitCode:number|null=null,processSignal:string|null=null,processStopped=false,observation:ProtocolObservation|undefined
      try{const final=JSON.parse(terminal);exitCode=final.exitCode;processSignal=final.signal;if(final.processStarted!==true||!(final.exitCode===null||Number.isInteger(final.exitCode))||!(final.signal===null||typeof final.signal==='string'))throw Error('Not launched');processStopped=true}catch{error||='Missing terminal observation'}
      try{const candidate=JSON.parse(channel);const keys=['tests','passed','failed','assertionFailures','otherFailures','skipped','todo','cancelled','explicit'];const all=['schema','operationId','runtimeDigest','environmentDigest','complete',...keys].sort();if(!candidate||JSON.stringify(Object.keys(candidate).sort())!==JSON.stringify(all)||candidate.schema!==1||candidate.operationId!==operationId||candidate.runtimeDigest!==runtime.runtimeDigest||candidate.environmentDigest!==environmentDigest||typeof candidate.complete!=='boolean'||keys.some(key=>!Number.isSafeInteger(candidate[key])||candidate[key]<0)||candidate.tests>100000||candidate.tests!==candidate.passed+candidate.failed+candidate.skipped+candidate.todo||candidate.assertionFailures+candidate.otherFailures!==candidate.failed||candidate.cancelled>candidate.otherFailures||candidate.explicit>candidate.tests)throw Error('Invalid observation');observation=candidate}catch{error||='Missing structured test observation'}
      const complete=!capped&&!error&&!timedOut&&!signal.aborted&&processSignal===null
      const summary=observation?{tests:observation.tests,pass:observation.passed,fail:observation.failed,cancelled:observation.cancelled,skipped:observation.skipped,todo:observation.todo}:undefined
      const result=observeProcessResult({isError:exitCode!==0||!complete,value:{exitCode,signal:processSignal,timedOut,aborted:signal.aborted,processStarted:started,processStopped,outputComplete:complete,...(summary?{summary}:{})},content:[{type:'text',text:output+(error?`\n${error}`:'')}]})
      if(launchError)markUncertainProtocolResult(result)
      if(observation&&complete)registerStructuredObservation(result,observation)
      resolve(result)
    })
  })
}
