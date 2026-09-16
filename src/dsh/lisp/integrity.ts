import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fail } from './contracts.js'
import { under } from './files.js'

export async function verifyLispVendor(library: string): Promise<void> {
  const root = await realpath(join(library, 'vendor'))
  const manifest = JSON.parse(await readFile(join(library, 'vendor-manifest.json'), 'utf8')) as { format: number; files: Record<string, string> }
  if (manifest.format !== 1 || !manifest.files || Object.keys(manifest.files).length > 10000) fail('BUNDLE_INTEGRITY', '同梱ライブラリの一覧が不正です。')
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (isAbsolute(name) || name.split('/').includes('..') || !/^[a-f0-9]{64}$/u.test(hash)) fail('BUNDLE_INTEGRITY', '同梱ライブラリの照合情報が不正です。')
    const path = await realpath(join(root, name))
    if (!under(root, path) || createHash('sha256').update(await readFile(path)).digest('hex') !== hash) fail('BUNDLE_INTEGRITY', `同梱ライブラリが一致しません: ${name}`)
  }
}
