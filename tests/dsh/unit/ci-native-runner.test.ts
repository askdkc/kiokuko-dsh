import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const { nativeCiPlan } = await import(pathToFileURL(join(process.cwd(), 'scripts/run-ci-native.mjs')).href)
const fixture = 'dsh-runtime'
const manifest = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(join(process.cwd(), 'tests/fixtures', fixture, 'package.json'), 'utf8')))
const version = manifest.dependencies['@deepseek-ai/dsh']
test('npm and pnpm resolve the canonical DSH release without a legacy package graph', async () => {
  const root = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(root.dsh.compatibility.dsh, version)
  assert.deepEqual(root.dsh.compatibility.dshReleases, { [version]: 'compatible' })
  for (const [name, selected] of Object.entries(root.devDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(selected, version, name)
  }
  for (const file of ['package-lock.json', 'tests/fixtures/dsh-runtime/package-lock.json']) {
    const lock = JSON.parse(await readFile(file, 'utf8'))
    const packages = Object.entries(lock.packages).filter(([path]) => /node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(path))
    assert.ok(packages.length > 0, file)
    for (const [path, entry] of packages) assert.equal((entry as { version: string }).version, version, `${file}: ${path}`)
  }
  const pnpm = parse(await readFile('pnpm-lock.yaml', 'utf8'))
  const packages = Object.keys(pnpm.packages).filter(name => name.startsWith('@deepseek-ai/dsh-'))
  assert.ok(packages.length > 0)
  for (const name of packages) assert.equal(name.slice(name.lastIndexOf('@') + 1), version, name)
  for (const [name, entry] of Object.entries(pnpm.importers['.'].devDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal((entry as { specifier: string }).specifier, version, name)
  }
})
test('native CI runs every suite with the canonical current fixture', async () => {
    const environment = { SENTINEL: 'kept', KIOKUKO_DSH_SOURCE_ROOT: '/not-the-selected-fixture', KIOKUKO_REQUIRE_DSH_NATIVE: '0', KIOKUKO_EXPECTED_DSH_VERSION: 'wrong' }
    const before = { ...environment }
    for (const suite of ['unit', 'integration', 'e2e']) {
      const plan = nativeCiPlan(suite, environment)
      assert.equal(plan.command, process.execPath)
      assert.equal(plan.args[0], 'scripts/run-tests.mjs')
      assert.ok(plan.args.length > 1)
      assert.ok(plan.args.slice(1).every((file: string) => file.startsWith(`tests/dsh/${suite}/`) && file.endsWith('.test.ts')))
      if (suite === 'integration') assert.ok(plan.args.includes('tests/dsh/integration/subagent-standard-preset-native.test.ts'))
      assert.equal(plan.cwd, process.cwd())
      assert.equal(plan.env.KIOKUKO_DSH_PACKAGE_ROOT, join(process.cwd(), 'tests/fixtures', fixture, 'node_modules'))
      assert.equal(plan.env.KIOKUKO_EXPECTED_DSH_VERSION, version)
      assert.equal(plan.env.KIOKUKO_REQUIRE_DSH_NATIVE, '1')
      assert.equal(plan.env.KIOKUKO_DSH_SOURCE_ROOT, undefined)
      assert.equal(plan.env.SENTINEL, 'kept')
    }
    const queued = nativeCiPlan('queued-intent', environment)
    assert.deepEqual(queued.args.slice(1), ['tests/dsh/unit/decisions/akinator-classification.test.ts', 'tests/dsh/unit/decisions/akinator-scope.test.ts', 'tests/dsh/integration/queued-intent-native.test.ts'])
    assert.equal(queued.env.KIOKUKO_REQUIRE_DSH_NATIVE, '1')
    assert.equal(queued.env.KIOKUKO_EXPECTED_DSH_VERSION, version)
    const all = nativeCiPlan('e2e', environment).args.slice(1)
    const batches = ['e2e-core', 'e2e-agent', 'e2e-repeated'].flatMap(suite => nativeCiPlan(suite, environment).args.slice(1))
    assert.deepEqual([...batches].sort(), [...all].sort(), 'bounded batches retain every E2E file exactly once')
    assert.equal(new Set(batches).size, batches.length)
    const repeated = ['deep', 'normal', 'enno-prefix', 'enno-bounded'].flatMap(route => nativeCiPlan(`e2e-repeated-${route}`, environment).scenarios)
    const { repeatedMemoryScenarios } = await import(pathToFileURL(join(process.cwd(), 'scripts/repeated-memory-scenarios.mjs')).href)
    assert.deepEqual([...repeated].sort(), [...repeatedMemoryScenarios].sort(), 'route batches retain every required repeated scenario exactly once')
    assert.equal(new Set(repeated).size, repeated.length)
    const lisp = nativeCiPlan('lisp', environment)
    assert.equal(lisp.env.KIOKUKO_REQUIRE_LISP_RUNTIME, '1')
    assert.ok(lisp.args.slice(1).every((file: string) => ['tests/dsh/unit/lisp/', 'tests/dsh/integration/lisp/'].some(prefix => file.startsWith(prefix))))
    for (const browser of ['browser-approval', 'browser-shortcuts']) {
      const plan = nativeCiPlan(browser, environment)
      assert.deepEqual(plan.args, [browser === 'browser-approval' ? 'scripts/verify-lisp-approval-web.mjs' : 'scripts/verify-shortcuts-web.mjs'])
      assert.equal(plan.env.KIOKUKO_LISP_APPROVAL_RUNTIME, fixture)
      assert.equal(plan.env.KIOKUKO_SHORTCUT_RUNTIME, fixture)
    }
    assert.deepEqual(environment, before)
  })
test('native CI rejects old selectors and unknown suites before constructing a launch', () => {
  for (const suite of ['pinned', 'current', '../outside', '', '../../outside']) {
    assert.throws(() => nativeCiPlan(suite, {}), /Usage:/)
  }
})
