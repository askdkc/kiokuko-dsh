import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import YAML from 'yaml'
import * as plugin from '../../../src/dsh/index.js'
import { Config } from '../../../src/dsh/config.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const patchPath = join(repositoryRoot, 'dsh/cordis.patch.yml')
const packagePath = join(repositoryRoot, 'package.json')

async function run(command: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  return execFileAsync(command, [...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024 * 8,
  })
}

async function hasDshCommand(): Promise<boolean> {
  const command = process.env.DSH_BIN ?? 'dsh'
  try {
    await run(command, ['--help'])
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return false
    throw error
  }
}

test('dsh bundle manifest has one named Kiokuko Cordis row and no default export', async () => {
  const packageManifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
    exports?: Record<string, unknown>
    files?: string[]
    peerDependencies?: Record<string, string>
    name?: string
    scripts?: Record<string, string>
    dsh?: { bundle?: { patch?: string }; client?: { platform?: string; inject?: string[] } }
  }
  assert.equal(packageManifest.name, 'kiokuko-dsh')
  assert.equal(packageManifest.scripts?.prepare, 'npm run build')
  assert.deepEqual(Object.keys(packageManifest.exports ?? {}), ['.', './client', './dsh'])
  assert.deepEqual(packageManifest.exports?.['.'], {
    types: './dist/index.d.ts',
    default: './dist/index.js',
  })
  assert.deepEqual(packageManifest.exports?.['./client'], {
    types: './dist/client.d.ts',
    default: './dist/client.cjs',
  })
  assert.deepEqual(packageManifest.exports?.['./dsh'], {
    types: './dist/dsh/index.d.ts',
    default: './dist/dsh/index.js',
  })
  assert.equal(packageManifest.dsh?.bundle?.patch, './dsh/cordis.patch.yml')
  assert.equal(packageManifest.dsh?.client?.platform, 'web')
  assert.ok(packageManifest.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-session'))
  assert.ok(packageManifest.files?.includes('dsh/cordis.patch.yml'))
  assert.equal(packageManifest.peerDependencies?.['@deepseek-ai/cordis'], '^4.0.2')

  const patch = YAML.parse(await readFile(patchPath, 'utf8')) as Array<{
    id?: string
    disabled?: boolean
    insert?: Array<{ id?: string; name?: string; inject?: string[] }>
  }>
  assert.equal(patch.length, 2)
  assert.equal(patch[0]?.id, 'session-log-download')
  assert.equal(patch[0]?.disabled, true)
  assert.equal(patch[1]?.insert?.length, 1)
  assert.equal(patch[1]?.insert?.[0]?.id, 'kiokuko-dsh')
  assert.equal(patch[1]?.insert?.[0]?.name, 'kiokuko-dsh')
  assert.ok(patch[1]?.insert?.[0]?.inject?.includes('connection'))
  assert.ok(patch[1]?.insert?.[0]?.inject?.includes('attachments'))
  assert.deepEqual(Config.parse({}), { enabled: true })

  await run('npm', ['run', 'build'])
  await access(join(repositoryRoot, 'dist/dsh/index.js'))
  assert.equal(plugin.name, 'kiokuko-dsh')
  assert.equal('default' in plugin, false)

  const packageOutput = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-pack-'))
  const npmCache = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-npm-cache-'))
  try {
    const packed = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', packageOutput], {
      npm_config_cache: npmCache,
      npm_config_dry_run: 'false',
    })).stdout) as Array<{ filename?: string }>
    const filename = packed[0]?.filename
    assert.ok(filename)
    const tarball = join(packageOutput, filename)
    const archive = await run('tar', ['-tzf', tarball])
    assert.match(archive.stdout, /package\/dist\/dsh\/index\.js\n/)
    assert.match(archive.stdout, /package\/dist\/dsh\/index\.d\.ts\n/)
    assert.match(archive.stdout, /package\/dist\/index\.js\n/)
    assert.match(archive.stdout, /package\/dist\/client\.cjs\n/)
    assert.match(archive.stdout, /package\/dsh\/cordis\.patch\.yml\n/)
  } finally {
    await Promise.all([
      rm(packageOutput, { recursive: true, force: true }),
      rm(npmCache, { recursive: true, force: true }),
    ])
  }
})

test('Cordis loads and unloads the bootstrap effect without residue', async () => {
  const context = new Context()
  const fiber = context.plugin(plugin, { enabled: true })
  await fiber
  assert.deepEqual(fiber.getEffects().map((effect) => effect.label), ['kiokuko-dsh composition'])
  await fiber.dispose()
  assert.deepEqual(fiber.getEffects(), [])
})

test('dsh installs and removes the packed bundle in an isolated profile', {
  skip: !(await hasDshCommand()) ? 'dsh CLI is not installed; set DSH_BIN to dsh 0.1.2-rc.1' : false,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-home-'))
  const packageOutput = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-pack-'))
  const npmCache = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-npm-cache-'))
  try {
    const packed = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', packageOutput], {
      npm_config_cache: npmCache,
      npm_config_dry_run: 'false',
    })).stdout) as Array<{ filename?: string }>
    const filename = packed[0]?.filename
    assert.ok(filename)
    const tarball = join(packageOutput, filename)
    await access(tarball)

    const env = { DSH_HOME: home, npm_config_dry_run: 'false' }
    const install = await run(process.env.DSH_BIN ?? 'dsh', [
      'plugin', '--profile', 'web', 'add', tarball,
    ], env)
    assert.ok(install.stdout !== undefined)

    const dumped = await run(process.env.DSH_BIN ?? 'dsh', [
      '--profile', 'web', '--dump-config',
    ], env)
    const installedRows = YAML.parseDocument(dumped.stdout).toJS() as Array<Record<string, unknown>>
    assert.equal(installedRows.filter(row => row.id === 'kiokuko-dsh' && row.name === 'kiokuko-dsh' && row.disabled !== true).length, 1)
    assert.equal(installedRows.filter(row => row.id === 'session-log-download'
      && row.name === '@deepseek-ai/dsh-session-log-export' && row.disabled === true).length, 1)

    const remove = await run(process.env.DSH_BIN ?? 'dsh', [
      'plugin', '--profile', 'web', 'remove', 'kiokuko-dsh',
    ], env)
    assert.ok(remove.stdout !== undefined)

    const afterRemove = await run(process.env.DSH_BIN ?? 'dsh', [
      '--profile', 'web', '--dump-config',
    ], env)
    const removedRows = YAML.parseDocument(afterRemove.stdout).toJS() as Array<Record<string, unknown>>
    assert.equal(removedRows.filter(row => row.id === 'kiokuko-dsh' || row.name === 'kiokuko-dsh').length, 0)
    assert.equal(removedRows.filter(row => row.id === 'session-log-download'
      && row.name === '@deepseek-ai/dsh-session-log-export' && row.disabled !== true).length, 1)
  } finally {
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(packageOutput, { recursive: true, force: true }),
      rm(npmCache, { recursive: true, force: true }),
    ])
  }
})
