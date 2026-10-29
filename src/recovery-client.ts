import type { DshClientContext } from './client.js'
import type { RecoveryResult, RecoveryStatus } from './dsh/session-recovery.js'

declare const jsx: (type: unknown, props: Record<string, unknown>, key?: string) => unknown
declare const jsxs: typeof jsx
declare const Fragment: unknown
declare const useState: <T>(initial: T) => [T, (next: T) => void]
declare const useRef: <T>(initial: T) => { current: T }
declare const useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => void
const NS = 'kiokuko-session-recovery'
const en = {
  open: 'Session recovery', title: 'Recover an interrupted conversation', refresh: 'Check again', checking: 'Checking…', close: 'Close',
  continue: 'Continue with this history', fresh: 'Start a fresh conversation', working: 'Preparing…',
  intro: 'The original history stays intact. Unknown tool outcomes are not automatically replayed. Old background-job IDs cannot be restored.',
  unknown: 'Tool calls with unknown outcomes', request: 'Original requests, in order', model: 'Saved model', missing: 'Model connection unavailable. Restore the connection or select a model before continuing.',
  running: 'This conversation is running. Recovery is disabled until it is idle.', healthy: 'No interrupted last turn was found. You can still create an empty conversation.',
  created: 'A new empty conversation is ready. Review the request and attachments before sending; nothing has been submitted to the model.',
  openNew: 'Open the new conversation with this draft', previous: 'Open the conversation already created', continued: 'Continuation requested. Check the response in this conversation.',
  unavailable: 'Recovery is unavailable. The original history has been retained.', draft: 'Request to carry over',
}
const ja: Record<keyof typeof en, string> = {
  open: 'セッション復旧', title: '中断した会話を復旧', refresh: '状態を再確認', checking: '確認中…', close: '閉じる',
  continue: 'この履歴から続ける', fresh: '空の会話でやり直す', working: '準備中…',
  intro: '元の履歴は残ります。結果不明のツール処理は自動再実行しません。前プロセスのジョブ ID は復元できません。',
  unknown: '結果が不明なツール呼び出し', request: '元のユーザー依頼（時系列）', model: '保存されたモデル', missing: 'モデル接続が利用できません。接続を復旧するか、モデルを選び直してから続行してください。',
  running: 'この会話は実行中です。終了するまで復旧操作できません。', healthy: '最後のターンに中断は見つかりませんでした。新しい空の会話は作成できます。',
  created: '新しい空の会話を作成しました。依頼内容と添付を確認してから送信してください。まだモデルへ送信していません。',
  openNew: 'この依頼文を新しい会話で開く', previous: '作成済みの会話を開く', continued: '続行を依頼しました。この会話の応答を確認してください。',
  unavailable: '復旧機能に接続できません。元の履歴は保持されています。', draft: '引き継ぐ依頼文',
}

