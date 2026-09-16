import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, mkdir, writeFile, readFile, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyChange, freezeChange, snapshot } from '../../../../src/dsh/lisp/files.js'

test('file proposals reject links/protected files and changed contents; deletion keeps an independent backup', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lf-'))), root = join(base, 'workspace'), backups = join(base, 'backups')
  await mkdir(root); await mkdir(backups)
  const owner = { sessionId: 's', agentId: 'a', root }
  const nested = await freezeChange(owner, { operation: 'write', path: 'new/nested/result.txt', content: 'new result' }, backups, [])
  await applyChange(owner, nested, [])
  assert.equal(await readFile(join(root, 'new/nested/result.txt'), 'utf8'), 'new result')
  await writeFile(join(root, 'disguised.txt'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]))
  await assert.rejects(snapshot(root, 'disguised.txt', []), /SQLite/)
  await writeFile(join(root, 'a.txt'), 'before')
  await symlink(join(root, 'a.txt'), join(root, 'symlink'))
  await assert.rejects(snapshot(root, 'symlink', []), /通常ファイル/)
  for (const path of ['../a.txt', '.git/config', '.env', 'x.sqlite3-wal', '/tmp/a', 'x.pem']) await assert.rejects(snapshot(root, path, []), /対象にできません/)
  const frozen = await freezeChange(owner, { operation: 'delete', path: 'a.txt' }, backups, [])
  await writeFile(join(root, 'a.txt'), 'changed')
  await assert.rejects(applyChange(owner, frozen, []), /承認後に対象/)
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'changed')
  const approved = await freezeChange(owner, { operation: 'delete', path: 'a.txt' }, backups, [])
  await applyChange(owner, approved, [])
  await assert.rejects(readFile(join(root, 'a.txt')), { code: 'ENOENT' })
  assert.equal(await readFile(approved.backup!, 'utf8'), 'changed')
  await writeFile(join(root, 'linked'), 'linked'); await link(join(root, 'linked'), join(root, 'second'))
  await assert.rejects(snapshot(root, 'linked', []), /通常ファイル/)
})

test('parent symlink replacement after review stops before touching an outside file', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lr-'))), root = join(base, 'w'), outside = join(base, 'outside')
  await mkdir(join(root, 'dir'), { recursive: true }); await mkdir(outside); await mkdir(join(base, 'b'))
  await writeFile(join(root, 'dir', 'a'), 'inside'); await writeFile(join(outside, 'a'), 'outside')
  const owner = { sessionId: 's', agentId: 'a', root }
  const frozen = await freezeChange(owner, { operation: 'delete', path: 'dir/a' }, join(base, 'b'), [])
  const { rename } = await import('node:fs/promises')
  await rename(join(root, 'dir'), join(root, 'old')); await symlink(outside, join(root, 'dir'))
  await assert.rejects(applyChange(owner, frozen, []), /親ディレクトリ/)
  assert.equal(await readFile(join(outside, 'a'), 'utf8'), 'outside')
})
