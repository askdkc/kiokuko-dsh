/** Start a disposable real Web profile; supply built DSH JS entry and Kiokuko tarball. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const [dshArg, pluginArg] = process.argv.slice(2)
assert.ok(dshArg && pluginArg, 'Supply the selected built DSH JS entry and Kiokuko tarball')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kiokuko-recovery-web-')))
const env = { PATH: process.env.PATH, SHELL: process.env.SHELL ?? '/bin/sh',
  HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), DSH_HOME: join(root, 'dsh'),
  KIOKUKO_DATA_DIR: join(root, 'data'), DSH_TELEMETRY_MODE: 'DISABLED',
  KIOKUKO_RECOVERY_PROJECT: join(root, 'project'), KIOKUKO_RECOVERY_READY: join(root, 'ready.json'),
  KIOKUKO_RECOVERY_REQUESTS: join(root, 'requests.json'), npm_config_cache: join(root, 'cache'),
  TERM: 'xterm-256color', NODE_ENV: 'production',
}
for (const directory of [env.HOME, env.DSH_HOME, env.KIOKUKO_DATA_DIR, env.KIOKUKO_RECOVERY_PROJECT]) mkdirSync(directory, { recursive: true })
const dsh = resolve(dshArg)
execFileSync(process.execPath, [dsh, 'plugin', '--profile', 'web', 'add', `kiokuko-dsh@file:${resolve(pluginArg)}`, '--ignore-scripts'], { env, encoding: 'utf8', stdio: 'pipe' })
const port = await new Promise(resolvePort => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolvePort(value)) }) })
const patch = join(root, 'probe.patch.yml')
writeFileSync(patch, YAML.stringify([
  { id: 'kiokuko-dsh', config: { enabled: true, typedDecisions: { mode: 'off' }, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' }, agenticReplay: { enabled: false }, lisp: { enabled: false } } },
  { id: 'llm-deepseek-api-key', disabled: true },
  { id: 'agent-default-model', config: { provider: 'recovery-fixture', model: 'fixture' } },
  { insert: [{ id: 'session-recovery-fixture', name: fileURLToPath(new URL('./session-recovery-web-fixture.mjs', import.meta.url)) }] },
]))
const child = spawn(process.execPath, [dsh, '--profile', 'web', '--patch', patch, '--port', String(port), '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs += chunk; writeFileSync(join(root, 'host.log'), logs) })
writeFileSync('/tmp/kiokuko-recovery-web-current.json', JSON.stringify({ root, pid: child.pid, port, url: `http://127.0.0.1:${port}/` }))
console.log(JSON.stringify({ root, pid: child.pid, url: `http://127.0.0.1:${port}/` }))
const stop = signal => { child.kill(signal) }
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
child.on('exit', (code, signal) => { console.log(JSON.stringify({ code, signal, root })); process.exit(code ?? (signal ? 1 : 0)) })
