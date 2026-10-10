import { loadAgenticReplayLibrary, type ViewerLibrary } from './agenticreplay-libraries.js'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { rename, rm, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgenticReplayConfig } from './config.js'
import { AgenticReplayError, type DshAgenticReplayBinding, type WithAgenticReplayIndex } from './agenticreplay-types.js'
import { checkedRunDir, checkPrivatePath, AGENTICREPLAY_RUN_ID, privateDirectory, workspaceKey } from './agenticreplay-security.js'
import { readAgenticReplayManifest, readAgenticReplayPage, scanAgenticReplayTrace } from './agenticreplay-files.js'

export class DshAgenticReplayReadService {
  readonly #cursorKey = randomBytes(32)
  constructor(readonly config: AgenticReplayConfig, readonly withIndex: WithAgenticReplayIndex,
    private readonly loadViewer: () => Promise<ViewerLibrary> = () => loadAgenticReplayLibrary('viewer')) {}
  async list(binding: DshAgenticReplayBinding) {
    return this.withIndex(store => {
      const rows = store.list(binding.sessionId, workspaceKey(binding.workspaceRoot))
      for (const row of rows) {
        if (!['starting', 'recording', 'finalizing'].includes(row.state)) continue
        const match = /^pid_([1-9][0-9]*)_[0-9a-f]{24}$/u.exec(row.recorder_instance_id)
        if (!match) continue
        const pid = Number(match[1])
        if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) continue
        try { process.kill(pid, 0) } catch (error) {
          // ESRCH proves the owner is absent. EPERM, unknown/PID-reused owners stay untouched.
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') store.markOwnerIncomplete(row.recorder_instance_id)
        }
      }
      return store.list(binding.sessionId, workspaceKey(binding.workspaceRoot))
    })
  }
  async #authorized(binding: DshAgenticReplayBinding, id: string) {
    if (!AGENTICREPLAY_RUN_ID.test(id)) throw new AgenticReplayError('trace_not_found')
    const row = await this.withIndex(store => store.get(binding.sessionId, workspaceKey(binding.workspaceRoot), id))
    if (!row || row.store_root !== binding.storeRoot || row.session_cwd !== binding.sessionCwd) throw new AgenticReplayError('trace_not_found')
    if (row.state !== 'completed') throw new AgenticReplayError('trace_not_completed')
    const dir = await checkedRunDir(row.store_root, id)
    const manifest = await readAgenticReplayManifest(dir, id)
    if (!manifest.ended_at || manifest.counts?.events !== row.event_count) throw new AgenticReplayError('trace_integrity_mismatch')
    return { row, dir }
  }
  #encode(id: string, offset: number, seq: number): string {
    const body = Buffer.from(JSON.stringify({ v: 1, id, offset, seq })).toString('base64url')
    return `${body}.${createHmac('sha256', this.#cursorKey).update(body).digest('base64url')}`
  }
  #decode(cursor: string | undefined, id: string) {
    if (cursor === undefined) return { offset: 0, seq: -1 }
    if (cursor.length > 1024) throw new AgenticReplayError('invalid_cursor')
    const parts = cursor.split('.')
    const [body, signature] = parts
    if (parts.length !== 2 || !body || !signature) throw new AgenticReplayError('invalid_cursor')
    const expected = createHmac('sha256', this.#cursorKey).update(body).digest()
    const supplied = Buffer.from(signature, 'base64url')
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) throw new AgenticReplayError('invalid_cursor')
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (value.v !== 1 || value.id !== id) throw new AgenticReplayError('invalid_cursor')
    return value as { offset: number; seq: number }
  }
  async show(binding: DshAgenticReplayBinding, id: string, cursor?: string) {
    const { dir, row } = await this.#authorized(binding, id)
    const position = this.#decode(cursor, id)
    const page = await readAgenticReplayPage(dir, position.offset, position.seq, this.config.maxTimelineEventsPerPage, this.config.maxTimelineReadBytesPerPage)
    let viewer: ViewerLibrary
    try { viewer = await this.loadViewer() } catch { throw new AgenticReplayError('viewer_unavailable_reinstall_package') }
    return { recordingState: row.state, exactReplay: false, usage: 'Missing usage is unknown, not measured zero.',
      rows: viewer.buildTimeline(page.events), events: page.events,
      ...(page.done ? {} : { cursor: this.#encode(id, page.offset, page.previousSeq) }) }
  }
  async export(binding: DshAgenticReplayBinding, id: string): Promise<string> {
    const { dir, row } = await this.#authorized(binding, id)
    const scan = await scanAgenticReplayTrace(dir, id, this.config.maxHtmlExportInputBytes, this.config.maxHtmlExportEvents)
    if (scan.eventCount !== row.event_count || scan.exportInputBytes !== row.export_input_bytes) throw new AgenticReplayError('trace_integrity_mismatch')
    // Bound repeated blob inlining, escaping, fixed markup, static CSS/JS before invoking the materializing viewer.
    const estimate = 1_048_576 + scan.exportInputBytes * 40 + scan.eventCount * (8192 + this.config.maxHtmlInlineCharsPerEvent * 6)
    if (!Number.isSafeInteger(estimate) || estimate > this.config.maxHtmlExportOutputBytes) throw new AgenticReplayError('export_output_limit')
    let viewer: ViewerLibrary
    try { viewer = await this.loadViewer() } catch { throw new AgenticReplayError('viewer_unavailable_reinstall_package') }
    const exports = join(row.store_root, '.agenticreplay', 'exports')
    await privateDirectory(exports)
    const output = join(exports, `${id}.html`)
    async function verifyExisting() {
      try { await checkPrivatePath(output, false) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await verifyExisting()
    const temporary = join(exports, `.${id}.${randomBytes(12).toString('hex')}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    await handle.close()
    try {
      const result = await viewer.exportTraceHtml(dir, temporary, { maxBlobBytes: this.config.maxHtmlExportInputBytes,
        maxInlineChars: this.config.maxHtmlInlineCharsPerEvent })
      const actual = await checkPrivatePath(temporary, false)
      if (actual.size !== result.bytes || result.bytes > this.config.maxHtmlExportOutputBytes) throw new AgenticReplayError('export_output_limit')
      // Detect changes during the third-party reader's second pass before publishing the file locally.
      const after = await scanAgenticReplayTrace(dir, id, this.config.maxHtmlExportInputBytes, this.config.maxHtmlExportEvents)
      if (after.manifest.integrity?.events_sha256 !== scan.manifest.integrity?.events_sha256 || after.exportInputBytes !== scan.exportInputBytes) throw new AgenticReplayError('file_changed')
      await checkPrivatePath(exports, true)
      await verifyExisting()
      await rename(temporary, output)
      return output
    } finally { await rm(temporary, { force: true }) }
  }
}
