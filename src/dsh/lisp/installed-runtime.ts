import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { CompiledLispCache, runLispSetup } from './compiled-cache.js'
import { digest, LispConfig, LispError } from './contracts.js'
import { verifyLispVendor } from './integrity.js'
import { prepareLayout } from './sandbox.js'

const recovery = 'SBCL を用意して npm run lisp:build をパッケージのディレクトリで実行するか、kiokuko-dsh を再インストールしてください。'
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const Manifest = z.object({ format: z.literal(1), key: hash, hash,
  bytes: z.number().int().positive().max(1024 * 1024 * 1024) }).strict()
export interface InstalledLispRuntime { key: string; path: string; executable: string; reused: boolean; prepareMs: number }

async function sourceKey(library: string): Promise<string> {
  await verifyLispVendor(library)
  const sources: Record<string, string> = {}
  for (const file of ['vendor-manifest.json', 'kioku-runtime.asd', 'tools.lisp', 'compile.lisp', 'check-compiled.lisp', 'save-executable.lisp'])
    sources[file] = createHash('sha256').update(await readFile(join(library, file))).digest('hex')
  return digest({ format: 1, platform: process.platform, arch: process.arch, sources })
}
async function binaryHash(path: string, privateFile = false): Promise<{ hash: string; bytes: number }> {
  const info = await lstat(path)
  if (!info.isFile() || (privateFile && info.nlink !== 1) || !(info.mode & 0o111) || info.size > 1024 * 1024 * 1024) throw new Error('Invalid executable file')
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    if (bytes > 1024 * 1024 * 1024) throw new Error('Executable too large')
    hash.update(chunk)
  }
  return { hash: hash.digest('hex'), bytes }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function verifiedRuntime(directory: string, key: string): Promise<InstalledLispRuntime> {
  try {
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('Invalid directory')
    const manifestPath = join(directory, 'manifest.json'), info = await lstat(manifestPath)
    // Package managers can hard-link both files when reusing cached install output.
    if (!info.isFile() || info.size > 4096) throw new Error('Invalid manifest')
    const manifest = Manifest.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    const executable = join(directory, 'kiokuko-lisp'), actual = await binaryHash(executable)
    if (manifest.key !== key || manifest.hash !== actual.hash || manifest.bytes !== actual.bytes) throw new Error('Digest mismatch')
    return { key, path: directory, executable, reused: true, prepareMs: 0 }
  } catch (cause) {
    const error = new LispError('INSTALLED_RUNTIME_INVALID', 'インストール済み Lisp 実行ファイルの整合性を確認できません。起動していません。', recovery)
    error.cause = cause; throw error
  }
}

/** Runtime selection never invokes SBCL. Missing artifacts retain source-checkout compatibility. */
export async function installedLispRuntime(library: string): Promise<InstalledLispRuntime | undefined> {
  const root = join(await realpath(library), '.native')
  if (!await exists(root)) return undefined
  const key = await sourceKey(library), directory = join(root, key)
  if (!await exists(directory)) throw new LispError('INSTALLED_RUNTIME_STALE', 'このソースと OS/CPU に対応する Lisp 実行ファイルがありません。', recovery)
  return verifiedRuntime(directory, key)
}

/** Build only pristine bundled code, self-test a fresh executable, then publish atomically. */
export async function buildInstalledLisp(library: string, sbclPath = 'sbcl', signal = new AbortController().signal): Promise<InstalledLispRuntime> {
  const started = performance.now(), canonical = await realpath(library), key = await sourceKey(canonical)
  const root = join(canonical, '.native'), target = join(root, key)
  if (await exists(target)) return verifiedRuntime(target, key)
  const base = await mkdtemp(join(canonical, '.native-build-'))
  let stopped = true
  try {
    const config = LispConfig.parse({ sbclPath, executionMode: 'protected', startupTimeoutMs: 60000 })
    const compiled = await new CompiledLispCache(join(base, 'compiled'), canonical, config).ensure(signal, () => {})
    const layout = await prepareLayout(join(base, 'image'), canonical)
    layout.compiled = compiled.path
    await runLispSetup(layout, config, 'save-executable.lisp', signal)
    const check = await runLispSetup(layout, config, 'check-executable', signal)
    if (check.trim() !== 'KIOKU-EXECUTABLE/1') throw new LispError('COMPILE_FAILED', 'Lisp 実行ファイルの動作確認に失敗しました。', recovery)
    if (await sourceKey(canonical) !== key) throw new LispError('COMPILE_INPUT_CHANGED', 'ビルド中に Lisp ソースが変更されました。', recovery)
    const executable = join(layout.cache, 'kiokuko-lisp'), info = await binaryHash(executable, true)
    // The image contains only public bundled code. Like other package assets,
    // it must be readable when an administrator installs for another user.
    const publish = join(base, 'publish'); await mkdir(publish, { mode: 0o755 })
    await rename(executable, join(publish, 'kiokuko-lisp'))
    const binary = await open(join(publish, 'kiokuko-lisp'), 'r')
    try { await binary.sync() } finally { await binary.close() }
    const manifest = await open(join(publish, 'manifest.json'), 'wx', 0o644)
    try { await manifest.writeFile(JSON.stringify({ format: 1, key, ...info })); await manifest.sync() } finally { await manifest.close() }
    signal.throwIfAborted()
    await mkdir(root, { recursive: true, mode: 0o755 })
    try { await rename(publish, target) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      return await verifiedRuntime(target, key)
    }
    return { key, path: target, executable: join(target, 'kiokuko-lisp'), reused: false, prepareMs: Math.round(performance.now() - started) }
  } catch (error) {
    if (error instanceof LispError && error.code === 'STOP_UNCONFIRMED') stopped = false
    throw error
  } finally { if (stopped) await rm(base, { recursive: true, force: true }) }
}
