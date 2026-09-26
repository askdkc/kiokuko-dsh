import type { DshCompositionHost } from '../composition.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import type { AutoMemoryReviewCoordinator, ReviewNativeSession } from '../auto-memory-review.js'
import type { DshMemoryFinalizer } from '../session-memory-finalizer.js'
import type { DshSessionLogMirror } from '../session-log-mirror.js'
import type { TurnRecord } from './turn-state.js'
import { resolveProjectWorkspaceReadOnly } from '../../memory/workspaces.js'
import { assertCaptureAllowed } from '../../memory/capture-policy.js'

interface MemoryReviewHostDependencies {
  readonly runtime: DshCoreRuntime
  readonly autoReview: AutoMemoryReviewCoordinator
  readonly root: string
  readonly currentSession: (sessionId: string) => TurnRecord | undefined
  readonly objectRecord: (value: unknown) => Record<string, unknown> | undefined
  readonly memoryFinalizer: DshMemoryFinalizer
  readonly sessionMirror: DshSessionLogMirror
  readonly reviewBinding: (item: TurnRecord, session: object) => { workspace: string; runId: string; session: ReviewNativeSession; startSeq: number }
}

export function createMemoryReviewHost(deps: MemoryReviewHostDependencies): NonNullable<DshCompositionHost['memoryReview']> {
  const { runtime, autoReview, root, currentSession, objectRecord, memoryFinalizer, sessionMirror, reviewBinding } = deps
  return {
      async start(){const project=await runtime.withDatabase(db=>resolveProjectWorkspaceReadOnly(db,root,{allowDirectory:true}));if(project)await autoReview.start(project.workspace)},
      configure:config=>autoReview.configure(config),
      async command(session,raw) {
        const item=currentSession(session.id)
        if(item&&item.nativeSession!==session)throw new Error('session_owner_unavailable')
        const sessionRoot=objectRecord(objectRecord(session)?.header)?.cwd
        const workspace=item?.workspace??(await runtime.withDatabase(db=>resolveProjectWorkspaceReadOnly(db,typeof sessionRoot==='string'?sessionRoot:root,{allowDirectory:true})))?.workspace
        if(!workspace)throw new Error('workspace_unavailable')
        const args=raw.trim().split(/\s+/)
        if(!raw.trim()||args[0]==='status')return autoReview.status(workspace,session.id)
        if(args[0]==='mode'&&args.length===2&&['off','observe','active'].includes(args[1]!)){await autoReview.setMode(workspace,args[1] as 'off'|'observe'|'active');return autoReview.status(workspace,session.id)}
        if(raw.trim()==='exclude session') {await autoReview.exclude(workspace,session.id);return {state:'excluded',message:'この会話の自動メモリ生成を除外しました。保存済み記憶と会話ログは残ります。'}}
        if(!item)throw new Error('session_owner_unavailable')
        if(args[0]==='retry'&&args.length===2){const job=await autoReview.retry(item.workspace,args[1]!);return {jobId:job.id,state:job.state,reason:job.reason}}
        if(args[0]==='retry-finalizer'&&args.length===2){
          await runtime.withDatabase(db=>{const job=db.prepare('SELECT workspace,dsh_session_id,status,attempt_count FROM dsh_memory_finalizations WHERE run_id=?').get<{workspace:string;dsh_session_id:string;status:string;attempt_count:number}>(args[1]!);if(!job||job.workspace!==item.workspace)throw new Error('finalizer_not_found');assertCaptureAllowed(db,job.workspace,job.dsh_session_id);if(job.status!=='failed'||job.attempt_count>=3)throw new Error('finalizer_retry_unavailable')})
          await memoryFinalizer.retryFailed(args[1]!);return {runId:args[1],state:'queued'}
        }
        if(raw.trim()==='run'){
          const end=await sessionMirror.latestEvent(session.id,'turn/end',Number.MAX_SAFE_INTEGER)
          if(!end)return {state:'no_confirmed_turns'}
          const job=await autoReview.scan(reviewBinding(item,session),end.seq,'manual')
          return job?{jobId:job.id,state:job.state}:{state:'no_unscheduled_turns'}
        }
        throw new Error('invalid_command')
      },
    }
}
