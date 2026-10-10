import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { nativeCiPlan } = await import(pathToFileURL(join(process.cwd(), 'scripts/run-ci-native.mjs')).href)
for (const [runtime, fixture, version] of [['pinned', 'dsh-runtime', '0.1.5-rc.1'], ['current', 'dsh-runtime-current', '0.2.0-rc.2']] as const) {
  test(`native CI ${runtime} runs every suite with an exact required fixture rather than silently skipping`, async () => {
    const environment = { SENTINEL: 'kept', KIOKUKO_DSH_SOURCE_ROOT: '/not-the-selected-fixture', KIOKUKO_REQUIRE_DSH_NATIVE: '0', KIOKUKO_EXPECTED_DSH_VERSION: 'wrong' }
    const before = { ...environment }
    for (const suite of ['unit', 'integration', 'e2e']) {
      const plan = nativeCiPlan(runtime, suite, environment)
      assert.equal(plan.command, process.execPath)
      assert.equal(plan.args[0], 'scripts/run-tests.mjs')
      assert.ok(plan.args.length > 1)
      assert.ok(plan.args.slice(1).every((file: string) => file.startsWith(`tests/dsh/${suite}/`) && file.endsWith('.test.ts')))
      if (suite === 'integration') assert.equal(plan.args.includes('tests/dsh/integration/subagent-standard-preset-native.test.ts'), runtime === 'current')
      assert.equal(plan.cwd, process.cwd())
      assert.equal(plan.env.KIOKUKO_DSH_PACKAGE_ROOT, join(process.cwd(), 'tests/fixtures', fixture, 'node_modules'))
      assert.equal(plan.env.KIOKUKO_EXPECTED_DSH_VERSION, version)
      assert.equal(plan.env.KIOKUKO_REQUIRE_DSH_NATIVE, '1')
      assert.equal(plan.env.KIOKUKO_DSH_SOURCE_ROOT, undefined)
      assert.equal(plan.env.SENTINEL, 'kept')
    }
    const queued = nativeCiPlan(runtime, 'queued-intent', environment)
    assert.deepEqual(queued.args.slice(1), ['tests/dsh/unit/decisions/akinator-classification.test.ts', 'tests/dsh/unit/decisions/akinator-scope.test.ts', 'tests/dsh/integration/queued-intent-native.test.ts'])
    assert.equal(queued.env.KIOKUKO_REQUIRE_DSH_NATIVE, '1')
    assert.equal(queued.env.KIOKUKO_EXPECTED_DSH_VERSION, version)
    const all = nativeCiPlan(runtime, 'e2e', environment).args.slice(1)
    const batches = ['e2e-core', 'e2e-agent', 'e2e-repeated'].flatMap(suite => nativeCiPlan(runtime, suite, environment).args.slice(1))
    assert.deepEqual([...batches].sort(), [...all].sort(), 'bounded batches retain every E2E file exactly once')
    assert.equal(new Set(batches).size, batches.length)
    const repeated = ['deep', 'normal', 'enno-prefix', 'enno-bounded'].flatMap(route => nativeCiPlan(runtime, `e2e-repeated-${route}`, environment).scenarios)
    const { repeatedMemoryScenarios } = await import(pathToFileURL(join(process.cwd(), 'scripts/repeated-memory-scenarios.mjs')).href)
    assert.deepEqual([...repeated].sort(), [...repeatedMemoryScenarios].sort(), 'route batches retain every required repeated scenario exactly once')
    assert.equal(new Set(repeated).size, repeated.length)
    const lisp = nativeCiPlan(runtime, 'lisp', environment)
    assert.equal(lisp.env.KIOKUKO_REQUIRE_LISP_RUNTIME, '1')
    assert.ok(lisp.args.slice(1).every((file: string) => ['tests/dsh/unit/lisp/', 'tests/dsh/integration/lisp/'].some(prefix => file.startsWith(prefix))))
    for (const browser of ['browser-approval', 'browser-shortcuts']) {
      const plan = nativeCiPlan(runtime, browser, environment)
      assert.deepEqual(plan.args, [browser === 'browser-approval' ? 'scripts/verify-lisp-approval-web.mjs' : 'scripts/verify-shortcuts-web.mjs'])
      assert.equal(plan.env.KIOKUKO_LISP_APPROVAL_RUNTIME, fixture)
      assert.equal(plan.env.KIOKUKO_SHORTCUT_RUNTIME, fixture)
    }
    assert.deepEqual(environment, before)
  })
}
test('native CI rejects unknown runtimes and arbitrary paths before constructing a launch', () => {
  for (const [runtime, suite] of [['../outside', 'unit'], ['constructor', 'unit'], ['current', '../../outside'], ['current', ''], ['', 'unit']]) {
    assert.throws(() => nativeCiPlan(runtime, suite, {}), /Usage:/)
  }
})
