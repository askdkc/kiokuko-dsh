import type { DshCompositionHost } from '../composition.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import type { DshMemoryFinalizer } from '../session-memory-finalizer.js'
import type { EvolutionConfig } from '../../memory/evolution/contracts.js'
import { evolutionStatus } from '../../memory/evolution/store.js'

interface EvolutionHostDependencies {
  readonly runtime: DshCoreRuntime
  readonly memoryFinalizer: DshMemoryFinalizer
  readonly evolutionConfig: EvolutionConfig
}

export function createEvolutionHost({ runtime, memoryFinalizer, evolutionConfig }: EvolutionHostDependencies): NonNullable<DshCompositionHost['memoryEvolution']> {
  return {
    configure(config: EvolutionConfig) { memoryFinalizer.configureMemoryEvolution(config); Object.assign(evolutionConfig, config) },
    async status(sessionId: string) {
      return runtime.withDatabase(db => {
        const workspaces = db.prepare('SELECT DISTINCT workspace FROM ledger_runs WHERE dsh_session_id=? LIMIT 2').all<{ workspace: string }>(sessionId)
        if (workspaces.length !== 1) throw new Error('Evolution status requires an unambiguous session workspace')
        return evolutionStatus(db, workspaces[0]!.workspace)
      })
    },
  }
}
