import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { DiffReviewError, sha256, type DiffFile, type DiffHunk } from './schema.js'
import { sanitizeFile } from './redaction.js'
import { abortable } from '../dsh/http-json.js'

export interface NativeChanges {
  summary(sessionId: string, seq: number): {
    cwd: string; total: number; files: { path: string; binary?: true; oversized?: true }[]
    snapshot?: { before: string; after: string }
  } | undefined
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<{
    kind: 'text' | 'binary' | 'oversized'; path: string
    hunks?: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]
  } | undefined>
}

export async function captureNativeTurn(
  source: NativeChanges | undefined, sessionId: string, seq: number, root: string,
  limits: { maxFiles: number; maxFileBytes: number; maxSnapshotBytes: number }, signal: AbortSignal,
): Promise<{ files: DiffFile[]; total: number; beforeTree?: string; afterTree?: string }> {
  const summary = source?.summary(sessionId, seq)
  if (!summary) throw new DiffReviewError('turn_snapshot_unavailable', 422)
  const cwd = await realpath(summary.cwd).catch(() => { throw new DiffReviewError('session_workspace_mismatch', 409) })
  if (cwd !== root && !cwd.startsWith(root + sep)) throw new DiffReviewError('session_workspace_mismatch', 409)
  const files: DiffFile[] = []
  for (let index = 0; index < Math.min(summary.files.length, limits.maxFiles); index++) {
    const item = summary.files[index]!
    const absolute = resolve(cwd, item.path)
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      files.push({ fileId: randomUUID(), layer: 'turn', displayPath: '[outside repository]', kind: 'excluded', reason: 'outside_repository', hunks: [] })
      continue
    }
    const diff = await abortable(source!.diff(sessionId, seq, index, signal), signal)
    if (!diff || diff.path !== item.path) throw new DiffReviewError('turn_snapshot_unavailable', 422)
    const hunks: DiffHunk[] = diff.kind === 'text' ? (diff.hunks ?? []).map((hunk, i) => ({
      id: sha256(`${index}:${i}:${JSON.stringify(hunk)}`).slice(0, 16),
      oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines: [...hunk.lines],
    })) : []
    if (Buffer.byteLength(JSON.stringify(hunks)) > limits.maxFileBytes) {
      files.push(sanitizeFile({ fileId: randomUUID(), layer: 'turn', displayPath: item.path, newPath: item.path,
        kind: 'oversized', reason: 'file_limit', hunks: [] }))
      continue
    }
    const file: DiffFile = { fileId: randomUUID(), layer: 'turn', newPath: item.path, displayPath: item.path,
      kind: diff.kind, ...(diff.kind === 'text' ? { patch: hunks.map(hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`).join('\n') } : {}), hunks }
    files.push(sanitizeFile(file))
    if (Buffer.byteLength(JSON.stringify(files)) > limits.maxSnapshotBytes) throw new DiffReviewError('diff_too_large', 422)
  }
  return { files, total: summary.total,
    ...(summary.snapshot ? { beforeTree: summary.snapshot.before, afterTree: summary.snapshot.after } : {}) }
}
