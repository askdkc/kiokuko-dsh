interface SnapshotStore<T> {
  getSnapshot(): T
  update(update: (state: T) => void): void
}

interface DshSessionDownloadWindow {
  showSaveFilePicker?: (options: unknown) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>
  location: { assign(url: string): void }
}

export interface DshSessionDownloadOptions {
  readonly endpoint: string
  readonly sessionId: string
  readonly fetch?: typeof globalThis.fetch
  readonly signal?: AbortSignal
  readonly window?: DshSessionDownloadWindow
}

interface SessionLogDownloadEntry {
  readonly open: boolean
  readonly status: 'downloading' | 'success' | 'error'
  readonly error: string | null
}

interface SessionLogDownloadState {
  bySession: Record<string, SessionLogDownloadEntry | undefined>
}

interface DshClientContext {
  readonly uiConversation: { readonly events: { register(definition: unknown): unknown } }
  readonly locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown
    bind?(namespace: string): (key: string) => string
  }
  readonly sidebarRightTabs?: { register(definition: unknown): () => unknown }
  readonly sidebarRight?: { openTab(kind: string): void; openResource?(address: string): void }
  inject?(services: readonly string[], callback: (scope: DshClientContext) => void): unknown
  readonly slots: {
    inject(name: string, register: () => unknown): unknown
    register(
      definition: {
        readonly name: string
        readonly id?: string
        readonly key?: string
        readonly priority?: number
        readonly select?: (props: Record<string, unknown>) => unknown
        readonly locale: string
        readonly inject?: () => Record<string, unknown>
      },
      component: (props: Record<string, unknown>) => unknown,
    ): unknown
  }
  effect(setup: () => void | (() => void | Promise<void>), label: string): unknown
  on(event: 'command/executed', listener: (sessionId: string, commandName: string, result: { readonly kind: string }) => void): unknown
}

// Supplied by the DSH lazy-CJS wrapper generated after tsc. These deliberately
// remain type-only: cross-plugin value imports break the browser module table.
declare const createSnapshotStore: <T>(initial: T) => SnapshotStore<T>
declare const jsx: (component: unknown, props: Record<string, unknown>, key?: string | number) => unknown
declare const jsxs: (component: unknown, props: Record<string, unknown>, key?: string | number) => unknown
declare const Fragment: unknown
declare const useState: <T>(initial: T | (() => T)) => [T, (value: T) => void]
declare const useRef: <T>(initial: T) => { current: T }
declare const useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => void
declare const Modal: unknown
declare const Button: unknown
declare const IconDownloadOutline16: unknown
declare const MarkdownText: unknown

const SESSION_EXPORT_PATH = '/api/session.export'
const LOCALE_NAMESPACE = 'kiokuko-session-log-download'
const INITIAL_DOWNLOAD_STATE: SessionLogDownloadState = { bySession: {} }

const en = {
  'header.action': 'Session log',
  'dialog.preparingTitle': 'Exporting Session',
  'dialog.preparingDescription': 'Streaming this Session, its sub-Sessions, and attachments to a ZIP file.',
  'dialog.successTitle': 'Session export complete',
  'dialog.successDescription': 'The Session ZIP has been saved or handed to the browser download manager.',
  'dialog.errorTitle': 'Session export failed',
  'dialog.close': 'Close',
  'dialog.commandFailed': 'Could not export the Session log.',
  'review.discuss': 'Chat about it',
  'review.copy': 'Copy',
  'review.copied': 'Copied',
  'review.footnotes': 'Footnotes',
  'review.title': 'Diff review',
  'review.description': 'Review changes with repository facts and Kiokuko context.',
}

const ja: Record<keyof typeof en, string> = {
  'header.action': 'Session log',
  'dialog.preparingTitle': 'Sessionをエクスポート中',
  'dialog.preparingDescription': 'このSession、子Session、添付ファイルをZIPへストリーミングしています。',
  'dialog.successTitle': 'Sessionのエクスポート完了',
  'dialog.successDescription': 'Session ZIPを保存、またはブラウザのダウンロード処理へ渡しました。',
  'dialog.errorTitle': 'Sessionのエクスポートに失敗',
  'dialog.close': '閉じる',
  'dialog.commandFailed': 'Session logをエクスポートできませんでした。',
  'review.discuss': '相談に戻る',
  'review.copy': 'コピー',
  'review.copied': 'コピーしました',
  'review.footnotes': '脚注',
  'review.title': 'Diff レビュー',
  'review.description': '差分をリポジトリの事実と Kiokuko の文脈で確認します。',
}

const zh: Record<keyof typeof en, string> = {
  'header.action': 'Session 日志',
  'dialog.preparingTitle': '正在导出 Session',
  'dialog.preparingDescription': '正在将当前 Session、子 Session 和附件流式写入 ZIP 文件。',
  'dialog.successTitle': 'Session 导出完成',
  'dialog.successDescription': 'Session ZIP 已保存或交给浏览器下载管理器。',
  'dialog.errorTitle': 'Session 导出失败',
  'dialog.close': '关闭',
  'dialog.commandFailed': '无法导出 Session 日志。',
  'review.discuss': '继续讨论',
  'review.copy': '复制',
  'review.copied': '已复制',
  'review.footnotes': '脚注',
  'review.title': 'Diff 审查',
  'review.description': '结合仓库事实和 Kiokuko 上下文查看更改。',
}

function hostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError'
}

function sessionLogZipFilename(sessionId: string): string {
  return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/gu, '_')}.zip`
}

async function responseFailure(response: Response): Promise<Error> {
  const detail = await response.text().catch(() => '')
  return new Error(`Session export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
}

/** Browser helper that never builds a whole-log Blob in application memory. */
export async function downloadDshSessionLog(options: DshSessionDownloadOptions): Promise<'streamed' | 'navigated'> {
  const url = new URL(options.endpoint)
  url.searchParams.set('sessionId', options.sessionId)
  url.searchParams.set('includeDescendants', 'true')
  const browser = options.window ?? (globalThis as unknown as { window?: DshSessionDownloadWindow }).window
  if (browser?.showSaveFilePicker === undefined) {
    if (browser === undefined) throw new Error('browser download surface is unavailable')
    url.searchParams.set('download', '1')
    browser.location.assign(url.toString())
    return 'navigated'
  }
  const handle = await browser.showSaveFilePicker({
    suggestedName: sessionLogZipFilename(options.sessionId),
    types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
  })
  const response = await (options.fetch ?? globalThis.fetch)(url, options.signal === undefined ? {} : { signal: options.signal })
  if (!response.ok) throw await responseFailure(response)
  if (response.body === null) throw new Error('Session export returned no response stream')
  const writable = await handle.createWritable()
  await response.body.pipeTo(writable)
  return 'streamed'
}

class SessionLogDownloadController {
  readonly store = createSnapshotStore<SessionLogDownloadState>({ ...INITIAL_DOWNLOAD_STATE, bySession: {} })
  private readonly active = new Map<string, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private disposed = false

  download(sessionId: string): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const done = this.run(sessionId, abort.signal).finally(() => this.active.delete(sessionId))
    this.active.set(sessionId, { abort, done })
    return done
  }

  dismiss(sessionId: string): void {
    const current = this.store.getSnapshot().bySession[sessionId]
    if (current === undefined || !current.open) return
    this.publish(sessionId, { ...current, open: false })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.active.values()]
    for (const operation of active) operation.abort.abort()
    await Promise.allSettled(active.map(operation => operation.done))
  }

  private async run(sessionId: string, signal: AbortSignal): Promise<void> {
    this.publish(sessionId, { open: true, status: 'downloading', error: null })
    try {
      const endpoint = new URL(SESSION_EXPORT_PATH, hostBase()).toString()
      const browser = (globalThis as unknown as { window?: DshSessionDownloadWindow }).window
      if (browser?.showSaveFilePicker === undefined) {
        const probe = await fetch(`${endpoint}?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`, {
          method: 'HEAD',
          signal,
        })
        if (!probe.ok) throw await responseFailure(probe)
      }
      await downloadDshSessionLog({
        endpoint,
        sessionId,
        signal,
        ...(browser === undefined ? {} : { window: browser }),
      })
      const open = this.store.getSnapshot().bySession[sessionId]?.open ?? true
      this.publish(sessionId, { open, status: 'success', error: null })
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return
      const open = this.store.getSnapshot().bySession[sessionId]?.open ?? true
      this.publish(sessionId, { open, status: 'error', error: messageOf(error) })
    }
  }

  private publish(sessionId: string, entry: SessionLogDownloadEntry): void {
    this.store.update(state => {
      state.bySession = { ...state.bySession, [sessionId]: entry }
    })
  }
}

function SessionLogDownloadDialog(props: Record<string, unknown>): unknown {
  const sessionId = String(props.sessionId)
  const useSessionLogDownload = props.useSessionLogDownload as (selector: (state: SessionLogDownloadState) => SessionLogDownloadEntry | undefined) => SessionLogDownloadEntry | undefined
  const dismiss = props.dismiss as (sessionId: string) => void
  const t = props.t as (key: keyof typeof en) => string
  const entry = useSessionLogDownload(state => state.bySession[sessionId])
  const status = entry?.status
  const error = status === 'error' ? entry?.error || t('dialog.commandFailed') : null
  return jsx(Modal, {
    open: entry?.open === true,
    onClose: () => dismiss(sessionId),
    title: status === 'downloading'
      ? t('dialog.preparingTitle')
      : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle'),
    description: status === 'downloading'
      ? t('dialog.preparingDescription')
      : status === 'success' ? t('dialog.successDescription') : error ?? t('dialog.commandFailed'),
    closeLabel: t('dialog.close'),
    footer: jsx(Button, { variant: 'primary', onClick: () => dismiss(sessionId), children: t('dialog.close') }),
  })
}

