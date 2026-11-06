import type { Context } from '@deepseek-ai/cordis'
import { managedAdmissionDenied } from '../managed-operation-runner.js'
import { LispError } from './contracts.js'

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
const pipelineSpecifier: string = '@deepseek-ai/dsh-tools/pipeline'

async function rejectUnavailablePipeline(): Promise<never> {
  return managedAdmissionDenied(new LispError('HOST_ADAPTER_UNAVAILABLE',
    `DSH nested tool pipeline ${pipelineSpecifier} is unavailable. The tool was not dispatched.`,
    'DSH とプラグインが同じ DSH パッケージ一式を参照しているか確認してください。'))
}

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
  let pipelineModule: { ToolExecutionPipeline: new (ctx: Context) => Pipeline }
  try {
    pipelineModule = await import(pipelineSpecifier) as typeof pipelineModule
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND' && code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
    return rejectUnavailablePipeline
  }
  const { ToolExecutionPipeline } = pipelineModule
  if (typeof ToolExecutionPipeline !== 'function') return rejectUnavailablePipeline
  let pipeline: Pipeline | undefined
  await ctx.inject(['tools'], scope => {
    pipeline = new ToolExecutionPipeline(scope)
  })
  if (!pipeline) return rejectUnavailablePipeline
  const activePipeline = pipeline
  return async input => {
    const prepared = await activePipeline.prepare(input)
    const outcome = prepared.kind === 'dispatch' ? await activePipeline.dispatch(prepared.exec) : prepared
    const result = await activePipeline.complete(prepared.exec, outcome)
    if (prepared.kind !== 'dispatch' && result && typeof result === 'object') notDispatched.add(result)
    return result
  }
}
