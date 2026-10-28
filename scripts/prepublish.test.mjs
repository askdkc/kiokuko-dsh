import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))

function publishFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'kiokuko-prepublish-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'))
  const wrapper = new URL('./prepublish.mjs', import.meta.url)
  if (existsSync(wrapper)) cpSync(wrapper, join(root, 'scripts/prepublish.mjs'))
  const userConfig = join(root, 'npmrc')
  writeFileSync(userConfig, 'allow-scripts=prepublish-fixture-dev\n')
  const env = { ...process.env, NODE_ENV: 'production', npm_config_userconfig: userConfig,
    NPM_CONFIG_USERCONFIG: userConfig, npm_config_cache: join(root, 'cache'),
    npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' }
  delete env.npm_config_allow_scripts
  delete env.NPM_CONFIG_ALLOW_SCRIPTS
  for (const kind of ['dev', 'optional']) {
    const directory = join(root, kind)
    mkdirSync(directory)
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      name: `prepublish-fixture-${kind}`, version: '1.0.0',
      scripts: { install: 'node -e "process.exit(91)"' },
    }))
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'kiokuko-prepublish-fixture', version: '1.0.0', type: 'module', files: ['dist'],
    scripts: {
      prepublishOnly: manifest.scripts.prepublishOnly,
      preinstall: 'node -e "process.exit(92)"',
      prepare: 'node prepare.mjs',
    },
    devDependencies: { 'prepublish-fixture-dev': 'file:./dev' },
    optionalDependencies: { 'prepublish-fixture-optional': 'file:./optional' },
  }))
  writeFileSync(join(root, 'prepare.mjs'), `
import { accessSync, mkdirSync, writeFileSync } from 'node:fs';
for (const name of ['dev', 'optional']) accessSync('node_modules/prepublish-fixture-' + name + '/package.json');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.js', 'export const prepared = true;');
`)
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: root, env, stdio: 'pipe', timeout: 30_000 })
  return { root, env }
}

for (const config of ['npmrc', 'environment']) {
  test(`publish dry-run installs build dependencies and prepares the archive with allow-scripts from ${config}`, t => {
    const { root, env } = publishFixture(t)
    if (config === 'environment') {
      env.npm_config_allow_scripts = 'prepublish-fixture-dev'
      env.NPM_CONFIG_ALLOW_SCRIPTS = 'prepublish-fixture-dev'
    }
    const result = spawnSync('npm', ['publish', '--dry-run', '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(readFileSync(join(root, 'dist/index.js'), 'utf8'), 'export const prepared = true;')
    assert.match(result.stdout, /dist\/index\.js/u)
    assert.equal(readFileSync(join(root, 'npmrc'), 'utf8'), 'allow-scripts=prepublish-fixture-dev\n')
  })
}

test('prepublish stops on a failed clean install before prepare or packaging', t => {
  const { root, env } = publishFixture(t)
  rmSync(join(root, 'package-lock.json'))
  const result = spawnSync('npm', ['publish', '--dry-run'], { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /EUSAGE/u)
  assert.equal(existsSync(join(root, 'dist')), false)
})