function SessionLogDownloadHeaderAction(props: Record<string, unknown>): unknown {
  const sessionId = String(props.sessionId)
  const useSessionLogDownload = props.useSessionLogDownload as (selector: (state: SessionLogDownloadState) => SessionLogDownloadEntry | undefined) => SessionLogDownloadEntry | undefined
  const request = props.request as (sessionId: string) => void
  const t = props.t as (key: keyof typeof en) => string
  const busy = useSessionLogDownload(state => state.bySession[sessionId])?.status === 'downloading'
  return jsxs(Fragment, {
    children: [
      jsxs('button', {
        type: 'button',
        className: 'kiokuko-session-log-button',
        disabled: busy,
        'aria-busy': busy,
        onClick: () => request(sessionId),
        children: [jsx('span', { children: t('header.action') }), jsx(IconDownloadOutline16, { size: 12 })],
      }),
      jsx(SessionLogDownloadDialog, props),
    ],
  })
}

function installStyle(): () => void {
  const styleId = 'kiokuko-session-log-download-style'
  const existing = document.querySelector(`style[data-plugin-css="${styleId}"]`)
  if (existing !== null) return () => undefined
  const style = document.createElement('style')
  style.dataset.plugin = 'kiokuko-dsh'
  style.dataset.pluginCss = styleId
  style.textContent = '.kiokuko-session-log-button{border:.5px solid var(--dsw-alias-border-l4);min-width:111px;height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:transparent;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:6px 12px;font-size:13px;font-weight:400;line-height:20px;display:inline-flex}.kiokuko-session-log-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.kiokuko-session-log-button:disabled{color:var(--dsw-alias-label-dimmed);cursor:wait}.kiokuko-session-log-button span,.kiokuko-session-log-button svg{flex:none}.kiokuko-session-log-button span{white-space:nowrap}'
  document.head.appendChild(style)
  return () => style.remove()
}

export const inject = ['slots', 'locale', 'uiConversation'] as const

/** A plugin-owned result in chat, never forged as a model assistant message. */
const completionReportDefinition = {
  kind: 'kiokuko-completion-report', target: 'chat',
  match: (event: { type: string; data: { reportId?: string; text?: string } }) =>
    ['kiokuko/completion-report', 'kiokuko/execution-status', 'kiokuko/deep-report', 'kiokuko/deep-status'].includes(event.type) && typeof event.data.reportId === 'string' && typeof event.data.text === 'string'
      ? { id: event.data.reportId, role: 'start' } : null,
  start: (_context: unknown, match: { event: { type: string; seq: number; data: { text: string } } }) => ({ seq: match.event.seq, text: match.event.data.text, status: match.event.type.endsWith('status') }),
  update: (context: { state: unknown }) => context.state,
  buildViewNode: (context: { key: string; id: string; state?: { seq: number; text: string; status: boolean }; start?: { location: unknown } }) =>
    context.state === undefined ? null : {
      key: context.key, id: context.id, kind: 'kiokuko-completion-report', target: 'chat',
      anchorSeq: context.state.seq, location: context.start?.location ?? { kind: 'session' },
      visibility: 'visible', data: { text: context.state.text, status: context.state.status },
    },
}

function CompletionReport(props: Record<string, unknown>): unknown {
  const node = props.node as { data: { text: string; status?: boolean } }
  return jsx('section', { ...(node.data.status ? { role: 'status', 'aria-live': 'polite', 'aria-atomic': true } : { 'aria-label': '保存済みの回答', tabIndex: 0 }),
    style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%', minWidth: 0, padding: '12px 0', lineHeight: 1.65 }, children: node.data.text })
}

interface DeepDisplayItem { id: string; kind: 'report' | 'status'; text: string; delivered: boolean }
interface LispDisplayState { enabled: boolean; state: string; recovery?: string; error?: { message: string; recovery: string }; operations?: { id: string; state: string }[] }
/** Recovery stays available even when the model loop is stopped. */
function LispSessionStatus(props: Record<string, unknown>): unknown {
  const sessionId = String(props.sessionId)
  const [status, setStatus] = useState<LispDisplayState | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [details, setDetails] = useState('')
  const dialog = useRef<HTMLDialogElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const current = useRef(sessionId); current.current = sessionId
  const request = async (action?: string) => {
    const url = new URL('/api/kiokuko.lisp', hostBase()); url.searchParams.set('sessionId', sessionId)
    const response = await fetch(url, action ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) } : {})
    if (response.status === 404 && !action) return null
    const value = await response.json() as LispDisplayState & { message?: string; code?: string }
    if (!response.ok) throw new Error(value.message ?? 'Lisp の状態を取得できません。接続を確認してください。')
    return value
  }
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal()
    if (!open && dialog.current?.open) { dialog.current.close(); trigger.current?.focus() }
  }, [open])
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, lastState = ''
    setStatus(null); setError(''); setOpen(false); setDetails(''); setBusy(false)
    const refresh = async () => {
      try {
        const value = await request()
        if (disposed) return
        if (value) { setStatus(value); setError(''); if (value.enabled && ['RECOVERY_REQUIRED', 'STOP_UNCONFIRMED'].includes(value.state) && value.state !== lastState) setOpen(true); lastState = value.state }
        else if (lastState) setError('Lisp の接続が失われました。保護は解除されていません。プラグインを戻して /kioku-lisp status を確認してください。')
      } catch (failure) { if (!disposed && lastState) setError(messageOf(failure)) }
      finally { if (!disposed) timer = setTimeout(() => void refresh(), document.hidden ? 10000 : 2000) }
    }
    void refresh()
    return () => { disposed = true; clearTimeout(timer) }
  }, [sessionId])
  const act = async (action: string) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await request(action)
      if (current.current !== sessionId) return
      if (result?.code) setDetails(JSON.stringify(result, null, 2))
      else { setDetails(''); if (result?.state) setStatus({ ...status, ...result, enabled: result.enabled ?? status?.enabled ?? true }) }
    } catch (failure) { if (current.current === sessionId) setError(messageOf(failure)) }
    finally { if (current.current === sessionId) setBusy(false) }
  }
  if (!status?.enabled && !error) return null
  const label = ({ READY: '実行可能', SUSPENDED: '休止中（次回自動起動）', EVALUATING: '処理中', PREFLIGHT: '起動中', STOPPING: '停止中', RECOVERY_REQUIRED: '確認が必要', STOP_UNCONFIRMED: '停止未確認' } as Record<string, string>)[status?.state ?? ''] ?? '状態不明'
  return jsxs(Fragment, { children: [jsx('button', { type: 'button', ref: trigger, onClick: () => setOpen(true), children: `Lisp: ${label}` }),
    jsx('dialog', { ref: dialog, onCancel: () => setOpen(false), 'aria-label': 'Lisp の状態と復旧', style: { maxWidth: 'min(720px, 90vw)', maxHeight: '85vh' },
      children: jsxs('section', { children: [jsx('h2', { children: `Lisp: ${label}` }),
        jsx('p', { role: 'status', 'aria-live': 'polite', children: busy ? '処理しています。初回の起動には時間がかかる場合があります。' : status?.error?.message ?? '現在のセッションの状態です。' }),
        jsx('p', { children: status?.error?.recovery ?? status?.recovery ?? '' }),
        ...(error ? [jsx('p', { role: 'alert', children: error })] : []),
        ...(details ? [jsx('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, children: details })] : []),
        jsx('p', { children: '未確定の変更は自動で再実行・復元しません。詳細は /kioku-lisp diagnostics でも確認できます。' }),
        jsx('button', { type: 'button', disabled: busy, onClick: () => void act('cancel'), children: '停止する' }),
        jsx('button', { type: 'button', disabled: busy || ['STOP_UNCONFIRMED', 'SUSPENDED'].includes(status?.state ?? ''), onClick: () => void act('recover'), children: '照合して新しい Lisp を起動' }),
        jsx('button', { type: 'button', onClick: () => setOpen(false), children: '閉じる' }),
      ] }) })] })
}
/** Read-only, Session-bound display with explicit delivery acknowledgement after render. */
function DeepSessionReports(props: Record<string, unknown>): unknown {
  const sessionId = String(props.sessionId)
  const notices = props.notices === true
  const label = notices ? 'Kiokuko' : 'Deep'
  const endpoint = notices ? '/api/kiokuko.notices' : '/api/kiokuko.deep'
  const [items, setItems] = useState<DeepDisplayItem[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const seen = useRef(new Set<string>())
  const dialog = useRef<HTMLDialogElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal()
    else if (!open && dialog.current?.open) { dialog.current.close(); trigger.current?.focus() }
  }, [open])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let etag = ''
    setItems([]); setOpen(false); seen.current = new Set()
    const refresh = async () => {
      try {
        const url = new URL(endpoint, hostBase()); url.searchParams.set('sessionId', sessionId)
        const response = await fetch(url, { signal: controller.signal, headers: etag ? {'if-none-match':etag} : {} })
        if (response.status === 304) { setError(''); return }
        if (!response.ok) throw new Error(`${label}の状態を再確認できません。接続を確認してください。`)
        etag = response.headers.get('etag') ?? ''
        const data = await response.json() as {items:DeepDisplayItem[]}
        if (!Array.isArray(data.items) || data.items.some(item => typeof item.id !== 'string' || typeof item.text !== 'string')) throw new Error(`${label}の応答を読み取れません。`)
        if (controller.signal.aborted) return
        setItems(data.items); setError('')
        for (const item of data.items) if ((item.kind === 'report' || notices) && !item.delivered && !seen.current.has(item.id)) { seen.current.add(item.id); setOpen(true) }
      } catch (failure) { if (!controller.signal.aborted) setError(messageOf(failure)) }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), document.hidden ? 10_000 : 2_000) }
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [sessionId, endpoint, label, notices])
  useEffect(() => {
    const unread = items.filter(item => !item.delivered && (open || !notices && item.kind === 'status'))
    if (!unread.length) return
    const controller = new AbortController()
    const url = new URL(endpoint, hostBase()); url.searchParams.set('sessionId', sessionId)
    for (const item of unread) url.searchParams.append('id', item.id)
    let timer: ReturnType<typeof setTimeout> | undefined
    const acknowledge = async () => {
      try {
        const response = await fetch(url, {method:'POST', signal:controller.signal})
        if (!response.ok) throw new Error(`${label}の受領確認を再試行しています。回答は保持されています。`)
      } catch (failure) {
        if (!controller.signal.aborted) { setError(messageOf(failure)); timer = setTimeout(() => void acknowledge(), 5_000) }
      }
    }
    void acknowledge()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [sessionId, items, open, endpoint, label, notices])
  if (!items.length && !error) return null
  const status = items.find(item => item.kind === 'status')?.text ?? `${label}の保存済み回答`
  return jsxs(Fragment, { children: [
    jsx('button', {ref:trigger,type:'button', className:'kiokuko-session-log-button', onClick:()=>setOpen(true), 'aria-label':`${label}: ${status}`, children: items.some(item=>item.kind==='report') ? `${label}の回答` : `${label}の状態`}),
    jsx('span', {role:'status', 'aria-live':'polite', style:{position:'absolute',width:1,height:1,overflow:'hidden',clipPath:'inset(50%)'}, children:error || status.slice(0,200)}),
    jsxs('dialog', {ref:dialog,'aria-label':label,onCancel:()=>setOpen(false),onClose:()=>{setOpen(false);trigger.current?.focus()},
      style:{width:'min(48rem, calc(100vw - 2rem))',maxHeight:'calc(100dvh - 2rem)',boxSizing:'border-box',margin:'auto',padding:'20px',border:'1px solid var(--dsw-alias-border-l4, #ddd)',borderRadius:'16px',background:'var(--dsw-alias-background-primary, Canvas)',color:'var(--dsw-alias-label-primary, CanvasText)',overflow:'auto'},
      children:[jsxs('div',{style:{display:'flex',justifyContent:'space-between',gap:'16px',alignItems:'center'},children:[jsx('h2',{style:{fontSize:'20px',margin:0},children:label}),jsx('button',{type:'button',className:'kiokuko-session-log-button',onClick:()=>setOpen(false),children:'閉じる'})]}),
        jsx('p',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'},children:error || status}),
        ...items.filter(item=>item.kind==='report').map(item=>jsx('section', {key:item.id,'aria-label':'保存済みの回答',tabIndex:0,style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxWidth:'100%',padding:'12px 0',lineHeight:1.65},children:item.text}))]}),
  ] })
}

