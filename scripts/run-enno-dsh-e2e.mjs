import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Script } from 'node:vm'
import YAML from 'yaml'

const exec = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const dsh = process.env.DSH_BIN ?? 'dsh'
const profile = 'web'
const expectedDshVersion = process.env.KIOKUKO_EXPECTED_DSH_VERSION ?? '0.1.2-rc.1'
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

function dumpedRows(result, label) {
  const document = YAML.parseDocument(result.stdout, { strict: true })
  if (document.errors.length > 0) {
    throw new Error(`${label} was not valid YAML: ${document.errors.map(String).join('; ')}`)
  }
  const rows = document.toJS()
  if (!Array.isArray(rows)) throw new Error(`${label} did not contain a top-level row array`)
  return rows
}

function relevantDump(rows, stderr) {
  const relevant = rows.filter(row => row !== null && typeof row === 'object'
    && (row.id === 'session-log-download' || row.id === 'kiokuko-dsh' || row.name === 'kiokuko-dsh'))
  return `${JSON.stringify(relevant, null, 2)}\nstderr:\n${stderr.trim().slice(-4096)}`
}

function assertInstalledDump(result) {
  const rows = dumpedRows(result, 'dsh dump-config after install')
  const kiokuko = rows.filter(row => row?.id === 'kiokuko-dsh'
    && row?.name === 'kiokuko-dsh' && row?.disabled !== true)
  const stock = rows.filter(row => row?.id === 'session-log-download'
    && row?.name === '@deepseek-ai/dsh-session-log-export' && row?.disabled === true)
  if (kiokuko.length !== 1 || stock.length !== 1) {
    throw new Error(`dsh dump-config did not contain one active Kiokuko row and one disabled stock export row\n${relevantDump(rows, result.stderr)}`)
  }
}

