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

const notDispatched = new WeakSet<object>()
/** Host-local preparation evidence; serialized error text cannot mint this fact. */
export function lispHostToolWasNotDispatched(result: unknown): boolean {
  return !!result && typeof result === 'object' && notDispatched.has(result)
}

/** Host-owned nested calls retain their exact parent identity and all DSH policy stages. */
export async function createLispHostDispatch(ctx: Context, tools: Tools): Promise<(input: Invocation) => Promise<any>> {
  if (typeof tools.setExecutor !== 'function') return input => tools.execute(input)
  // The batch entry point accepts model calls, not nested host invocations. Its
  // parser drops parent/root identity. Use the exported scheduler stages for
  // this single, already-parsed nested invocation instead.
  const specifier: string = '@deepseek-ai/dsh-tools/pipeline'
  let pipeline: Pipeline | undefined
  try {
    const { ToolExecutionPipeline } = await import(specifier) as { ToolExecutionPipeline: new (ctx: Context) => Pipeline }
    await ctx.inject(['tools'], scope => {
      pipeline = new ToolExecutionPipeline(scope)
    })
  } catch (error) {
    // Optional peer absent in this host: nested calls go through the plain tool
    // executor. Host policy stages own their identity checks at the boundary.
    if (error instanceof Error && !/Cannot find module|ERR_MODULE_NOT_FOUND|Cannot find package/u.test(error.message)) throw error
    pipeline = undefined
  }
  if (!pipeline) return input => tools.execute(input)
  const activePipeline = pipeline
  return async input => {
    const prepared = await activePipeline.prepare(input)
    const outcome = prepared.kind === 'dispatch' ? await activePipeline.dispatch(prepared.exec) : prepared
    const result = await activePipeline.complete(prepared.exec, outcome)
    if (prepared.kind !== 'dispatch' && result && typeof result === 'object') notDispatched.add(result)
    return result
  }
}
