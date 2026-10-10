// Foreground native CI preflight; requires installed fixtures and never installs runtimes.
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repeatedMemoryScenarios } from './repeated-memory-scenarios.mjs'

const root = resolve(import.meta.dirname, '..')
const fixtures = new Map([['pinned', 'dsh-runtime'], ['current', 'dsh-runtime-current']])
const scenarioRoutes = new Map([
  ['e2e-repeated-deep', 'deep'], ['e2e-repeated-normal', 'normal'], ['e2e-repeated-enno', 'enno'],
  ['e2e-repeated-enno-prefix', 'enno/prefix_reuse'], ['e2e-repeated-enno-bounded', 'enno/bounded_evidence'],
])
const suites = new Set(['unit', 'integration', 'lisp', 'queued-intent', 'browser-approval', 'browser-shortcuts', 'e2e', 'e2e-core', 'e2e-agent', 'e2e-repeated', ...scenarioRoutes.keys()])
// Standard-preset coverage explicitly requires rc.2; the current preflight owns it.
const currentOnly = 'tests/dsh/integration/subagent-standard-preset-native.test.ts'
function testFiles(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`
    return entry.isDirectory() ? testFiles(file) : entry.isFile() && file.endsWith('.test.ts') ? [file] : []
  }).sort()
}

export function nativeCiPlan(runtime, suite, environment = process.env) {
  if (!fixtures.has(runtime) || !suites.has(suite)) throw new Error('Usage: run-ci-native.mjs pinned|current unit|integration|e2e')
  const fixture = join(root, 'tests/fixtures', fixtures.get(runtime))
  const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'))
  const env = { ...environment, KIOKUKO_DSH_PACKAGE_ROOT: join(fixture, 'node_modules'),
    KIOKUKO_EXPECTED_DSH_VERSION: manifest.dependencies['@deepseek-ai/dsh'], KIOKUKO_REQUIRE_DSH_NATIVE: '1' }
  delete env.KIOKUKO_DSH_SOURCE_ROOT
  delete env.KIOKUKO_REPEATED_SCENARIO
  if (suite === 'browser-approval' || suite === 'browser-shortcuts') {
    env.KIOKUKO_LISP_APPROVAL_RUNTIME = fixtures.get(runtime)
    env.KIOKUKO_SHORTCUT_RUNTIME = fixtures.get(runtime)
    return { command: process.execPath, args: [suite === 'browser-approval' ? 'scripts/verify-lisp-approval-web.mjs' : 'scripts/verify-shortcuts-web.mjs'], cwd: root, env }
  }
  const directory = `tests/dsh/${suite.startsWith('e2e') ? 'e2e' : suite}`
  if (suite === 'lisp') env.KIOKUKO_REQUIRE_LISP_RUNTIME = '1'
  const files = (suite === 'queued-intent' ? ['tests/dsh/unit/decisions/akinator-classification.test.ts', 'tests/dsh/unit/decisions/akinator-scope.test.ts', 'tests/dsh/integration/queued-intent-native.test.ts'] : suite === 'lisp' ? [...testFiles('tests/dsh/unit/lisp'), ...testFiles('tests/dsh/integration/lisp')] : testFiles(directory)).filter(file => runtime !== 'pinned' || file !== currentOnly).filter(file => {
    const agent = file.endsWith('/native-agent-loop.test.ts'), repeated = file.endsWith('/repeated-memory-lifecycle.test.ts')
    return suite === 'e2e-core' ? !agent && !repeated : suite === 'e2e-agent' ? agent : suite.startsWith('e2e-repeated') ? repeated : true
  })
  if (!files.length) throw new Error('Native CI suite is empty')
  const route = scenarioRoutes.get(suite)
  const scenarios = route ? repeatedMemoryScenarios.filter(name => name.startsWith(`${route}/`)) : undefined
  if (route && !scenarios.length) throw new Error('Native CI scenario batch is empty')
  return { command: process.execPath, args: ['scripts/run-tests.mjs', ...files], cwd: root, env, scenarios }
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
    if (process.argv.length !== 4) throw new Error('Select exactly one runtime and suite')
    const plan = nativeCiPlan(process.argv[2], process.argv[3])
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
