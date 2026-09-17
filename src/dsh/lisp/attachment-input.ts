import { createHash } from 'node:crypto'
import { FILE_BYTES, LispError, fail } from './contracts.js'

interface FileRef { attachmentId: string; name: string; bytes: number }
export interface LispAttachmentStore {
  fileHostPath?(ref: FileRef): string | undefined
  readFileStream?(ref: FileRef, signal?: AbortSignal): AsyncIterable<Uint8Array>
}
export interface LispAttachmentSession { snapshotEvents?(): readonly unknown[] }
export interface AttachmentInput {
  source: { path: string; attachmentId: string; size: number; hash: string }
  size: number
  read(): Promise<Buffer>
}

/** Only durable user-file parts in this live session confer attachment access. */
export function attachmentInput(session: LispAttachmentSession, store: LispAttachmentStore | undefined, path: string, signal?: AbortSignal): AttachmentInput {
  if (!store?.fileHostPath || !store.readFileStream || !session.snapshotEvents) {
    throw new LispError('ATTACHMENT_UNAVAILABLE', 'このホストでは Lisp への添付入力を利用できません。', 'DSH の添付サービスを確認するか、ファイルを作業フォルダに置いて相対パスで指定してください。')
  }
  for (const raw of session.snapshotEvents()) {
    const event = raw as { type?: string; data?: { source?: { kind?: string }; content?: unknown[] } } | null
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user' || !Array.isArray(event.data.content)) continue
    for (const rawPart of event.data.content) {
      const part = rawPart as { type?: string; attachment?: Partial<FileRef> } | null
      const ref = part?.attachment
      if (part?.type !== 'file' || !ref || typeof ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(ref.attachmentId)
        || typeof ref.name !== 'string' || !Number.isSafeInteger(ref.bytes) || ref.bytes! < 0) continue
      const file: FileRef = { attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes! }
      if (store.fileHostPath(file) !== path) continue
      if (file.bytes > FILE_BYTES) fail('FILE_LIMIT', '添付入力は 64 MiB 以下のファイルに限ります。')
      const hash = file.attachmentId.slice(7)
      return { source: { path, attachmentId: file.attachmentId, size: file.bytes, hash }, size: file.bytes,
        read: async () => {
          signal?.throwIfAborted()
          const chunks: Buffer[] = [], digest = createHash('sha256')
          let size = 0
          for await (const chunk of store.readFileStream!(file, signal)) {
            signal?.throwIfAborted()
            size += chunk.byteLength
            if (size > file.bytes || size > FILE_BYTES) fail('ATTACHMENT_CHANGED', '添付ファイルの容量が記録と一致しません。')
            const copy = Buffer.from(chunk)
            chunks.push(copy); digest.update(copy)
          }
          signal?.throwIfAborted()
          if (size !== file.bytes || digest.digest('hex') !== hash) fail('ATTACHMENT_CHANGED', '添付ファイルの内容が記録と一致しません。')
          return Buffer.concat(chunks, size)
        } }
    }
  }
  throw new LispError('ATTACHMENT_NOT_IN_SESSION', 'このセッションに添付されたファイルのパスではありません。', 'このセッションの添付パス、または作業フォルダ内の相対パスを inputs に指定してください。')
}
