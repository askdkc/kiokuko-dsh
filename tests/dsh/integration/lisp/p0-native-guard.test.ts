import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT
if (process.env.KIOKUKO_REQUIRE_DSH_NATIVE === '1' && !packages) throw new Error('P0 native guard proof requires the pinned DSH package runtime')

test('P0: real DSH registry guard denies direct, nested and late-registered tools despite allow listeners', {
  skip: packages ? false : 'requires pinned DSH packages; skip is not protection evidence', timeout: 15_000,
}, async () => {
  const [cordis, prompt, tools, scope] = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-scope']
    .map(name => import(pathToFileURL(path.join(packages!, '@deepseek-ai', name, 'lib/index.js')).href)))
  const ctx = new cordis.Context()
  const fibers: any[] = []
  const disposers: Array<() => unknown> = []
  let executions = 0
  const definition = (name: string) => tools.defineTool({ name, description: 'P0 harmless counter fixture', parameters: {},
    output: { schema: { type: 'integer' }, render: (_: unknown, value: number) => [{ type: 'text', text: String(value) }] },
    execute: async () => ++executions })
  const parent = { id: 'p0-parent', session: { id: 'p0-parent' } }
  const child = { id: 'p0-child', session: { id: 'p0-child' } }
  scope.bindScopeParent(child, parent)
  const call = (name: string, agent: object = parent, nested = false) => ctx.tools.execute({
    callId: `p0-${name}`, name, arguments: {}, agent, signal: new AbortController().signal,
    ...(nested ? { parent: Symbol('p0-parent-execution'), rootCallId: 'p0-root' } : {}),
  })
  try {
    fibers.push(await ctx.plugin(prompt.default, {}))
    fibers.push(await ctx.plugin(tools.default, { mode: 'native' }))
    disposers.push(ctx.tools.register(definition('p0_write')))
    assert.equal((await call('p0_write')).isError, false, 'positive control must reach the real body')
    assert.equal(executions, 1)
    disposers.push(ctx.on('tools/pre-execute', async () => ({ kind: 'allow' })))
    const removeGuard = ctx.tools.guard(() => 'P0_PROTECTION_REQUIRED')
    disposers.push(removeGuard)
    disposers.push(ctx.tools.guard(() => undefined))
    disposers.push(ctx.tools.register(definition('p0_late_write')))
    for (const agent of [parent, child]) {
      for (const name of ['p0_write', 'p0_late_write']) {
        for (const nested of [false, true]) {
          const result = await call(name, agent, nested)
          assert.equal(result.isError, true)
          assert.equal(result.error?.message, 'P0_PROTECTION_REQUIRED')
        }
      }
    }
    assert.equal(executions, 1, 'denials must happen before any fixture effect')
    removeGuard()
    assert.equal((await call('p0_late_write')).isError, false)
    assert.equal(executions, 2, 'removing the guard reopens execution: admission must be host-owned')
  } finally {
    for (const dispose of disposers.reverse()) dispose()
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
})
