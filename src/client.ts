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
  }
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
declare const jsx: (component: unknown, props: Record<string, unknown>) => unknown
declare const jsxs: (component: unknown, props: Record<string, unknown>) => unknown
declare const Fragment: unknown
declare const useState: <T>(initial: T | (() => T)) => [T, (value: T) => void]
declare const useRef: <T>(initial: T) => { current: T }
declare const useEffect: (effect: () => void | (() => void), dependencies: readonly unknown[]) => void
declare const Modal: unknown
declare const Button: unknown
declare const IconDownloadOutline16: unknown

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
    (event.type === 'kiokuko/completion-report' || event.type === 'kiokuko/execution-status') && typeof event.data.reportId === 'string' && typeof event.data.text === 'string'
      ? { id: event.data.reportId, role: 'start' } : null,
  start: (_context: unknown, match: { event: { seq: number; data: { text: string } } }) => ({ seq: match.event.seq, text: match.event.data.text }),
  update: (context: { state: unknown }) => context.state,
  buildViewNode: (context: { key: string; id: string; state?: { seq: number; text: string }; start?: { location: unknown } }) =>
    context.state === undefined ? null : {
      key: context.key, id: context.id, kind: 'kiokuko-completion-report', target: 'chat',
      anchorSeq: context.state.seq, location: context.start?.location ?? { kind: 'session' },
      visibility: 'visible', data: { text: context.state.text },
    },
}

function CompletionReport(props: Record<string, unknown>): unknown {
  const node = props.node as { data: { text: string } }
  return jsx('section', { role: 'status', 'aria-live': 'polite',
    style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '12px 0' }, children: node.data.text })
}

interface IntakePending {
  readonly key: string
  readonly kind: 'question'
  readonly questions: readonly [{ id: string; header: string; question: string; detail?: string; options: readonly { label: string; description?: string }[]; multiSelect?: boolean }]
  answer(value: { answers: [{ id: string; selected: string[]; custom?: string }] }): Promise<void>
  cancel(): Promise<void>
}

interface IntakeDraft { selected: number | null; custom: string }
const intakeDrafts = new WeakMap<object, IntakeDraft>()

function intakePending(props: Record<string, unknown>): IntakePending | null {
  const pending = props.pendingInteraction as IntakePending | undefined
  const question = pending?.questions?.[0]
  return pending?.kind === 'question' && pending.questions.length === 1
    && question?.id === 'taskType' && question.header === 'Kiokuko · 作業の選択'
    && question.multiSelect !== true && question.options?.length > 0 && question.options.length <= 9
    && typeof pending.answer === 'function' && typeof pending.cancel === 'function'
    ? pending : null
}

/** Native pending carrier, plugin-only presentation. Other DSH questions remain untouched. */
function IntakeQuestion(props: Record<string, unknown>): unknown {
  const pending = props.matched as IntakePending
  return jsx(IntakeQuestionCard, { key: pending.key, pending })
}

