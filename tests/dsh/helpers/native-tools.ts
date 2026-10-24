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
