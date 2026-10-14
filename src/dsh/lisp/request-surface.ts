import type { PromptAssembly } from '../japanese-output-skill.js'

export { LISP_ASSEMBLY_SERVICE, stableLispCapabilities } from '../lisp-service-key.js'
export interface LispAssemblyService {
  readonly capabilities?: readonly { name: string; description: string }[]
  inventory?(agent: { id: string }): readonly { name: string; description?: string }[]
  /** Task-stop evidence requires supervised Lisp processes and pending calls to drain. */
  stopTask?(agent: { id: string }): Promise<void>
  /** Observe background Lisp jobs without counting the caller's current evaluation. */
  taskJobsIdle?(agent: { id: string }): Promise<boolean>
  /** Recheck in the completion transaction without yielding to a pending job launch. */
  taskJobsIdleSync?(agent: { id: string }): boolean
  project(agent: { id: string }, assembly: PromptAssembly): PromptAssembly | Promise<PromptAssembly>
}
