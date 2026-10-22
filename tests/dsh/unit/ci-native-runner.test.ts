import { satisfies } from 'semver'
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
  const range = root.dsh.compatibility.dsh
  assert.ok(satisfies(version, range, { includePrerelease: true }))
  assert.ok(satisfies('0.3.0', range), 'a future release label must not fail without a known incompatibility')
  const tested = Object.entries(root.dsh.compatibility.dshReleases).filter(([, result]) => result === 'compatible').map(([release]) => release)
  assert.ok(tested.includes(version), 'the installed fixture must be reported as tested')
  assert.ok(tested.every(release => satisfies(release, range, { includePrerelease: true })))
  for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-attachment', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai']) {
    assert.equal(root.peerDependencies[name], range, name)
  }
  // Root development follows the channel; the repeatable fixture owns its graph.
  for (const [name, selected] of Object.entries(root.devDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(selected, 'alpha', name)
  }
  const fixtureLock = JSON.parse(await readFile('tests/fixtures/dsh-runtime/package-lock.json', 'utf8'))
  const dshPackages = (lock: any) => Object.entries(lock.packages).filter(([path]) => /node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/.test(path))
  assert.ok(dshPackages(fixtureLock).length > 0)
  for (const [path, entry] of dshPackages(fixtureLock)) assert.equal((entry as any).version, version, path)
  const npm = JSON.parse(await readFile('package-lock.json', 'utf8'))
  assert.deepEqual(npm.packages[''].devDependencies, root.devDependencies)
  const pnpm = parse(await readFile('pnpm-lock.yaml', 'utf8'))
  for (const [name, entry] of Object.entries(pnpm.importers['.'].devDependencies)) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    assert.equal((entry as any).specifier, 'alpha', name)
    assert.equal(npm.packages[`node_modules/${name}`].version, (entry as any).version.split('(')[0], name)
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
      assert.equal(plan.env.KIOKUKO_EXPECTED_DSH_VERSION, version, 'fixture node_modules is stale. Run: npm ci --prefix tests/fixtures/dsh-runtime')
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
    assert.ok(lisp.args.slice(1).every((file: string) => file === 'tests/dsh/e2e/coding-workflow-native.test.ts' || ['tests/dsh/unit/lisp/', 'tests/dsh/integration/lisp/'].some(prefix => file.startsWith(prefix))))
    assert.ok(lisp.args.includes('tests/dsh/e2e/coding-workflow-native.test.ts'), 'Lisp jobs require the real coding session');
    for (const browser of ['browser-approval', 'browser-shortcuts', 'browser-coding']) {
      const plan = nativeCiPlan(browser, environment)
      assert.deepEqual(plan.args, [browser === 'browser-approval' ? 'scripts/verify-lisp-approval-web.mjs' : browser === 'browser-coding' ? 'scripts/verify-coding-workflow-web.mjs' : 'scripts/verify-shortcuts-web.mjs'])
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
test('recursive discovery executes import-only aliases through their declared leaves once', async () => {
  const contract=JSON.parse(await readFile('scripts/verification.json','utf8'));
  const discovered=['unit','integration'].flatMap(suite=>nativeCiPlan(suite,{}).args.slice(1));
  assert.equal(new Set(discovered).size,discovered.length);
  for(const alias of contract.testAliases){
    assert.ok(!discovered.includes(alias.file),alias.file);
    const imports=(await readFile(alias.file,'utf8')).matchAll(/import ['"]([^'"]+)['"]/g);
    const {posix}=await import('node:path');
    const leaves=[...imports].map(match=>posix.normalize(posix.join(posix.dirname(alias.file),match[1]!)));
    assert.deepEqual(leaves,alias.coveredFiles);
    for(const leaf of leaves)assert.equal(discovered.filter(file=>file===leaf).length,1,leaf);
  }
  for(const lane of contract.nativeScopeExclusions){
    assert.ok(!discovered.includes(lane.file));
    const selected=nativeCiPlan(lane.profile,{});
    assert.deepEqual(selected.args.slice(1),[lane.file]);
    assert.equal(selected.env[({'code-provider':'KIOKUKO_REQUIRE_CODE_PROVIDER',p0:'KIOKUKO_REQUIRE_LISP_P0','packages-live':'KIOKUKO_PACKAGE_LIVE'} as Record<string,string>)[lane.profile]!],'1');
  }
 });

test('an explicitly selected newer host is tested without replacing it with the historical fixture', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const selected = await mkdtemp(join(tmpdir(), 'kiokuko-selected-host-'))
  try {
    const dir = join(selected, '@deepseek-ai/dsh'); await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0-next.7' }))
    const env = { KIOKUKO_DSH_PACKAGE_ROOT: selected, KIOKUKO_EXPECTED_DSH_VERSION: 'old-stale-label' }
    for (const suite of ['unit', 'integration', 'e2e', 'lisp', 'browser-approval', 'browser-shortcuts', 'browser-coding']) {
      const plan = nativeCiPlan(suite, env)
      assert.equal(plan.env.KIOKUKO_DSH_PACKAGE_ROOT, selected)
      assert.equal(plan.env.KIOKUKO_EXPECTED_DSH_VERSION, '1.0.0-next.7')
      assert.equal(plan.env.DSH_BIN, join(selected, '.bin/dsh'))
    }
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'other', version: '1.0.0-next.7' }))
    assert.throws(() => nativeCiPlan('unit', env), /selected DSH package/)
  } finally { await rm(selected, { recursive: true, force: true }) }
})


