import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertExpectedPatchWarning, assertKiokukoInstalled, assertRemoved, assertTuiServicesConfigured, parseRows } from './dsh-tui-e2e-assertions.mjs'

const root = resolve(import.meta.dirname, '..')
const fixture = join(root, 'tests/fixtures/dsh-tui-runtime-current')
const runtimeRoot = join(fixture, 'node_modules')
const dsh = process.env.DSH_BIN ?? join(runtimeRoot, '.bin/dsh')
const profile = 'dsh-tui'
const scratch = await mkdtemp(join(tmpdir(), 'kiokuko-tui-e2e-'))
const workspace = join(scratch, 'workspace')
const home = join(scratch, 'home')
const dshHome = join(scratch, 'dsh')
const output = join(scratch, 'pack')
const overlay = join(scratch, 'probe.patch.yml')
const missingServiceOverlay = join(scratch, 'missing-session.patch.yml')
const activeChildren = new Set()
const interrupted = new AbortController()
function stopChild(child, signal = 'SIGTERM') {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) { if (error?.code !== 'ESRCH') throw error }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted.abort(new Error(`TUI E2E interrupted by ${signal}`))
  for (const child of activeChildren) stopChild(child)
  setTimeout(() => { for (const child of activeChildren) stopChild(child, 'SIGKILL') }, 3000).unref()
})
const baseEnv = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  USERPROFILE: home,
  DSH_HOME: dshHome,
  KIOKUKO_DATA_DIR: join(scratch, 'data'),
  DSH_TUI_SESSION_ROOT: join(scratch, 'sessions'),
  XDG_CONFIG_HOME: join(scratch, 'xdg/config'),
  XDG_CACHE_HOME: join(scratch, 'xdg/cache'),
  XDG_DATA_HOME: join(scratch, 'xdg/data'),
  npm_config_cache: join(scratch, 'npm-cache'),
  npm_config_store_dir: join(scratch, 'pnpm-store'),
  PNPM_HOME: join(scratch, 'pnpm-home'),
  COREPACK_HOME: join(scratch, 'corepack'),
  XDG_STATE_HOME: join(scratch, 'xdg/state'),
  DSH_TELEMETRY_DISABLED: '1',
  CI: '1',
  DEEPSEEK_API_KEY: '',
}
async function run(command, args, cwd = workspace, timeout = 180_000) {
  interrupted.signal.throwIfAborted()
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: baseEnv, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    activeChildren.add(child)
    let stdout = '', stderr = '', failure
    const append = (part, chunk) => {
      const value = part + chunk.toString()
      if (value.length > 8 * 1024 * 1024) {
        failure = new Error(`TUI E2E command output exceeded 8 MiB: ${command}`)
        stopChild(child)
        return value.slice(0, 8 * 1024 * 1024)
      }
      return value
    }
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
    child.once('error', error => { failure = error })
    const timer = setTimeout(() => {
      failure = new Error(`TUI E2E command timed out: ${command}`)
      stopChild(child)
      setTimeout(() => { if (activeChildren.has(child)) stopChild(child, 'SIGKILL') }, 3000).unref()
    }, timeout)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      activeChildren.delete(child)
      const error = failure ?? (interrupted.signal.aborted ? interrupted.signal.reason : code === 0 ? undefined : new Error(`Command failed: ${command} ${args.join(' ')} (code=${code}, signal=${signal})`))
      if (error) {
        error.message += `\n${stderr.slice(-4000)}\n${stdout.slice(-1000)}`
        error.stdout = stdout; error.stderr = stderr; rejectRun(error)
      }
      else resolveRun({ stdout, stderr })
    })
  })
}
async function config() {
  const result = await run(dsh, ['--profile', profile, '--dump-config'])
  return { rows: parseRows(result.stdout), stderr: result.stderr }
}
async function probe(patch) {
  return run(process.execPath, [join(root, 'scripts/dsh-tui-core-probe.mjs'), runtimeRoot, patch], workspace, 60_000)
}
try {
  for (const dir of [workspace, home, dshHome, output]) await mkdir(dir, { recursive: true })
  await run('git', ['init', '-q'], workspace)
  const dshManifest = JSON.parse(await readFile(join(runtimeRoot, '@deepseek-ai/dsh/package.json'), 'utf8'))
  const tuiManifest = JSON.parse(await readFile(join(runtimeRoot, '@deepseek-harness-tui/dsh-tui/package.json'), 'utf8'))
  assert.equal(dshManifest.version, '0.1.7-rc.2')
  assert.equal(tuiManifest.version, '0.11.1')
  const version = await run(dsh, ['--version'])
  assert.match(version.stdout + version.stderr, /0\.1\.7-rc\.2/u)
  await run(dsh, ['plugin', '--profile', profile, 'add', '@deepseek-harness-tui/dsh-tui@0.11.1'], workspace, 300_000)
  const before = await config()
  assertTuiServicesConfigured(before.rows)
  const commit = (await run('git', ['rev-parse', 'HEAD'], root)).stdout.trim()
  const dirty = (await run('git', ['status', '--porcelain'], root)).stdout.trim().length > 0
  const packed = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', output], root, 300_000)).stdout)[0]
  assert.equal(packed.name, 'kiokuko-dsh')
  assert.ok(packed.integrity && packed.filename)
  await run(dsh, ['plugin', '--profile', profile, 'add', join(output, packed.filename)], workspace, 300_000)
  const installed = await config()
  assertKiokukoInstalled(installed.rows)
  assertTuiServicesConfigured(installed.rows)
  assertExpectedPatchWarning(installed.stderr)
  await writeFile(overlay, '- id: dsh-tui\n  disabled: true\n')
  const core = await probe(overlay)
  const marker = core.stdout.split(/\r?\n/u).find(line => line.startsWith('KIOKUKO_TUI_PROBE:'))
  assert.ok(marker, `native core probe did not finish: ${core.stdout.slice(-4000)} ${core.stderr.slice(-4000)}`)
  const coreEvidence = JSON.parse(marker.slice('KIOKUKO_TUI_PROBE:'.length))
  assert.ok(coreEvidence.commands.length > 0 && coreEvidence.tools.length > 0)
  await writeFile(missingServiceOverlay, '- id: dsh-tui\n  disabled: true\n- id: session-persistence-jsonl\n  disabled: true\n')
  await assert.rejects(() => probe(missingServiceOverlay), error =>
    /sessionPersistence|session-persistence-jsonl/u.test(`${error?.stderr ?? ''}\n${error?.message ?? ''}`),
  'a missing native session service must fail for the expected reason')
  await run(dsh, ['plugin', '--profile', profile, 'remove', 'kiokuko-dsh'], workspace, 300_000)
  const removed = await config()
  assertRemoved(before.rows, removed.rows)
  const evidence = { profile, dshVersion: dshManifest.version, tuiVersion: tuiManifest.version, kiokukoVersion: packed.version, commit, dirty, integrity: packed.integrity, composition: 'passed', core: coreEvidence, missingService: 'rejected', uninstall: 'restored' }
  if (process.env.KIOKUKO_DSH_EVIDENCE_PATH) {
    const file = resolve(process.env.KIOKUKO_DSH_EVIDENCE_PATH)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(evidence, null, 2) + '\n')
  }
  process.stdout.write(JSON.stringify(evidence) + '\n')
} catch (error) {
  if (process.env.KIOKUKO_DSH_EVIDENCE_PATH) {
    const file = resolve(process.env.KIOKUKO_DSH_EVIDENCE_PATH)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ profile, status: 'failed', reason: error instanceof Error ? error.message.slice(0, 3000) : String(error).slice(0, 3000) }, null, 2) + '\n')
  }
  throw error
} finally {
  await rm(scratch, { recursive: true, force: true })
}
