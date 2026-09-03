import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const dsh = process.env.DSH_BIN ?? 'dsh'
const profile = 'web'
const expectedDshVersion = process.env.KIOKUKO_EXPECTED_DSH_VERSION ?? '0.1.2-alpha.5'
const requireDshCli = process.env.KIOKUKO_REQUIRE_DSH_CLI === '1'

async function run(command, args, env = {}) {
  return exec(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
    killSignal: 'SIGTERM',
  })
}

async function localDshSourceRoot() {
  const candidate = process.env.KIOKUKO_DSH_SOURCE_ROOT
    ?? (isAbsolute(dsh) ? resolve(dirname(dsh), '../../..') : undefined)
  if (candidate === undefined) return undefined
  try {
    await access(join(candidate, 'packages/core/agent-loop/lib/index.js'))
    return candidate
  } catch {
    return undefined
  }
}

async function runCordisComposition() {
  const sourceRoot = await localDshSourceRoot()
  await run(process.execPath, ['scripts/run-tests.mjs', 'tests/dsh/e2e'], sourceRoot === undefined
    ? {}
    : { KIOKUKO_DSH_SOURCE_ROOT: sourceRoot })
}

function startWebProfile(env) {
  const child = spawn(dsh, ['--profile', profile, '--no-open', '--port', '0'], {
    cwd: root,
    env: { ...process.env, ...env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let settled = false
  let timer
  const ready = new Promise((resolveReady, rejectReady) => {
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectReady(error)
      else resolveReady(value)
    }
    const observe = () => {
      const output = `${stdout}\n${stderr}`
      const url = output.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0]
      if (url && output.includes('[kiokuko-dsh] plugin loaded')) finish(null, { url })
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      observe()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      observe()
    })
    child.once('error', (error) => finish(error))
    child.once('exit', (code, signal) => {
      if (!settled) finish(new Error(`DSH web exited before readiness (code=${code}, signal=${signal})\n${stdout}\n${stderr}`))
    })
    timer = setTimeout(() => finish(new Error(`DSH web did not become ready within 30 seconds\n${stdout}\n${stderr}`)), 30_000)
  })
  return { child, ready, getOutput: () => `${stdout}\n${stderr}` }
}

async function stopWebProfile(processHandle) {
  if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
    if (processHandle.child.exitCode !== 0 || processHandle.child.signalCode !== null) {
      throw new Error(`DSH web exited unexpectedly (code=${processHandle.child.exitCode}, signal=${processHandle.child.signalCode})\n${processHandle.getOutput()}`)
    }
    return
  }
  const exited = new Promise((resolveExit) => processHandle.child.once('exit', (code, signal) => resolveExit({ code, signal })))
  processHandle.child.kill('SIGTERM')
  const result = await Promise.race([
    exited,
    new Promise((resolveExit) => setTimeout(() => resolveExit({ timeout: true }), 7_000)),
  ])
  if (result.timeout) {
    processHandle.child.kill('SIGKILL')
    throw new Error(`DSH web did not stop gracefully\n${processHandle.getOutput()}`)
  }
  if (result.code !== 0) throw new Error(`DSH web stopped unsuccessfully (code=${result.code}, signal=${result.signal})\n${processHandle.getOutput()}`)
}

async function runCliLifecycle() {
  const home = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-home-'))
  const output = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-pack-'))
  const cache = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-cache-'))
  const dataDirectory = join(home, 'kiokuko-data')
  const env = { DSH_HOME: home, KIOKUKO_DATA_DIR: dataDirectory, npm_config_cache: cache }
  let web
  try {
    try {
      await run(dsh, ['--help'], env)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        if (requireDshCli) throw new Error('DSH CLI is required for this verification but dsh is not installed')
        process.stdout.write(JSON.stringify({ cli: 'unsupported', reason: 'dsh executable is not installed' }) + '\n')
        return
      }
      throw error
    }
    const version = await run(dsh, ['--version'], env)
    const dshVersion = `${version.stdout}${version.stderr}`.trim()
    if (!dshVersion.includes(expectedDshVersion)) throw new Error(`expected DSH ${expectedDshVersion}, got ${dshVersion}`)
    const packageCommit = (await run('git', ['rev-parse', 'HEAD'], env)).stdout.trim()
    if (!/^[0-9a-f]{40}$/u.test(packageCommit)) throw new Error('git did not return an exact package Commit')
    const workingTreeClean = (await run('git', ['status', '--porcelain'], env)).stdout.trim().length === 0
    const packed = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', output], env)).stdout)
    const packageMetadata = packed[0]
    const filename = packageMetadata?.filename
    if (typeof filename !== 'string') throw new Error('npm pack did not return a tarball')
    if (typeof packageMetadata?.version !== 'string' || packageMetadata.version.length === 0) throw new Error('npm pack did not return the package version')
    if (typeof packageMetadata?.integrity !== 'string' || packageMetadata.integrity.length === 0) throw new Error('npm pack did not return artifact integrity')
    const tarball = join(output, filename)
    await access(tarball)
    await run(dsh, ['plugin', '--profile', profile, 'add', tarball], env)
    const dumped = await run(dsh, ['--profile', profile, '--dump-config'], env)
    if ((dumped.stdout.match(/kiokuko-dsh\/dsh/g) ?? []).length !== 1) {
      throw new Error('dsh dump-config did not contain exactly one Kiokuko bundle')
    }
    web = startWebProfile(env)
    await web.ready
    if (web.child.exitCode !== null || web.child.signalCode !== null) throw new Error(`DSH web exited immediately after readiness\n${web.getOutput()}`)
    await stopWebProfile(web)
    await run(dsh, ['plugin', '--profile', profile, 'remove', 'kiokuko-dsh'], env)
    const afterRemove = await run(dsh, ['--profile', profile, '--dump-config'], env)
    if ((afterRemove.stdout.match(/kiokuko-dsh\/dsh/g) ?? []).length !== 0) {
      throw new Error('dsh bundle remained after removal')
    }
    const evidence = {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      cli: 'complete',
      profile,
      dshVersion: dshVersion.trim(),
      packageVersion: packageMetadata.version,
      packageCommit,
      workingTreeClean,
      packageIntegrity: packageMetadata.integrity,
      install: 'complete',
      web: 'started-and-stopped',
      uninstall: 'complete',
    }
    const evidencePath = process.env.KIOKUKO_DSH_EVIDENCE_PATH
    if (evidencePath) {
      await mkdir(dirname(evidencePath), { recursive: true })
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    }
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
  } finally {
    if (web && web.child.exitCode === null && web.child.signalCode === null) {
      try {
        await stopWebProfile(web)
      } catch {
        web.child.kill('SIGKILL')
      }
    }
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(output, { recursive: true, force: true }),
      rm(cache, { recursive: true, force: true }),
    ])
  }
}

await access(join(root, 'dist/dsh/index.js'))
await access(join(root, 'dsh/cordis.patch.yml'))
await runCordisComposition()
await runCliLifecycle()
