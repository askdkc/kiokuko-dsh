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
    event.type === 'kiokuko/completion-report' && typeof event.data.reportId === 'string' && typeof event.data.text === 'string'
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

/** Register Kiokuko's streaming Session-export browser surface. */
export function apply(ctx: DshClientContext): void {
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
