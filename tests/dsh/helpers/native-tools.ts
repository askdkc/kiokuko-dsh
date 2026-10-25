import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Install the selected host's actual native executor, not a registry shim. */
export async function mountNativeTools(ctx: any, tools: any, packages: string, fibers: any[]): Promise<void> {
  const current = typeof tools.default?.prototype?.setExecutor === 'function'
  fibers.push(await ctx.plugin(tools.default, current ? {} : { mode: 'native' }))
  if (current) {
    const executor = await import(pathToFileURL(join(packages, '@deepseek-ai/dsh-tool-executor-native/lib/index.js')).href)
    fibers.push(await ctx.plugin(executor, {}))
  }
}

/** Preserve direct model batches and nested host calls as distinct native paths. */
export async function executeNativeTool(ctx: any, packages: string, input: any): Promise<any> {
  if (typeof ctx.tools.setExecutor !== 'function') return ctx.tools.execute(input)
  if (input.parent !== undefined) {
    const { ToolExecutionPipeline } = await import(pathToFileURL(join(packages, '@deepseek-ai/dsh-tools/lib/pipeline.js')).href)
    const pipeline = new ToolExecutionPipeline(ctx)
    const prepared = await pipeline.prepare(input)
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
    return pipeline.complete(prepared.exec, outcome)
  }
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    agent: input.agent, signal: input.signal,
    ...(input.toolSet ? { toolSet: input.toolSet } : {}),
  })
  assert.equal(batch.results.length, 1, 'a one-call native batch must settle exactly once')
  return batch.results[0].result
}

/** Select the current host executor after its real PTC runtime is mounted. */
export async function mountToolExecutor(ctx: any, tools: any, packages: string, mode: 'native' | 'ptc', fibers: any[]): Promise<void> {
  if (mode === 'native') return mountNativeTools(ctx, tools, packages, fibers)
  assert.equal(typeof tools.default?.prototype?.setExecutor, 'function', 'PTC fixtures require the selected executor API')
  fibers.push(await ctx.plugin(tools.default, {}))
  const executor = await import(pathToFileURL(join(packages, '@deepseek-ai/dsh-tool-executor-ptc/lib/index.js')).href)
  fibers.push(await ctx.plugin(executor, {}))
  const assembly = await ctx.systemPrompt.assemble({})
  assert.deepEqual(assembly.tools.map((tool: any) => tool.name), ['run_code'])
  assert.equal(ctx.tools.get('run_code'), undefined, 'current PTC transport belongs to its executor, not the registry')
  assert.equal(typeof ctx.get('ptcRuntime').run, 'function')
}

/** Mount only the executor after a fixture has installed its registry and prompt. */
export async function mountNativeExecutor(ctx: any, packages: string, fibers: any[] = []): Promise<void> {
  const executor = await import(pathToFileURL(join(packages, '@deepseek-ai/dsh-tool-executor-native/lib/index.js')).href)
  fibers.push(await ctx.plugin(executor, {}))
}