function assertRemovedDump(result) {
  const rows = dumpedRows(result, 'dsh dump-config after removal')
  const kiokuko = rows.filter(row => row?.id === 'kiokuko-dsh' || row?.name === 'kiokuko-dsh')
  const stock = rows.filter(row => row?.id === 'session-log-download'
    && row?.name === '@deepseek-ai/dsh-session-log-export' && row?.disabled !== true)
  if (kiokuko.length !== 0 || stock.length !== 1) {
    throw new Error(`dsh removal did not restore exactly one active stock export row\n${relevantDump(rows, result.stderr)}`)
  }
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

async function localDshPackageRoot() {
  const configured = process.env.KIOKUKO_DSH_PACKAGE_ROOT
  if (configured !== undefined) {
    const candidate = resolve(configured)
    try {
      await access(join(candidate, '@deepseek-ai/dsh-agent-loop/lib/index.js'))
      return candidate
    } catch {
      return undefined
    }
  }
  try {
    const binary = isAbsolute(dsh)
      ? dsh
      : (await run(process.platform === 'win32' ? 'where.exe' : 'which', [dsh])).stdout.trim().split(/\r?\n/u)[0]
    if (!binary) return undefined
    const candidate = resolve(dirname(await realpath(binary)), '../../..')
    await access(join(candidate, '@deepseek-ai/dsh-agent-loop/lib/index.js'))
    return candidate
  } catch {
    return undefined
  }
}

async function runCordisComposition() {
  const [sourceRoot, packageRoot] = await Promise.all([localDshSourceRoot(), localDshPackageRoot()])
  if (requireDshCli && sourceRoot === undefined && packageRoot === undefined) {
    throw new Error('Mandatory native DSH workflow coverage has no pinned runtime')
  }
  const result = await run(process.execPath, ['scripts/run-tests.mjs', 'tests/dsh/e2e'], {
    ...(sourceRoot === undefined ? {} : { KIOKUKO_DSH_SOURCE_ROOT: sourceRoot }),
    ...(packageRoot === undefined ? {} : { KIOKUKO_DSH_PACKAGE_ROOT: packageRoot }),
    ...(requireDshCli ? { KIOKUKO_REQUIRE_DSH_NATIVE: '1' } : {}),
  })
  if (requireDshCli && /\bskipped [1-9]\d*/u.test(result.stdout)) {
    throw new Error(`Mandatory native workflow tests were skipped:\n${result.stdout}`)
  }
  process.stdout.write(result.stdout)
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
      const url = output.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0]
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

function readBootManifest(html) {
  const marker = 'globalThis["__DSH_BOOT__"] = '
  const start = html.indexOf(marker)
  if (start < 0) throw new Error('DSH Web root did not contain __DSH_BOOT__')
  const valueStart = start + marker.length
  const end = html.indexOf('</script>', valueStart)
  if (end < 0) throw new Error('DSH Web root contained an unterminated __DSH_BOOT__ payload')
  const boot = JSON.parse(html.slice(valueStart, end))
  if (!Array.isArray(boot?.entries) || !Array.isArray(boot?.batches)) {
    throw new Error('DSH Web root contained an invalid __DSH_BOOT__ payload')
  }
  return boot
}

async function authenticatedWebRoot(tokenUrl) {
  const authentication = await fetch(tokenUrl, { redirect: 'manual' })
  if (authentication.status < 300 || authentication.status >= 400) {
    throw new Error(`DSH Web token exchange returned HTTP ${authentication.status}`)
  }
  const setCookie = authentication.headers.get('set-cookie')
  if (setCookie === null) throw new Error('DSH Web token exchange did not set an authentication cookie')
  const cookie = setCookie.split(';', 1)[0]
  const location = authentication.headers.get('location') ?? '/'
  const rootUrl = new URL(location, tokenUrl)
  const response = await fetch(rootUrl, { headers: { cookie } })
  if (!response.ok) throw new Error(`authenticated DSH Web root returned HTTP ${response.status}`)
  return { rootUrl, cookie, html: await response.text() }
}

async function verifyBrowserBundle(tokenUrl) {
  const { rootUrl, cookie, html } = await authenticatedWebRoot(tokenUrl)
  const boot = readBootManifest(html)
  const kiokuko = boot.entries.filter(entry => entry?.id === 'kiokuko-dsh')
  if (kiokuko.length !== 1) throw new Error(`DSH Web manifest contained ${kiokuko.length} Kiokuko client entries`)
  const application = boot.batches.find(batch => batch?.phase === 'application')
  if (typeof application?.url !== 'string') throw new Error('DSH Web manifest did not contain an application bundle')
  const response = await fetch(new URL(application.url, rootUrl), { headers: { cookie } })
  const source = await response.text()
  if (!response.ok) {
    throw new Error(`DSH application client bundle returned HTTP ${response.status}: ${source.slice(0, 4096)}`)
  }
  const registrations = new Map()
  const window = {
    __ModuleLoader__: {
      load(handoff) {
        if (typeof handoff?.id !== 'string' || typeof handoff?.factory !== 'function') {
          throw new Error('DSH application bundle registered an invalid client handoff')
        }
        registrations.set(handoff.id, handoff)
      },
    },
  }
  new Script(source, { filename: 'dsh-application-client.js' }).runInNewContext({ window }, { timeout: 15_000 })
  const handoff = registrations.get('kiokuko-dsh')
  if (handoff === undefined) throw new Error('DSH application bundle did not register the Kiokuko client')
  const requested = []
  const client = handoff.factory((specifier) => {
    requested.push(specifier)
    return {}
  })
  if (typeof client?.apply !== 'function' || typeof client?.downloadDshSessionLog !== 'function') {
    throw new Error('DSH could not materialize the Kiokuko client factory')
  }
  const expected = [
    '@deepseek-ai/dsh-client-store',
    'react/jsx-runtime',
    'react',
    '@deepseek-ai/dsh-client-ui-primitives',
  ]
  if (JSON.stringify(requested) !== JSON.stringify(expected)) {
    throw new Error(`Kiokuko client requested an unexpected DSH browser module set: ${JSON.stringify(requested)}`)
  }
  return { bytes: Buffer.byteLength(source), registrations: registrations.size }
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
    assertInstalledDump(dumped)
    web = startWebProfile(env)
    const ready = await web.ready
    if (web.child.exitCode !== null || web.child.signalCode !== null) throw new Error(`DSH web exited immediately after readiness\n${web.getOutput()}`)
    const browserBundle = await verifyBrowserBundle(ready.url)
    await stopWebProfile(web)
    await run(dsh, ['plugin', '--profile', profile, 'remove', 'kiokuko-dsh'], env)
    const afterRemove = await run(dsh, ['--profile', profile, '--dump-config'], env)
    assertRemovedDump(afterRemove)
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
      web: 'browser-bundle-loaded-and-materialized',
      browserBundle,
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
