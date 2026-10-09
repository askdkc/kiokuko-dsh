import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { executable } from './sandbox.js'
import { fail } from './contracts.js'

export interface PackageCommandResult { code: number; stdout: string; stderr: string }
export type PackageCommand = (manager: 'npm' | 'pnpm', args: string[], directory: string, signal: AbortSignal) => Promise<PackageCommandResult>

/** Only the typed package broker calls this; arbitrary worker programs never receive network permission. */
export const runPackageCommand: PackageCommand = async (manager, args, directory, signal) => {
  const binary = await executable(manager)
  if (!['/usr/', '/bin/', '/opt/homebrew/Cellar/', '/opt/homebrew/bin/', '/usr/local/Cellar/', '/usr/local/lib/'].some(root => binary.startsWith(root)))
    fail('PACKAGES_EXECUTABLE_SCOPE', 'Package managers must be installed in a trusted runtime directory.')
  const env: NodeJS.ProcessEnv = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: directory, TMPDIR: directory,
    LANG: 'C.UTF-8', OPENSSL_CONF: '/dev/null', NPM_CONFIG_USERCONFIG: join(directory, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(directory, '.global-npmrc') }
  let command: string, argv: string[]
  const runtime = dirname(dirname(binary))
  if (process.platform === 'darwin') {
    const literal = (path: string) => {
      if (/["\\\p{Cc}]/u.test(path)) fail('PACKAGES_PATH', 'Unsupported package scratch path.')
      return JSON.stringify(path)
    }
    const reads = ['/usr/lib', '/usr/share', '/usr/bin', '/bin', '/System/Library', '/System/Cryptexes/OS', '/System/Volumes/Preboot/Cryptexes/OS',
      '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/lib', '/usr/local/Cellar', '/usr/local/lib',
      join(runtime, 'bin'), join(runtime, 'lib'), join(runtime, 'libexec'), join(runtime, 'share')]
    // Package-manager children inherit this boundary. Lifecycle scripts and hooks are separately disabled by fixed command/config.
    const policy = `(version 1) (deny default)
(allow process-exec process-fork) (allow signal (target self)) (allow sysctl-read) (allow dynamic-code-generation)
(allow network-outbound)
(allow file-read-metadata)
(allow file-read* file-map-executable ${[...new Set(reads)].map(path => `(subpath ${literal(path)})`).join(' ')})
(allow file-read* (literal "/") (literal "/etc/resolv.conf") (literal "/private/etc/resolv.conf"))
(allow file-read* file-write* (subpath ${literal(directory)}))
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`
    const path = join(directory, `package-policy-${randomUUID()}.sb`)
    await writeFile(path, policy, { flag: 'wx', mode: 0o600 })
    command = '/usr/bin/sandbox-exec'; argv = ['-f', path, binary, ...args]
  } else if (process.platform === 'linux') {
    command = await executable('bwrap')
    argv = ['--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--clearenv',
      ...Object.entries(env).flatMap(([key, value]) => ['--setenv', key, value!]),
      ...['/usr', '/bin', '/lib', '/lib64', '/etc/ld.so.cache', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl', runtime]
        .flatMap(path => ['--ro-bind-try', path, path]),
      '--proc', '/proc', '--dev', '/dev', '--bind', directory, directory, '--chdir', directory, '--', binary, ...args]
  } else return fail('UNSUPPORTED_OS', 'Protected package operations require macOS or Linux.')
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(new URL('../../../lisp/supervisor.mjs', import.meta.url)),
      JSON.stringify({ command, args: argv, cwd: directory, env, group: true })],
      { cwd: directory, env, signal, timeout: 90000, maxBuffer: 262144 }, (error, stdout, stderr) => {
      if (signal.aborted) return reject(signal.reason)
      if (error && typeof error.code !== 'number') return reject(new Error('Protected package command failed or timed out.'))
      resolve({ code: error?.code as number ?? 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}
