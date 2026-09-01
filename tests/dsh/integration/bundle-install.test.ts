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
    dsh?: { bundle?: { patch?: string } }
  }
  assert.equal(packageManifest.name, 'kiokuko-dsh')
  assert.equal(packageManifest.scripts?.prepare, 'npm run build')
  assert.deepEqual(packageManifest.exports?.['./dsh'], {
    types: './dist/dsh/index.d.ts',
    default: './dist/dsh/index.js',
  })
  assert.equal(packageManifest.dsh?.bundle?.patch, './dsh/cordis.patch.yml')
  assert.ok(packageManifest.files?.includes('dsh/cordis.patch.yml'))
  assert.equal(packageManifest.peerDependencies?.['@deepseek-ai/cordis'], '^4.0.2')

  const patch = YAML.parse(await readFile(patchPath, 'utf8')) as Array<{ insert?: Array<{ name?: string }> }>
  const rows = patch.flatMap((operation) => operation.insert ?? [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.name, 'kiokuko-dsh/dsh')
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
    })).stdout) as Array<{ filename?: string }>
    const filename = packed[0]?.filename
    assert.ok(filename)
    const tarball = join(packageOutput, filename)
    const archive = await run('tar', ['-tzf', tarball])
    assert.match(archive.stdout, /package\/dist\/dsh\/index\.js\n/)
    assert.match(archive.stdout, /package\/dist\/dsh\/index\.d\.ts\n/)
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
  skip: !(await hasDshCommand()) ? 'dsh CLI is not installed; set DSH_BIN to dsh 0.1.2-alpha.3' : false,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-home-'))
  const packageOutput = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-pack-'))
  const npmCache = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-npm-cache-'))
  try {
    const packed = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', packageOutput], {
      npm_config_cache: npmCache,
    })).stdout) as Array<{ filename?: string }>
    const filename = packed[0]?.filename
    assert.ok(filename)
    const tarball = join(packageOutput, filename)
    await access(tarball)

    const env = { DSH_HOME: home }
    const install = await run(process.env.DSH_BIN ?? 'dsh', [
      'plugin', '--profile', 'kiokuko-test', 'add', tarball,
    ], env)
    assert.ok(install.stdout !== undefined)

    const dumped = await run(process.env.DSH_BIN ?? 'dsh', [
      '--profile', 'kiokuko-test', '--dump-config',
    ], env)
    assert.equal((dumped.stdout.match(/kiokuko-dsh\/dsh/g) ?? []).length, 1)

    const remove = await run(process.env.DSH_BIN ?? 'dsh', [
      'plugin', '--profile', 'kiokuko-test', 'remove', 'kiokuko-dsh',
    ], env)
    assert.ok(remove.stdout !== undefined)

    const afterRemove = await run(process.env.DSH_BIN ?? 'dsh', [
      '--profile', 'kiokuko-test', '--dump-config',
    ], env)
    assert.equal((afterRemove.stdout.match(/kiokuko-dsh\/dsh/g) ?? []).length, 0)
  } finally {
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(packageOutput, { recursive: true, force: true }),
      rm(npmCache, { recursive: true, force: true }),
    ])
  }
})
