import { LispConfig } from '../lisp/contracts.js'
import { mountLispSurface } from '../lisp/surface.js'
import type { DshModule } from '../core/modules.js'
import type { CoreModuleHost } from '../core/host.js'
import { bundledResources } from './resources.js'

/** Lisp uses the shared development executor; explicit protected mode retains its root fence. */
export const lispModule: DshModule<CoreModuleHost> = {
  id: 'lisp', coreVersion: 1, requires: ['tools', 'sessions', 'agents', 'commands'], conflicts: ['enno'],
  resources: bundledResources(['kiokuko-lisp']),
  configure: value => LispConfig.parse(value ?? {}),
  async mount({ host, defer }, configuration) {
    const surface = await mountLispSurface(host.context, host.runtime, LispConfig.parse(configuration), host.prompts, host.decisions, host.semanticCompaction)
    let drained: Promise<void> | undefined
    return { stopIngress() { surface.stop() }, drain() { return drained ??= surface.dispose() }, async dispose() {} }
  },
}
