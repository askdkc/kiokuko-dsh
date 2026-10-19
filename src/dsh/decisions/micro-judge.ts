import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, lstat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export const MICRO_JUDGE_VERSION = 'kiokuko-fd-v1'
export type Expression = number | boolean | { variable: number } | { op: 'eq'|'ne'|'lt'|'and'|'or'|'implies'|'diag'; args: Expression[] }
export interface FiniteDomainProblem { domains: { kind: 'bool'|'int'; values: number[] }[]; constraints: Expression[]; query: Expression; workBudget?: number }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const hex = z.string().regex(/^[a-f0-9]{64}$/u)
const reply = z.object({ version: z.literal(MICRO_JUDGE_VERSION), inputId: hex, inputDigest: hex,
  complete: z.boolean(), status: z.enum(['entailed','refuted','undetermined','inconsistent','resource_limit']),
  solutions: z.number().int().min(0).max(100000), truth: z.number().int().min(0).max(100000),
  nodes: z.number().int().nonnegative(), work: z.number().int().nonnegative(), elapsedMicros: z.number().int().nonnegative(), peakRssBytes: z.null() }).strict()
export type MicroJudgeResult = { state: 'available'; binaryHash: string; outputDigest: string; elapsedMs: number; result: z.infer<typeof reply> }
  | { state: 'unavailable'; reason: 'unsupported_platform'|'artifact_unavailable'|'artifact_mismatch'|'invalid_input'|'cancelled'|'timeout'|'process_failed'|'output_limit'|'malformed_response'; inputDigest?: string; binaryHash?: string; elapsedMs: number }
