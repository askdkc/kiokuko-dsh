import { Config } from '../config.js'
import type { DshModule } from '../core/modules.js'
import type { CoreModuleHost } from '../core/host.js'
import { bundledResources } from './resources.js'
export const EnnoModuleConfig = Config.pick({ akinatorMemory: true, modelRoutes: true, efficiency: true, continuity: true, ennoMemory: true, finalization: true }).strict()

/** Retain the existing role/lease/verification adapter behind the local feature boundary. */
export const ennoModule: DshModule<CoreModuleHost> = {
  id: 'enno', coreVersion: 1, requires: ['tools', 'sessions', 'agents', 'commands', 'userQuestions', 'llm'], conflicts: ['lisp'],
  resources: bundledResources(['kiokuko-enno-oduno']),
  configure: value => EnnoModuleConfig.parse(value ?? {}),
  async mount({ host, defer }, configuration) {
    host.claimNativeIngress()
    const config = Config.parse({ ...EnnoModuleConfig.parse(configuration), deepPlanning: { enabled: false }, orca: { enabled: false }, memoryReview: { mode: 'off' }, memoryEvolution: { mode: 'off' } })
    const [{ createDshHostAdapter }, { mountDshComposition }] = await Promise.all([import('../host-adapter.js'), import('../composition.js')])
    const adapter = createDshHostAdapter(host.context, { ...config, repositoryRoot: host.repositoryRoot, runtime: host.runtime, decisions: host.decisions, semanticCompactionCoordinator: host.semanticCompaction, skillPrompts: host.prompts })
    defer(adapter.dispose)
    // Shared runtime, Skills and SOUL are owned by the enclosing composition.
    const { skills: _skills, systemPrompt: _prompt, ...featureHost } = adapter.host
    const composition = await mountDshComposition(host.context, featureHost, undefined, host.prompts, { typeSafeCommand: false })
    let drained: Promise<void> | undefined
    return { stopIngress: composition.stopIngress, drain() { return drained ??= (async () => { composition.stopIngress(); await composition.dispose(); await adapter.dispose() })() }, async dispose() {} }
  },
}
