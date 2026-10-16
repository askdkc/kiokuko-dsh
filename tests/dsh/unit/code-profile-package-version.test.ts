import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const run = promisify(execFile)
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const [major, minor, patch] = packageMetadata.version.split('.').map(Number)
const versions = [
  { expectedPackageVersion: packageMetadata.version, mismatch: false },
  { expectedPackageVersion: `${major + 1}.${minor}.${patch}`, mismatch: false },
  { expectedPackageVersion: packageMetadata.version, mismatch: true },
  { expectedPackageVersion: packageMetadata.version, mismatch: false, historical: true },
]

for (const { expectedPackageVersion, mismatch, historical = false } of versions) test(`packed fixture ${mismatch ? 'rejects a mismatched install' : 'follows local metadata'} (${expectedPackageVersion}/${historical ? 'historical' : 'current'})`, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'kiokuko-code-package-'))
  const json = async (path: string, value: unknown) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(value))
  }
  try {
    await mkdir(join(fixture, 'scripts'))
    await cp(join(root, 'scripts/install-code-profile.mjs'), join(fixture, 'scripts/install-code-profile.mjs'))
    await json(join(fixture, 'package.json'), { name: packageMetadata.name, version: expectedPackageVersion })
    await json(join(fixture, '.artifacts/code-intelligence/dsh-lsp-server/package.json'), { name: '@askdkc/dsh-lsp-server', version: '1.2.3' })
    // Selected host labels deliberately differ from the historical regression fixture.
    for (const [name, version] of [['dsh', '0.3.0'], ['cordis', '4.1.0']] as const) {
      await json(join(fixture, 'tests/fixtures/dsh-runtime/node_modules/@deepseek-ai', name, 'package.json'), { name: `@deepseek-ai/${name}`, version })
    }
    await json(join(fixture, 'scripts/code-profile-historical.json'), { '@deepseek-ai/dsh': '0.2.1-alpha.2', '@deepseek-ai/cordis': '4.0.5-alpha.1', '@askdkc/dsh-cli': '0.14.4' })
    const bin = join(fixture, 'bin')
    await mkdir(bin)
    const fakeNpm = join(bin, 'npm')
    await writeFile(fakeNpm, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), cwd = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
fs.appendFileSync(process.env.FIXTURE_COMMAND_LOG, JSON.stringify(args) + '\n');
if (args[0] === 'pack') {
  const destination = args[args.indexOf('--pack-destination') + 1];
  fs.writeFileSync(path.join(destination, 'fixture.tgz'), JSON.stringify(manifest));
} else if (args[0] === 'install') {
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    const installed = spec.startsWith('file:') ? JSON.parse(fs.readFileSync(spec.slice(5), 'utf8')) : { name, version: spec === 'latest' ? '1.2.3' : spec };
    if (name === process.env.FIXTURE_SUITE_NAME && process.env.FIXTURE_INSTALLED_VERSION) installed.version = process.env.FIXTURE_INSTALLED_VERSION;
    const target = path.join(cwd, 'node_modules', name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(installed));
  }
} else { throw new Error('Unexpected npm action: ' + args.join(' ')); }
`)
    await chmod(fakeNpm, 0o755)
    const envRoot = join(fixture, 'environment')
    await mkdir(envRoot)
    const log = join(fixture, 'commands.jsonl')
    const execute = () => run(process.execPath, [join(fixture, 'scripts/install-code-profile.mjs'), ...(historical ? ['--historical'] : [])], {
      cwd: fixture,
      timeout: 15000,
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: envRoot, TMPDIR: envRoot, XDG_CONFIG_HOME: envRoot, LANG: 'C.UTF-8', FIXTURE_COMMAND_LOG: log, FIXTURE_SUITE_NAME: packageMetadata.name, ...(mismatch ? { FIXTURE_INSTALLED_VERSION: `${major + 2}.${minor}.${patch}` } : {}) },
    })
    if (mismatch) {
      await assert.rejects(execute, (error: any) => error.code === 1 && error.stderr.includes('AssertionError') && error.stderr.includes(expectedPackageVersion))
      return
    }
    const result = await execute()
    assert.ok(result.stdout.includes('Installed packed provider and Kiokuko'))
    const installed = JSON.parse(await readFile(join(fixture, '.artifacts/code-intelligence/profile/node_modules', packageMetadata.name, 'package.json'), 'utf8'))
    assert.equal(installed.version, expectedPackageVersion)
    const profile = JSON.parse(await readFile(join(fixture, '.artifacts/code-intelligence/profile/package.json'), 'utf8'))
    assert.equal(profile.dependencies['@deepseek-ai/dsh'], historical ? '0.2.1-alpha.2' : '0.3.0', 'current selection and explicit historical regression are independent')
    assert.equal(profile.dependencies['@askdkc/dsh-cli'], historical ? '0.14.4' : 'latest', 'the normal installer follows the selected distribution')
    const commands = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(commands.map(args => args[0]), ['pack', 'pack', 'install'])
    assert.ok(commands.every(args => args.includes('--ignore-scripts')))
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
