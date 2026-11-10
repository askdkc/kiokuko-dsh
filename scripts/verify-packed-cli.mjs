import { completeVerification } from './verification-completion.mjs'
import { selectedDshRuntime } from './dsh-fixture-identity.mjs'
import { installPackedConsumer } from './pack-install-environment.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

// The existing PTY acceptance runs against installed archive bytes, including
// restart and native permission/Stop behavior. Model generation is scripted.
const root = resolve(import.meta.dirname, '..'), exec = promisify(execFile)
const selected = selectedDshRuntime(root)
const temporary = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'kc-'))
try {
  const consumer = join(temporary, 'consumer'), home = join(temporary, 'home')
  await mkdir(consumer); await mkdir(home)
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n')
  const archive = process.env.KIOKUKO_VERIFY_TARBALL ?? join(temporary,
    JSON.parse((await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root })).stdout)[0].filename)
  const installed = await installPackedConsumer(archive, { cwd: consumer, home, cache: join(temporary, 'cache') })
  assert.equal(installed.ok, true, JSON.stringify(installed.diagnostic))
  const plugin = join(consumer, 'node_modules/kiokuko-dsh/package.json')
  assert.equal(JSON.parse(await readFile(plugin, 'utf8')).name, 'kiokuko-dsh')
  const fixture = join(root, 'tests/fixtures/dsh-runtime/package.json')
  const childEnv = { ...selected.environment }
  if (childEnv.KIOKUKO_VERIFY_COMPLETION_FILE) childEnv.KIOKUKO_VERIFY_COMPLETION_FILE = join(dirname(childEnv.KIOKUKO_VERIFY_COMPLETION_FILE), 'cli-child/completion.json')
  const result = await exec(process.execPath, [join(root, 'scripts/verify-cli-profile.mjs'),
    join(selected.packageRoot, '@deepseek-ai/dsh/lib/bin.js'),
    join(selected.packageRoot, '@askdkc/dsh-cli/package.json'), plugin,
    fixture, fixture, join(temporary, 'profile'), 'source'],
    { cwd: root, env: childEnv, timeout: 600000, maxBuffer: 16 * 1024 ** 2 })
  // The child independently verifies the loaded factory hash and retained session.
  const report = JSON.parse(await readFile(join(temporary, 'profile/report.json'), 'utf8'))
  assert.equal(report.status, 'passed')
  console.log(JSON.stringify({ packed: true, status: report.status, resumed: report.resume?.resumed ?? report.resumed?.resumed, archive }))
  completeVerification({ profile: 'dsh-cli', interactive: true, packed: true, persistedResume: true })
} finally { await rm(temporary, { recursive: true, force: true }) }