test('fixture preflight diagnoses stale installs and inconsistent declarations without repair', async () => {
  const { assertDshFixtureIdentity } = await import(pathToFileURL(join(process.cwd(), 'scripts/dsh-fixture-identity.mjs')).href)
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-identity-'))
  const name = '@deepseek-ai/dsh', version = '1.0.0'
  const installed = { name, version }
  const declaration = { dependencies: { [name]: version } }
  const lock = { packages: { '': declaration, [`node_modules/${name}`]: { version } } }
  const write = (file: string, value: unknown) => writeFile(join(temporary, file), JSON.stringify(value))
  try {
    await write('package.json', declaration); await write('package-lock.json', lock)
    assert.doesNotThrow(() => assertDshFixtureIdentity(temporary, installed))
    for (const stale of [{ name, version: '0.9.0' }, undefined, { name: 'other', version }]) {
      assert.throws(() => assertDshFixtureIdentity(temporary, stale), /node_modules is stale or missing:.*npm ci --prefix/)
    }
    for (const broken of [
      { packages: { ...lock.packages, '': { dependencies: { [name]: 'old' } } } },
      { packages: { ...lock.packages, [`node_modules/${name}`]: { version: 'old' } } },
      { packages: {} }, null,
    ]) {
      await write('package-lock.json', broken)
      assert.throws(() => assertDshFixtureIdentity(temporary, installed), /declaration\/lock mismatch:.*Reconcile/)
    }
    await write('package-lock.json', lock); await write('package.json', { dependencies: {} })
    assert.throws(() => assertDshFixtureIdentity(temporary, installed), /declaration\/lock mismatch/)
    await write('package.json', null)
    assert.throws(() => assertDshFixtureIdentity(temporary, installed), /declaration\/lock mismatch/)
    await writeFile(join(temporary, 'package.json'), '{')
    assert.throws(() => assertDshFixtureIdentity(temporary, installed), /Cannot read DSH fixture declaration\/lock:.*Restore/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('a symlink alias of the canonical fixture still checks installed identity', async () => {
  const { copyFile, mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-identity-alias-'))
  try {
    await mkdir(join(temporary, 'scripts'))
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ type: 'module' }))
    for (const file of ['run-ci-native.mjs', 'dsh-fixture-identity.mjs', 'repeated-memory-scenarios.mjs']) {
      await copyFile(join(process.cwd(), 'scripts', file), join(temporary, 'scripts', file))
    }
    await writeFile(join(temporary, 'scripts/verification.json'), JSON.stringify({ nativeScopeExclusions: [], testAliases: [] }))
    const fixtureRoot = join(temporary, 'tests/fixtures/dsh-runtime')
    const installed = join(fixtureRoot, 'node_modules')
    await mkdir(join(installed, '@deepseek-ai/dsh'), { recursive: true })
    const name = '@deepseek-ai/dsh', version = '1.0.0'
    const manifest = { dependencies: { [name]: version } }
    await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(fixtureRoot, 'package-lock.json'), JSON.stringify({ packages: { '': manifest, [`node_modules/${name}`]: { version } } }))
    await writeFile(join(installed, name, 'package.json'), JSON.stringify({ name, version: '0.9.0' }))
    await mkdir(join(temporary, 'tests/dsh/unit'), { recursive: true })
    await writeFile(join(temporary, 'tests/dsh/unit/probe.test.ts'), '// discovery only\n')
    const alias = join(temporary, 'fixture-alias')
    await symlink(installed, alias, 'dir')
    const { nativeCiPlan: plan } = await import(pathToFileURL(join(temporary, 'scripts/run-ci-native.mjs')).href)
    assert.throws(() => plan('unit', { KIOKUKO_DSH_PACKAGE_ROOT: alias }), /node_modules is stale or missing:.*npm ci --prefix/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
