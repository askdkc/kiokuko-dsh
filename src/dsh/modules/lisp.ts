import { LispConfig } from '../lisp/contracts.js'
import { mountLispSurface } from '../lisp/surface.js'
import { LISP_CODING_SERVICE, type LispCodingService } from '../lisp/coding-choice.js'
import { resolveGroundedIntakeProfile } from '../intake-profile-resolver.js'
import type { DshModule } from '../core/modules.js'
import type { CoreModuleHost } from '../core/host.js'
import { bundledResources } from './resources.js'

/** Protected execution stays host-owned. Unload preserves the existing root fence. */
export const lispModule: DshModule<CoreModuleHost> = {
  id: 'lisp', coreVersion: 1, requires: ['tools', 'sessions', 'agents', 'commands'], conflicts: ['enno'],
  resources: bundledResources(['kiokuko-lisp']),
  configure: value => LispConfig.parse(value ?? {}),
  async mount({ host, defer }, configuration) {
    const surface = await mountLispSurface(host.context, host.runtime, LispConfig.parse(configuration), host.prompts, host.decisions, host.semanticCompaction)
    const unregister = host.beforeTask(async input => {
      const coding = host.context.get(LISP_CODING_SERVICE, false) as LispCodingService | undefined
      if (!coding || !input.agent) return
      const profile = resolveGroundedIntakeProfile({ task: input.task, cwd: input.cwd, ...(input.profileHints ? { profileHints: input.profileHints } : {}) })
      const selected = await coding.prepare({ agent: input.agent, task: input.task, taskType: profile.profileHints.taskType, turn: input.turn, signal: input.signal })
      return { taskType: selected.taskType, ...(selected.clarification ? { constraints: selected.clarification } : {}) }
    })
    defer(unregister)
    let drained: Promise<void> | undefined
    return { stopIngress() { unregister(); surface.stop() }, drain() { return drained ??= surface.dispose() }, async dispose() {} }
  },
}
