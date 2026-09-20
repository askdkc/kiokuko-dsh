import { SemanticCompactionConfig, type SemanticCompactionConfiguration } from '../semantic-compaction/contracts.js'
import { MemoryReuseConfig, type MemoryReuseConfiguration } from '../../memory/reuse.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { typeSafeCredentials } from '../typesafe/command.js'
import type { TypeSafeCredentialProvider } from '../typesafe/credentials.js'
import type { DshNativeCommandDefinition } from '../commands.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import { TypedDecisionsConfig, type DecisionConfiguration } from './config.js'
import { DecisionError } from './contracts.js'
import { TypeSafeDecisionProvider, NimbleDecisionProvider } from './providers.js'
import { DecisionService, databaseDecisionStore } from './service.js'

export function createDecisionService(ctx: { get(name: string, strict?: boolean): unknown }, runtime: Pick<DshCoreRuntime, 'withDatabase'>, configuration: DecisionConfiguration = TypedDecisionsConfig.parse({}), memoryReuse: MemoryReuseConfiguration = MemoryReuseConfig.parse({}), semanticCompaction: SemanticCompactionConfiguration = SemanticCompactionConfig.parse({})): DecisionService {
  const credentials = typeSafeCredentials(ctx)
  return new DecisionService(configuration, config => config.provider === 'typesafe'
    ? new TypeSafeDecisionProvider(config.typesafe, async () => {
      try { return await credentials.resolve() } catch { throw new DecisionError('AUTH') }
    })
    : new NimbleDecisionProvider(config.nimble, async () => {
      if (!config.nimble.credentialRef) return undefined
      try {
        const native = ctx.get('credentials', false) as TypeSafeCredentialProvider | undefined
        const value = (await native?.resolve(config.nimble.credentialRef))?.value
        if (!value) throw new DecisionError('AUTH')
        return value
      } catch { throw new DecisionError('AUTH') }
    }), databaseDecisionStore(runtime), { memoryReuse, semanticCompaction, configurationCheck: async (config, signal) => {
      signal.throwIfAborted()
      if (config.provider === 'typesafe') {
        try { return canonicalContentHash(await credentials.resolve()) } catch { return false }
      }
      if (!config.nimble.credentialRef) return true
      try {
        const native = ctx.get('credentials', false) as TypeSafeCredentialProvider | undefined
        const credential = (await native?.resolve(config.nimble.credentialRef))?.value
        return credential ? canonicalContentHash(credential) : false
      } catch { return false }
    } })
}
export function mountDecisionCommand(commands: { register(definition: DshNativeCommandDefinition): () => void }, service: DecisionService): () => void {
  return commands.register({ name: 'kioku-decisions', description: 'Show the configured typed-decision backend, limits and fallback status.', input: { hint: 'status | probe' },
    handler: async invocation => {
      invocation.signal.throwIfAborted()
      const action = invocation.rawInput.trim()
      if (action === 'probe') await service.probe(invocation.signal, true)
      else if (action && action !== 'status') return { kind: 'error', text: 'Use /kioku-decisions status or /kioku-decisions probe.' }
      return { kind: 'success', text: JSON.stringify(await service.inspectStatus(invocation.signal), null, 2) }
    } })
}