function IntakeQuestionCard(props: Record<string, unknown>): unknown {
  const pending = props.pending as IntakePending
  const question = pending.questions[0]
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
    intakeDrafts.set(pending, value)
    setDraft(value)
    setError('')
  }
  const settle = (cancel = false, skip = false) => {
    if (inFlight.current) return
    const custom = draft.custom.trim()
    if (!cancel && !skip && draft.selected === null && custom === '') {
      setError('選択肢を選ぶか、自由入力してください。')
      return
    }
    if (!cancel && !skip && /^[0-9０-９]+$/u.test(custom)) {
      const ordinal = Number(custom.normalize('NFKC'))
      if (ordinal < 1 || ordinal > question.options.length) {
        setError(`番号は1〜${question.options.length}で入力してください。`)
        return
      }
    }
    inFlight.current = true
    setBusy(true)
    setError('')
    // Enter is a separate confirmation. Typing, key-repeat and IME cannot submit twice.
    void Promise.resolve().then(() => cancel ? pending.cancel() : pending.answer({ answers: [{
      id: question.id,
      selected: skip || draft.selected === null ? [] : [question.options[draft.selected]!.label],
      ...(!skip && custom ? { custom } : {}),
    }] })).then(() => { intakeDrafts.delete(pending) }).catch(cause => {
      if (!mounted.current) return
      inFlight.current = false
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  const keyDown = (event: {
    key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; repeat?: boolean;
    nativeEvent?: { isComposing?: boolean; keyCode?: number }; target?: { tagName?: string; isContentEditable?: boolean };
    preventDefault(): void; stopPropagation(): void;
  }) => {
    if (busy || event.repeat || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229
      || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    const editing = event.target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName ?? '')
    if (!editing && /^[1-9]$/u.test(event.key)) {
      const index = Number(event.key) - 1
      if (index >= question.options.length) return
      event.preventDefault(); event.stopPropagation()
      update({ selected: index, custom: '' })
      card.current?.focus()
    } else if (event.key === 'Enter' && event.target?.tagName !== 'BUTTON') {
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
        jsx('p', { children: question.detail }),
        jsx('p', { children: `1〜${question.options.length}キーで選択、Enterで確定。自由入力中の数字は文字として入力されます。` }),
        jsx('div', { 'aria-label': '作業の選択肢', children: question.options.map((option, index) => jsxs('button', {
          key: option.label, type: 'button', className: 'kiokuko-intake-option', disabled: busy,
          ref: (element: HTMLElement | null) => { optionElements.current[index] = element },
          'aria-pressed': draft.selected === index, 'aria-keyshortcuts': String(index + 1),
          onClick: () => update({ selected: index, custom: '' }),
          onKeyDown: (event: { key: string; repeat?: boolean; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; nativeEvent?: { isComposing?: boolean; keyCode?: number }; preventDefault(): void; stopPropagation(): void }) => {
            if (event.key !== 'Enter' || event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229 || draft.selected !== index) return
            event.preventDefault(); event.stopPropagation(); settle()
          },
          children: [jsx('strong', { children: `${index + 1}. ${option.label}` }), jsx('span', { children: option.description })],
        })) }),
        jsx('label', { htmlFor: `${titleId}-custom`, children: '自由入力（番号でも回答できます）' }),
        jsx('textarea', { id: `${titleId}-custom`, rows: 2, disabled: busy, value: draft.custom,
          onChange: (event: { target: { value: string } }) => update({ selected: null, custom: event.target.value }),
        }),
      ] }),
      jsxs('footer', { children: [
        jsx('span', { role: 'status', 'aria-live': 'polite', children: error || (busy ? '送信中…' : draft.selected === null ? '' : `${draft.selected + 1}. ${question.options[draft.selected]!.label}を選択中`) }),
        jsx('button', { type: 'button', disabled: busy, onClick: () => settle(false, true), children: '作業を始めず会話する' }),
        jsx('button', { type: 'button', disabled: busy || (draft.selected === null && !draft.custom.trim()), onClick: () => settle(), children: '確定（Enter）' }),
      ] }),
    ],
  })
}

function installIntakeStyle(): (() => void) | undefined {
  if (typeof document === 'undefined') return undefined
  const style = document.createElement('style')
  style.textContent = '.kiokuko-intake{border:1px solid var(--dsw-alias-border-l4,#bbb);border-radius:16px;padding:16px;background:var(--dsw-alias-background-primary,Canvas);color:var(--dsw-alias-label-primary,CanvasText);display:flex;flex-direction:column;max-height:70dvh;gap:12px}.kiokuko-intake header,.kiokuko-intake footer{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.kiokuko-intake h2{font-size:18px;margin:0;flex:1}.kiokuko-intake-body{overflow:auto;min-height:0}.kiokuko-intake p{white-space:pre-wrap;line-height:1.5}.kiokuko-intake button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l4,#bbb);border-radius:8px;padding:10px;min-height:44px;cursor:pointer}.kiokuko-intake button:disabled{cursor:default;opacity:.6}.kiokuko-intake-option{display:flex;width:100%;text-align:left;flex-direction:column;gap:4px;margin-bottom:8px;overflow-wrap:anywhere}.kiokuko-intake-option[aria-pressed=true]{border:2px solid var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-interactive-bg-hover,#eee)}.kiokuko-intake-option span{font-size:13px;line-height:1.5}.kiokuko-intake textarea{box-sizing:border-box;width:100%;font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l4,#bbb);padding:8px;border-radius:8px}.kiokuko-intake :focus-visible,.kiokuko-intake:focus-visible{outline:2px solid Highlight;outline-offset:3px}.kiokuko-intake footer [role=status]{flex:1;min-width:120px}'
  document.head.appendChild(style)
  return () => style.remove()
}

/** Register Kiokuko's streaming Session-export browser surface. */
export function apply(ctx: DshClientContext): void {
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer', priority: -10, select: intakePending, locale: LOCALE_NAMESPACE,
  }, IntakeQuestion))
  ctx.effect(installIntakeStyle, 'kiokuko-dsh: intake style')
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