/** Initialize the exact native target generation before publishing navigation. */
export function openRecoveryDraft(ctx: DshClientContext, id: string, draft: string): void {
  const sessions = ctx.get?.('sessions', false) as any
  const conversation = ctx.get?.('conversation', false) as any
  const workspace = ctx.get?.('uiWorkspace', false) as any
  if (!sessions?.retain || !conversation?.input?.requestDraftInitialization || !workspace?.openSession) throw new Error('新しい会話を開けません。一覧から会話を開き、表示された依頼文をコピーしてください。')
  const reference = sessions.retain(id, { source: 'mainView' })
  try {
    const binding = sessions.binding(id)
    if (!binding || conversation.input.requestDraftInitialization(binding, { prompt: draft, whenDraftExists: 'keep' }) === 'blocked') throw new Error('新しい会話の入力欄を準備できません。元の会話と依頼文は保持されています。')
    workspace.openSession(id)
  } finally { reference.release() }
}
async function api(id: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const response = await fetch(`/api/kiokuko.session-recovery?sessionId=${encodeURIComponent(id)}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) } : (signal ? { signal } : {}))
  const value = await response.json().catch(() => ({ error: ja.unavailable }))
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : ja.unavailable)
  return value
}
function RecoveryAction(props: Record<string, unknown>): unknown {
  const id = String(props.sessionId)
  const t = props.recoveryT as (key: keyof typeof en) => string
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<RecoveryStatus | null>(null), [result, setResult] = useState<RecoveryResult | null>(null)
  const [error, setError] = useState(''), [draft, setDraft] = useState('')
  const dialog = useRef<HTMLDialogElement | null>(null), trigger = useRef<HTMLButtonElement | null>(null)
  const active = useRef(id), mounted = useRef(true), pending = useRef(false)
  const operation = useRef<{ action: 'continue' | 'new'; seq: number; id: string } | null>(null)
  active.current = id
  useEffect(() => { mounted.current = true; pending.current = false; operation.current = null; setOpen(false); setBusy(false); setStatus(null); setResult(null); setError(''); return () => { mounted.current = false } }, [id])
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal()
    else if (!open && dialog.current?.open) { dialog.current.close(); trigger.current?.focus() }
  }, [open])
  const current = () => mounted.current && active.current === id
  const load = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setResult(null); operation.current = null
    try { const next = await api(id, undefined, AbortSignal.timeout(15000)); if (current()) setStatus(next) }
    catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : t('unavailable')) }
    finally { if (current()) { pending.current = false; setBusy(false) } }
  }
  const act = async (action: 'continue' | 'new') => {
    if (pending.current || !status) return
    pending.current = true; setBusy(true); setError('')
    const previous = operation.current
    const op = previous?.action === action && previous.seq === status.seq ? previous : { action, seq: status.seq, id: crypto.randomUUID() }
    operation.current = op
    try {
      const next: RecoveryResult = await api(id, { sessionId: id, action, expectedSeq: op.seq, operationId: op.id }, AbortSignal.timeout(30000))
      if (current()) { setResult(next); setDraft(next.draft ?? ''); if (action === 'continue') setStatus({ ...status, canContinue: false }) }
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : t('unavailable')) }
    finally { if (current()) { pending.current = false; setBusy(false) } }
  }
  const openTarget = (target: string, prompt: string) => {
    try { (props.openRecovery as (id: string, draft: string) => void)(target, prompt); setOpen(false) }
    catch (failure) { setError(failure instanceof Error ? failure.message : t('unavailable')) }
  }
  const button = (label: string, onClick: () => void, disabled = false) => jsx('button', { type: 'button', disabled: busy || disabled, onClick, children: label })
  return jsxs(Fragment, { children: [
    jsx('button', { ref: trigger, type: 'button', onClick: () => { setOpen(true); void load() }, children: t('open') }),
    jsxs('dialog', { ref: dialog, className: 'kiokuko-recovery-dialog', 'aria-label': t('title'), onCancel: (event: Event) => { if (pending.current) event.preventDefault(); else setOpen(false) }, onClose: () => setOpen(false), children: [
      jsx('h2', { children: t('title') }), jsx('p', { children: t('intro') }),
      busy ? jsx('p', { role: 'status', children: t('working') }) : null,
      error ? jsx('p', { role: 'alert', children: error }) : null,
      status ? jsxs('div', { children: [
        jsx('p', { children: `${t('model')}: ${status.model ? `${status.model.provider}/${status.model.model}` : '—'}` }),
        !status.modelAvailable ? jsx('p', { role: 'status', children: t('missing') }) : null,
        status.busy ? jsx('p', { role: 'status', children: t('running') }) : null,
        !status.interrupted ? jsx('p', { children: t('healthy') }) : null,
        ...status.warnings.map((warning, index) => jsx('p', { children: warning }, `warning-${index}`)),
        status.unknownCalls.length ? jsxs('div', { children: [jsx('h3', { children: t('unknown') }), jsx('ul', { children: status.unknownCalls.map(call => jsx('li', { children: `${call.name} (${call.id})` }, call.id)) })] }) : null,
        jsx('label', { children: jsxs(Fragment, { children: [t('request'), jsx('textarea', { readOnly: true, rows: 5, value: status.originalRequest })] }) }),
        jsxs('div', { className: 'kiokuko-recovery-actions', children: [button(t('continue'), () => void act('continue'), !status.canContinue || !!result), button(t('fresh'), () => void act('new'), !status.canRestart || !!result)] }),
        status.lastRestart && !result ? button(t('previous'), () => openTarget(status.lastRestart!.sessionId, status.lastRestart!.draft)) : null,
      ] }) : null,
      result?.action === 'continue' ? jsx('p', { role: 'status', children: t('continued') }) : null,
      result?.action === 'new' ? jsxs('div', { children: [jsx('p', { role: 'status', children: t('created') }), ...result.warnings.map((warning, index) => jsx('p', { children: warning }, `result-warning-${index}`)), jsx('label', { children: jsxs(Fragment, { children: [t('draft'), jsx('textarea', { rows: 7, value: draft, onChange: (event: { target: { value: string } }) => setDraft(event.target.value) })] }) }), button(t('openNew'), () => openTarget(result.sessionId, draft))] }) : null,
      jsxs('div', { className: 'kiokuko-recovery-actions', children: [button(t('refresh'), () => void load()), button(t('close'), () => setOpen(false))] }),
    ] }),
  ] })
}
export function mountRecoveryClient(ctx: DshClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, ja }) as () => void, 'kiokuko recovery dictionaries')
  const t = ctx.locale.bind?.(NS) ?? ((key: keyof typeof en) => ja[key])
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'kiokuko-session-recovery', locale: NS, inject: () => ({ recoveryT: t, openRecovery: (id: string, draft: string) => openRecoveryDraft(ctx, id, draft) }) }, RecoveryAction))
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = '.kiokuko-recovery-dialog{box-sizing:border-box;width:min(46rem,calc(100vw - 2rem));max-height:85vh;overflow:auto;margin:auto;padding:20px;border:1px solid #888;border-radius:16px;background:var(--dsw-alias-background-primary,Canvas);color:var(--dsw-alias-text-primary,CanvasText)}.kiokuko-recovery-dialog textarea{display:block;box-sizing:border-box;width:100%;margin:8px 0 16px;padding:10px;background:transparent;color:inherit;border:1px solid #888;border-radius:6px}.kiokuko-recovery-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.kiokuko-recovery-dialog button{min-height:40px;padding:8px 12px}.kiokuko-recovery-dialog :focus-visible{outline:2px solid #3286ff;outline-offset:3px}'
    document.head.append(style)
    return () => style.remove()
  }, 'kiokuko recovery style')
}
