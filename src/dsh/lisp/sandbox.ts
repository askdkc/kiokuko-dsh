import { access, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fail } from './contracts.js'
import { networkFilter } from './seccomp.js'
import { checkedDirectory } from './files.js'

export interface SandboxLayout { base: string; scratch: string; inputs: string; cache: string; library: string; compiled?: string }
export interface Launch { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; seccompPath?: string }
const systemPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
export async function executable(name: string): Promise<string> {
  if (/\p{Cc}/u.test(name)) fail('INVALID_EXECUTABLE', '実行ファイル名が不正です。')
  for (const path of isAbsolute(name) ? [name] : systemPaths.map(p => join(p, name))) {
    try { await access(path, constants.X_OK); const resolved = await realpath(path); if ((await stat(resolved)).isFile()) return resolved } catch { /* try the next fixed search directory */ }
  }
  return fail('RUNTIME_MISSING', `${name} が見つかりません。インストール後に /kioku-lisp enable を実行してください。`)
}
function literal(path: string): string {
  if (!isAbsolute(path) || /["\\\p{Cc}]/u.test(path)) fail('UNSUPPORTED_PATH', '保護設定で利用できないパスです。')
  return `"${path}"`
}
export async function prepareLayout(base: string, library: string): Promise<SandboxLayout> {
  const layout = { base, library: await realpath(library), scratch: join(base, 'scratch'), inputs: join(base, 'inputs'), cache: join(base, 'cache') }
  for (const path of [base, layout.scratch, layout.inputs, layout.cache]) await mkdir(path, { recursive: true, mode: 0o700 })
  return layout
}
/** The OS boundary applies to arbitrary Lisp, FFI, exec, Python and shell alike. */
export async function sandboxLaunch(layout: SandboxLayout, program: string, args: string[], generation: string, protocol = false, directory = '.'): Promise<Launch> {
  const binary = await executable(program)
  const cwd = (await checkedDirectory(layout.scratch, directory)).path
  if (!protocol && !['/usr/', '/bin/', '/opt/homebrew/Cellar/', '/opt/homebrew/bin/'].some(root => binary.startsWith(root))) fail('EXECUTABLE_SCOPE', '実行ファイルは OS またはインストール済みランタイムの場所から指定してください。')
  const env: Record<string, string> = { PATH: systemPaths.join(':'), HOME: layout.scratch, TMPDIR: layout.scratch, LANG: 'C.UTF-8',
    KIOKU_SCRATCH: `${layout.scratch}/`, KIOKU_CACHE: `${layout.cache}/`, KIOKU_GENERATION: generation }
  if (layout.compiled) env.KIOKU_COMPILED = `${layout.compiled}/`
  // Homebrew Node otherwise reads host OpenSSL configuration outside its
  // allowed runtime roots. A fixed empty config needs no extra read permission.
  if (basename(binary) === 'node') env.OPENSSL_CONF = '/dev/null'
  if (process.platform === 'darwin') {
    const runtime = dirname(dirname(binary))
    // No child can fork or escape the host's direct-child termination accounting.
    const readRoots = ['/usr/lib', '/usr/share', '/bin', '/usr/bin', '/System/Library', '/System/Cryptexes/OS', '/System/Volumes/Preboot/Cryptexes/OS',
      '/Library/Developer/CommandLineTools', '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/lib', '/usr/local/Cellar', '/usr/local/opt', '/usr/local/lib',
      ...(runtime === '/' || runtime === '/usr' ? [] : [join(runtime, 'lib'), join(runtime, 'libexec'), join(runtime, 'bin'), join(runtime, 'share')]), layout.library, layout.inputs,
      ...layout.compiled ? [layout.compiled] : []]
    const profile = `(version 1) (deny default)
(deny process-fork) (allow process-exec) (allow signal (target self)) (allow sysctl-read) (allow dynamic-code-generation)
(allow file-read-metadata) (allow file-read-data (literal "/"))
(allow file-read* file-map-executable ${[...new Set(readRoots)].map(p => `(subpath ${literal(p)})`).join(' ')})
(allow file-read* file-write* (subpath ${literal(layout.scratch)}) (subpath ${literal(layout.cache)}))
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`
    const policy = join(layout.base, `policy-${protocol ? 'worker' : 'job'}.sb`)
    await writeFile(policy, profile, { mode: 0o600 })
    return { command: '/usr/bin/sandbox-exec', args: ['-f', policy, binary, ...args], env, cwd }
  }
  if (process.platform === 'linux') {
    const seccompPath = join(layout.base, 'network.bpf')
    await writeFile(seccompPath, networkFilter(process.arch), { mode: 0o600 })
    const runtime = dirname(dirname(binary))
    const binds: string[] = []
    for (const path of new Set(['/usr', '/bin', '/lib', '/lib64', '/etc/ld.so.cache', layout.library, layout.inputs, ...layout.compiled ? [layout.compiled] : [],
      ...(runtime === '/' || runtime === '/usr' ? [] : [join(runtime, 'bin'), join(runtime, 'lib'), join(runtime, 'libexec'), join(runtime, 'share')])])) {
      try { await access(path); binds.push('--ro-bind', path, path) } catch { /* optional runtime directory */ }
    }
    return { command: await executable('bwrap'), args: ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv', ...Object.entries(env).flatMap(([k,v]) => ['--setenv', k, v]),
      ...binds, '--proc', '/proc', '--dev', '/dev', '--bind', layout.scratch, layout.scratch, '--bind', layout.cache, layout.cache,
      '--seccomp', '4', '--chdir', cwd, '--', binary, ...args], env, cwd, seccompPath }
  }
  return fail('UNSUPPORTED_OS', 'Common Lisp は macOS と Linux で利用できます。')
}
