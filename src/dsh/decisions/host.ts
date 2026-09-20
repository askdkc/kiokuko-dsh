import { typeSafeCredentials } from '../typesafe/command.js'
import type { TypeSafeCredentialProvider } from '../typesafe/credentials.js'
import type { DshNativeCommandDefinition } from '../commands.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import { TypedDecisionsConfig, type DecisionConfiguration } from './config.js'
import { DecisionError } from './contracts.js'
import { TypeSafeDecisionProvider, NimbleDecisionProvider } from './providers.js'
import { DecisionService, databaseDecisionStore } from './service.js'

export function createDecisionService(ctx: { get(name: string, strict?: boolean): unknown }, runtime: Pick<DshCoreRuntime, 'withDatabase'>, configuration: DecisionConfiguration = TypedDecisionsConfig.parse({})): DecisionService {
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
    }), databaseDecisionStore(runtime))
}
export function mountDecisionCommand(commands: { register(definition: DshNativeCommandDefinition): () => void }, service: DecisionService): () => void {
  return commands.register({ name: 'kioku-decisions', description: 'Show the configured typed-decision backend, limits and fallback status.', input: { hint: 'status' },
    handler: async invocation => {
      invocation.signal.throwIfAborted()
      if (invocation.rawInput.trim() && invocation.rawInput.trim() !== 'status') return { kind: 'error', text: 'Use /kioku-decisions status.' }
      return { kind: 'success', text: JSON.stringify(service.status(), null, 2) }
    } })
}