interface IntakePending {
  readonly key: string
  readonly kind: 'question' | 'plan-review'
  readonly questions: readonly [{ id: string; header: string; question: string; detail?: string; options: readonly { label: string; description?: string }[]; multiSelect?: boolean; intent?: { kind: 'plan-review'; approve: string } }]
  answer(value: { answers: [{ id: string; selected: string[]; custom?: string }] }): Promise<void>
  cancel(): Promise<void>
}

interface IntakeDraft { selected: number | null; custom: string; ordinal?: string }
const intakeDrafts = new WeakMap<object, IntakeDraft>()

interface IntakeKeyEvent {
  key: string; code?: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; repeat?: boolean;
  isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean; keyCode?: number };
  preventDefault(): void; stopPropagation(): void;
}

/** Option count a single number key addresses: the range the shortcut card covers. */
const DIGIT_ADDRESSABLE_OPTIONS = 9

const ENNO_SELECTION_QUESTIONS = [
  'enno-execution-mode', 'enno-model-source', 'enno-template', 'enno-template-provider',
  'enno-template-unavailable', 'enno-bind-provider', 'enno-model-review', 'enno-catalog-retry',
  'enno-route-provider', 'enno-route-family', 'enno-route-auth', 'enno-route-protocol',
]
const DEEP_SELECTION_QUESTIONS = [
  'deep-configuration', 'deep-budget-field', 'deep-budget-value', 'deep-role-model',
  'deep-apply-configuration', 'deep-pending-input', 'deep-uncertain',
]
function isEnnoSearchQuestion(question: IntakePending['questions'][0]): boolean {
  return question.header === '実行方式とモデル' && /^enno-(?:provider|model)-(?:ideal|zenki|goki|worker|check)$/u.test(question.id)
}
function questionInputKind(question: IntakePending['questions'][0]): 'choice' | 'search' | 'value' {
  if (isEnnoSearchQuestion(question) || (question.header === 'Deep planning' && question.id === 'deep-role-model')) return 'search'
  if (question.header === 'Deep planning' && question.id === 'deep-budget-value') return 'value'
  return 'choice'
}

/**
 * Decide whether this plugin's numbered card owns a native question carrier.
 *
 * The card claims every single-select question carrying one to nine options,
 * whoever asked it — Kiokuko's own intake, an Enno or Deep selection, another
 * plugin, or a question the model composed in chat — so a number-key plus Enter
 * shortcut is never missing from a question this composer shows. Longer catalogs
 * are claimed only by the Enno and Deep selection questions, whose typed search
 * and value flows own their own addressing. Multi-select batches, optionless
 * prompts, and multi-question batches have no single number per answer and stay
 * with the native composer.
 */
function isSupportedQuestion(question: IntakePending['questions'][0] | undefined): boolean {
  if (question === undefined || question.multiSelect === true) return false
  const options = question.options?.length ?? 0
  if (options < 1) return false
  if (options <= DIGIT_ADDRESSABLE_OPTIONS) return true
  if (question.header === '実行方式とモデル' && (ENNO_SELECTION_QUESTIONS.includes(question.id) || isEnnoSearchQuestion(question))) return true
  if (question.header === 'Deep planning' && DEEP_SELECTION_QUESTIONS.includes(question.id)) return true
  return false
}

function intakePending(props: Record<string, unknown>): IntakePending | null {
  const pending = props.pendingInteraction as IntakePending | undefined
  if (!pending || pending.questions?.length !== 1 || typeof pending.answer !== 'function' || typeof pending.cancel !== 'function') return null
  const question = pending.questions[0]
  if (!isSupportedQuestion(question)) return null
  if (pending.kind === 'question') return pending
  return pending.kind === 'plan-review' && question.intent?.kind === 'plan-review'
    && typeof question.detail === 'string' && question.options.length <= 2
    && question.options.some(option => option.label === question.intent!.approve) ? pending : null
}

/**
 * Native pending carrier, plugin-only presentation. The card answers through the
 * carrier's own protocol, so claiming a question does not change what the asker
 * receives — only how the option can be chosen.
 */
function IntakeQuestion(props: Record<string, unknown>): unknown {
  const pending = props.matched as IntakePending
  const t = props.t as (key: string) => string
  return jsx(IntakeQuestionCard, { key: pending.key, pending,
    ...(pending.kind === 'plan-review' ? { reviewCopy: { discuss: t('review.discuss'),
      labels: { code: { copyLabel: t('review.copy'), copiedLabel: t('review.copied') }, footnotes: t('review.footnotes') } } } : {}),
  })
}

