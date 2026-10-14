import path from 'node:path'
import type { SqliteDatabase } from '../../db/adapter.js'
import { withImmediateTransaction } from '../../db/transaction.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { KiokukoError } from '../../errors.js'
import { bindTaskRepository, captureTaskLease, authorizeTaskLease, type TaskLease } from '../task-state.js'
import { readCodingWorkflow, mutateCodingWorkflow } from '../coding-workflow/store.js'
import type { CodingIdentity } from '../coding-workflow/contracts.js'
import type { ExecutionReceipt } from '../owned-execution.js'
import { shellArguments, executionCommand } from '../execution-command.js'
import { ProtocolRecipeSchema, type ProtocolState, type ProtocolRecipe } from './contracts.js'
import { manifest, equalManifest, issueProtocolReceipt, validateProtocolReceipt, protocolReceiptUncertain } from './evidence.js'
import { protocolRuntime, checkProtocol } from './engine.js'
function conflict(message:string):never {throw new KiokukoError('CONFLICT',`Protocol: ${message}`)}
export function readProtocol(db:SqliteDatabase,runId:string):ProtocolState|undefined {return readCodingWorkflow(db,runId)?.protocol}
function current(db:SqliteDatabase,lease:TaskLease,reportRead=false):ProtocolState {
  authorizeTaskLease(db,lease)
  const workflow=readCodingWorkflow(db,lease.taskId),state=workflow?.protocol
  if(!workflow||!state||workflow.pendingScopeChange||workflow.scopeVersion!==state.scopeVersion||(['cancelled','superseded'].includes(workflow.state)||workflow.state==='completed'&&!reportRead)||canonicalContentHash(state.lease as any)!==canonicalContentHash(lease as any))conflict('task, scope or authority changed; explicitly amend/rebind the unit')
  const binding=db.prepare('SELECT criterion_revision,method_json,method_digest,approved FROM dsh_completion_bindings WHERE run_id=? AND criterion_id=?').get<{criterion_revision:number;method_json:string;method_digest:string;approved:number}>(lease.taskId,state!.criterionId)
  const criterion=workflow.definition?.criteria.find(item=>state!.criterionId===`coding:${workflow.workflowId}:${item.criterionId}`)
  if(!binding||binding.approved!==1||binding.method_digest!==state!.methodDigest||criterion?.revision!==binding.criterion_revision)conflict('current completion binding was removed or replaced; explicitly rebind the unit')
  const method=JSON.parse(binding.method_json)
  if(canonicalContentHash({revision:binding.criterion_revision,method,scope:workflow.scopeVersion})!==state!.methodDigest||canonicalContentHash(method.protocol??null)!==canonicalContentHash(state!.recipe))conflict('current completion binding changed; explicitly rebind the unit')
  if(state!.runtimeDigest!==protocolRuntime().runtimeDigest)conflict('runtime changed; explicitly amend/rebind the unit')
  return state!
}
function fresh(state:ProtocolState):void {
  if(!equalManifest(state.source,manifest(state.lease.repositoryRoot,state.sourcePaths))||!equalManifest(state.tests,manifest(state.lease.repositoryRoot,state.recipe.testPaths)))conflict('source/tests changed outside the bound phase; explicitly amend/rebind the unit')
}
function update(db:SqliteDatabase,state:ProtocolState,key:string,payload:unknown,change:(state:ProtocolState)=>void):ProtocolState {
  const workflow=readCodingWorkflow(db,state.lease.taskId)!
  return mutateCodingWorkflow(db,workflow,key,workflow.revision,payload,value=>{if(!value.protocol||value.protocol.recipeId!==state.recipeId)conflict('recipe replaced');change(value.protocol)}).protocol!
}
export function enrollProtocol(db:SqliteDatabase,identity:CodingIdentity,input:{criterionId:string;methodDigest:string;command:string;cwd:string;sourcePaths:string[];recipe:ProtocolRecipe}):void {
  const recipe=ProtocolRecipeSchema.parse(input.recipe),workflow=readCodingWorkflow(db,identity.runId)
  if(!workflow?.definition||workflow.choice.state==='pending'||workflow.pendingScopeChange)conflict('finish Goal and execution choice before binding a protocol')
  if(!workflow.definition!.items.some(item=>item.itemId===recipe.unitId&&item.criterionIds.some(id=>input.criterionId===`coding:${workflow.workflowId}:${id}`)))conflict('recipe must name the exact bound implementation unit')
  const declared=[...recipe.implementationPaths,...recipe.testPaths]
  if(declared.some(file=>!input.sourcePaths.includes(file)))conflict('approved sourcePaths must cover every declared implementation/test path')
  const argv=shellArguments(input.command),selected=argv?.slice(3)
  if(!argv||!['node',process.execPath].includes(argv[0]!)||argv[1]!=='--test'||argv[2]!=='--test-reporter=tap'||selected?.length!==recipe.testPaths.length||selected.some((file,index)=>file!==recipe.testPaths[index])||path.resolve(identity.repositoryRoot,input.cwd)!==identity.repositoryRoot)conflict('use the exact selected Node command: node --test --test-reporter=tap <declared test paths>, cwd .')
  if(db.prepare('SELECT 1 FROM dsh_lisp_sessions WHERE session_id=? AND enabled=1').get(identity.sessionId))conflict('disable the existing Lisp session before enrolling the protocol')
  const running=db.prepare("SELECT receipt_json FROM dsh_owned_operations WHERE run_id=?").all<{receipt_json:string}>(identity.runId)
  if(running.some(row=>{const r=JSON.parse(row.receipt_json);return r.state==='started'||r.kind==='kioku_exec'&&r.processStarted&&r.exitCode===undefined&&r.signal===undefined}))conflict('stop and confirm existing owned processes before binding')
  const runtimeDigest=protocolRuntime().runtimeDigest // Missing/unverified platform binary cannot enable the protocol.
  bindTaskRepository(db,{taskId:identity.runId,sessionId:identity.sessionId,repositoryRoot:identity.repositoryRoot})
  const lease=captureTaskLease(db,{taskId:identity.runId,sessionId:identity.sessionId,repositoryRoot:identity.repositoryRoot})
  const previous=workflow.protocol
  if(previous?.scopeVersion===workflow.scopeVersion&&(recipe.implementationPaths.some(file=>!previous.recipe.implementationPaths.includes(file))||recipe.testPaths.some(file=>!previous.recipe.testPaths.includes(file))))conflict('amend the coding scope before broadening the implementation or test paths')
  if(previous?.pending&&previous.lease.generation===lease.generation)conflict('an interrupted/pending effect requires stop confirmation, explicit resume and a fresh binding; inspect actual files first')
  const sourcePaths=input.sourcePaths.filter(file=>!recipe.testPaths.includes(file)),source=manifest(identity.repositoryRoot,sourcePaths),tests=manifest(identity.repositoryRoot,recipe.testPaths)
  const generation=(previous?.generation??0)+1,recipeId=canonicalContentHash({lease,scope:workflow.scopeVersion,generation,recipe,method:input.methodDigest})
  const state:ProtocolState={schema:1,recipe,recipeId,scopeVersion:workflow.scopeVersion,generation,lease,criterionId:input.criterionId,methodDigest:input.methodDigest,runtimeDigest,command:executionCommand(input.command),cwd:identity.repositoryRoot,sourcePaths,phase:'write-tests',source,tests,baselineTests:{...tests},edits:[],consumed:[]}
  mutateCodingWorkflow(db,identity,`protocol-bind:${recipeId}`,workflow.revision,{recipeId},value=>{value.protocol=state})
}
export function invalidateProtocolBinding(db:SqliteDatabase,runId:string,criterionId:string,methodDigest:string):void {
  const state=readProtocol(db,runId)
  if(state?.criterionId===criterionId)update(db,state,`protocol-replaced:${methodDigest}`,{methodDigest},value=>invalidateProtocol(value,'completion binding replaced; explicitly rebind the unit'))
}
export function invalidateProtocol(state:ProtocolState|undefined,reason:string):void {if(state){state.phase='blocked';state.reason=reason;delete state.red;delete state.green}}
export function assertProtocolRoute(db:SqliteDatabase,lease:TaskLease,name:string,owned=false):void {
  const state=readProtocol(db,lease.taskId);if(!state)return
  current(db,lease)
  if(!owned&&!['kioku_read','kioku_result'].includes(name))conflict('this enrolled unit accepts effects only through bound owned file/test tools')
}
export function reserveProtocolFile(db:SqliteDatabase,lease:TaskLease,id:string,name:string,target:string,requestDigest:string):boolean {
  if(!readProtocol(db,lease.taskId))return false
  return withImmediateTransaction(db,()=>{
    const state=current(db,lease);fresh(state)
    if(state.pending)conflict('another effect is pending; inspect its result before continuing')
    if(state.consumed.length>=128||state.edits.length>=128)conflict('bounded unit budget reached; run GREEN or explicitly amend/rebind the unit')
    const relative=path.relative(lease.repositoryRoot,target).split(path.sep).join('/'),isTest=state.recipe.testPaths.includes(relative)
    if(name==='kioku_remove')conflict('source removal is not supported by this bounded protocol; amend the recipe')
    if(isTest){if(!['write-tests','verify-red'].includes(state.phase))conflict('tests are frozen after RED; explicitly amend/rebind the unit')}
    else {
      if(!state.recipe.implementationPaths.includes(relative))conflict('file is outside the declared implementation unit')
      if(state.phase!=='implement'||!state.red)conflict('implementation requires an actual assertion RED phase')
      validateProtocolReceipt(db,state,state.red)
      if(state.red.runtimeDigest!==protocolRuntime().runtimeDigest)conflict('runtime changed; rebind the unit')
    }
    update(db,state,`protocol-reserve:${id}`,{id,name,target,requestDigest},value=>{value.pending={id,kind:'file',path:relative,requestDigest,phase:value.phase}})
    return true
  })
}
/** Retrying acquisition is safe; replaying an entered effect callback is not. */
export function withProtocolEffect<T>(db:SqliteDatabase,effect:()=>T):T {
  let entered=false
  return withImmediateTransaction(db,()=>{
    if(entered)conflict('effect transaction outcome is uncertain; inspect the operation instead of retrying its effect')
    entered=true
    return effect()
  })
}
/** No await between this final reauthorization and the synchronous file effect. */
export function applyProtocolFile<T>(db:SqliteDatabase,lease:TaskLease,id:string,signal:AbortSignal,effect:()=>T):T {
  return withProtocolEffect(db,()=>{
    const state=current(db,lease);fresh(state);signal.throwIfAborted()
    if(state.pending?.id!==id||state.pending.kind!=='file'||state.pending.phase!==state.phase)conflict('file effect reservation changed or was already consumed')
    const relative=state.pending!.path!,result=effect()
    update(db,state,`protocol-applied:${id}`,{id},value=>{
      value.source=manifest(lease.repositoryRoot,value.sourcePaths);value.tests=manifest(lease.repositoryRoot,value.recipe.testPaths)
      if(value.recipe.testPaths.includes(relative))value.phase=value.recipe.testPaths.every(file=>value.tests[file]!==value.baselineTests[file])?'verify-red':'write-tests'
      else value.edits.push(id)
      delete value.pending
    })
    return result
  })
}
export function reserveProtocolTest(db:SqliteDatabase,lease:TaskLease,id:string,command:string,cwd:string):ProtocolState|undefined {
  if(!readProtocol(db,lease.taskId))return undefined
  return withImmediateTransaction(db,()=>{
    const state=current(db,lease);fresh(state)
    if(executionCommand(command)!==state.command||cwd!==state.cwd)conflict('command is not the exact approved selected test command')
    if(state.pending)conflict('another effect is pending; inspect its result before continuing')
    if(state.consumed.length>=128)conflict('bounded verification budget reached; explicitly amend/rebind the unit')
    if(!['verify-red','implement','verify-green','report'].includes(state.phase))conflict('write every declared regression before RED; current phase does not admit tests')
    if(['implement','verify-green','report'].includes(state.phase)&&(!state.red||!state.edits.length||state.red.sourceDigest===canonicalContentHash(state.source)))conflict('GREEN requires a changed implementation unit with a net source delta from RED')
    return update(db,state,`protocol-test:${id}`,{id,command,cwd},value=>{if(value.phase==='implement'||value.phase==='report')value.phase='verify-green';value.pending={id,kind:'test',requestDigest:canonicalContentHash({command,cwd}),phase:value.phase}})
  })
}
export function authorizeProtocolTest(db:SqliteDatabase,lease:TaskLease,id:string,signal:AbortSignal):ProtocolState {
  const state=current(db,lease);fresh(state);signal.throwIfAborted()
  if(state.pending?.id!==id||state.pending.kind!=='test')conflict('test reservation changed')
  return state
}
export async function finishProtocolTest(database:<T>(action:(db:SqliteDatabase)=>T)=>Promise<T>,receipt:ExecutionReceipt):Promise<void> {
  const state=await database(db=>readProtocol(db,receipt.runId))
  if(!state||state.pending?.id!==receipt.operationId||state.pending.kind!=='test')return
  if(protocolReceiptUncertain(receipt)){await database(db=>withImmediateTransaction(db,()=>{const latest=current(db,state.lease);if(latest.pending?.id===receipt.operationId)update(db,latest,`protocol-uncertain:${receipt.operationId}`,{id:receipt.operationId},value=>{invalidateProtocol(value,'Effect transaction outcome is uncertain; inspect and reconcile, confirm stopped, then explicitly resume/rebind')})}));return}
  let proof
  try{proof=await database(db=>issueProtocolReceipt(db,current(db,state.lease),receipt,protocolRuntime().runtimeDigest))}
  catch(error){await database(db=>{const latest=current(db,state.lease);if(latest.pending?.id===receipt.operationId)update(db,latest,`protocol-incomplete:${receipt.operationId}`,{id:receipt.operationId},value=>{delete value.pending;value.reason=String(error);if(value.phase==='verify-red')value.phase='write-tests'})});return}
  const phase=state.phase==='verify-red'?'verify-red':state.phase==='report'?'report':'verify-green'
  let allowed=false
  if(proof.outcome!=='setup-error')allowed=await checkProtocol(state,proof,phase)
  const reopen=phase==='verify-green'&&!allowed&&proof.outcome==='assertion-failure'&&await checkProtocol(state,proof,'verify-red')
  await database(db=>withImmediateTransaction(db,()=>{
    const latest=current(db,state.lease);fresh(latest);validateProtocolReceipt(db,latest,proof!)
    if(latest.pending?.id!==receipt.operationId||latest.consumed.includes(proof!.id))conflict('test receipt was reused or the pending phase changed')
    update(db,latest,`protocol-settled:${receipt.operationId}`,{digest:proof!.digest,allowed,reopen},value=>{
      value.consumed.push(proof!.id);delete value.pending;delete value.reason
      if(phase==='verify-red') { if(allowed){value.red=proof!;value.phase='implement';value.edits=[]}else{value.phase='write-tests';value.reason='A genuine failing assertion is required; passing legacy checks are verification-only'}}
      else if(allowed){value.green=proof!;value.phase='report'}
      else if(reopen){value.red=proof!;value.phase='implement';value.edits=[]}
      else{value.phase='verify-green';value.reason='GREEN is incomplete; fix test setup or rerun the bound command. The implementation lease is closed'}
    })
  }))
}

export function protocolCompletionReady(db:SqliteDatabase,runId:string):boolean {
  const state=readProtocol(db,runId);if(!state)return true
  try { const value=current(db,state.lease,true);fresh(value);if(value.phase!=='report'||value.pending||!value.green||value.green.outcome!=='passed'||!value.edits.length||!value.red||value.red.sourceDigest===canonicalContentHash(value.source)||!value.consumed.includes(value.green.id))return false;validateProtocolReceipt(db,value,value.green);return value.green.sourceDigest===canonicalContentHash(value.source)&&value.green.runtimeDigest===protocolRuntime().runtimeDigest }catch{return false}
}
