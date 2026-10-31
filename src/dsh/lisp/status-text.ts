interface StatusOperation { id: string; state: string; kind?: string }
interface ManagedOperation extends StatusOperation { route: string }
export interface LispStatusView {
  state?: string; enabled?: boolean; error?: {message?: string} | null
  operationCount?: number; pendingCount?: number; pendingStates?: Record<string,number>
  operations?: StatusOperation[]; managedOperations?: ManagedOperation[]; managedUnknownOperations?: ManagedOperation[]
  managedOperationCount?: number; managedOperationsTruncated?: boolean; managedReconciliationRequired?: boolean
  codingPreparation?: {phase?: string}; hot?: {tools?: unknown[]}
}
const pending = new Set(['RUNNING','UNKNOWN','APPLYING','AWAITING_APPROVAL'])
const phases: Record<string,string> = {
  selected:'Lisp を選択（先行試作は任意）',cancelled:'取消済み・作業を保持',unavailable:'質問を利用できません',
  choice_pending:'Lisp の選択待ち',prototype_required:'試作待ち（未検証）',result_pending:'試作結果の確認待ち（未検証）',
  reviewed:'試作結果を確認済み（タスクの検証は別）',declined:'通常ツールを使用',failed:'試作失敗・自動再試行停止',
}
/** Human status is a bounded view. JSON and operation diagnostics retain the full evidence. */
export function formatLispStatus(value: LispStatusView): string {
  const lines = ['Lisp: '+(value.state??'状態不明')]
  const phase=value.codingPreparation?.phase
  if (phase && phases[phase]) lines.push('試作: '+phases[phase])
  if (value.error?.message) {
    const message=value.error.message.replace(/\s+/gu,' ').trim()
    lines.push('停止理由: '+message.slice(0,240)+(message.length>240?'…':''))
  }
  const operations=value.operations??[]
  const unresolved=operations.filter(o=>pending.has(o.state)).sort((a,b)=>Number(b.state==='UNKNOWN')-Number(a.state==='UNKNOWN'))
  const count=value.operationCount??operations.length
  const pendingCount=value.pendingCount??(value.pendingStates?Object.values(value.pendingStates).reduce((a,b)=>a+b,0):unresolved.length)
  lines.push('操作履歴: '+count+'件 / 未解決: '+pendingCount+'件')
  for (const operation of unresolved.slice(0,3)) {
    lines.push('未解決 '+operation.state+' · '+(operation.kind??'Lisp'))
    lines.push('  詳細: /kioku-lisp diagnostics '+operation.id)
  }
  if(pendingCount>3)lines.push('未解決はほかに'+(pendingCount-3)+'件あります。')
  const managed=value.managedOperations??[]
  const externalCount=value.managedOperationCount??managed.length
  if (externalCount) {
    lines.push('外部処理の未解決: '+externalCount+'件')
    const unique=new Map([...(value.managedUnknownOperations??[]),...managed].map(o=>[o.id,o]))
    const ordered=[...unique.values()].sort((a,b)=>Number(b.state==='unknown')-Number(a.state==='unknown'))
    for (const operation of ordered.slice(0,3)) {
      lines.push('外部 '+operation.route+'/'+operation.kind+' · '+operation.state)
      lines.push('  詳細: /kioku-lisp diagnostics '+operation.id)
    }
    if(externalCount>3||value.managedOperationsTruncated)lines.push('表示は先頭'+Math.min(3,managed.length)+'件です。')
  }
  if(value.managedReconciliationRequired||value.state==='RECONCILIATION_REQUIRED') {
    lines.push('外部処理の結果・停止は未確定です。上の詳細と元のホストreceiptを照合してください。')
    lines.push('確認できた操作だけを /kioku-lisp abandon-managed 操作ID で終了し、その後に /kioku-lisp recover で再開します。')
    lines.push('Lisp の再起動だけでは外部処理を確定できず、自動再実行もしません。')
  } else if(value.state==='STOP_UNCONFIRMED'||value.state==='STOPPING') {
    lines.push('停止をまだ確認できません。/kioku-lisp cancel で停止を確認し、実行結果を照合してください。')
  } else if(value.state==='RECOVERY_REQUIRED') {
    if(unresolved.some(o=>o.kind==='proposal'))lines.push('ファイルとバックアップを照合してください。採用しない変更だけを /kioku-lisp abandon 操作ID で終了できます。')
    lines.push('上の詳細で結果を照合した後、/kioku-lisp recover で再開できます。過去のコードは自動再実行しません。')
  } else if(value.state==='DISABLED')lines.push('利用する場合は /kioku-lisp enable')
  else if(value.state==='SUSPENDED')lines.push('休止中です。次の利用で自動起動します。変数・関数定義は保持されません。')
  else if(value.state==='READY'||value.state==='TASK_READY')lines.push('利用できます。')
  if(value.hot?.tools)lines.push('共有関数: '+value.hot.tools.length)
  lines.push('履歴の詳細: /kioku-lisp status --json')
  return lines.join('\n')
}
