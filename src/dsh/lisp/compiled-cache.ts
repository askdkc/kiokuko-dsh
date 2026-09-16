import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { digest, LispError, type LispConfiguration } from './contracts.js'
import { verifyLispVendor } from './integrity.js'
import { executable, prepareLayout, sandboxLaunch, type SandboxLayout } from './sandbox.js'

const MAX_BUNDLE_BYTES = 256 * 1024 * 1024
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const Manifest = z.object({ format: z.literal(1), key: hashSchema, hash: hashSchema,
  bytes: z.number().int().positive().max(MAX_BUNDLE_BYTES) }).strict()
export interface CompiledRuntime { key: string; path: string; reused: boolean; prepareMs: number }
export interface CompilationStatus { state: 'checking' | 'compiling' | 'ready' | 'failed'; key?: string; reused?: boolean; prepareMs?: number }
const recovery = '原因を解消して /kioku-lisp recover を実行してください。コンパイルを確認してから新しい Lisp を起動します。前のコードは再実行しません。'

async function fileHash(path: string, limit: number, privateFile = false): Promise<{ hash: string; bytes: number }> {
  const info = await lstat(path)
  if (!info.isFile() || (privateFile && info.nlink !== 1) || info.size > limit) throw new LispError('CACHE_FILE_INVALID', `通常ファイルではないか、容量が上限を超えています: ${path}`, recovery)
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    if (bytes > limit) throw new LispError('CACHE_FILE_INVALID', `ファイル容量が上限を超えました: ${path}`, recovery)
    hash.update(chunk)
  }
  return { hash: hash.digest('hex'), bytes }
}

