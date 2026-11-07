import { isolateSkillHome } from '../helpers/skill-home.js'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { access, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import YAML from 'yaml'
import { satisfies } from 'semver'
import * as plugin from '../../../src/dsh/index.js'
import { Config } from '../../../src/dsh/config.js'
import { webTarballInstallArgs } from '../../../scripts/web-test-install.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const patchPath = join(repositoryRoot, 'dsh/cordis.patch.yml')
const packagePath = join(repositoryRoot, 'package.json')

async function run(command: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  return execFileAsync(command, [...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024 * 8,
    timeout: 60_000,
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
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'kiokuko-bundle-source-'))
  // Match the verifier's working-tree inventory, including new source files
  // before staging. A local source install must test the actual current source.
  const files = (await run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout.split('\0').filter(name => name && !name.startsWith('micro-judge/'))
  const packageCommand = (command: string, args: readonly string[], env?: NodeJS.ProcessEnv) =>
    execFileAsync(command, [...args], { cwd: fixtureRoot, env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024, timeout: 60_000 })
  try {
    for (const name of files) {
      const source = join(repositoryRoot, name), destination = join(fixtureRoot, name)
      let info
      try { info = await lstat(source) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      await mkdir(join(destination, '..'), { recursive: true })
      if (info.isSymbolicLink()) await symlink(await readlink(source), destination)
      else if (info.isFile()) await copyFile(source, destination)
    }
    // CI-generated native binaries and their merged manifest form one artifact set, including untracked outputs.
    await cp(join(repositoryRoot, 'micro-judge'), join(fixtureRoot, 'micro-judge'), { recursive: true })
    await symlink(join(repositoryRoot, 'node_modules'), join(fixtureRoot, 'node_modules'), 'dir')
    const packagePath = join(fixtureRoot, 'package.json'), patchPath = join(fixtureRoot, 'dsh/cordis.patch.yml')
    const packageManifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
      exports?: Record<string, unknown>
      files?: string[]
      peerDependencies?: Record<string, string>
      dependencies?: Record<string, string>
      name?: string
      scripts?: Record<string, string>
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string; inject?: string[] } }
    }
    assert.equal(packageManifest.name, 'kiokuko-dsh')
    assert.ok(packageManifest.scripts?.prepare?.trim(), 'source installs must declare a prepare hook')
    assert.ok(packageManifest.files?.includes('scripts/prepare-build.mjs'), 'the prepare helper must ship with the package')
    assert.deepEqual(Object.keys(packageManifest.exports ?? {}), ['.', './client', './dsh', './core', './harness', './modules/lisp', './package.json', './locale/*.json', './models'])
    assert.equal(packageManifest.exports?.['./package.json'], './package.json')
    assert.equal(packageManifest.exports?.['./locale/*.json'], './dist/locale/*.json')
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
    assert.ok(packageManifest.files?.includes('dsh/cordis.patch.yml') || packageManifest.files?.includes('dsh/'), 'Bundle patch must be covered by the published file inventory')
    const cordis = JSON.parse(await readFile(join(fixtureRoot, 'node_modules/@deepseek-ai/cordis/package.json'), 'utf8'))
    const cordisRange = packageManifest.peerDependencies?.['@deepseek-ai/cordis']
    assert.ok(cordisRange && satisfies(cordis.version, cordisRange, { includePrerelease: true }), 'the published peer range must admit the Cordis version used by native tests')
    for (const name of ['agenticreplay']) {
      const range = packageManifest.dependencies?.[name]
      assert.ok(range, `${name} must be installed as a runtime dependency`)
      for (const version of ['0.1.2', '0.2.0']) {
        assert.ok(satisfies(version, range), `${name} must admit ${version} without editing Kiokuko`)
      }
      assert.equal(satisfies('1.0.0', range), false, `${name} major API changes require an explicit review`)
    }
    assert.ok(!Object.keys(packageManifest.dependencies ?? {}).some(name => name.startsWith('@agenticreplay/')),
      'libraries are resolved from the published distribution, not independently installed')

    const patch = YAML.parse(await readFile(patchPath, 'utf8')) as Array<{
      id?: string
      disabled?: boolean
      insert?: Array<{ id?: string; name?: string; inject?: string[]; config?: Config }>
    }>
    assert.equal(patch.length, 2)
    assert.equal(patch.some(row => row.id === 'session-log-download'), false, 'The bundle must not patch the Web-only exporter')
    assert.equal(patch.find(row => row.id === 'agent-loop')?.disabled, true, 'The bundle must disable the stock factory')
    const inserted = patch.flatMap(row => row.insert ?? [])
    assert.equal(inserted.length, 3)
    assert.equal(new Set(inserted.map(row => row.id)).size, 3)
    const modelRow = inserted.find(row => row.id === 'kiokuko-models'), executionRow = inserted.find(row => row.id === 'kiokuko-dsh')
    const harnessRow = inserted.find(row => row.id === 'kiokuko-harness')
    assert.equal(harnessRow?.name, 'kiokuko-dsh/harness')
    for (const service of ['agents', 'sessions', 'llm', 'sessionProjections']) assert.ok(harnessRow?.inject?.includes(service))
    assert.ok(executionRow?.inject?.includes('kiokukoHarness'), 'Execution must use the replacement factory')
    assert.deepEqual(modelRow, { id: 'kiokuko-models', name: 'kiokuko-dsh/models', inject: ['llm', 'commands'] })
    assert.equal(executionRow?.id, 'kiokuko-dsh')
    assert.equal(executionRow?.name, 'kiokuko-dsh')
    assert.ok(!executionRow?.inject?.includes('connection'), 'Web connection must not gate TUI core startup')
    assert.ok(executionRow?.inject?.includes('attachments'))
    assert.ok(executionRow?.inject?.includes('sessionPersistence'))
    assert.ok(executionRow?.inject?.includes('subagents'))
    assert.equal(Config.parse({}).enabled, true)
    assert.equal(Config.parse({}).agenticReplay.enabled, true)
    const bundledConfig = executionRow?.config
    assert.equal(bundledConfig?.agenticReplay?.enabled, true)
    assert.equal(Config.parse(bundledConfig).agenticReplay.storage, 'project')

    const builtEntry = join(fixtureRoot, 'dist/dsh/index.js')
    // Exercise the public hook and reject a successful no-op using stale dist.
    await rm(builtEntry, { force: true })
    await packageCommand('npm', ['run', 'prepare'], { KIOKUKO_CI_DEFER_PREPARE: '' })
    await access(builtEntry)
    assert.equal(plugin.name, 'kiokuko-dsh')
    assert.equal('default' in plugin, false)

    const packageOutput = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-pack-'))
    const npmCache = await mkdtemp(join(tmpdir(), 'kiokuko-dsh-npm-cache-'))
    try {
      const packed = JSON.parse((await packageCommand('npm', ['pack', '--json', '--pack-destination', packageOutput], {
        npm_config_cache: npmCache,
        npm_config_dry_run: 'false',
      })).stdout) as Array<{ filename?: string }>
      const filename = packed[0]?.filename
      assert.ok(filename)
      const tarball = join(packageOutput, filename)
      const archive = await packageCommand('tar', ['-tzf', tarball])
      assert.match(archive.stdout, /package\/dist\/dsh\/index\.js\n/)
      assert.match(archive.stdout, /package\/dist\/dsh\/index\.d\.ts\n/)
      assert.match(archive.stdout, /package\/dist\/index\.js\n/)
      assert.match(archive.stdout, /package\/dist\/client\.cjs\n/)
      assert.match(archive.stdout, /package\/dsh\/cordis\.patch\.yml\n/)
      assert.match(archive.stdout, /package\/scripts\/prepare-build\.mjs\n/)
      const packedPrepare = await packageCommand('tar', ['-xOzf', tarball, 'package/scripts/prepare-build.mjs'])
      assert.equal(packedPrepare.stdout, await readFile(join(fixtureRoot, 'scripts/prepare-build.mjs'), 'utf8'),
        'the packed prepare helper must match the source exercised by this test')
      const installedPatch = YAML.parse((await packageCommand('tar', ['-xOzf', tarball, 'package/dsh/cordis.patch.yml'])).stdout) as typeof patch
      assert.deepEqual(installedPatch, patch, 'the installed bundle retains both independent provider and execution rows')
      const installedExecution = installedPatch.flatMap(row => row.insert ?? []).find(row => row.id === 'kiokuko-dsh')
      assert.ok(installedExecution?.inject?.includes('subagents'))
      assert.equal(installedExecution?.config?.agenticReplay?.enabled, true)
    } finally {
      await Promise.all([
        rm(packageOutput, { recursive: true, force: true }),
        rm(npmCache, { recursive: true, force: true }),
      ])
    }
  } finally { await rm(fixtureRoot, { recursive: true, force: true }) }
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
    // The manifest test exercises source prepare in its own checkout. Package
    // the selected build here so the install test cannot rebuild shared dist.
    const packed = JSON.parse((await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packageOutput], {
      npm_config_cache: npmCache,
      npm_config_dry_run: 'false',
    })).stdout) as Array<{ filename?: string }>
    const filename = packed[0]?.filename
    assert.ok(filename)
    const tarball = join(packageOutput, filename)
    await access(tarball)

    const env = { DSH_HOME: home, npm_config_dry_run: 'false' }
    const install = await run(process.env.DSH_BIN ?? 'dsh', webTarballInstallArgs(tarball, home), env)
    assert.ok(install.stdout !== undefined)
    if (process.env.KIOKUKO_REQUIRE_LISP_RUNTIME === '1') {
      const installedPackage = join(home, 'profiles/web/node_modules/kiokuko-dsh')
      await run(process.execPath, ['scripts/smoke-installed-lisp.mjs', installedPackage], env)
    }

    const dumped = await run(process.env.DSH_BIN ?? 'dsh', [
      '--profile', 'web', '--dump-config',
    ], env)
    const installedRows = YAML.parseDocument(dumped.stdout).toJS() as Array<Record<string, unknown>>
    assert.equal(installedRows.filter(row => row.id === 'kiokuko-models' && row.name === 'kiokuko-dsh/models' && row.disabled !== true).length, 1)
    assert.equal(installedRows.filter(row => row.id === 'kiokuko-dsh' && row.name === 'kiokuko-dsh' && row.disabled !== true).length, 1)
    assert.equal(installedRows.filter(row => row.id === 'session-log-download'
      && row.name === '@deepseek-ai/dsh-session-log-export' && row.disabled !== true).length, 1)

    const remove = await run(process.env.DSH_BIN ?? 'dsh', [
      'plugin', '--profile', 'web', 'remove', 'kiokuko-dsh',
    ], env)
    assert.ok(remove.stdout !== undefined)

    const afterRemove = await run(process.env.DSH_BIN ?? 'dsh', [
      '--profile', 'web', '--dump-config',
    ], env)
    const removedRows = YAML.parseDocument(afterRemove.stdout).toJS() as Array<Record<string, unknown>>
    assert.equal(removedRows.filter(row => row.id === 'kiokuko-models' || row.name === 'kiokuko-dsh/models').length, 0)
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

