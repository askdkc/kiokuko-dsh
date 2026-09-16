import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createSocket } from 'node:dgram'
import { createServer, type Server } from 'node:net'
import { tmpdir, release } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyIsolation, parseNativeObservations, unverifiedRequirements, type P0Report, type ProbeCheck } from './report.js'

interface ProcessResult { code: number | string | null; signal: string | null; stdout: string; stderr: string }

/** Only finite, trusted probe programs run here. No user/project code is loaded. */
function run(file: string, args: readonly string[], cwd: string): Promise<ProcessResult> {
  return new Promise(resolve => {
    execFile(file, args, {
      cwd, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin', LANG: 'C', TMPDIR: cwd },
      timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? null : 0, signal: error?.signal ?? null, stdout, stderr })
    })
  })
}

function listen(server: Server, target: number | string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    const ready = () => { server.off('error', reject); resolve() }
    if (typeof target === 'number') server.listen(target, '127.0.0.1', ready)
    else server.listen(target, ready)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) { resolve(); return }
    server.close(error => error ? reject(error) : resolve())
  })
}

/** This is deliberately a candidate profile, never a runtime admission policy. */
export function seatbeltProfile(root: string, allowFork = true): string {
  // The only varying path is our own mkdtemp root, not model input.
  if (!path.isAbsolute(root) || /[\x00-\x1f"\\]/u.test(root)) throw new Error('Unsupported fixture path')
  return `(version 1)
(deny default)
${allowFork ? '(allow process-fork)' : '(deny process-fork)'}
(allow process-exec (literal "${root}/probe"))
(allow signal (target self) (target children))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read-data (literal "/"))
(allow file-read* file-map-executable (subpath "/System/Cryptexes/OS")
  (subpath "/System/Volumes/Preboot/Cryptexes/OS") (literal "${root}/probe"))
(allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/System/Library")
  (literal "${root}/probe") (literal "${root}/input"))
(allow file-read* file-write* (subpath "${root}/scratch"))
(allow file-read* file-write* (literal "/dev/null"))
`
}

async function resourceProbes(root: string): Promise<ProbeCheck[]> {
  const executable = path.join(root, 'probe')
  const compile = await run('cc', ['-std=c11', '-D_DEFAULT_SOURCE', '-Wall', '-Wextra', '-Werror', '-pthread',
    fileURLToPath(new URL('./resource-probe.c', import.meta.url)), '-o', executable], root)
  if (compile.code !== 0) return [{ id: 'resource-build', status: 'unavailable', detail: compile.stderr.trim() }]
  const checks: ProbeCheck[] = []
  const address = await run(executable, ['address-space'], root)
  if (address.code === 0) {
    const value = JSON.parse(address.stdout)
    checks.push({ id: 'rlimit-as-sample', status: value.baselineError === 0 && value.setLimitError === 0 && value.limitedError === 12 ? 'passed' : 'unverified',
      detail: address.stdout.trim() + ' — Address-space allocation only; not an aggregate physical-memory guarantee.' })
  } else checks.push({ id: 'rlimit-as-sample', status: 'unverified', detail: JSON.stringify(address) })
  if (process.platform !== 'darwin') return checks
  const baseline = await run(executable, ['fork'], root)
  const profile = path.join(root, 'no-fork.sb')
  await writeFile(profile, seatbeltProfile(root, false), { mode: 0o600 })
  const fork = await run('/usr/bin/sandbox-exec', ['-f', profile, executable, 'fork'], root)
  const control = baseline.code === 0 ? JSON.parse(baseline.stdout) : null
  const confined = fork.code === 0 ? JSON.parse(fork.stdout) : null
  checks.push({ id: 'fork-denial-sample', status: control?.forkError !== 0 ? 'unverified'
    : confined && [1, 13].includes(confined.forkError) ? 'passed' : 'failed',
    detail: JSON.stringify({ baseline, confined: fork }) + ' — One bounded fork; not complete process/IPC isolation.' })
  const threads = await run('/usr/bin/sandbox-exec', ['-f', profile, executable, 'threads'], root)
  const observation = threads.code === 0 ? JSON.parse(threads.stdout) : null
  checks.push({ id: 'rlimit-nproc-thread-counterexample', status: observation?.rlimitNproc === 1 && observation.createdThreads === 40 ? 'passed' : 'unverified',
    detail: JSON.stringify(threads) + ' — Fork denial and RLIMIT_NPROC do not establish the 32-task limit.' })
  return checks
}

async function runNativeProbes(root: string): Promise<ProbeCheck[]> {
  const checks: ProbeCheck[] = []
  const executable = path.join(root, 'probe')
  const compile = await run('cc', ['-std=c11', '-D_DEFAULT_SOURCE', '-Wall', '-Wextra', '-Werror',
    fileURLToPath(new URL('./native-probe.c', import.meta.url)), '-o', executable], root)
  if (compile.code !== 0) return [{ id: 'native-build', status: 'unavailable', detail: compile.stderr.trim() || 'C compiler unavailable' }]
  checks.push({ id: 'native-build', status: 'passed', detail: 'Built finite development fixture in private temporary directory.' })
  const scratch = path.join(root, 'scratch')
  await mkdir(scratch)
  await writeFile(path.join(root, 'input'), 'input fixture', { mode: 0o600 })
  await writeFile(path.join(root, 'private'), 'private fixture', { mode: 0o600 })
  const fileLimit = await run(executable, ['fsize', scratch], root)
  checks.push({ id: 'rlimit-fsize-counterexample', status: fileLimit.code === 0 ? 'passed' : 'unverified',
    detail: fileLimit.code === 0 ? fileLimit.stdout.trim() + ' — RLIMIT_FSIZE cannot stand in for aggregate scratch quota.' : fileLimit.stderr.trim() })

  const tcp = createServer(socket => socket.end())
  const unix = createServer(socket => socket.end())
  const udp = createSocket('udp4')
  let udpBound = false
  try {
    const socketPath = path.join(root, 's')
    // sockaddr_un includes a trailing NUL; macOS has the shorter (104-byte) field.
    if (Buffer.byteLength(socketPath) >= (process.platform === 'darwin' ? 104 : 108)) {
      throw new Error('Fixture temporary path is too long for a Unix socket; use a shorter TMPDIR.')
    }
    await listen(tcp, 0)
    await listen(unix, socketPath)
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject)
      udp.bind(0, '127.0.0.1', () => { udp.off('error', reject); udpBound = true; resolve() })
    })
    const tcpAddress = tcp.address()
    if (!tcpAddress || typeof tcpAddress === 'string') throw new Error('Missing fixture TCP address')
    const args = [scratch, path.join(root, 'input'), path.join(root, 'private'), String(tcpAddress.port), String(udp.address().port), socketPath]
    const baseline = await run(executable, args, root)
    if (baseline.code !== 0) return [...checks, { id: 'positive-control', status: 'unverified', detail: baseline.stderr.trim() || 'Native control could not run' }]
    const baselineRows = parseNativeObservations(baseline.stdout)
    await rm(path.join(scratch, 'output-0'), { force: true })
    await rm(path.join(scratch, 'output-1'), { force: true })
    if (process.platform !== 'darwin') return [...checks, { id: 'sandbox-candidate', status: 'unverified', detail: 'Linux bwrap/cgroup/quota prototype still requires a delegated Linux test environment.' }]
    const profile = path.join(root, 'profile.sb')
    await writeFile(profile, seatbeltProfile(root), { mode: 0o600 })
    const confined = await run('/usr/bin/sandbox-exec', ['-f', profile, executable, ...args], root)
    if (confined.code !== 0 || confined.signal) return [...checks, { id: 'sandbox-candidate', status: 'unavailable', detail: JSON.stringify(confined) }]
    checks.push(...classifyIsolation(baselineRows, parseNativeObservations(confined.stdout)))
    if (await readFile(path.join(root, 'input'), 'utf8') !== 'input fixture') {
      checks.push({ id: 'input-integrity', status: 'failed', detail: 'Input fixture changed.' })
    }
    return checks
  } catch (error) {
    return [...checks, { id: 'fixture-environment', status: 'unavailable', detail: error instanceof Error ? error.message : String(error) }]
  } finally {
    // Even fixture setup failure must close whichever endpoints started.
    const closed = await Promise.allSettled([
      closeServer(tcp), closeServer(unix),
      new Promise<void>(resolve => { if (udpBound) udp.close(resolve); else { try { udp.close(resolve) } catch { resolve() } } }),
    ])
    const failures = closed.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(item => item.reason), 'Fixture endpoint cleanup failed')
  }
}

export async function probeLispP0(): Promise<P0Report> {
  // Keep this suffix short: the test runner already adds its own temp directory.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lp0-')))
  const checks: ProbeCheck[] = []
  let sbcl = 'SBCL unavailable'
  try {
    const version = await run('sbcl', ['--version'], root)
    if (version.code === 0) sbcl = version.stdout.trim()
    checks.push({ id: 'sbcl-version', status: version.code === 0 ? 'passed' : 'unavailable', detail: sbcl + '; version discovery is not Lisp execution evidence.' })
    try {
      checks.push(...await runNativeProbes(root))
      checks.push(...await resourceProbes(root))
    }
    catch (error) {
      if (error instanceof AggregateError) throw error // Cleanup failure is a probe failure, not an unavailable backend.
      checks.push({ id: 'fixture-environment', status: 'unavailable', detail: error instanceof Error ? error.message : String(error) })
    }
    checks.push(...unverifiedRequirements())
    return { schemaVersion: 1, phase: 'P0', platform: process.platform, architecture: process.arch, kernel: release(),
      node: process.version, sbcl, backend: process.platform === 'darwin' ? 'Seatbelt candidate' : 'unverified', checks, readyForP1: false }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
