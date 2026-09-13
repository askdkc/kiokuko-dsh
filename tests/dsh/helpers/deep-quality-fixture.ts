import type { DeepJob, QualityReply } from '../../../src/deep-thinker/core/contracts.js'
export function qualityInput(job: Pick<DeepJob,'prompt'>): any { return JSON.parse(job.prompt.split('\n\n').at(-1)!) }
export function qualityResponse(input: any, options: { a?: string; b?: string; action?: 'repair'|'synthesize'; rejectConsensus?: boolean; selectFirst?: boolean } = {}): QualityReply {
  if (input.phase==='plan') return {kind:'quality-plan',decision:'leaf',checks:input.inheritedChecks.length?[]:input.requirementIds.flatMap((requirementId:string)=>['answer','evidence'].map(key=>({key:`${requirementId}-${key}`,requirementId,text:`Check ${key}`,evidenceNeeded:'Source or explicit analytical argument'}))),children:[],reason:'One bounded question',synthesis:'None'}
  if(input.phase==='plan-review') return {kind:'quality-plan-review',verdict:'supported',requirementIds:input.requirementIds,checkIds:input.checks.map((c:any)=>c.id),reason:'Checks cover the original request',evidence:[]}
  if(['draft-a','draft-b','compose','repair','synthesize'].includes(input.phase)) {
    const answer=input.phase==='draft-a'?(options.a??'CORRECT'):input.phase==='draft-b'?(options.b??'CORRECT'):'CORRECT'
    return {kind:'quality-candidate',answer,evidence:[],assumptions:[],unresolved:[],findings:input.checks.map((c:any)=>({checkId:c.id,conclusion:answer,evidence:[],unresolved:false}))}
  }
  const first=input.candidates[0], selected=options.selectFirst?first:input.candidates.find((c:any)=>c.answer==='CORRECT')??input.candidates.at(-1)
  const action=options.rejectConsensus?'unresolved':options.action&&input.phase==='compare'?options.action:'select'
  return {kind:'quality-review',action,selectedCandidateId:action==='select'?selected.id:null,requirementIds:input.requirementIds,reason:'Compared all obligations and counterexamples',evidence:[],
    evaluations:input.candidates.flatMap((c:any)=>input.checks.map((check:any)=>({candidateId:c.id,checkId:check.id,verdict:c.answer==='CORRECT'?'supported':'contradicted',reason:'Analytical fixture assessment',evidence:[]}))),
    agreement:input.checks.map((c:any)=>({checkId:c.id,kind:options.rejectConsensus?'agreement':'unknown',reason:'Agreement is not a correctness proof'})),
    issues:action==='repair'||action==='synthesize'?[{checkId:input.checks[0].id,text:'Resolve the concrete counterexample'}]:[],
    resolutions:input.issues.map((i:any)=>({issueId:i.id,status:'resolved',reason:'Counterexample addressed by the selected candidate',evidence:[]})),
  }
}
