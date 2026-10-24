import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageDshUpstream, upstreamIdentity, upstreamRepository } from './stage-dsh-upstream.mjs'
import { assertDshFixtureIdentity } from './dsh-fixture-identity.mjs'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-upstream-'))
  const source = join(base, 'source'), runtime = join(base, 'fixture')
  mkdirSync(source); mkdirSync(runtime)
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('remote', 'add', 'origin', upstreamRepository)
  writeFileSync(join(source, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*/*'] }))
  writeFileSync(join(source, '.gitignore'), 'lib/\n')
  for (const [path, name, entry] of [['apps/cli', 'dsh', 'bin.js'], ['packages/core/tools', 'dsh-tools', 'index.js'], ['packages/core/agent-loop', 'dsh-agent-loop', 'index.js']]) {
    mkdirSync(join(source, path, 'lib'), { recursive: true })
    writeFileSync(join(source, path, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '9.8.7-next.6', type: 'module' }))
    writeFileSync(join(source, path, 'lib', entry), name === 'dsh' ? 'if (import.meta.main) console.log(JSON.stringify(process.argv.slice(2)))\n' : '// disposable compiled fixture\n')
  }
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'isolated test input')
  const sha = git('rev-parse', 'HEAD')
  return { base, source, runtime, sha, git, close: () => rmSync(base, { recursive: true, force: true }) }
}

test('staging selects exact current source, removes obsolete packages, and preserves CLI support', () => {
  const f = fixture()
  try {
    mkdirSync(join(f.runtime, 'node_modules/@deepseek-ai/removed'), { recursive: true })
    mkdirSync(join(f.runtime, 'node_modules/@askdkc/dsh-cli'), { recursive: true })
    const development = join(f.base, 'development')
    const identity = stageDshUpstream(f.source, f.runtime, f.sha, development)
    assert.equal(identity.sha, f.sha)
    assert.equal(execFileSync(join(f.runtime, 'node_modules/.bin/dsh'), ['space in argument'], { encoding: 'utf8' }).trim(), '["space in argument"]')
    assert.equal(identity.version, '9.8.7-next.6', 'release labels are identity, not compatibility gates')
    assert.equal(existsSync(join(f.runtime, 'node_modules/@deepseek-ai/removed')), false)
    assert.equal(existsSync(join(f.runtime, 'node_modules/@askdkc/dsh-cli')), true)
    const installed = JSON.parse(readFileSync(join(f.runtime, 'node_modules/@deepseek-ai/dsh/package.json')))
    assert.equal(assertDshFixtureIdentity(f.runtime, installed).sha, f.sha)
    const obsolete = join(f.runtime, 'node_modules/@deepseek-ai/obsolete')
    mkdirSync(obsolete)
    assert.throws(() => assertDshFixtureIdentity(f.runtime, installed), /package scope differs/)
    rmSync(obsolete, { recursive: true })
    const tools = join(development, 'node_modules/@deepseek-ai/dsh-tools')
    rmSync(tools); symlinkSync(join(f.source, 'packages/core/agent-loop'), tools, 'dir')
    assert.throws(() => assertDshFixtureIdentity(f.runtime, installed), /package mapping is stale/)
  } finally { f.close() }
})

test('staging rejects changed SHA, wrong origin, dirty source, and missing build without changing the fixture', () => {
  const f = fixture()
  try {
    assert.throws(() => stageDshUpstream(f.source, f.runtime, '0'.repeat(40)), /selected full SHA/)
    assert.throws(() => upstreamIdentity(f.source, 'master'), /selected full SHA/)
    f.git('remote', 'set-url', 'origin', 'https://github.com/example/not-official.git')
    assert.throws(() => stageDshUpstream(f.source, f.runtime, f.sha), /official repository/)
    f.git('remote', 'set-url', 'origin', upstreamRepository)
    writeFileSync(join(f.source, 'injected.ts'), 'export const injected = true')
    assert.throws(() => stageDshUpstream(f.source, f.runtime, f.sha), /source changes/)
    rmSync(join(f.source, 'injected.ts'))
    writeFileSync(join(f.source, 'package.json'), '{}')
    assert.throws(() => stageDshUpstream(f.source, f.runtime, f.sha), /source changes/)
    f.git('checkout', '--', 'package.json')
    assert.throws(() => stageDshUpstream(f.source, f.source, f.sha), /must not change the official/ )
    rmSync(join(f.source, 'apps/cli/lib/bin.js'))
    assert.throws(() => stageDshUpstream(f.source, f.runtime, f.sha), /Build official DSH artifacts first/)
    assert.equal(existsSync(join(f.runtime, 'node_modules')), false)
  } finally { f.close() }
})

test('staging rejects source aliases and missing descendants before creating output', () => {
  const f = fixture()
  try {
    const alias = join(f.base, 'source-alias')
    symlinkSync(f.source, alias, 'dir')
    for (const destination of [alias, join(alias, 'missing', 'fixture')]) {
      assert.throws(() => stageDshUpstream(f.source, destination, f.sha), /must not change the official/)
      assert.throws(() => stageDshUpstream(f.source, f.runtime, f.sha, destination), /must not change the official/)
    }
    assert.equal(existsSync(join(f.source, 'node_modules')), false)
    assert.equal(existsSync(join(f.source, 'missing')), false)
    assert.equal(existsSync(join(f.runtime, 'node_modules')), false)
  } finally { f.close() }
})
