import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withNativeForegroundOnly } from '../../../../src/dsh/lisp/native-foreground.js'
import { mountNativeTools } from '../../helpers/native-tools.js'

// Exercise the shipped Bash + jobs contract without requiring process-inspection
// permissions. The separate SBCL integration test owns real-process acceptance.
const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)
test('native Bash never registers or promotes a synchronous Lisp command, even when promotion is enabled', { timeout: 10000 }, async () => {
  const [cordis, prompt, tools, scope] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope'].map(load))
  const ctx = new cordis.Context(), fibers: any[] = []
  const agent: any = { id: 'promotion-owner', session: { id: 'promotion-session', header: { cwd: '/tmp' }, append() {} } }
  let local: any, starts = 0, stopped = false, registered = 0
  const shell = {
    resolve(request: any) { return { ...request, onExpiry: request.onExpiry ?? 'kill', timeoutMs: request.timeoutMs ?? 10 } },
    async execute(spec: any) {
      starts++
      assert.equal(spec.onExpiry, 'kill', 'deadline must kill, never promote')
      let finish!: () => void
      const done = new Promise<void>(resolve => { finish = resolve })
      const stream = { readFrom() { return { text: '', nextOffset: 0, lossy: false } } }
      const proc = { status: 'running', signal: null as string | null, exitCode: null, done,
        observed: { stdout: stream, stderr: stream },
        kill() { stopped = true; proc.status = 'killed'; proc.signal = 'SIGTERM'; finish(); return true },
        async result() { await done; return { exitCode: null, signal: 'SIGTERM', timedOut: true, aborted: false,
          timeoutMs: spec.timeoutMs, stdout: { text: 'partial output', truncated: false }, stderr: { text: 'failed test', truncated: false } } },
      }
      const timer = setTimeout(() => proc.kill(), spec.timeoutMs)
      done.then(() => clearTimeout(timer))
      spec.signal?.addEventListener('abort', () => proc.kill(), { once: true })
      return proc
    },
  }
  try {
    fibers.push(await ctx.plugin(prompt.default, {})); await mountNativeTools(ctx, tools, packages, fibers)
    fibers.push(await ctx.plugin({ name: 'promotion-contract', apply(c: any) {
      c.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined })
      c.provide('sessions', { get: () => agent.session })
      c.provide('shell', shell)
      c.provide('workingDirectory', { ensure: async () => '/tmp' })
      c.provide('shellEnv', { collect: () => ({}) })
    } }))
    fibers.push(await ctx.plugin((await load('dsh-jobs-local')).default, {}))
    fibers.push(await ctx.plugin(await load('dsh-tool-bash'), {}))
    fibers.push(await ctx.plugin(await load('dsh-tool-jobs'), {}))
    local = scope.createScope(ctx, agent); agent.ctx = local.ctx
    const args = { command: 'fixture', description: 'promotion fixture', workdir: '/tmp/.', timeoutMs: 10 }
    const originalStart = ctx.jobs.start
    ctx.jobs.start = function (...args: any[]) { registered++; return originalStart.apply(this, args) }
    const result: any = await withNativeForegroundOnly(agent.ctx.get('jobs'),
      () => ctx.tools.get('bash', agent).execute(args, { callId: 'foreground-call', rootCallId: 'foreground-call', agent, signal: new AbortController().signal }))
    assert.equal(result.kind, 'foreground')
    assert.equal(result.timedOut, true)
    assert.equal(result.stdout.text, 'partial output')
    assert.equal(result.stderr.text, 'failed test')
    assert.equal(starts, 1); assert.equal(stopped, true)
    assert.equal(registered, 0, 'no job may be admitted, even transiently')
    assert.deepEqual(ctx.jobs.list(agent.id), [])
  } finally {
    await local?.dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
})
