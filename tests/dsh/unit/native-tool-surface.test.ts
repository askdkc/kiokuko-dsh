import { stableLispCapabilities } from '../../../src/dsh/lisp-service-key.js'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createNativeToolSurface, stableNativeToolCapabilities } from '../../../src/dsh/native-tool-surface.js'

const packages = process.env.KIOKUKO_DSH_PACKAGE_ROOT ?? join(process.cwd(), 'tests/fixtures/dsh-runtime/node_modules')
const load = (name: string) => import(pathToFileURL(join(packages, '@deepseek-ai', name, 'lib/index.js')).href)

test('native projection is per-agent, preserves the bound catalog and restores its registrations', async () => {
  const [{ Context }, { default: Prompt }, { default: Tools, defineTool }, { createScope }] = await Promise.all([
    load('cordis'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-scope'),
  ])
  const ctx = new Context()
  const scopes: any[] = []
  try {
    await ctx.plugin(Prompt)
    await ctx.plugin(Tools)
    for (const name of ['owned_a', 'owned_b', 'external']) ctx.tools.register(defineTool({
      name, description: `Full ${name}`, parameters: {},
      output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
      async execute() { return name },
    }))
    const make = (id: string) => {
      let scope: any
      const agent = { id, get ctx() { return scope.ctx } }
      scope = createScope(ctx, agent); scopes.push(scope)
      return agent
    }
    const agent = make('projected'), other = make('other')
    const baseline = ctx.tools.schemas(agent)
    const owners = new Map(['owned_a', 'owned_b'].map(name => [name, { execute: ctx.tools.get(name).execute }]))
    const surface = createNativeToolSurface(agent, owners)
    try {
      surface.prepare(schemas => schemas.filter(schema => schema.name !== 'owned_b').map(schema => schema.name === 'owned_a' ? { ...schema, description: 'Lean A' } : schema))
      assert.deepEqual(ctx.tools.schemas(agent).map((schema: any) => schema.name).sort(), ['external', 'owned_a'])
      assert.equal(ctx.tools.get('owned_a', agent).description, 'Lean A')
      assert.deepEqual(stableNativeToolCapabilities(ctx.tools.schemas(agent), agent), baseline)
      ctx.provide('kiokukoLispAssembly', {
        capabilities: [{ name: 'lisp_eval', description: 'Installed Lisp capability' }],
        inventory: (target: object) => ctx.tools.schemas(target),
      })
      assert.deepEqual(stableNativeToolCapabilities(stableLispCapabilities(ctx.tools.schemas(agent), agent), agent),
        [...baseline, { name: 'lisp_eval', description: 'Installed Lisp capability' }],
        'Lisp inventory must not discard the stable installed Kiokuko capabilities')
      assert.deepEqual(ctx.tools.schemas(other), baseline, 'another agent retains the original catalog')
      assert.deepEqual(ctx.tools.schemas(), baseline, 'host registrations are never modified')
      const admitted = await ctx.tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'fixture' }, signal: new AbortController().signal })
      try {
        assert.equal(ctx.tools.executable('owned_b', agent, admitted), undefined, 'hidden operations cannot dispatch through the step')
        assert.equal(ctx.tools.executable('owned_a', agent, admitted).execute, owners.get('owned_a')!.execute)
      } finally { admitted.dispose() }
      surface.prepare(schemas => schemas)
      assert.deepEqual(ctx.tools.schemas(agent), baseline, 'the next full step restores definitions')
      assert.throws(() => surface.prepare(() => { throw new Error('projection failed') }), /projection failed/)
      assert.deepEqual(ctx.tools.schemas(agent), baseline, 'failed projection leaves the original registrations visible')
      const collision = make('collision')
      const localTools = collision.ctx.get('tools')
      const existing = { ...ctx.tools.get('owned_a'), description: 'Existing Agent A' }
      const disposeExisting = localTools.register(existing)
      const failing = createNativeToolSurface(collision, owners)
      try {
        assert.throws(() => failing.prepare(schemas => schemas.filter(schema => schema.name !== 'owned_b')), /already registered in this scope/)
        assert.equal(ctx.tools.get('owned_a', collision), existing, 'rollback preserves an existing scoped definition')
        assert.ok(ctx.tools.get('owned_b', collision), 'rollback lifts the partially installed mask')
      } finally { failing.dispose(); disposeExisting() }
      surface.prepare(schemas => schemas, true)
      assert.deepEqual(ctx.tools.schemas(agent), [], 'automatic reconsideration can select a no-tool step')
      assert.deepEqual(stableNativeToolCapabilities(ctx.tools.schemas(agent), agent), baseline)
    } finally { surface.dispose() }
    assert.deepEqual(ctx.tools.schemas(agent), baseline, 'unload restores every mask and shadow')
  } finally {
    for (const scope of scopes.reverse()) await scope.dispose()
    await ctx.fiber.dispose()
  }
})
