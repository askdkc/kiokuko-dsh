// Foreground native CI preflight; requires installed fixtures and never installs runtimes.
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertDshFixtureIdentity } from './dsh-fixture-identity.mjs'
import { repeatedMemoryScenarios } from './repeated-memory-scenarios.mjs'

const root = resolve(import.meta.dirname, '..')
const fixture = 'dsh-runtime'
const scenarioRoutes = new Map([
  ['e2e-repeated-deep', 'deep'], ['e2e-repeated-normal', 'normal'], ['e2e-repeated-enno', 'enno'],
  ['e2e-repeated-enno-prefix', 'enno/prefix_reuse'], ['e2e-repeated-enno-bounded', 'enno/bounded_evidence'],
])
const contract = JSON.parse(readFileSync(join(root,'scripts/verification.json'),'utf8'))
const optIn = contract.nativeScopeExclusions
const aliases = new Set(contract.testAliases.map(item=>item.file))
const suites = new Set([...optIn.map(item=>item.profile),'unit', 'integration', 'ci-unit', 'ci-integration', 'ci-e2e', 'lisp', 'queued-intent', 'browser-approval', 'browser-shortcuts', 'browser-coding', 'e2e', 'e2e-core', 'e2e-agent', 'e2e-repeated', ...scenarioRoutes.keys()])
function testFiles(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`
    return entry.isDirectory() ? testFiles(file) : entry.isFile() && file.endsWith('.test.ts') ? [file] : []
  }).sort()
}

function sameDirectory(left, right) {
  if (left === right) return true
  try { return realpathSync(left) === realpathSync(right) } catch { return false }
}

export function nativeCiPlan(suite, environment = process.env) {
  if (!suites.has(suite)) throw new Error('Usage: run-ci-native.mjs unit|integration|e2e')
  // Only the explicit CI main partition omits source cases owned by Protected Lisp.
  // Standalone unit/integration/e2e and local full/main verification remain complete.
  if (['ci-unit', 'ci-integration', 'ci-e2e'].includes(suite)) {
    const plan = nativeCiPlan(suite.slice(3), environment)
    const lisp = nativeCiPlan('lisp', environment)
    const owned = contract.checks.find(check => check.id === 'owned-native')
    if (!owned || !owned.profiles.includes('lisp') || owned.argv[0] !== 'node'
      || owned.argv[1] !== 'scripts/run-tests.mjs' || !owned.argv.slice(2).length
      || owned.argv.slice(2).some(file => !file.endsWith('.test.ts'))) {
      throw new Error('Protected Lisp source ownership is missing or unsupported')
    }
    const modules = contract.checks.find(check => check.id === 'modules')
    if (!modules?.profiles.includes('lisp') || !modules.sourceFiles?.length) throw new Error('Module source ownership is missing')
    const skills = contract.checks.find(check => check.id === 'skill-delivery')
    if (!skills?.profiles.includes('lisp') || !skills.sourceFiles?.length) throw new Error('Skill source ownership is missing')
    const covered = new Set([...lisp.args.slice(1), ...owned.argv.slice(2), ...modules.sourceFiles, ...skills.sourceFiles])
    const files = plan.args.slice(1).filter(file => !covered.has(file))
    if (!files.length) throw new Error('CI main source partition is empty')
    // Removing Lisp paths must not silently increase the test runner's concurrency.
    const concurrency = plan.env.KIOKUKO_TEST_CONCURRENCY
      ?? (plan.args.slice(1).some(file => file.includes('/lisp/')) ? '2' : '4')
    return { ...plan, args: [plan.args[0], ...files],
      env: { ...plan.env, KIOKUKO_TEST_CONCURRENCY: concurrency } }
  }
  const fixtureRoot = join(root, 'tests/fixtures', fixture)
  const packageRoot = resolve(environment.KIOKUKO_DSH_PACKAGE_ROOT ?? join(fixtureRoot, 'node_modules'))
  const canonicalFixture = sameDirectory(packageRoot, resolve(fixtureRoot, 'node_modules'))
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, '@deepseek-ai/dsh/package.json'), 'utf8'))
  } catch (error) {
    if (canonicalFixture) throw new Error(`Cannot read installed DSH fixture: ${error.message}. Run: npm ci --prefix tests/fixtures/dsh-runtime`)
    throw error
  }
  if (canonicalFixture) assertDshFixtureIdentity(fixtureRoot, manifest)
  if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('Invalid selected DSH package metadata')
  }
  const env = { ...environment, KIOKUKO_DSH_PACKAGE_ROOT: packageRoot,
    KIOKUKO_EXPECTED_DSH_VERSION: manifest.version, KIOKUKO_REQUIRE_DSH_NATIVE: '1',
    DSH_BIN: environment.DSH_BIN ?? join(packageRoot, '.bin/dsh') }
  delete env.KIOKUKO_DSH_SOURCE_ROOT
  delete env.KIOKUKO_REPEATED_SCENARIO
  delete env.KIOKUKO_REPEATED_SCENARIOS
  if (suite === 'browser-approval' || suite === 'browser-shortcuts' || suite === 'browser-coding') {
    env.KIOKUKO_LISP_APPROVAL_RUNTIME = fixture
    env.KIOKUKO_SHORTCUT_RUNTIME = fixture
    return { command: process.execPath, args: [suite === 'browser-approval' ? 'scripts/verify-lisp-approval-web.mjs' : suite === 'browser-coding' ? 'scripts/verify-coding-workflow-web.mjs' : 'scripts/verify-shortcuts-web.mjs'], cwd: root, env }
  }
  const selectedOptional=optIn.find(item=>item.profile===suite)
  if(selectedOptional)env[{'code-provider':'KIOKUKO_REQUIRE_CODE_PROVIDER',p0:'KIOKUKO_REQUIRE_LISP_P0','packages-live':'KIOKUKO_PACKAGE_LIVE'}[suite]]='1'
  const directory = `tests/dsh/${suite.startsWith('e2e') ? 'e2e' : suite}`
  if (suite === 'lisp') env.KIOKUKO_REQUIRE_LISP_RUNTIME = '1'
  const files = (selectedOptional?[selectedOptional.file]:suite === 'queued-intent' ? ['tests/dsh/unit/decisions/akinator-classification.test.ts', 'tests/dsh/unit/decisions/akinator-scope.test.ts', 'tests/dsh/integration/queued-intent-native.test.ts'] : suite === 'lisp' ? [...testFiles('tests/dsh/unit/lisp'), ...testFiles('tests/dsh/integration/lisp'), 'tests/dsh/e2e/coding-workflow-native.test.ts'] : testFiles(directory)).filter(file => {
    const agent = file.endsWith('/native-agent-loop.test.ts'), repeated = file.endsWith('/repeated-memory-lifecycle.test.ts')
    return suite === 'e2e-core' ? !agent && !repeated : suite === 'e2e-agent' ? agent : suite.startsWith('e2e-repeated') ? repeated : true
  })
  if (!files.length) throw new Error('Native CI suite is empty')
  const scopedFiles = selectedOptional ? files : files.filter(file=>!aliases.has(file)&&!optIn.some(item=>item.file===file))
  if(!scopedFiles.length)throw new Error('Native scope is empty')
  const route = scenarioRoutes.get(suite)
  const scenarios = route ? repeatedMemoryScenarios.filter(name => name.startsWith(`${route}/`)) : undefined
  if (route && !scenarios.length) throw new Error('Native CI scenario batch is empty')
  return { command: process.execPath, args: ['scripts/run-tests.mjs', ...scopedFiles], cwd: root, env, scenarios }
}

export function shardNativePlan(plan, shard) {
  if(!/^[1-9][0-9]*\/[1-9][0-9]*$/.test(shard))throw new Error('Invalid native shard');
  const [index,count]=shard.split('/').map(Number),files=plan.args.slice(1);
  if(!Number.isSafeInteger(index)||!Number.isSafeInteger(count)||index>count||count>files.length||plan.scenarios)throw new Error('Empty or invalid native shard');
  // This long file registers independent lifecycle scenarios. Share the file,
  // partition its scenarios, and retain exact file ownership everywhere else.
  const repeated='tests/dsh/e2e/repeated-memory-lifecycle.test.ts';
  const selected=files.filter((file,i)=>file===repeated||i%count===index-1);
  const env={...plan.env};
  if(files.includes(repeated))env.KIOKUKO_REPEATED_SCENARIOS=JSON.stringify(repeatedMemoryScenarios.filter((_,i)=>i%count===index-1));
  return {...plan,args:[plan.args[0],...selected],env};
}

async function run(plan) {
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: 'inherit', shell: false })
  const term = () => child.kill('SIGTERM'), interrupt = () => child.kill('SIGINT')
  process.on('SIGTERM', term); process.on('SIGINT', interrupt)
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => resolve(code ?? 1))
    })
  } finally {
    process.off('SIGTERM', term); process.off('SIGINT', interrupt)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3 && !(process.argv.length === 5 && process.argv[3] === '--shard')) throw new Error('Select one suite and optional --shard index/count')
    const original = nativeCiPlan(process.argv[2])
    const plan = process.argv[4] ? shardNativePlan(original,process.argv[4]) : original
    if (plan.scenarios) {
      process.exitCode = 0
      for (const scenario of plan.scenarios) {
        console.log(`Native CI scenario: ${scenario}`)
        const code = await run({ ...plan, env: { ...plan.env, KIOKUKO_REPEATED_SCENARIO: scenario } })
        if (code !== 0) { process.exitCode = code; break }
      }
    } else process.exitCode = await run(plan)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
