import { canonicalContentHash } from '../../serialization/validate.js'
import type { RequestIntentContext, RequestIntentDecision } from './request-intent.js'
import type { DecisionBatch } from './contracts.js'
import type { DecisionService } from './service.js'
import { runMicroJudge, type Expression, type FiniteDomainProblem, type MicroJudgeResult } from './micro-judge.js'
export const INTENT_ASSESSMENT_POLICY='source-candidate-independent-v1'
export type SemanticVerdict='supported'|'contradicted'|'insufficient'|'unavailable'
export interface IntentAssessment { semantic: SemanticVerdict; semanticInputDigest: string; semanticOutputDigest?: string; providerDecisionId?: string; detector: MicroJudgeResult; outcome: 'consistent'|'clarify'|'unavailable' }
const criteria=[
  ['action','The proposed action and artifact scope preserve every requested action, negation, quotation, actor and distinction between explanation, verification and implementation.'],
  ['reference','Every proposed continuation, scope change and adopted proposal refers to the exact supplied current-session source. Omitted or uncertain targets are not replaced by the current directory.'],
  ['constraints','The candidate preserves applicable target exclusions and constraints. It does not turn a forbidden, quoted or hypothetical action into a request.'],
  ['latest-answer','Apply the latest explicitly labelled native clarification answer to its question and current scope. A same-scope explicit revision can supersede the earlier conflicting instruction; do not let an older prohibition permanently override it. Unrelated constraints remain in force.'],
] as const
/** Separate inference compares original source against a candidate; extraction scores/results are deliberately excluded. */
export function buildIntentAssessmentBatch(context: RequestIntentContext, candidate: RequestIntentDecision): DecisionBatch {
  return {purpose:'intent-semantic-match',state:{source:context,candidate:{relation:candidate.relation,action:candidate.action,changeScope:candidate.changeScope,taskOperation:candidate.taskOperation??null,evidence:candidate.evidence},
    boundary:'Independent semantic comparison, not authorization. Read the original source before assessing the candidate. Do not rubber-stamp extraction. Missing information is insufficient, not false. Optional Lisp metadata is irrelevant to understanding or starting the requested implementation. Native permissions, ownership, task lifecycle and cancellation remain host authority.'},
    questions:criteria.map(([name,instructions])=>({id:`semantic-${name}`,instructions,
      choices:[{id:'supported',description:'The source independently supports this aspect of the candidate.'},{id:'contradicted',description:'The source contradicts this aspect of the candidate.'},{id:'insufficient',description:'The source does not establish this aspect or is ambiguous.'}],abstainId:'insufficient'}))}
}
const op=(name:'eq'|'and'|'implies',...args:Expression[]):Expression=>({op:name,args})
/** Relations over host-owned source revisions and reference sets. No model-supplied authorization bit. */
export function compileIntentRelations(context: RequestIntentContext,candidate: RequestIntentDecision,semantic: SemanticVerdict): FiniteDomainProblem {
  const domains:FiniteDomainProblem['domains']=[],constraints:Expression[]=[],requirements:Expression[]=[]
  const value=(kind:'bool'|'int',values:number[]):Expression=>{const variable=domains.length;domains.push({kind,values});return {variable}}
  const bit=(known:boolean)=>value('bool',[known?1:0])
  const equal=(a:number|undefined,b:number|undefined)=>{
    if(a===undefined&&b===undefined)return
    if(a===undefined||b===undefined){requirements.push(value('bool',[0]));return}
    requirements.push(op('eq',value('int',[a]),b))
  }
  const symbols=new Map<string,number>()
  const symbol=(v:unknown)=>{const digest=canonicalContentHash(v??null);if(!symbols.has(digest))symbols.set(digest,symbols.size);return symbols.get(digest)!}
  const identity=(a:unknown,b:unknown)=>{
    // Intern exact opaque identities locally: only equality reaches the solver, never raw text.
    requirements.push(op('eq',value('int',[symbol(a)]),symbol(b)))
  }
  identity(candidate.evidence.requestDigest,canonicalContentHash(context.task))
  identity(candidate.evidence.messageRefs,context.messageRefs)
  const task=context.activeTask,goal=context.activeGoal
  identity(candidate.evidence.runId,goal?.runId)
  identity(candidate.evidence.taskId,task?.taskId)
  equal(candidate.evidence.taskRevision,task?.revision);equal(candidate.evidence.taskGeneration,task?.generation)
  equal(candidate.evidence.workflowRevision,goal?.workflowRevision);equal(candidate.evidence.goalRevision,goal?.goalRevision);equal(candidate.evidence.scopeRevision,goal?.scopeRevision)
  // Set membership is encoded as candidate membership => exact host membership.
  for(const ref of candidate.evidence.proposalRefs){
    const source=context.proposals.find(p=>p.id===ref.id)
    requirements.push(op('implies',bit(true),bit(!!source)))
    if(source){identity(ref.digest,source.digest);equal(ref.revision??undefined,source.revision??undefined)}
  }
  const resolved=value('bool',candidate.action==='unknown'||candidate.relation==='unknown'||candidate.action==='change'&&candidate.changeScope==='unknown'?[0,1]:[1])
  const semanticVariable=value('bool',semantic==='supported'?[1]:semantic==='contradicted'?[0]:[0,1])
  // A candidate task transition must belong to the host's current legal operation set.
  if(candidate.taskOperation)requirements.push(op('implies',bit(true),bit(!!task?.allowedOps.includes(candidate.taskOperation))))
  const valid=value('bool',[0,1]);let conjunction:Expression=op('and',resolved,semanticVariable)
  for(const relation of requirements)conjunction=op('and',conjunction,relation)
  // Split conjunctions into ternary relations; propagation can eliminate impossible states before MRV search.
  function flatten(e:Expression):Expression {
    if(typeof e==='object'&&'op'in e){const args=e.args.map(flatten);const next=value('bool',[0,1]);constraints.push(op('eq',next,{op:e.op,args}));return next}
    return e
  }
  constraints.push(op('eq',valid,flatten(conjunction)))
  return {domains,constraints,query:valid,workBudget:200000}
}
export async function assessRequestIntent(service:DecisionService|undefined,requestId:string,context:RequestIntentContext,candidate:RequestIntentDecision,signal:AbortSignal,
  options:Parameters<typeof runMicroJudge>[3]={}):Promise<IntentAssessment|undefined>{
  // Explicitly disabled typed decisions retain the existing native authority path; no assessment is claimed.
  if(service && (await service.bind(requestId,signal)).mode==='off')return undefined
  const batch=buildIntentAssessmentBatch(context,candidate),semanticInputDigest=canonicalContentHash(batch)
  let semantic:SemanticVerdict='unavailable',semanticOutputDigest:string|undefined,providerDecisionId:string|undefined
  if(service)try{
    const result=await service.evaluate(requestId,batch,signal,INTENT_ASSESSMENT_POLICY,undefined,{onEvaluation:o=>{providerDecisionId=o.decisionId}})
    signal.throwIfAborted()
    if(result.status==='completed'){
      semanticOutputDigest=canonicalContentHash(result.result)
      const answers=result.result.answers
      semantic=answers.some(a=>a.status==='selected'&&a.choiceId==='contradicted')?'contradicted':answers.length===criteria.length&&answers.every(a=>a.status==='selected'&&a.choiceId==='supported')?'supported':'insufficient'
    }
  }catch{signal.throwIfAborted()}
  const problem=compileIntentRelations(context,candidate,semantic)
  const detector=await runMicroJudge(problem,canonicalContentHash([requestId,semanticInputDigest]),signal,options)
  const outcome=semantic==='unavailable'||detector.state==='unavailable'||!detector.result.complete?'unavailable':detector.result.status==='entailed'?'consistent':'clarify'
  return {semantic,semanticInputDigest,...(semanticOutputDigest?{semanticOutputDigest}:{}),...(providerDecisionId?{providerDecisionId}:{}),detector,outcome}
}