/** Typed, bounded wire compiler. A Boolean unknown is the domain [0,1], never false. */
export function encodeFiniteDomain(problem: FiniteDomainProblem): string {
  if (problem.domains.length>128 || problem.constraints.length>256) throw new Error('bound')
  const budget=problem.workBudget ?? 200000
  if (!Number.isSafeInteger(budget) || budget<1 || budget>2000000) throw new Error('budget')
  let nodes=0
  function expr(e: Expression, depth=0): { wire: string; kind: 'bool'|'int'; vars: Set<number> } {
    if (++nodes>2048 || depth>32) throw new Error('expression bound')
    if (typeof e==='boolean') return {wire:String(e),kind:'bool',vars:new Set()}
    if (typeof e==='number') { if (!Number.isSafeInteger(e) || Math.abs(e)>1000000000) throw new Error('integer');return {wire:String(e),kind:'int',vars:new Set()} }
    if ('variable' in e) { const d=problem.domains[e.variable];if(!Number.isSafeInteger(e.variable) || !d)throw new Error('variable');return {wire:`@${e.variable}`,kind:d.kind,vars:new Set([e.variable])} }
    if (!['eq','ne','lt','and','or','implies','diag'].includes(e.op) || e.args.length!==(e.op==='diag'?3:2))throw new Error('operator')
    const xs=e.args.map(x=>expr(x,depth+1));
    if ((e.op==='eq'||e.op==='ne') ? xs[0]!.kind!==xs[1]!.kind : xs.some(x=>x.kind!==(e.op==='lt'||e.op==='diag'?'int':'bool')))throw new Error('type')
    return {wire:`${e.op} ${xs.map(x=>x.wire).join(' ')}`,kind:'bool',vars:new Set(xs.flatMap(x=>[...x.vars]))}
  }
  const domains=problem.domains.map(d=>{
    if (!['bool','int'].includes(d.kind) || !d.values.length || d.values.length>32 || d.values.some(v=>!Number.isSafeInteger(v)||Math.abs(v)>1000000000||d.kind==='bool'&&v!==0&&v!==1))throw new Error('domain')
    return `${d.kind==='bool'?'b':'i'} ${d.values.length} ${d.values.join(' ')}`
  })
  const constraints=problem.constraints.map(c=>{const x=expr(c);if(x.kind!=='bool'||x.vars.size>3)throw new Error('constraint');return x.wire})
  const query=expr(problem.query);if(query.kind!=='bool')throw new Error('query')
  const payload=[budget,domains.length,constraints.length,...domains,...constraints,query.wire].join(' ')
  if (Buffer.byteLength(payload)>120000)throw new Error('bytes')
  return payload
}
const manifestSchema=z.object({version:z.literal(MICRO_JUDGE_VERSION),artifacts:z.array(z.object({platform:z.enum(['darwin','linux','win32']),arch:z.enum(['arm64','x64']),sha256:hex,bytes:z.number().int().positive(),file:z.string(),nativeVerified:z.boolean(),sourceDigest:hex.optional(),compiler:z.string().max(256).optional()}).strict()).max(6)}).strict()
/** No PATH fallback, compiler, download, environment override, or provider authority. */
export async function runMicroJudge(problem: FiniteDomainProblem, inputId: string, signal: AbortSignal,
  options: { artifactRoot?: string; timeoutMs?: number } = {}): Promise<MicroJudgeResult> {
  const started=performance.now();let inputDigest: string|undefined,binaryHash: string|undefined
  const unavailable=(reason: Extract<MicroJudgeResult,{state:'unavailable'}>['reason']): MicroJudgeResult=>({state:'unavailable',reason,elapsedMs:Math.ceil(performance.now()-started),...(inputDigest?{inputDigest}:{}),...(binaryHash?{binaryHash}:{})})
  let payload: string
  try {hex.parse(inputId);payload=encodeFiniteDomain(problem);inputDigest=hash(payload)}catch{return unavailable('invalid_input')}
  if(signal.aborted)return unavailable('cancelled')
  const root=options.artifactRoot ?? fileURLToPath(new URL('../../../micro-judge/',import.meta.url))
  let executable: string
  try {
    const rootStat=await lstat(root);if(!rootStat.isDirectory() || rootStat.isSymbolicLink())return unavailable('artifact_mismatch')
    const manifestFile=join(root,'manifest.json'),ms=await lstat(manifestFile)
    if(!ms.isFile()||ms.isSymbolicLink()||ms.size>16384)return unavailable('artifact_mismatch')
    const manifest=manifestSchema.parse(JSON.parse(await readFile(manifestFile,'utf8')))
    const entries=manifest.artifacts.filter(a=>a.platform===process.platform&&a.arch===process.arch)
    if(entries.length!==1)return unavailable('unsupported_platform')
    const entry=entries[0]!,expected=`${process.platform}-${process.arch}/kiokuko-micro-judge${process.platform==='win32'?'.exe':''}`
    if(entry.file!==expected || entry.bytes>8000000)return unavailable('artifact_mismatch')
    executable=join(root,entry.file)
    const parent=await lstat(dirname(executable));if(!parent.isDirectory()||parent.isSymbolicLink())return unavailable('artifact_mismatch')
    const handle=await open(executable,constants.O_RDONLY|constants.O_NOFOLLOW)
    try {const stat=await handle.stat();if(!stat.isFile()||stat.size!==entry.bytes || process.platform!=='win32'&&(stat.mode&0o111)===0)return unavailable('artifact_mismatch');binaryHash=hash(await handle.readFile())}finally{await handle.close()}
    if(binaryHash!==entry.sha256)return unavailable('artifact_mismatch')
  }catch{return unavailable('artifact_unavailable')}
  const deadline=options.timeoutMs ?? 1500
  if(!Number.isSafeInteger(deadline)||deadline<1||deadline>5000)return unavailable('invalid_input')
  const execution=await new Promise<{output?:string;reason?:Extract<MicroJudgeResult,{state:'unavailable'}>['reason']}>(resolve=>{
    let output=Buffer.alloc(0),reason: Extract<MicroJudgeResult,{state:'unavailable'}>['reason']|undefined,done=false
    const child=spawn(executable,[],{stdio:['pipe','pipe','ignore'],env:{},windowsHide:true})
    const stop=(why:typeof reason)=>{reason??=why;child.kill('SIGKILL')}
    const abort=()=>stop('cancelled'),timer=setTimeout(()=>stop('timeout'),deadline)
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    const finish=(value:{output?:string;reason?:Extract<MicroJudgeResult,{state:'unavailable'}>['reason']})=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);resolve(value)}
    child.on('error',()=>finish({reason:reason??'process_failed'}));child.stdin.on('error',()=>stop('process_failed'))
    child.stdout.on('data',(chunk:Buffer)=>{if(output.length+chunk.length>16384){stop('output_limit');return}output=Buffer.concat([output,chunk])})
    child.on('close',code=>finish(reason?{reason}:code!==0?{reason:'process_failed'}:{output:output.toString('utf8')}))
    child.stdin.end(`${MICRO_JUDGE_VERSION}\t${inputId}\t${inputDigest}\t${payload}\n`)
  })
  if(signal.aborted)return unavailable('cancelled')
  if(execution.reason)return unavailable(execution.reason)
  try {
    // Detect replacement during the call too. Digest identities are integrity evidence, not signatures.
    if(hash(await readFile(executable))!==binaryHash)return unavailable('artifact_mismatch')
    const result=reply.parse(JSON.parse(execution.output!))
    if(result.inputId!==inputId || result.inputDigest!==inputDigest || result.truth>result.solutions
      || result.complete!==(result.status!=='resource_limit') || result.work>(problem.workBudget??200000)+1
      || result.status==='entailed'&&(!result.solutions||result.truth!==result.solutions)
      || result.status==='refuted'&&(!result.solutions||result.truth!==0)
      || result.status==='inconsistent'&&(result.solutions!==0||result.truth!==0)
      || result.status==='undetermined'&&(!result.truth||result.truth>=result.solutions))return unavailable('malformed_response')
    return {state:'available',binaryHash:binaryHash!,outputDigest:hash(execution.output!),elapsedMs:Math.ceil(performance.now()-started),result}
  }catch{return unavailable('malformed_response')}
}
