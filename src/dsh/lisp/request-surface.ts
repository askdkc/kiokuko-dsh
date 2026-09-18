import type { PromptAssembly } from '../japanese-output-skill.js'

export const LISP_ASSEMBLY_SERVICE = 'kiokukoLispAssembly'
export interface LispAssemblyService {
  project(agent: { id: string }, assembly: PromptAssembly): PromptAssembly
}
