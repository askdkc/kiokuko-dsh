import {z} from 'zod'
import path from 'node:path'
import {canonicalContentHash} from '../serialization/validate.js'
import {LedgerStore} from '../ledger/store.js'
import type {SqliteDatabase} from '../db/adapter.js'
import {assessTaskCompletion} from './task-completion.js'
import {currentCorrectionSources,type CorrectionReceipt} from './correction-context.js'
import {applicationSourceDigest} from '../memory/application.js'
import {compatibilityDecisionConflicts} from '../memory/correction-contract.js'

const relative=z.string().min(1).max(512).refine(value=>!path.isAbsolute(value)&&!value.split(/[\\/]/u).some(p=>p==='..'||p==='.git')&&!/[\p{C}]/u.test(value))
export const correctionDecisionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('compatibility'),target:relative,basis:z.enum(['version_only','capability','reproducibility']),requiredVersion:z.string().min(1).max(128),observedVersion:z.string().min(1).max(128)}).strict(),
  z.object({kind:z.literal('completion'),target:relative,complete:z.boolean(),basis:z.enum(['version_only','observed_checks','unverified'])}).strict(),
])
export type CorrectionDecision=z.infer<typeof correctionDecisionSchema>
/** Known decision shapes only. Natural-language agreement is never inferred. */
export function checkCorrectionDecision(db:SqliteDatabase,receipt:CorrectionReceipt|undefined,decision:CorrectionDecision){
  const retrieval=receipt?.retrieval??'not_requested',delivery=receipt?.delivery??'not_delivered'
  const base={retrieval,delivery,verification:'unverified' as string,targetDigest:receipt?applicationSourceDigest(receipt.repositoryRoot,[decision.target]):null}
  if(!receipt||retrieval!=='retrieved')return {...base,state:'unverified',reason:retrieval}
  if(!currentCorrectionSources(db,receipt))return {...base,state:'stale',reason:'correction_source_changed'}
  if(delivery!=='delivered'||!receipt.inputDigest)return {...base,state:'handoff_missing',reason:'correction_not_in_provider_input'}
  const compatibility=receipt.sources.some(source=>source.rule==='capability_compatibility')
  if(compatibilityDecisionConflicts(receipt.sources,decision))
    return {...base,state:'contradiction',reason:'version_only_compatibility_rejection'}
  if(decision.kind==='completion'){
    const assessment=assessTaskCompletion(db,receipt.runId)
    // Use actual current host observations. Model-provided test claims are not accepted.
    const targetBound=db.prepare('SELECT method_json FROM dsh_completion_bindings WHERE run_id=? AND approved=1').all<{method_json:string}>(receipt.runId)
      .some(row=>{const method=JSON.parse(row.method_json);return method.kind==='native_command'&&method.sourcePaths?.includes(decision.target)})
    if(targetBound&&assessment.verified&&compatibility&&!decision.complete&&decision.basis==='version_only')
      return {...base,state:'contradiction',reason:'verified_work_marked_incomplete_for_version',verification:'host_observed'}
    if(targetBound&&assessment.verified&&decision.complete)return {...base,state:'consistent',reason:'current_host_verification',verification:'host_observed'}
  }
  return {...base,state:'unverified',reason:'no_machine_verified_application'}
}
/** Bounded native-session evidence, not a reusable memory save or model attestation. */
export function recordCorrectionObservation(db:SqliteDatabase,receipt:CorrectionReceipt,payload:Record<string,unknown>={}){
  const data=JSON.parse(JSON.stringify({schema:'correction-application-v1',...receipt,...payload}))
  const store=new LedgerStore(db),run=store.readRun(receipt.runId)
  if(run?.status!=='active'||run.workspace!==receipt.workspace)return false
  store.appendBatch(receipt.runId,{events:[{eventId:`correction:${canonicalContentHash(data)}`,eventType:'correction.recorded',actor:'kiokuko-dsh',payload:data}]})
  return true
}
/** Inspect only supported literal writes; CI install pins and provenance text do not match. */
export function literalVersionGate(name:string,args:any,root:string):CorrectionDecision|undefined {
  if(!['kioku_write','kioku_edit','Write','write','write_file','Edit','edit','apply_patch','Bash','bash'].includes(name))return
  const text=name==='Bash'||name==='bash'?args?.command:args?.new_string??args?.newText??args?.content??args?.patch
  if(typeof text!=='string'||text.length>256000)return
  if((name==='Bash'||name==='bash')&&!/apply_patch|writeFile|write_text|sed\s+-i/u.test(text))return
  const normalized=text.replaceAll('\\.','.')
  const line=normalized.split('\n').find(line=>!line.startsWith('-')&&/assert\.(?:match|equal)\s*\(/u.test(line)&&/compiler|rustc/u.test(line)&&/\b\d+\.\d+\.\d+\b/u.test(line))
  if(!line)return
  const target=args?.file_path??args?.path??text.match(/\*\*\* (?:Update|Add) File: ([^\r\n]+)/u)?.[1]
  if(typeof target!=='string')return
  const relativeTarget=path.relative(root,path.resolve(root,target)).split(path.sep).join('/')
  if(!relative.safeParse(relativeTarget).success)return
  if(!/\.[cm]?[jt]s$/u.test(relativeTarget)||/(?:^|\/)(?:tests|fixtures)\/|\.test\.[cm]?[jt]s$/u.test(relativeTarget))return
  return {kind:'compatibility',target:relativeTarget,basis:'version_only',requiredVersion:line.match(/\b\d+\.\d+\.\d+\b/u)![0],observedVersion:'another_capable_compiler'}
}