function IntakeQuestionCard(props: Record<string, unknown>): unknown {
  const pending = props.pending as IntakePending
  const reviewing = pending.kind === 'plan-review'
  const reviewCopy = props.reviewCopy as { discuss: string; labels: unknown } | undefined
  const original = pending.questions[0]
  // The review's first choice cancels back to discussion. Other choices retain
  // the host's exact labels; approval stays last, even if supplied first.
  const question = reviewing ? { ...original, options: [
    { label: reviewCopy!.discuss },
    ...original.options.filter(option => option.label !== original.intent!.approve),
    ...original.options.filter(option => option.label === original.intent!.approve),
  ] } : original
  const inputKind = questionInputKind(question)
  const mac = /Mac|iPhone|iPad|iPod/u.test(globalThis.navigator?.platform ?? '')
  const userAgent = globalThis.navigator?.userAgent ?? ''
  const safari = mac && /Safari\//u.test(userAgent) && !/(?:Chrome|Chromium|CriOS|Edg|OPR)\//u.test(userAgent)
  const controlShortcut = !mac || safari
  const shortcutModifier = controlShortcut ? 'Ctrl' : 'Cmd'
  const [draft, setDraft] = useState<IntakeDraft>(() => intakeDrafts.get(pending) ?? { selected: null, custom: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const card = useRef<HTMLElement | null>(null)
  const optionElements = useRef<Array<HTMLElement | null>>([])
  useEffect(() => {
    mounted.current = true
    card.current?.focus()
    return () => { mounted.current = false }
  }, [pending])
  useEffect(() => {
    if (draft.selected !== null) optionElements.current[draft.selected]?.scrollIntoView({ block: 'nearest' })
  }, [draft.selected])
  const update = (value: IntakeDraft) => {
    if (inFlight.current) return
    intakeDrafts.set(pending, value)
    setDraft(value)
    setError('')
  }
  const settle = (cancel = false) => {
    if (inFlight.current) return
    // Read the synchronous draft: a digit and Enter can arrive before React rerenders.
    const current = intakeDrafts.get(pending) ?? draft
    let custom = current.custom.trim()
    let selected = current.selected
    if (!cancel && selected === null && custom === '') {
      setError(reviewing ? '選択肢を選んでから確定してください。' : '選択肢を選ぶか、自由入力してください。')
      return
    }
    if (!cancel && !reviewing && inputKind === 'choice' && /^[0-9０-９]+$/u.test(custom)) {
      const ordinal = Number(custom.normalize('NFKC'))
      if (ordinal < 1 || ordinal > question.options.length) {
        setError(`番号は1〜${question.options.length}で入力してください。`)
        return
      }
      selected = ordinal - 1
      custom = ''
    }
    inFlight.current = true
    setBusy(true)
    setError('')
    // Enter is a separate confirmation. Typing, key-repeat and IME cannot submit twice.
    void Promise.resolve().then(() => cancel || (reviewing && selected === 0) ? pending.cancel() : pending.answer({ answers: [{
      id: question.id,
      selected: selected === null ? [] : [question.options[selected]!.label],
      ...(custom ? { custom } : {}),
    }] })).then(() => { intakeDrafts.delete(pending) }).catch(cause => {
      if (!mounted.current) return
      inFlight.current = false
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  const selectShortcut = (event: IntakeKeyEvent) => {
    if (busy || inFlight.current || event.repeat || event.isComposing || event.keyCode === 229
      || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229 || event.altKey || event.shiftKey
      || !(controlShortcut ? event.ctrlKey && !event.metaKey : event.metaKey && !event.ctrlKey)) return false
    const digit = /^(?:Digit|Numpad)([1-9])$/u.exec(event.code ?? '')?.[1] ?? event.key
    if (!/^[1-9]$/u.test(digit) || Number(digit) > question.options.length) return false
    event.preventDefault(); event.stopPropagation()
    update({ selected: Number(digit) - 1, custom: '' })
    card.current?.focus()
    return true
  }
  useEffect(() => {
    const element = card.current
    const owner = element?.ownerDocument
    if (!owner) return
    // Capture before the host's composer handlers, even if it has moved focus.
    // Only the visible, mounted question owns these modified shortcuts.
    const listener = (event: KeyboardEvent) => {
      if (element.isConnected && element.getClientRects().length > 0) selectShortcut(event)
    }
    owner.addEventListener('keydown', listener, true)
    return () => owner.removeEventListener('keydown', listener, true)
  }, [pending, busy, controlShortcut])
  const keyDown = (event: IntakeKeyEvent & { target?: { tagName?: string; isContentEditable?: boolean } }) => {
    if (selectShortcut(event)) return
    if (busy || inFlight.current || event.repeat || event.isComposing || event.keyCode === 229 || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229
      || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    const editing = event.target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName ?? '')
    const current = intakeDrafts.get(pending) ?? draft
    if (!editing && (/^[0-9]$/u.test(event.key) || (event.key === 'Backspace' && current.ordinal))) {
      const multipleDigits = question.options.length > 9
      if (!multipleDigits && (!/^[1-9]$/u.test(event.key) || Number(event.key) > question.options.length)) return
      event.preventDefault(); event.stopPropagation()
      const ordinal = event.key === 'Backspace' ? current.ordinal!.slice(0, -1) : multipleDigits ? (current.ordinal ?? '') + event.key : event.key
      const index = Number(ordinal) - 1
      const valid = ordinal !== '' && index >= 0 && index < question.options.length
      update({ selected: valid ? index : null, custom: '', ordinal })
      if (ordinal && !valid) setError(`番号「${ordinal}」は範囲外です。1〜${question.options.length}で入力してください。Backspaceで訂正できます。`)
      card.current?.focus()
    } else if (event.key === 'Enter' && event.target?.tagName !== 'BUTTON' && !event.target?.isContentEditable) {
      event.preventDefault(); event.stopPropagation()
      settle()
    }
  }
  const titleId = `kiokuko-intake-${pending.key}`
  return jsxs('section', {
    className: 'kiokuko-intake', tabIndex: 0, ref: (element: HTMLElement | null) => { card.current = element },
    'aria-labelledby': titleId, 'aria-busy': busy, onKeyDown: keyDown,
    children: [
      jsxs('header', { children: [jsx('h2', { id: titleId, children: question.question }),
        jsx('button', { type: 'button', disabled: busy, onClick: () => settle(true), 'aria-label': '質問を閉じる', children: '閉じる' })] }),
      jsxs('div', { className: 'kiokuko-intake-body', children: [
        reviewing ? jsx(MarkdownText, { text: question.detail, labels: reviewCopy!.labels })
          : question.detail ? jsx('p', { children: question.detail }) : null,
        jsx('p', { children: question.options.length > 9
          ? `${shortcutModifier}+1〜9で選択、Enterで確定。10以上は番号（1〜${question.options.length}）を数字で続けて入力、Backspaceで訂正できます。`
          : `${shortcutModifier}+1〜${question.options.length}で選択、Enterで確定。` }),
        jsx('div', { 'aria-label': '選択肢', children: question.options.map((option, index) => jsxs('button', {
          key: index, type: 'button', className: 'kiokuko-intake-option', disabled: busy,
          ref: (element: HTMLElement | null) => { optionElements.current[index] = element },
          'aria-pressed': draft.selected === index,
          ...(index < 9 ? { 'aria-keyshortcuts': `${question.options.length <= 9 ? `${index + 1} ` : ''}${controlShortcut ? 'Control' : 'Meta'}+${index + 1}` } : {}),
          onClick: () => update({ selected: index, custom: '' }),
          onKeyDown: (event: IntakeKeyEvent) => {
            if (event.key !== 'Enter' || event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229 || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229 || (intakeDrafts.get(pending) ?? draft).selected !== index) return
            event.preventDefault(); event.stopPropagation(); settle()
          },
          children: [jsx('strong', { children: `${index + 1}. ${option.label}` }), option.description ? jsx('span', { children: option.description }) : null,
            jsx('kbd', { className: 'kiokuko-intake-shortcut', 'aria-hidden': true, children: index < 9 ? `${shortcutModifier}+${index + 1}` : `${index + 1} → Enter` })],
        })) }),
        !reviewing ? jsx('label', { htmlFor: `${titleId}-custom`, children: inputKind === 'search' ? '検索（Enterで検索・数字も検索語として入力できます）' : inputKind === 'value' ? '値を入力（Enterで確定）' : '自由入力（任意）' }) : null,
        inputKind === 'choice' && question.header === '実行方式とモデル'
          ? jsx('p', { children: '選択肢に当てはまらない内容はAIに渡し、会話に戻ります。実行方式やモデル構成は確定しません。' }) : null,
        !reviewing ? jsx('textarea', { id: `${titleId}-custom`, rows: 1, disabled: busy, value: draft.custom,
          onChange: (event: { target: { value: string } }) => update({ selected: null, custom: event.target.value }),
        }) : null,
      ] }),
      jsxs('footer', { children: [
        jsx('span', { role: 'status', 'aria-live': 'polite', children: error || (busy ? '送信中…' : draft.selected === null ? '' : `${draft.selected + 1}. ${question.options[draft.selected]!.label}を選択中`) }),
        jsx('button', { type: 'button', disabled: busy || (draft.selected === null && !draft.custom.trim()), onClick: () => settle(), children: '確定（Enter）' }),
      ] }),
    ],
  })
}

function installIntakeStyle(): (() => void) | undefined {
  if (typeof document === 'undefined') return undefined
  const style = document.createElement('style')
  style.textContent = `
.kiokuko-intake{box-sizing:border-box;width:100%;max-width:680px;align-self:center;margin-inline:auto;border:1px solid var(--dsw-alias-border-l4,#bbb);border-radius:12px;padding:12px;background:var(--dsw-alias-background-primary,Canvas);color:var(--dsw-alias-label-primary,CanvasText);display:flex;flex-direction:column;min-height:0;max-height:min(480px,70dvh);gap:8px;font-size:14px}
.kiokuko-intake header,.kiokuko-intake footer{display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex-shrink:0}
.kiokuko-intake h2{font-size:16px;line-height:1.4;margin:0;flex:1}
.kiokuko-intake-body{overflow:auto;min-height:0;display:flex;flex-direction:column;gap:8px}
.kiokuko-intake p{margin:0;white-space:pre-wrap;line-height:1.4;font-size:12px}
.kiokuko-intake button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l4,#bbb);border-radius:8px;padding:8px 10px;min-height:40px;cursor:pointer}
.kiokuko-intake button:disabled{cursor:default;opacity:.6}
.kiokuko-intake-option{display:grid;grid-template-columns:minmax(0,1fr) max-content;width:100%;text-align:left;gap:4px 12px;margin-bottom:6px;overflow-wrap:anywhere}
.kiokuko-intake-option strong,.kiokuko-intake-option span{grid-column:1}
.kiokuko-intake-shortcut{grid-column:2;grid-row:1 / span 2;align-self:center;font-family:inherit;font-size:11px;line-height:1.4;white-space:nowrap}
.kiokuko-intake-option:last-child{margin-bottom:0}
.kiokuko-intake-option[aria-pressed=true]{border-color:var(--dsw-alias-label-primary,CanvasText);box-shadow:inset 0 0 0 1px currentColor;background:var(--dsw-alias-interactive-bg-hover,#eee)}
.kiokuko-intake-option span{font-size:12px;line-height:1.4}
.kiokuko-intake label{font-size:12px}
.kiokuko-intake textarea{box-sizing:border-box;width:100%;min-height:36px;max-height:96px;resize:vertical;font:inherit;line-height:1.4;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l4,#bbb);padding:8px;border-radius:8px}
.kiokuko-intake :focus-visible,.kiokuko-intake:focus-visible{outline:2px solid Highlight;outline-offset:2px}
.kiokuko-intake footer [role=status]{flex:1;min-width:0;font-size:12px;overflow-wrap:anywhere}
`
  document.head.appendChild(style)
  return () => style.remove()
}

type ReviewMode = 'current' | 'staged' | 'unstaged' | 'turn'
interface ReviewFileView { fileId: string; layer: string; displayPath: string; kind: string; reason?: string; newDigest?: string; hunks: { id: string; oldStart: number; newStart: number; lines: string[] }[] }
interface ReviewView { reviewId: string; state: string; freshness: string; summary?: string; errors: string[]; claims: { text: string; evidenceIds: string[]; confidence: string; unverifiedAssumptions: string[]; anchor?: { fileId: string; hunkId: string; side: string; startLine: number } }[];
  analysis?: { overallRisk: string; impact: string[]; breakingChanges: string[]; testGaps: string[]; memoryConflicts: string[]; assumptions: string[] };
  analyzedFileIds: string[]; unanalyzedFileIds: string[]; excludedFileIds?: string[];
  context: { source: string; memory: string; task?: string; reviewInput?: string; reason?: string; execution?: { command: string; status: string; snapshotMatch: string }[]; candidates?: { runId: string; task: string; status: string }[] };
  snapshot: { snapshotId: string; capturedAt: string; mode: string; turnSeq?: number; totalFiles: number; files: ReviewFileView[] } }
interface ReviewSessionView { loading: boolean; busy: boolean; cancelling: boolean; error: string; availability: string; modelAvailability: string; models: { provider: string; model: string }[];
  untracked: string[]; turns: number[]; review?: ReviewView | undefined; mode: ReviewMode; turnSeq?: number | undefined; selected: string[]; selectedUntracked: string[];
  modelKey: string; purpose: string; runId: string; activeFileId: string; fileListOpen: boolean }
interface ReviewClientState { bySession: Record<string, ReviewSessionView | undefined> }
const REVIEW_NS = 'kiokuko-session-log-download'
const REVIEW_KIND = 'kiokuko-diff-review'
const REVIEW_TAB_ID = 'kiokuko-dsh/diff-review'
const REVIEW_ERRORS: Record<string, string> = {
  repository_changed: '差分の取得中または取得後に変更がありました。取得し直してください。',
  file_changed: '現在のファイルは取得済みの差分と一致しません。差分内の内容を確認してください。',
  file_link_unavailable: 'この差分から現在のファイルへは移動できません。',
  turn_snapshot_unavailable: 'このターンの差分記録は利用できません。現在の差分を選んで取得してください。',
  repo_unavailable: 'このセッションの Git リポジトリを確認できません。',
  session_unavailable: '選択中のセッションを確認できません。開き直してください。',
  session_workspace_mismatch: 'セッションと作業場所が一致しません。',
  diff_too_large: '差分が上限を超えました。対象を絞って取得してください。',
  git_timeout: 'Git の読み取りが時間内に終わりませんでした。',
  git_unavailable: 'Git の読み取りサービスを利用できません。',
  model_unavailable: '選択したモデルを利用できません。モデルの設定を確認してください。',
  analysis_in_progress: 'このセッションでは分析が進行中です。完了または停止後に再試行してください。',
  capture_in_progress: '差分を取得中です。完了後に再試行してください。',
  review_expired: '結果の保存期間が過ぎました。差分を取得し直してください。',
  unmerged_conflict: '競合中のファイルがあります。解決してから分析してください。',
  unsafe_review_input: 'レビューの目的に秘密情報らしい内容があります。削除して再試行してください。',
  analysis_timeout: '分析が時間内に終わりませんでした。取得済みの差分は表示しています。',
  provider_failure: 'モデルへの接続に失敗しました。取得済みの差分は表示しています。',
  invalid_model_json: 'モデルの出力を読み取れませんでした。取得済みの差分は表示しています。',
  invalid_model_schema: 'モデルの出力形式が一致しません。取得済みの差分は表示しています。',
  model_incomplete: 'モデルの回答が完了しませんでした。取得済みの差分は表示しています。',
  invalid_evidence_reference: '存在しない根拠を参照する説明を除外しました。',
  context_limit: '文脈が入力上限を超え、分析できませんでした。',
  chunk_or_hunk_limit: '入力上限により一部の変更を分析していません。',
  cancelled: '分析を停止しました。取得済みの差分は表示しています。',
}

function reviewErrorMessage(code: string): string { return REVIEW_ERRORS[code] ?? `レビューを続行できません（${code}）。` }
const REVIEW_STATES: Record<string, string> = { 'facts-only': '差分のみ', analyzing: '分析中', analyzed: '分析完了', partial: '一部未分析', cancelled: '停止', failed: '分析失敗' }
const REVIEW_CONTEXT_SOURCES: Record<string, string> = { 'current-run': '実行中のタスク', 'completed-run': '完了済みタスク', 'review-input': '利用者入力', unavailable: '取得不可' }
const REVIEW_MEMORY_STATES: Record<string, string> = { available: '取得済み', empty: '該当なし', unavailable: '取得不可', withheld: '保留', mismatch: '不一致' }
const REVIEW_FRESHNESS: Record<string, string> = { current: '現在と一致', stale: '取得後に変更あり', unknown: '現在との一致は未確認' }

function initialReviewSession(): ReviewSessionView {
  return { loading: false, busy: false, cancelling: false, error: '', availability: 'unknown', modelAvailability: 'unknown', models: [], untracked: [], turns: [], mode: 'current',
    selected: [], selectedUntracked: [], modelKey: '', purpose: '', runId: '', activeFileId: '', fileListOpen: true }
}

function matchesReviewMode(review: ReviewView | undefined, mode: ReviewMode, turnSeq: number | undefined): boolean {
  return review?.snapshot.mode === mode && (mode !== 'turn' || review.snapshot.turnSeq === turnSeq)
}

class DiffReviewClientController {
  readonly store = createSnapshotStore<ReviewClientState>({ bySession: {} })
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly generations = new Map<string, number>()
  private closed = false

  private nextGeneration(sessionId: string): number {
    const next = (this.generations.get(sessionId) ?? 0) + 1
    this.generations.set(sessionId, next)
    return next
  }

  private current(sessionId: string): ReviewSessionView { return this.store.getSnapshot().bySession[sessionId] ?? initialReviewSession() }
  private publish(sessionId: string, next: ReviewSessionView): void {
    if (this.closed) return
    this.store.update(state => { state.bySession = { ...state.bySession, [sessionId]: next } })
  }
  change(sessionId: string, changes: Partial<ReviewSessionView>): void { this.publish(sessionId, { ...this.current(sessionId), ...changes }) }

  private url(sessionId: string, reviewId?: string): URL {
    const url = new URL('/api/kiokuko.diff-review', hostBase())
    url.searchParams.set('sessionId', sessionId)
    if (reviewId) url.searchParams.set('reviewId', reviewId)
    return url
  }

  private async json(url: URL, body?: object): Promise<Record<string, unknown>> {
    let response: Response
    try { response = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }
    catch { throw new Error('DSH に接続できません。接続を確認して再試行してください。') }
    let value: Record<string, unknown>
    try { value = await response.json() as Record<string, unknown> }
    catch { throw new Error('DSH の応答を読み取れません。再試行してください。') }
    if (!response.ok) throw new Error(typeof value.code === 'string' ? reviewErrorMessage(value.code) : `HTTP ${response.status}`)
    return value
  }

  async load(sessionId: string): Promise<void> {
    const generation = this.nextGeneration(sessionId)
    this.change(sessionId, { loading: true, error: '' })
    try {
      const response = await this.json(this.url(sessionId))
      if (this.generations.get(sessionId) !== generation) return
      const review = response.review as ReviewView | undefined
      const models = response.models as ReviewSessionView['models'] ?? []
      const modelKeys = models.map(item => JSON.stringify([item.provider, item.model]))
      const current = this.current(sessionId)
      const untracked = response.untracked as string[] ?? []
      this.change(sessionId, { loading: false, busy: review?.state === 'analyzing', cancelling: false,
        availability: String(response.availability), modelAvailability: String(response.modelAvailability ?? 'unknown'), models, review,
        untracked, selectedUntracked: current.selectedUntracked.filter(path => untracked.includes(path)), turns: response.turns as number[] ?? [],
        ...(review ? { selected: current.review?.reviewId === review.reviewId ? current.selected.filter(id => review.snapshot.files.some(file => file.fileId === id && file.kind === 'text')) : review.snapshot.files.filter(file => file.kind === 'text').map(file => file.fileId),
          activeFileId: current.review?.reviewId === review.reviewId && review.snapshot.files.some(file => file.fileId === current.activeFileId) ? current.activeFileId : review.snapshot.files[0]?.fileId || '' } : {}),
        modelKey: modelKeys.includes(current.modelKey) ? current.modelKey : '',
        error: !review && current.review ? '保存期間が過ぎました。差分を取得し直してください。' : '' })
      if (review?.state === 'analyzing') this.poll(sessionId, review.reviewId)
    } catch (error) { if (this.generations.get(sessionId) === generation) this.change(sessionId, { loading: false, busy: false, error: messageOf(error) }) }
  }

  async capture(sessionId: string): Promise<void> {
    const current = this.current(sessionId)
    if (current.busy || current.loading || current.cancelling || current.review?.state === 'analyzing') return
    const generation = this.nextGeneration(sessionId)
    this.change(sessionId, { busy: true, error: '' })
    try {
      const review = await this.json(this.url(sessionId), { action: 'capture', sessionId, mode: current.mode,
        ...(current.mode === 'turn' ? { turnSeq: current.turnSeq } : {}), untracked: current.selectedUntracked, requestId: crypto.randomUUID() }) as unknown as ReviewView
      if (this.generations.get(sessionId) !== generation) return
      this.change(sessionId, { loading: false, busy: false, review, selected: review.snapshot.files.filter(file => file.kind === 'text').map(file => file.fileId),
        activeFileId: review.snapshot.files[0]?.fileId ?? '', fileListOpen: false })
      await this.load(sessionId)
    } catch (error) { if (this.generations.get(sessionId) === generation) this.change(sessionId, { loading: false, busy: false, error: messageOf(error) }) }
  }

  async analyze(sessionId: string): Promise<void> {
    const current = this.current(sessionId)
    if (current.busy || current.loading || current.cancelling || !current.review || !matchesReviewMode(current.review, current.mode, current.turnSeq) || current.review.state === 'analyzing' || !current.selected.length || !current.modelKey) return
    let provider: string, model: string
    try { [provider, model] = JSON.parse(current.modelKey) as [string, string] }
    catch { return }
    if (!provider || !model) return
    const generation = this.nextGeneration(sessionId)
    this.change(sessionId, { busy: true, error: '' })
    try {
      const review = await this.json(this.url(sessionId), { action: 'analyze', sessionId, reviewId: current.review.reviewId,
        requestId: crypto.randomUUID(), selectedFileIds: current.selected, provider, model,
        ...(current.purpose.trim() ? { purpose: current.purpose.trim() } : {}), ...(current.runId ? { runId: current.runId } : {}) }) as unknown as ReviewView
      if (this.generations.get(sessionId) !== generation) return
      this.change(sessionId, { loading: false, review })
      this.poll(sessionId, review.reviewId)
    } catch (error) { if (this.generations.get(sessionId) === generation) this.change(sessionId, { busy: false, error: messageOf(error) }) }
  }

  private poll(sessionId: string, reviewId: string): void {
    clearTimeout(this.timers.get(sessionId))
    const generation = this.generations.get(sessionId)
    const tick = async () => {
      try {
        const review = await this.json(this.url(sessionId, reviewId)) as unknown as ReviewView
        if (this.generations.get(sessionId) !== generation || this.current(sessionId).review?.reviewId !== reviewId || this.current(sessionId).cancelling) return
        this.change(sessionId, { review, busy: review.state === 'analyzing', error: '' })
        if (review.state === 'analyzing') this.timers.set(sessionId, setTimeout(() => void tick(), document.hidden ? 5000 : 1000))
      } catch (error) {
        if (this.generations.get(sessionId) === generation && this.current(sessionId).review?.reviewId === reviewId && !this.current(sessionId).cancelling) {
          this.change(sessionId, { busy: false, error: messageOf(error) })
        }
      }
    }
    this.timers.set(sessionId, setTimeout(() => void tick(), 500))
  }

  async refreshReview(sessionId: string, reviewId: string): Promise<void> {
    const generation = this.nextGeneration(sessionId)
    clearTimeout(this.timers.get(sessionId))
    this.change(sessionId, { loading: true, error: '' })
    try {
      const review = await this.json(this.url(sessionId, reviewId)) as unknown as ReviewView
      if (this.generations.get(sessionId) === generation && this.current(sessionId).review?.reviewId === reviewId) {
        this.change(sessionId, { loading: false, busy: review.state === 'analyzing', review, error: '' })
        if (review.state === 'analyzing') this.poll(sessionId, reviewId)
      }
    } catch (error) {
      if (this.generations.get(sessionId) === generation && this.current(sessionId).review?.reviewId === reviewId) this.change(sessionId, { loading: false, busy: false, error: messageOf(error) })
    }
  }

  async cancel(sessionId: string, reviewId: string): Promise<void> {
    if (this.current(sessionId).cancelling || this.current(sessionId).review?.reviewId !== reviewId) return
    const generation = this.nextGeneration(sessionId)
    clearTimeout(this.timers.get(sessionId))
    this.change(sessionId, { loading: false, cancelling: true, error: '' })
    try {
      const review = await this.json(this.url(sessionId), { action: 'cancel', sessionId, reviewId }) as unknown as ReviewView
      if (this.generations.get(sessionId) === generation && this.current(sessionId).review?.reviewId === reviewId) this.change(sessionId, { review, busy: false, cancelling: false, error: '' })
    } catch (error) {
      if (this.generations.get(sessionId) === generation && this.current(sessionId).review?.reviewId === reviewId) this.change(sessionId, { busy: false, cancelling: false, error: messageOf(error) })
    }
  }

  exportUrl(sessionId: string, reviewId: string, format: 'markdown' | 'json'): string {
    const url = this.url(sessionId, reviewId)
    url.searchParams.set('format', format)
    return url.toString()
  }

  async openCurrentFile(sessionId: string, reviewId: string, fileId: string, openFile: (address: string) => boolean): Promise<void> {
    try {
      const url = this.url(sessionId, reviewId)
      url.searchParams.set('format', 'file-link')
      url.searchParams.set('fileId', fileId)
      const response = await this.json(url)
      if (typeof response.address !== 'string' || !response.address.startsWith('dsh-resource://file/session/') || !openFile(response.address)) {
        throw new Error('ファイルタブを開けません。取得済みの差分を確認してください。')
      }
    } catch (error) { this.change(sessionId, { error: messageOf(error) }) }
  }

  async dispose(): Promise<void> {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

function SnapshotDiff(props: { file: ReviewFileView; snapshotId: string }): unknown {
  return jsxs('div', { className: 'kiokuko-review-diff', children: props.file.hunks.map(hunk => {
    let oldLine = hunk.oldStart, newLine = hunk.newStart
    return jsxs('section', { id: `kiokuko-review-${props.file.fileId}-${hunk.id}`, tabIndex: -1, children: [
      jsx('h4', { children: `@@ -${hunk.oldStart} +${hunk.newStart} @@` }),
      jsx('pre', { children: hunk.lines.map((line, index) => {
        const prefix = line[0]
        const old = prefix === '+' || prefix === '\\' ? '' : String(oldLine++)
        const next = prefix === '-' || prefix === '\\' ? '' : String(newLine++)
        return jsx('div', { className: prefix === '+' ? 'added' : prefix === '-' ? 'removed' : '', tabIndex: -1,
          'data-snapshot-id': props.snapshotId, 'data-file-id': props.file.fileId, 'data-hunk-id': hunk.id,
          ...(old ? { 'data-old-line': old } : {}), ...(next ? { 'data-new-line': next } : {}),
          children: `${old.padStart(5)} ${next.padStart(5)} ${line}` }, index)
      }) }),
    ] }, hunk.id)
  }) })
}

function DiffReviewTab(props: Record<string, unknown>): unknown {
  const sessionId = String(props.sessionId)
  const useReview = props.useDiffReview as (selector: (state: ReviewClientState) => ReviewSessionView | undefined) => ReviewSessionView | undefined
  const controller = props.reviewController as DiffReviewClientController
  const openFile = props.openCurrentFile as (address: string) => boolean
  const useTabInfo = props.useTabInfo as () => { tab: { signal: AbortSignal; visible: boolean } }
  const { tab } = useTabInfo()
  const state = useReview(value => value.bySession[sessionId]) ?? initialReviewSession()
  const wasVisible = useRef(tab.visible)
  useEffect(() => { void controller.load(sessionId) }, [sessionId])
  useEffect(() => {
    if (tab.visible && !wasVisible.current && state.review) void controller.refreshReview(sessionId, state.review.reviewId)
    wasVisible.current = tab.visible
  }, [sessionId, tab.visible, state.review?.reviewId])
  useEffect(() => {
    const onClose = () => { const review = controller.store.getSnapshot().bySession[sessionId]?.review; if (review?.state === 'analyzing') void controller.cancel(sessionId, review.reviewId) }
    tab.signal.addEventListener('abort', onClose, { once: true })
    return () => tab.signal.removeEventListener('abort', onClose)
  }, [sessionId, tab.signal])
  const review = state.review
  const reviewMatchesSelection = matchesReviewMode(review, state.mode, state.turnSeq)
  const active = review?.snapshot.files.find(file => file.fileId === state.activeFileId) ?? review?.snapshot.files[0]
  const selectFile = (fileId: string) => controller.change(sessionId, { selected: state.selected.includes(fileId)
    ? state.selected.filter(id => id !== fileId) : [...state.selected, fileId] })
  const visitEvidence = (id: string, anchor?: { fileId: string; hunkId: string; side: string; startLine: number }) => {
    const [fileId, hunkId] = id.split(':')
    if (!fileId || !review?.snapshot.files.some(file => file.fileId === fileId)) return
    controller.change(sessionId, { activeFileId: fileId, fileListOpen: false })
    requestAnimationFrame(() => {
      if (!hunkId) { document.getElementById(`kiokuko-review-${review.reviewId}-detail`)?.focus(); return }
      const section = document.getElementById(`kiokuko-review-${fileId}-${hunkId}`)
      const line = anchor?.fileId === fileId && anchor.hunkId === hunkId
        ? [...(section?.querySelectorAll<HTMLElement>('[data-old-line],[data-new-line]') ?? [])].find(element =>
          element.dataset[anchor.side === 'old' ? 'oldLine' : 'newLine'] === String(anchor.startLine)) : undefined
      const target = line ?? section
      target?.focus({ preventScroll: true })
      target?.scrollIntoView({ block: 'center' })
    })
  }
  const analysisGroups: { label: string; items: string[] }[] = review?.analysis ? [
    { label: '影響', items: review.analysis.impact },
    { label: '破壊的変更', items: review.analysis.breakingChanges },
    { label: 'テストの不足', items: review.analysis.testGaps },
    { label: '過去判断との不一致', items: review.analysis.memoryConflicts },
    { label: '仮定', items: review.analysis.assumptions },
  ] : []
  return jsxs('section', { className: 'kiokuko-review', 'aria-label': 'Diff レビュー', children: [
    jsx('h2', { children: 'Diff レビュー' }),
    jsxs('div', { className: 'kiokuko-review-controls', children: [
      jsxs('label', { children: ['比較対象', jsx('select', { value: state.mode, onChange: (event: { target: { value: ReviewMode } }) => controller.change(sessionId, { mode: event.target.value }), children: [
        jsx('option', { value: 'current', children: '未コミット全体' }), jsx('option', { value: 'staged', children: 'ステージ済み' }),
        jsx('option', { value: 'unstaged', children: '未ステージ' }), jsx('option', { value: 'turn', children: 'このターン' }),
      ] })] }),
      ...(state.mode === 'turn' ? [jsxs('label', { children: ['ターン差分', jsx('select', { value: String(state.turnSeq ?? ''), onChange: (event: { target: { value: string } }) => controller.change(sessionId, { turnSeq: event.target.value === '' ? undefined : Number(event.target.value) }),
        children: [jsx('option', { value: '', children: '選択' }), ...state.turns.map(seq => jsx('option', { value: String(seq), children: `seq ${seq}` }, seq))] })] }, 'turn')] : []),
      jsx('button', { type: 'button', disabled: state.busy || state.loading || state.cancelling || review?.state === 'analyzing' || state.mode === 'turn' && state.turnSeq === undefined, onClick: () => void controller.capture(sessionId), children: review ? '取得し直す' : '差分を取得' }),
      review ? jsx('button', { type: 'button', disabled: state.loading || state.cancelling || state.busy && review.state !== 'analyzing', onClick: () => void controller.refreshReview(sessionId, review.reviewId), children: '状態を確認' }) : null,
    ] }),
    state.untracked.length ? jsxs('fieldset', { children: [jsx('legend', { children: '未追跡ファイル（明示選択）' }), ...state.untracked.map(path => jsxs('label', { children: [jsx('input', { type: 'checkbox', checked: state.selectedUntracked.includes(path), onChange: () => controller.change(sessionId, { selectedUntracked: state.selectedUntracked.includes(path) ? state.selectedUntracked.filter(item => item !== path) : [...state.selectedUntracked, path] }) }), path] }, path))] }) : null,
    jsx('p', { role: 'status', 'aria-live': 'polite', children: state.cancelling ? '分析を停止中' : state.loading ? '確認中' : state.busy ? '処理中' : state.error || (state.availability === 'repo_unavailable' ? 'Git リポジトリを確認できません' : '') }),
    review ? jsxs(Fragment, { children: [
      jsx('p', { children: `${review.snapshot.capturedAt} / ${review.snapshot.mode} / ${REVIEW_STATES[review.state] ?? review.state} / 鮮度: ${REVIEW_FRESHNESS[review.freshness] ?? review.freshness}` }),
      jsx('p', { children: `文脈: ${REVIEW_CONTEXT_SOURCES[review.context.source] ?? review.context.source} / メモリ: ${REVIEW_MEMORY_STATES[review.context.memory] ?? review.context.memory}${review.context.reason ? ` (${review.context.reason})` : ''}` }),
      review.context.task ? jsx('p', { children: `タスク: ${review.context.task}` }) : null,
      review.context.reviewInput ? jsx('p', { children: `このレビューの目的（利用者入力）: ${review.context.reviewInput}` }) : null,
      ...(review.context.candidates?.length ? [jsxs('label', { children: ['タスク', jsx('select', { value: state.runId, onChange: (event: { target: { value: string } }) => controller.change(sessionId, { runId: event.target.value }), children: [jsx('option', { value: '', children: '指定なし' }), ...review.context.candidates.map(item => jsx('option', { value: item.runId, children: `${item.task} (${item.status})` }, item.runId))] })] }, 'runs')] : []),
      jsx('p', { children: `変更ファイル: ${review.snapshot.files.length} / ${review.snapshot.totalFiles}` }),
      review.snapshot.totalFiles > review.snapshot.files.length ? jsx('p', { role: 'status', children: `${review.snapshot.totalFiles - review.snapshot.files.length} 件は取得上限で未収集です。全体リスクは未確定です。` }) : null,
      jsx('p', { children: `送信対象: ${state.selected.length} ファイル / ${review.snapshot.files.filter(file => file.kind !== 'text').length} ファイルはテキスト分析対象外` }),
      !reviewMatchesSelection ? jsx('p', { role: 'status', children: '比較対象を変更しました。「取得し直す」で新しい差分を確認してください。' }) : null,
      !state.selected.length ? jsx('p', { role: 'status', children: review.snapshot.files.some(file => file.kind === 'text')
        ? '分析するテキストファイルを変更ファイル一覧で選択してください。' : '分析できるテキストファイルがありません。差分は引き続き確認できます。' }) : null,
      jsxs('div', { className: 'kiokuko-review-analysis-controls', children: [
        jsxs('label', { children: ['モデル', jsx('select', { value: state.modelKey, disabled: state.busy || state.loading || state.cancelling, onChange: (event: { target: { value: string } }) => controller.change(sessionId, { modelKey: event.target.value }),
          children: [jsx('option', { value: '', children: '選択' }), ...state.models.map(item => jsx('option', { value: JSON.stringify([item.provider, item.model]), children: `${item.provider}/${item.model}` }, `${item.provider}:${item.model}`))] })] }),
        jsxs('label', { children: ['レビューの目的（任意）', jsx('textarea', { value: state.purpose, disabled: state.busy || state.loading || state.cancelling, maxLength: 4000, onChange: (event: { target: { value: string } }) => controller.change(sessionId, { purpose: event.target.value }) })] }),
        jsx('button', { type: 'button', disabled: state.busy || state.loading || state.cancelling || review.state === 'analyzing' || !reviewMatchesSelection || !state.selected.length || !state.modelKey, onClick: () => void controller.analyze(sessionId), children: '分析する' }),
        review.state === 'analyzing' ? jsx('button', { type: 'button', disabled: state.cancelling, onClick: () => void controller.cancel(sessionId, review.reviewId), children: state.cancelling ? '停止中' : '停止' }) : null,
      ] }),
      !state.models.length && !state.loading ? jsxs('p', { role: 'status', children: [
        state.modelAvailability === 'no_models' ? '登録済みモデルがありません。DSH のモデル設定を確認してください。'
          : state.modelAvailability === 'catalog_error' ? 'モデル一覧を取得できませんでした。'
            : state.modelAvailability === 'service_unavailable' ? 'モデルサービスを利用できません。DSH の接続を確認してください。'
              : 'モデル一覧を確認できません。DSH の接続とモデル設定を確認してください。',
        ' ', jsx('button', { type: 'button', disabled: state.busy || state.cancelling, onClick: () => void controller.load(sessionId), children: 'モデルを再取得' }),
      ] }) : null,
      jsx('button', { type: 'button', className: 'kiokuko-review-list-toggle', onClick: () => {
        controller.change(sessionId, { fileListOpen: !state.fileListOpen })
        requestAnimationFrame(() => document.getElementById(`kiokuko-review-${review.reviewId}-${state.fileListOpen ? 'detail' : 'files'}`)?.focus())
      },
        children: state.fileListOpen ? '差分に戻る' : '変更ファイル一覧' }),
      jsxs('div', { className: 'kiokuko-review-main', 'data-list-open': String(state.fileListOpen), children: [
        jsxs('nav', { id: `kiokuko-review-${review.reviewId}-files`, tabIndex: -1, 'aria-label': '変更ファイル', children: [jsx('h3', { children: '変更ファイル' }), ...review.snapshot.files.map(file => jsxs('div', { className: 'kiokuko-review-file-row', children: [
          jsx('input', { type: 'checkbox', 'aria-label': `${file.displayPath} を分析対象にする`, checked: state.selected.includes(file.fileId), disabled: file.kind !== 'text', onChange: () => selectFile(file.fileId) }),
          jsx('button', { type: 'button', 'aria-current': active?.fileId === file.fileId ? 'true' : undefined, onClick: () => {
            controller.change(sessionId, { activeFileId: file.fileId, fileListOpen: false })
            requestAnimationFrame(() => document.getElementById(`kiokuko-review-${review.reviewId}-detail`)?.focus())
          }, children: `${file.displayPath} (${file.layer}, ${file.kind})` }),
        ] }, file.fileId))] }),
        active ? jsxs('article', { id: `kiokuko-review-${review.reviewId}-detail`, tabIndex: -1, children: [jsx('h3', { children: active.displayPath }),
          active.kind === 'text' && active.newDigest && review.snapshot.mode !== 'turn' ? jsx('button', { type: 'button',
            onClick: () => void controller.openCurrentFile(sessionId, review.reviewId, active.fileId, openFile), children: '現在のファイルへ' }) : null,
          active.reason ? jsx('p', { children: `除外・制限: ${active.reason}` }) : null,
          jsx(SnapshotDiff, { file: active, snapshotId: review.snapshot.snapshotId })] }) : jsx('p', { children: '変更はありません' }),
      ] }),
      review.context.execution?.length ? jsxs('section', { children: [jsx('h3', { children: '記録された実行証拠' }), ...review.context.execution.map((item, index) => jsx('p', { children: `${item.command}: ${item.status} / 今回の差分との一致: ${item.snapshotMatch}` }, index))] }) : null,
      jsxs('section', { children: [jsx('h3', { children: 'AI の解釈' }), jsx('p', { children: review.summary || '分析なし' }),
        review.analysis ? jsx('p', { children: `全体リスク: ${review.analysis.overallRisk}` }) : null,
        ...analysisGroups.filter(group => group.items.length).map(group => jsxs('section', { children: [jsx('h4', { children: group.label }), jsx('ul', { children: group.items.map((item, index) => jsx('li', { children: item }, index)) })] }, group.label)),
        ...review.claims.map((claim, index) => jsxs('p', { children: [claim.text, ` (確信度: ${claim.confidence}) `,
          ...claim.evidenceIds.map(id => jsx('button', { type: 'button', onClick: () => visitEvidence(id, claim.anchor), children: `根拠 ${id}` }, id)),
          ...(claim.unverifiedAssumptions.length ? [jsx('span', { children: ` 未検証の仮定: ${claim.unverifiedAssumptions.join('、')}` })] : [])] }, index))] }),
      review.unanalyzedFileIds?.length ? jsx('p', { children: `未分析: ${review.unanalyzedFileIds.map(id => review.snapshot.files.find(file => file.fileId === id)?.displayPath ?? id).join('、')}` }) : null,
      review.errors.length ? jsx('p', { role: 'status', children: `未検証: ${review.errors.map(reviewErrorMessage).join(' ')}` }) : null,
      jsxs('div', { className: 'kiokuko-review-exports', children: [jsx('a', { href: controller.exportUrl(sessionId, review.reviewId, 'markdown'), children: 'Markdown を保存' }), jsx('a', { href: controller.exportUrl(sessionId, review.reviewId, 'json'), children: 'JSON を保存' })] }),
    ] }) : null,
  ] })
}

function DiffReviewHeaderAction(props: Record<string, unknown>): unknown {
  const openPane = props.openDiffReview as () => boolean
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const fallbackAbort = useRef(new AbortController())
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal()
    if (!open && dialog.current?.open) { dialog.current.close(); trigger.current?.focus() }
  }, [open])
  const close = () => { fallbackAbort.current.abort(); setOpen(false); trigger.current?.focus() }
  const openReview = () => {
    if (openPane()) return
    fallbackAbort.current = new AbortController()
    setOpen(true)
  }
  return jsxs(Fragment, { children: [
    jsx('button', { ref: trigger, type: 'button', className: 'kiokuko-session-log-button', onClick: openReview, children: 'Diff レビュー' }),
    open ? jsxs('dialog', { ref: dialog, onCancel: close, onClose: close, 'aria-label': 'Diff レビュー',
      className: 'kiokuko-review-fallback', children: [
        jsx('button', { type: 'button', onClick: close, children: '閉じる' }),
        jsx(DiffReviewTab, { ...props, useTabInfo: () => ({ tab: { signal: fallbackAbort.current.signal, visible: true } }) }),
      ] }) : null,
  ] })
}

function installReviewStyle(): () => void {
  const style = document.createElement('style')
  style.dataset.pluginCss = 'kiokuko-diff-review'
  style.textContent = `.kiokuko-review-fallback{width:min(1000px,95vw);height:min(85vh,900px);padding:8px;box-sizing:border-box}.kiokuko-review{box-sizing:border-box;height:100%;overflow:auto;padding:12px;color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-background-primary,Canvas);font:13px/1.5 var(--dsw-font-family,system-ui)}.kiokuko-review h2{margin:0 0 12px;font-size:17px}.kiokuko-review h3{font-size:14px}.kiokuko-review button,.kiokuko-review select,.kiokuko-review textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l4,#888);border-radius:6px;padding:6px;min-height:36px}.kiokuko-review button{cursor:pointer}.kiokuko-review button:disabled{opacity:.55;cursor:default}.kiokuko-review :focus-visible{outline:2px solid Highlight;outline-offset:2px}.kiokuko-review-controls,.kiokuko-review-analysis-controls,.kiokuko-review-exports{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin:8px 0}.kiokuko-review label{display:flex;flex-direction:column;gap:3px}.kiokuko-review fieldset label{display:inline-flex;flex-direction:row;align-items:center;margin:4px 8px}.kiokuko-review-main{display:grid;grid-template-columns:minmax(130px,32%) minmax(0,1fr);gap:10px;min-width:0}.kiokuko-review-main nav{overflow:auto;min-width:0;max-height:55vh}.kiokuko-review-main article{overflow:auto;min-width:0}.kiokuko-review-file-row{display:flex;align-items:center;overflow-wrap:anywhere}.kiokuko-review-file-row button{text-align:left;border:0;overflow-wrap:anywhere}.kiokuko-review-file-row button[aria-current=true]{font-weight:700;text-decoration:underline}.kiokuko-review-diff pre{font:12px/1.4 ui-monospace,monospace;overflow:auto;white-space:pre}.kiokuko-review-diff .added{background:color-mix(in srgb,green 15%,transparent)}.kiokuko-review-diff .removed{background:color-mix(in srgb,red 15%,transparent)}.kiokuko-review-exports a{color:inherit;text-decoration:underline}@media(max-width:600px){.kiokuko-review-main{grid-template-columns:1fr}.kiokuko-review-main nav{max-height:180px}}`
  style.textContent += '.kiokuko-review{container-type:inline-size}.kiokuko-review-list-toggle{display:none}.kiokuko-review-analysis-controls label:first-child{flex:1 1 160px;min-width:0;max-width:100%}.kiokuko-review-analysis-controls label:nth-child(2){flex:2 1 220px;min-width:0;max-width:100%}.kiokuko-review-analysis-controls select,.kiokuko-review-analysis-controls textarea{box-sizing:border-box;width:100%;min-width:0;max-width:100%}.kiokuko-review-diff [tabindex="-1"]:focus{outline:2px solid Highlight;outline-offset:2px}@container (max-width:800px){.kiokuko-review-main{grid-template-columns:minmax(0,1fr)}.kiokuko-review-list-toggle{display:block}.kiokuko-review-main[data-list-open=false] nav{display:none}.kiokuko-review-main[data-list-open=true] article{display:none}}'
  document.head.appendChild(style)
  return () => style.remove()
}

/** Register Kiokuko's streaming Session-export browser surface. */
export function apply(ctx: DshClientContext): void {
  const reviewController = new DiffReviewClientController()
  let rightSidebar: DshClientContext['sidebarRight']
  ctx.effect(() => async () => reviewController.dispose(), 'kiokuko-dsh: diff review browser lifecycle')
  ctx.effect(installReviewStyle, 'kiokuko-dsh: diff review style')
  ctx.inject?.(['sidebarRightTabs', 'sidebarRight'], scope => {
    const t = scope.locale.bind?.(REVIEW_NS) ?? ((key: string) => key)
    scope.effect(() => { rightSidebar = scope.sidebarRight; return () => { if (rightSidebar === scope.sidebarRight) rightSidebar = undefined } }, 'kiokuko-dsh: diff review pane availability')
    scope.effect(() => {
      const dispose = scope.sidebarRightTabs!.register({
      id: REVIEW_TAB_ID, kind: REVIEW_KIND, priority: 'extension', title: () => t('review.title'),
      guide: [{ id: 'open', order: 30, title: () => t('review.title'), description: () => t('review.description') }],
      })
      return () => { void dispose() }
    }, 'kiokuko-dsh: diff review page')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: REVIEW_TAB_ID, locale: REVIEW_NS,
      inject: () => ({ hooks: { diffReview: reviewController.store }, reviewController,
        openCurrentFile: (address: string) => { if (!rightSidebar?.openResource) return false; try { rightSidebar.openResource(address); return true } catch { return false } } }),
    }, DiffReviewTab)) as () => void, 'kiokuko-dsh: diff review tab body')
  })
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'kiokuko-diff-review-open', locale: REVIEW_NS,
    inject: () => ({ hooks: { diffReview: reviewController.store }, reviewController,
      openDiffReview: () => { if (!rightSidebar) return false; try { rightSidebar.openTab(REVIEW_KIND); return true } catch { return false } },
      openCurrentFile: (address: string) => { if (!rightSidebar?.openResource) return false; try { rightSidebar.openResource(address); return true } catch { return false } } }),
  }, DiffReviewHeaderAction))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'kiokuko-lisp-status', locale: LOCALE_NAMESPACE,
  }, LispSessionStatus))
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer', priority: -10, select: intakePending, locale: LOCALE_NAMESPACE,
  }, IntakeQuestion))
  ctx.effect(installIntakeStyle, 'kiokuko-dsh: intake style')
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'kiokuko-deep-reports', locale: LOCALE_NAMESPACE,
  }, DeepSessionReports))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'kiokuko-session-notices', locale: LOCALE_NAMESPACE,
  }, (props: Record<string, unknown>) => jsx(DeepSessionReports, { ...props, notices: true })))
  ctx.uiConversation.events.register(completionReportDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'kiokuko-completion-report', locale: LOCALE_NAMESPACE,
  }, CompletionReport))
  const controller = new SessionLogDownloadController()
  ctx.effect(() => async () => controller.dispose(), 'kiokuko-dsh: browser download lifecycle')
  ctx.effect(installStyle, 'kiokuko-dsh: browser download style')
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { en, ja, zh }) as () => void, 'kiokuko-dsh: browser dictionaries')
  ctx.on('command/executed', (sessionId, commandName, result) => {
    if (commandName === 'export' && result.kind === 'success') void controller.download(sessionId)
  })
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'kiokuko-session-log-download',
    locale: LOCALE_NAMESPACE,
    inject: () => ({
      hooks: { sessionLogDownload: controller.store },
      request: (sessionId: string) => controller.download(sessionId),
      dismiss: (sessionId: string) => controller.dismiss(sessionId),
    }),
  }, SessionLogDownloadHeaderAction))
}
