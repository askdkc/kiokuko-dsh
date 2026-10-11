import type { PromptAssembly } from '../japanese-output-skill.js'

export { LISP_ASSEMBLY_SERVICE, stableLispCapabilities } from '../lisp-service-key.js'
export interface LispAssemblyService {
  readonly capabilities?: readonly { name: string; description: string }[]
  inventory?(agent: { id: string }): readonly { name: string; description?: string }[]
  project(agent: { id: string }, assembly: PromptAssembly): PromptAssembly | Promise<PromptAssembly>
}
