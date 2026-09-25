import { findSecret } from '../memory/secrets.js'
import type { DiffFile } from './schema.js'

const SECRET_PATH = /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|\.netrc$|\.ssh\/|\.aws\/|\.config\/gcloud\/|\.docker\/config\.json$|auth\.json$|id_(?:rsa|ed25519)|[^/]*\.(?:pem|p12|pfx|key|keystore|kdbx)$|credentials?(?:\.|$)|secrets?(?:\.|$))/iu
const GENERATED_PATH = /(?:^|\/)(?:node_modules|dist|build|coverage|\.next)\//u

export function exclusionReason(path: string, content?: string): string | undefined {
  if (SECRET_PATH.test(path) || findSecret(path)) return 'secret_path'
  if (GENERATED_PATH.test(path)) return 'generated_file'
  if (content !== undefined && findSecret(content)) return 'secret_content'
  return undefined
}

export function sanitizeFile(file: DiffFile): DiffFile {
  const reason = exclusionReason(file.newPath ?? file.oldPath ?? file.displayPath, file.patch)
  if (reason === undefined) return file
  return {
    fileId: file.fileId, layer: file.layer, displayPath: reason === 'secret_path' ? '[excluded path]' : file.displayPath,
    kind: 'excluded', reason, hunks: [],
  }
}

export function safeReviewInput(input: string): string | undefined {
  const trimmed = input.trim()
  return trimmed && !findSecret(trimmed) ? trimmed : undefined
}
