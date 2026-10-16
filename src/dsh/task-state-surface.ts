import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { TASK_TYPES, type TaskType } from '../akinator/types.js'
import type { OnDemandIntake } from './on-demand-intake.js'
import type { DshNativeCommandDefinition } from './commands.js'
import { TASK_OPERATIONS, type TaskOperation } from './task-state.js'
import { DshTaskWorkflow, TASK_OPERATION_TOOL, TASK_WORKFLOW_SERVICE,
  type TaskNativeAgent } from './task-state-host.js'

// Providers require an object at the root. modelOperation validates each
// operation's required fields and rejects fields from other operations.
const taskOperationTransportSchema = z.object({
  operation: z.enum(['create', ...TASK_OPERATIONS]),
  taskType: z.enum(TASK_TYPES).optional(),
  taskId: z.string().trim().min(1).max(4096).optional(),
  expectedRevision: z.number().int().positive().optional(),
  expectedGeneration: z.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(4096).optional(),
  evidence: z.array(z.string().trim().min(1).max(512)).max(32).optional(),
}).strict()

const usage = '/kioku-task status | create <type> <request> | start | wait | resume [taskId] | complete [taskId] [--evidence <ref> ...] | ignore [taskId] --reason <text>'

/** Native command registration consumes failures as command results, never model input. */
export function taskWorkflowCommand(service: DshTaskWorkflow): DshNativeCommandDefinition {
  return { name: 'kioku-task', description: 'Inspect or explicitly change the current SQLite task state.',
    input: { hint: 'status | create <type> <request> | start | wait | resume [taskId] | complete [taskId] [--evidence <ref> ...] | ignore [taskId] --reason <text>' },
    recordInput: false,
    handler: async invocation => {
      try {
        const agent = invocation.agent as TaskNativeAgent | undefined
        if (!agent) throw new Error('Current native agent is required')
        const [operation = 'status', ...parts] = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
        if (operation === 'status') {
          if (parts.length > 0) throw new Error(usage)
          return { kind: 'success', text: JSON.stringify(await service.snapshot(agent)) }
        }
        if (operation === 'create') {
          const parsed = invocation.rawInput.trim().match(/^create\s+(\S+)\s+([\s\S]+)$/u)
          if (!parsed || !(TASK_TYPES as readonly string[]).includes(parsed[1]!)) throw new Error(usage)
          const task = await service.operate(agent, { operation: 'create', taskType: parsed[1] as TaskType, request: parsed[2]! }, invocation.signal)
          return { kind: 'success', text: JSON.stringify(task) }
        }
        if (operation === 'complete') {
          const rest = [...parts], taskId = rest[0] && rest[0] !== '--evidence' ? rest.shift() : undefined
          const evidence: string[] = []
          while (rest.length) {
            if (rest.shift() !== '--evidence' || !rest[0] || rest[0]!.startsWith('--')) throw new Error(usage)
            evidence.push(rest.shift()!)
          }
          const task = await service.operate(agent, { operation: 'complete', ...(taskId ? { taskId } : {}), evidence,
            reason: 'Explicit completion judgment based on the supplied host receipts and all existing completion criteria' }, invocation.signal)
          return { kind: 'success', text: JSON.stringify(task) }
        }
        if (operation === 'ignore') {
          const parsed = invocation.rawInput.trim().match(/^ignore(?:\s+(\S+))?\s+--reason\s+([\s\S]+)$/u)
          if (!parsed) throw new Error('Ignore requires an explicit reason: /kioku-task ignore [taskId] --reason <text>')
          const task = await service.operate(agent, { operation: 'ignore', reason: parsed[2]!, ...(parsed[1] ? { taskId: parsed[1] } : {}) }, invocation.signal)
          return { kind: 'success', text: JSON.stringify(task) }
        }
        if (!(TASK_OPERATIONS as readonly string[]).includes(operation) || parts.length > 1) throw new Error(usage)
        const task = await service.operate(agent, { operation: operation as TaskOperation,
          ...(parts[0] ? { taskId: parts[0] } : {}) }, invocation.signal)
        return { kind: 'success', text: JSON.stringify(task) }
      } catch (error) { return { kind: 'error', text: error instanceof Error ? error.message : 'Task operation failed' } }
    } }
}

export function mountTaskWorkflowSurface(ctx: Context, service: DshTaskWorkflow, demand?: OnDemandIntake): () => void {
  const disposers: Array<() => unknown> = []
  const native = ctx as any
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true; service.dispose()
    for (const release of disposers.reverse()) try { release() } catch { /* Release the remaining registrations too. */ }
  }
  try {
  disposers.push(native.provide(TASK_WORKFLOW_SERVICE, service))
  const commands = native.get('commands', false), tools = native.get('tools', false)
  if (commands?.register) disposers.push(commands.register(taskWorkflowCommand(service)))
  if (tools?.register && demand) {
    const definition = { name: TASK_OPERATION_TOOL,
      description: 'Explicit structured operation on the exact current SQLite task. Read its current taskId, revision, generation and allowedOps. Create uses the original human request; it accepts no rewritten request. State changes do not grant native permission. Completion and stop require host-observed evidence. Completion must satisfy every existing criterion; for noncoding work without criteria, completion is an explicit human or model judgment grounded in the actual content of supplied current host receipts, not an automatic success inference. If only run_code is exposed, use only return await tools.task_operation(<one JSON object>) as the entire code; the host intercepts it without program evaluation.',
      parameters: JSON.parse(JSON.stringify(z.toJSONSchema(taskOperationTransportSchema))),
      output: { schema: {}, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args: unknown, execution: any) => service.modelOperation(execution.agent, args, execution),
    }
    disposers.push(tools.register(definition))
    disposers.push(demand.registerControlTool(definition))
  }
  const retry = (payload: any) => {
    const agent = payload?.agent ?? payload
    if (!agent?.session) return
    void service.snapshot(agent).then(({ task }) => {
      if (task?.pendingStop) service.finishStop(agent, task)
      if (task?.state === 'Done') service.finishCompletion(agent, task)
    }).catch(() => {})
  }
  disposers.push(native.on('agent/idle', retry, { global: true }))
  disposers.push(native.on('agent/created', retry, { global: true }))
  disposers.push(native.on('agent/status', (event: any) => { if (event.status === 'idle') retry(event) }, { global: true }))
  for (const agent of native.get('agents', false)?.list?.() ?? []) retry(agent)
  return dispose
  } catch (error) { dispose(); throw error }
}
