// Foreground native CI preflight; requires installed fixtures and never installs runtimes.
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repeatedMemoryScenarios } from './repeated-memory-scenarios.mjs'

const root = resolve(import.meta.dirname, '..')
const fixture = 'dsh-runtime'
const scenarioRoutes = new Map([
  ['e2e-repeated-deep', 'deep'], ['e2e-repeated-normal', 'normal'], ['e2e-repeated-enno', 'enno'],
  ['e2e-repeated-enno-prefix', 'enno/prefix_reuse'], ['e2e-repeated-enno-bounded', 'enno/bounded_evidence'],
])
const optIn = JSON.parse(readFileSync(join(root,'scripts/verification.json'),'utf8')).nativeScopeExclusions
const suites = new Set([...optIn.map(item=>item.profile),'unit', 'integration', 'lisp', 'queued-intent', 'browser-approval', 'browser-shortcuts', 'browser-coding', 'e2e', 'e2e-core', 'e2e-agent', 'e2e-repeated', ...scenarioRoutes.keys()])
function testFiles(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`
    return entry.isDirectory() ? testFiles(file) : entry.isFile() && file.endsWith('.test.ts') ? [file] : []
  }).sort()
}

export function nativeCiPlan(suite, environment = process.env) {
  if (!suites.has(suite)) throw new Error('Usage: run-ci-native.mjs unit|integration|e2e')
  const fixtureRoot = join(root, 'tests/fixtures', fixture)
  const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'package.json'), 'utf8'))
  const env = { ...environment, KIOKUKO_DSH_PACKAGE_ROOT: join(fixtureRoot, 'node_modules'),
    KIOKUKO_EXPECTED_DSH_VERSION: manifest.dependencies['@deepseek-ai/dsh'], KIOKUKO_REQUIRE_DSH_NATIVE: '1' }
  delete env.KIOKUKO_DSH_SOURCE_ROOT
  delete env.KIOKUKO_REPEATED_SCENARIO
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
  const scopedFiles = selectedOptional ? files : files.filter(file=>!optIn.some(item=>item.file===file))
  if(!scopedFiles.length)throw new Error('Native scope is empty')
  const route = scenarioRoutes.get(suite)
  const scenarios = route ? repeatedMemoryScenarios.filter(name => name.startsWith(`${route}/`)) : undefined
  if (route && !scenarios.length) throw new Error('Native CI scenario batch is empty')
  return { command: process.execPath, args: ['scripts/run-tests.mjs', ...scopedFiles], cwd: root, env, scenarios }
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
    if (process.argv.length !== 3) throw new Error('Select exactly one suite')
    const plan = nativeCiPlan(process.argv[2])
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
