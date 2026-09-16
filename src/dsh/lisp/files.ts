import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink, mkdir, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fail, FILE_BYTES, type LispOwner, type ProposalInput } from './contracts.js'

export interface FileSnapshot { path: string; parent: string; parentDev: number; parentIno: number; exists: boolean; dev?: number; ino?: number; size?: number; hash?: string; mode?: number; missingParents?: string[] }
export interface FrozenChange { request: ProposalInput; before: FileSnapshot; id: string; backup: string | null; restoration?: { path: string; hash: string; size: number } }
const protectedSegment = /^(?:\.git|\.ssh|\.gnupg|\.aws|\.azure|\.config|\.env(?:\..*)?|AGENTS\.md|.*\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?|.*\.(?:pem|key|p12)|credentials(?:\..*)?)$/iu
export function under(root: string, path: string): boolean { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)) }

/** Resolve every directory without following links; no directory deletion is exposed. */
export async function snapshot(root: string, path: string, protectedRoots: readonly string[]): Promise<FileSnapshot> {
  if (isAbsolute(path) || /[\\\p{Cc}\p{Cf}]/u.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || protectedSegment.test(p))) fail('PROTECTED_PATH', 'このパスは汎用 Lisp ファイル操作の対象にできません。')
  if (await realpath(root) !== root) fail('ROOT_CHANGED', '作業ディレクトリの参照先が変わりました。')
  const target = join(root, path)
  if (protectedRoots.some(p => under(p, target))) fail('PROTECTED_PATH', 'プラグイン・状態・バックアップ領域は変更できません。')
  const parts = path.split('/')
  let parent = root
  for (const [index, part] of parts.slice(0, -1).entries()) {
    const next = join(parent, part)
    let info
    try { info = await lstat(next) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const anchor = await lstat(parent), missingParents = parts.slice(index, -1).map((_part, offset) => join(root, ...parts.slice(0, index + offset + 1)))
      return { path: target, parent: dirname(target), parentDev: anchor.dev, parentIno: anchor.ino, exists: false, missingParents }
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_PARENT', '親ディレクトリにリンクまたは通常でない項目があります。')
    parent = next
  }
  const parentInfo = await lstat(parent)
  const base: FileSnapshot = { path: target, parent, parentDev: parentInfo.dev, parentIno: parentInfo.ino, exists: false }
  let info
  try { info = await lstat(target) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return base; throw error }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > FILE_BYTES) fail('UNSAFE_FILE', '通常ファイルだけを扱えます。リンク・ディレクトリ・64 MiB 超のファイルは対象外です。')
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await file.stat()
    if (opened.dev !== info.dev || opened.ino !== info.ino) fail('TARGET_CHANGED', '対象が確認中に変わりました。')
    const content = await file.readFile()
    if (content.length > FILE_BYTES) fail('FILE_LIMIT', 'ファイル容量が上限を超えました。')
    if (content.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) || (content.length >= 32 && [0x377f0682, 0x377f0683].includes(content.readUInt32BE(0)))) fail('PROTECTED_DATABASE', '名前を変えた SQLite 本体・WAL も汎用ファイル操作では扱えません。')
    const after = await file.stat()
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('TARGET_CHANGED', '対象が読み取り中に変わりました。')
    return { ...base, exists: true, dev: info.dev, ino: info.ino, size: content.length, hash: createHash('sha256').update(content).digest('hex'), mode: info.mode & 0o777 }
  } finally { await file.close() }
}
export function sameFile(a: FileSnapshot, b: FileSnapshot): boolean {
  return a.path === b.path && a.parentDev === b.parentDev && a.parentIno === b.parentIno && a.exists === b.exists && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.hash === b.hash && JSON.stringify(a.missingParents) === JSON.stringify(b.missingParents)
}
export async function checkedBytes(before: FileSnapshot): Promise<Buffer> {
  const file = await open(before.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1 || stat.size > FILE_BYTES) fail('TARGET_CHANGED', '対象が変更されています。')
    const bytes = await file.readFile()
    if (createHash('sha256').update(bytes).digest('hex') !== before.hash) fail('TARGET_CHANGED', '対象の内容が変更されています。')
    return bytes
  } finally { await file.close() }
}
async function durableWrite(path: string, content: string | Buffer, mode = 0o600): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try { await file.writeFile(content); await file.sync() } finally { await file.close() }
}
async function syncDirectory(path: string): Promise<void> { const file = await open(path, constants.O_RDONLY); try { await file.sync() } finally { await file.close() } }
export async function freezeChange(owner: LispOwner, request: ProposalInput, backupRoot: string, protectedRoots: readonly string[]): Promise<FrozenChange> {
  const before = await snapshot(owner.root, request.path, protectedRoots)
  if (request.operation === 'delete' && !before.exists) fail('TARGET_MISSING', '削除対象がありません。')
  if (request.operation === 'write' && Buffer.byteLength(request.content) > FILE_BYTES) fail('FILE_LIMIT', '出力が上限を超えました。')
  return { request, before, id: randomUUID(), backup: before.exists ? join(backupRoot, randomUUID()) : null }
}
/** Backups are independent copies. Never replay this function after an uncertain outcome. */
export async function applyChange(owner: LispOwner, change: FrozenChange, protectedRoots: readonly string[]): Promise<void> {
  if (!sameFile(change.before, await snapshot(owner.root, change.request.path, protectedRoots))) fail('TARGET_CHANGED', '承認後に対象が変わりました。変更案を作り直してください。')
  if (change.backup) {
    await durableWrite(change.backup, await checkedBytes(change.before))
    await syncDirectory(dirname(change.backup))
  }
  let before = await snapshot(owner.root, change.request.path, protectedRoots)
  if (!sameFile(change.before, before)) fail('TARGET_CHANGED', '保存後に対象が変わりました。処理を停止しました。')
  if (before.missingParents) {
    for (const parent of before.missingParents) {
      await mkdir(parent, { mode: 0o700 }) // exclusive: an intervening entry is a conflict, never followed
      await syncDirectory(dirname(parent))
    }
    before = await snapshot(owner.root, change.request.path, protectedRoots)
    if (before.exists || before.missingParents) fail('TARGET_CHANGED', '出力先が作成中に変わりました。処理を停止しました。')
  }
  if (change.request.operation === 'delete') await unlink(before.path)
  else {
    const temporary = join(before.parent, `.${basename(before.path)}.kioku-${change.id}`)
    await durableWrite(temporary, change.restoration ? await restoreBytes(change.restoration) : change.request.content, before.mode ?? 0o600)
    if (!sameFile(before, await snapshot(owner.root, change.request.path, protectedRoots))) fail('TARGET_CHANGED', `対象が変わりました。出力は ${temporary} に残っています。`)
    await rename(temporary, before.path)
  }
  await syncDirectory(before.parent)
}
export async function backupUsage(root: string): Promise<number> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  let bytes = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile()) fail('BACKUP_INTEGRITY', 'バックアップ領域に想定外の項目があります。')
    bytes += (await lstat(join(root, entry.name))).size
  }
  return bytes
}
export async function restoreBytes(source: NonNullable<FrozenChange['restoration']>): Promise<Buffer> {
  const file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== source.size || stat.size > FILE_BYTES) fail('BACKUP_INTEGRITY', 'バックアップの情報が一致しません。')
    const bytes = await file.readFile()
    if (createHash('sha256').update(bytes).digest('hex') !== source.hash) fail('BACKUP_INTEGRITY', 'バックアップの内容が変わっています。')
    return bytes
  } finally { await file.close() }
}
