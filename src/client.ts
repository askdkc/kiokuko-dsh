/// <reference path="./dsh-session-log-export-client.d.ts" />

export interface DshSessionDownloadOptions {
  readonly endpoint: string
  readonly sessionId: string
  readonly fetch?: typeof globalThis.fetch
  readonly window?: {
    showSaveFilePicker?: (options: unknown) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>
    location: { assign(url: string): void }
  }
}

// Keep DSH's native Header modal and `/export` command behavior. Loading is
// deferred so non-Web consumers can import `./client` without the DSH bundle.
export const inject = ['slots', 'locale'] as const
export async function apply(ctx: import('@deepseek-ai/cordis').Context): Promise<void> {
  const official = await import('@deepseek-ai/dsh-session-log-export/client')
  official.apply(ctx)
}

/** Browser helper that never builds a whole-log Blob in application memory. */
export async function downloadDshSessionLog(options: DshSessionDownloadOptions): Promise<'streamed' | 'navigated'> {
  const url = new URL(options.endpoint)
  url.searchParams.set('sessionId', options.sessionId)
  const browser = options.window ?? (globalThis as unknown as { window?: DshSessionDownloadOptions['window'] }).window
  if (browser?.showSaveFilePicker === undefined) {
    if (browser === undefined) throw new Error('browser download surface is unavailable')
    url.searchParams.set('download', '1')
    browser.location.assign(url.toString())
    return 'navigated'
  }
  const response = await (options.fetch ?? globalThis.fetch)(url)
  if (!response.ok) throw new Error(`Session export failed: HTTP ${response.status}`)
  if (response.body === null) throw new Error('Session export returned no response stream')
  const handle = await browser.showSaveFilePicker({ suggestedName: `dsh-session-${options.sessionId}.zip`, types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] })
  const writable = await handle.createWritable()
  await response.body.pipeTo(writable)
  return 'streamed'
}
