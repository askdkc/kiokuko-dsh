import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const [runtimeRoot, overlay] = process.argv.slice(2)
assert.ok(runtimeRoot && overlay, 'runtime root and overlay are required')
const manifest = JSON.parse(await readFile(join(runtimeRoot, '@deepseek-ai/dsh/package.json'), 'utf8'))
assert.equal(manifest.version, '0.1.7-rc.2')
const requireFromDsh = createRequire(join(await realpath(join(runtimeRoot, '@deepseek-ai/dsh')), 'lib/bin.js'))
const moduleUrl = pathToFileURL(requireFromDsh.resolve('@deepseek-ai/dsh-app-boot')).href
const profileUrl = pathToFileURL(join(runtimeRoot, '@deepseek-ai/dsh/lib/profile-boot.js')).href
const { loadLayeredEnv } = await import(moduleUrl)
const { runProfile } = await import(profileUrl)
let result
let sessions
let sessionId
try {
  result = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'dsh-tui', patchFiles: [overlay], args: [] })
  const { ctx } = result
  const names = ['skills', 'systemPrompt', 'tools', 'commands', 'agents', 'sessions', 'sessionQuery', 'sessionPersistence']
  for (const name of names) assert.ok(ctx.get(name, false), `native ${name} service is missing`)
  const commands = ctx.get('commands')
  const listed = commands.list(undefined).map(command => command.name)
  assert.ok(listed.includes('kioku-orca'), 'Kiokuko command was not registered')
  const rejectedCommand = await commands.find(undefined, 'kioku-orca').handler({ rawInput: 'status', signal: new AbortController().signal })
  assert.deepEqual(rejectedCommand, { kind: 'error', text: 'session_required' }, 'Orca command must reject absent native session')
  const tools = ctx.get('tools')
  const schemas = tools.schemas(undefined).map(schema => schema.name)
  assert.ok(schemas.some(name => name.startsWith('task_')), 'Kiokuko task tools were not registered')
  const skillNames = (await ctx.get('skills').list({ cwd: process.cwd() })).map(skill => skill.name)
  assert.ok(skillNames.includes('kiokuko-soul'), 'Kiokuko Skill was not discoverable')
  sessions = ctx.get('sessions')
  sessionId = 'kiokuko-tui-probe-session'
  const session = sessions.create(sessionId, { meta: { cwd: process.cwd() } })
  assert.equal(sessions.get(sessionId), session, 'native session was not created')
  process.stdout.write(`KIOKUKO_TUI_PROBE:${JSON.stringify({ services: names, skills: skillNames.filter(name => name.startsWith('kiokuko-')), commands: listed.filter(name => name.startsWith('kioku-')), tools: schemas.filter(name => name.startsWith('task_')), commandRejection: rejectedCommand.text, sessionCreated: true })}\n`)
} finally {
  if (result) await result.ctx.fiber.dispose()
  if (sessions && sessionId) assert.equal(sessions.get(sessionId), undefined, 'native session was not released')
}