/** Bounded, supervised, sandboxed setup. No user code or inherited environment. */
export async function runLispSetup(layout: SandboxLayout, config: LispConfiguration, script: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const launch = await sandboxLaunch(layout, config.sbclPath,
    ['--noinform', '--disable-debugger', '--no-sysinit', '--no-userinit', '--script', join(layout.library, script)], 'setup', true)
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(layout.library, 'supervisor.mjs'), JSON.stringify({ ...launch, protocol: false })],
      { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), bytes = 0, failure: Error | undefined
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error) => {
      if (failure) return
      failure = error; child.kill('SIGTERM')
      stopTimer = setTimeout(() => { cleanup(); reject(new LispError('STOP_UNCONFIRMED', 'Lisp の準備プロセスの停止を確認できません。', 'ホストを停止し、残ったプロセスを確認してから再開してください。')) }, 5000)
    }
    const abort = () => stop(new LispError('CANCELLED', 'Lisp の準備を取り消しました。', recovery))
    const timer = setTimeout(() => stop(new LispError('COMPILE_TIMEOUT', 'Lisp の準備が時間内に完了しませんでした。', 'startupTimeoutMs を確認し、/kioku-lisp recover で再開してください。')), config.startupTimeoutMs)
    const cleanup = () => { clearTimeout(timer); clearTimeout(stopTimer); signal.removeEventListener('abort', abort) }
    for (const output of [child.stdout!, child.stderr!]) output.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (output === child.stdout) stdout = Buffer.concat([stdout, chunk]).subarray(-16384)
      else stderr = Buffer.concat([stderr, chunk]).subarray(-16384)
      if (bytes > config.maxOutputBytes) stop(new LispError('OUTPUT_LIMIT', 'Lisp の準備中の出力量が上限を超えました。', recovery))
    })
    child.once('error', error => { cleanup(); reject(error) })
    child.once('close', code => {
      cleanup()
      if (failure) reject(failure)
      else if (code !== 0) reject(new LispError('COMPILE_FAILED', `Lisp の準備に失敗しました。\n${stderr.toString().slice(-6000)}`, recovery))
      else resolve(stdout.toString())
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** The manager's exclusive data-root lease owns publication and serializes builders. */
export class CompiledLispCache {
  #tail: Promise<unknown> = Promise.resolve()
  #stopFailure: LispError | undefined
  constructor(readonly root: string, readonly library: string, readonly config: LispConfiguration) {}
  assertStopped(): void { if (this.#stopFailure) throw this.#stopFailure }
  ensure(signal: AbortSignal, progress: (status: CompilationStatus) => void): Promise<CompiledRuntime> {
    const result = this.#tail.catch(() => {}).then(async () => {
      let latest: CompilationStatus = { state: 'checking' }
      try { return await this.prepare(signal, status => { latest = status; progress(status) }) }
      catch (error) { progress({ ...latest, state: 'failed' }); throw error }
    })
    this.#tail = result
    return result
  }
  private async identity(layout: SandboxLayout, signal: AbortSignal): Promise<string> {
    await verifyLispVendor(this.library)
    const source: Record<string, string> = {}
    for (const name of ['vendor-manifest.json', 'kioku-runtime.asd', 'tools.lisp', 'compile.lisp', 'check-compiled.lisp', 'bootstrap.lisp', 'runtime-identity.lisp']) {
      source[name] = (await fileHash(join(this.library, name), MAX_BUNDLE_BYTES)).hash
    }
    const output = (await runLispSetup(layout, this.config, 'runtime-identity.lisp', signal)).trim().split('\n')
    if (output.length !== 8 || output[0] !== 'KIOKU-RUNTIME/1' || output.some(line => !line || /[\r\0]/u.test(line))) {
      throw new LispError('RUNTIME_IDENTITY', '実際の SBCL の互換性情報を確認できません。', recovery)
    }
    const binaries: Record<string, string> = {}
    for (const path of [await executable(this.config.sbclPath), output[5]!, output[6]!]) {
      const actual = await realpath(path)
      binaries[actual] = (await fileHash(actual, 1024 * 1024 * 1024)).hash
    }
    return digest({ format: 1, platform: process.platform, architecture: process.arch,
      library: await realpath(this.library), source, runtime: output, binaries })
  }
  private async existing(path: string, key: string): Promise<boolean> {
    try { await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    try {
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('cache directory is not canonical')
      const manifestPath = join(path, 'manifest.json')
      await fileHash(manifestPath, 4096, true)
      const manifest = Manifest.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
      const actual = await fileHash(join(path, 'runtime.fasl'), MAX_BUNDLE_BYTES, true)
      if (manifest.key !== key || manifest.hash !== actual.hash || manifest.bytes !== actual.bytes) throw new Error('cache digest mismatch')
      return true
    } catch {
      // Preserve invalid bytes for diagnosis; never execute them or repair in place.
      await rename(path, join(this.root, `invalid-${key}-${randomUUID()}`))
      throw new LispError('CACHE_INVALID', 'コンパイル済みファイルの破損を検出し、隔離しました。Lisp は起動していません。', recovery)
    }
  }
  private async prepare(signal: AbortSignal, progress: (status: CompilationStatus) => void): Promise<CompiledRuntime> {
    this.assertStopped()
    signal.throwIfAborted(); const start = performance.now(); progress({ state: 'checking' })
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const base = await mkdtemp(join(this.root, '.build-'))
    let stopped = true
    try {
      const layout = await prepareLayout(base, this.library)
      const key = await this.identity(layout, signal), path = join(this.root, key)
      signal.throwIfAborted()
      const reused = await this.existing(path, key)
      if (!reused) {
        progress({ state: 'compiling', key })
        await runLispSetup(layout, this.config, 'compile.lisp', signal)
        await runLispSetup(layout, this.config, 'check-compiled.lisp', signal)
        if (await this.identity(layout, signal) !== key) throw new LispError('COMPILE_INPUT_CHANGED', 'コンパイル中に SBCL または同梱ソースが変更されました。結果は採用していません。', recovery)
        signal.throwIfAborted()
        const bundle = join(layout.cache, 'runtime.fasl'), info = await fileHash(bundle, MAX_BUNDLE_BYTES)
        if (info.bytes === 0) throw new LispError('COMPILE_FAILED', 'コンパイル結果が空です。', recovery)
        const publish = join(base, 'publish'); await mkdir(publish, { mode: 0o700 })
        await rename(bundle, join(publish, 'runtime.fasl'))
        const fasl = await open(join(publish, 'runtime.fasl'), 'r')
        try { await fasl.sync() } finally { await fasl.close() }
        const manifest = await open(join(publish, 'manifest.json'), 'wx', 0o600)
        try { await manifest.writeFile(JSON.stringify({ format: 1, key, ...info })); await manifest.sync() } finally { await manifest.close() }
        const publishedDirectory = await open(publish, 'r'); try { await publishedDirectory.sync() } finally { await publishedDirectory.close() }
        signal.throwIfAborted()
        await rename(publish, path)
        const directory = await open(this.root, 'r'); try { await directory.sync() } finally { await directory.close() }
      }
      const result = { key, path, reused, prepareMs: Math.round(performance.now() - start) }
      progress({ state: 'ready', key, reused, prepareMs: result.prepareMs })
      return result
    } catch (error) {
      if (error instanceof LispError && error.code === 'STOP_UNCONFIRMED') { stopped = false; this.#stopFailure = error }
      throw error
    }
    finally { if (stopped) await rm(base, { recursive: true, force: true }) }
  }
}