// Isolate the plugin's startup deployment from the user's Skill directory.
isolateSkillHome()

const sourceCli = '/checkout/apps/cli/src/bin.ts'
const builtRoot = join(repositoryRoot, 'dist')

for (const scenario of ['missing', 'incompatible', 'success'] as const) {
  test(`built Cordis entry diagnoses ${scenario} imports without installed dependencies`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiokuko-startup-entry-'))
    try {
      await mkdir(join(root, 'dsh'))
      await writeFile(join(root, 'package.json'), '{"type":"module"}')
      await copyFile(join(builtRoot, 'index.js'), join(root, 'plugin.js'))
      await copyFile(join(builtRoot, 'dsh/startup-recovery.js'), join(root, 'dsh/startup-recovery.js'))
      if (scenario !== 'missing') await writeFile(join(root, 'plugin-runtime.js'), scenario === 'incompatible'
        ? 'throw new Error("fixture incompatible host API")'
        : 'export const name="kiokuko-dsh", inject={}, Config={}; export function apply() {}')
      const code = `process.argv = ['node', ${JSON.stringify(sourceCli)}, 'web']; await import(${JSON.stringify(pathToFileURL(join(root, 'plugin.js')).href)})`
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
        cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8', timeout: 10_000,
      })
      assert.ifError(child.error)
      if (scenario === 'success') {
        assert.equal(child.status, 0, child.stderr)
        assert.equal(child.stderr, '')
      } else {
        assert.notEqual(child.status, 0)
        assert.match(child.stderr, scenario === 'missing' ? /ERR_MODULE_NOT_FOUND/ : /fixture incompatible host API/)
        assert.match(child.stderr, /pnpm dsh plugin --profile web update kiokuko-dsh --latest/)
        assert.match(child.stderr, /Do not delete session logs/)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

// Run the delivered readers outside the repository: devDependencies must not mask missing imports.
test('bundled v0/v1/v2 history readers preserve physical records without another DSH runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kiokuko-isolated-codecs-'))
  try {
    const path = join(root, 'codecs.mjs')
    await copyFile(resolve(import.meta.dirname, '../../../dist/dsh/legacy-session-codecs.js'), path)
    const code = `
      import assert from 'node:assert/strict';
      const codecs = await import(${JSON.stringify(pathToFileURL(path).href)});
      for (const version of [0, 1, 2]) {
        const codec = codecs['releasedV' + version + 'SessionFormatCodec'];
        const header = { type: 'session', version, id: 'legacy-fixture', createdAt: 1,
          delegationDepth: 0, cwd: '/tmp/legacy-fixture', ...(version === 2 ? { isSeeded: false } : {}) };
        const decoder = codec.createDecoder(header, 'strict');
        const row = { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: {
          id: 'message-1', role: 'user', content: [{ type: 'text', text: 'Historical fixture' }], source: { kind: 'user' } } };
        const rows = [];
        const context = { emitEvent(event) { rows.push(event) }, emitRun(run) { rows.push(...run.expand()) } };
        decoder.decodeRow(row, context);
        assert.equal(decoder.finish(context), 0);
        assert.equal(decoder.header.id, header.id);
        assert.equal(decoder.header.version, version);
        assert.deepEqual(rows, [row]);
        assert.throws(() => codec.createDecoder({ ...header, id: 42 }, 'strict'), /id/);
        const invalid = codec.createDecoder(header, 'strict');
        assert.throws(() => invalid.decodeRow({ ...row, seq: 10 }, context), /seq|sequence/i);
      }
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8', timeout: 10_000,
    })
    assert.ifError(child.error)
    assert.equal(child.status, 0, child.stderr)
  } finally { await rm(root, { recursive: true, force: true }) }
})
