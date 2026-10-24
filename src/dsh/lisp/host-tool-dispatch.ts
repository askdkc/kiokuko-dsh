import type { Context } from '@deepseek-ai/cordis'

interface Invocation {
  callId: string
  name: string
  arguments: unknown
  agent?: object
  parent?: symbol
  rootCallId?: string
  toolSet?: unknown
  signal: AbortSignal
}
interface Pipeline {
  prepare(input: Invocation): Promise<{ kind: 'dispatch' | 'post-result' | 'final-result'; exec: unknown; result?: unknown }>
  dispatch(execution: unknown): Promise<unknown>
  complete(execution: unknown, outcome: unknown): Promise<unknown>
}
interface Tools {
  setExecutor?: unknown
  execute(input: unknown): Promise<unknown>
}

/** Host-owned nested calls retain their exact parent identity and all DSH policy stages. */
export async function createLispHostDispatch(ctx: Context, tools: Tools): Promise<(input: Invocation) => Promise<any>> {
  if (typeof tools.setExecutor !== 'function') return input => tools.execute(input)
  // The batch entry point accepts model calls, not nested host invocations. Its
  // parser drops parent/root identity. Use the exported scheduler stages for
  // this single, already-parsed nested invocation instead.
  const specifier: string = '@deepseek-ai/dsh-tools/pipeline'
  const { ToolExecutionPipeline } = await import(specifier) as { ToolExecutionPipeline: new (ctx: Context) => Pipeline }
  let pipeline: Pipeline | undefined
  await ctx.inject(['tools'], scope => {
    pipeline = new ToolExecutionPipeline(scope)
  })
  if (!pipeline) throw new Error('DSH tools service is unavailable for nested Lisp dispatch')
  const activePipeline = pipeline
  return async input => {
    const prepared = await activePipeline.prepare(input)
    const outcome = prepared.kind === 'dispatch' ? await activePipeline.dispatch(prepared.exec) : prepared
    return activePipeline.complete(prepared.exec, outcome)
  }
}
