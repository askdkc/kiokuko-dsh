import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mountTypeSafeCommand, typeSafeCredentials } from '../../../../src/dsh/typesafe/command.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
test('native DSH commands and credential provider: precedence, replacement, clear, reload and secret-free events', {
  skip: packages ? false : 'requires pinned DSH packages', timeout: 30000,
}, async () => {
  const [cordis, commands, credentials, launch] = await Promise.all(['cordis', 'dsh-commands', 'dsh-credentials-local', 'dsh-launch-environment']
    .map(name => import(pathToFileURL(join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)))
  const base = await mkdtemp(join(tmpdir(), 'typesafe-command-')), path = join(base, 'credentials.yaml')
  const secret = 'fixture-typesafe-private-key', fallback = 'fixture-fallback-key'
  const events: unknown[] = []
  const ctx = new cordis.Context(), fibers: any[] = []
  const agent: any = { id: 'command-agent', session: { id: 'command-session', append(type: string, data: unknown) { events.push({ type, data }) } } }
  let provider: any, unmount: (() => void) | undefined
  try {
    fibers.push(await ctx.plugin({ name: 'typesafe-launch', apply(c: any) {
      c.provide('launchEnvironment', launch.createLaunchEnvironmentSnapshot([{ source: 'project-env', values: { TYPESAFE_API_KEY: fallback } }]))
    } }))
    fibers.push(await ctx.plugin(commands.default, {}))
    provider = await ctx.plugin(credentials.default, { path, watch: false })
    unmount = mountTypeSafeCommand(ctx.commands, typeSafeCredentials(ctx))
    const invoke = async (raw = '') => (await ctx.commands.execute(agent, `/kioku-typesafe-key${raw ? ` ${raw}` : ''}`, [], new AbortController().signal)).result
    assert.match((await invoke()).text, /project-env.*writable/)
    assert.match((await invoke(secret)).text, /saved/)
    assert.equal((await ctx.credentials.resolve('TYPESAFE_API_KEY')).value, secret)
    assert.match((await invoke('status')).text, /file.*writable/)
    assert.match((await invoke('replacement-key')).text, /saved/)
    unmount(); unmount = undefined
    assert.equal(ctx.commands.list(agent).some((d: any) => d.name === 'kioku-typesafe-key'), false)
    await provider.dispose(); provider = await ctx.plugin(credentials.default, { path, watch: false })
    unmount = mountTypeSafeCommand(ctx.commands, typeSafeCredentials(ctx))
    assert.equal((await ctx.credentials.resolve('TYPESAFE_API_KEY')).value, 'replacement-key')
    assert.match((await invoke('clear')).text, /cleared.*configured.*project-env/)
    assert.equal((await ctx.credentials.resolve('TYPESAFE_API_KEY')).value, fallback)
    const saved = await readFile(path, 'utf8'); assert.ok(!saved.includes(secret)); assert.ok(!saved.includes('replacement-key'))
    await writeFile(path, 'invalid: [document')
    assert.equal((await invoke(secret)).kind, 'error')
    assert.match((await invoke('two words')).text, /TYPESAFE_INVALID_KEY/)
    await provider.dispose(); provider = undefined
    assert.match((await invoke('clear')).text, /TYPESAFE_STORAGE_UNAVAILABLE/)
    const recorded = JSON.stringify(events)
    for (const privateText of [secret, fallback, 'replacement-key', 'two words']) assert.ok(!recorded.includes(privateText))
    assert.ok(events.length > 0)
    for (const event of events as any[]) if (event.type === 'command/run') assert.equal(event.data.args, undefined)
  } finally { unmount?.(); await provider?.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(base, { recursive: true, force: true }) }

  const inherited = new cordis.Context(), cleanup: any[] = [], readonlyEvents: unknown[] = []
  let remove: (() => void) | undefined
  const readonlyPath = join(await mkdtemp(join(tmpdir(), 'typesafe-readonly-')), 'key.yaml')
  try {
    cleanup.push(await inherited.plugin({ name: 'typesafe-inherited', apply(c: any) {
      c.provide('launchEnvironment', launch.createLaunchEnvironmentSnapshot([{ source: 'process', values: { TYPESAFE_API_KEY: secret } }]))
    } }))
    cleanup.push(await inherited.plugin(commands.default, {}))
    cleanup.push(await inherited.plugin(credentials.default, { path: readonlyPath, watch: false }))
    remove = mountTypeSafeCommand(inherited.commands, typeSafeCredentials(inherited))
    agent.session.append = (type: string, data: unknown) => readonlyEvents.push({ type, data })
    for (const input of ['other-key', 'clear']) {
      const result = await inherited.commands.execute(agent, `/kioku-typesafe-key ${input}`, [], new AbortController().signal)
      assert.match(result.result.text, /TYPESAFE_READ_ONLY/)
    }
    const result = await inherited.commands.execute(agent, '/kioku-typesafe-key status', [], new AbortController().signal)
    assert.match(result.result.text, /env.*read-only/)
    assert.ok(!JSON.stringify(readonlyEvents).includes(secret))
    await assert.rejects(readFile(readonlyPath), { code: 'ENOENT' })
  } finally { remove?.(); for (const fiber of cleanup.reverse()) await fiber.dispose(); await rm(join(readonlyPath, '..'), { recursive: true, force: true }) }
})
