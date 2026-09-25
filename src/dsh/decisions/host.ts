import { SemanticCompactionConfig, type SemanticCompactionConfiguration } from '../semantic-compaction/contracts.js'
import { MemoryReuseConfig, type MemoryReuseConfiguration } from '../../memory/reuse.js'
import { canonicalContentHash } from '../../serialization/validate.js'
import { typeSafeCredentials } from '../typesafe/command.js'
import type { TypeSafeCredentialProvider } from '../typesafe/credentials.js'
import type { DshNativeCommandDefinition } from '../commands.js'
import type { DshCoreRuntime } from '../core-runtime.js'
import { TypedDecisionsConfig, resolveDecisionConfiguration, type DecisionConfiguration } from './config.js'
import { DecisionError } from './contracts.js'
import { TypeSafeDecisionProvider, NimbleDecisionProvider } from './providers.js'
import { LayaCoreMLDecisionProvider, discoverLayaConfiguration } from './laya-coreml.js'
import { LayaV1DecisionProvider } from './laya-v1.js'
import { DecisionService, databaseDecisionStore } from './service.js'
import { databaseDecisionSelection } from './selection-store.js'

export function createDecisionService(ctx: { get(name: string, strict?: boolean): unknown }, runtime: Pick<DshCoreRuntime, 'withDatabase'>, configuration: DecisionConfiguration = TypedDecisionsConfig.parse({}), memoryReuse: MemoryReuseConfiguration = MemoryReuseConfig.parse({}), semanticCompaction: SemanticCompactionConfiguration = SemanticCompactionConfig.parse({}), repositoryRoot = process.cwd()): DecisionService {
  const credentials = typeSafeCredentials(ctx)
  return new DecisionService(configuration, config => {
    switch (config.provider) {
    case 'laya-coreml': return config['laya-coreml']?.protocol === 'v1' ? new LayaV1DecisionProvider(config['laya-coreml']) : new LayaCoreMLDecisionProvider(config['laya-coreml'])
    case 'typesafe': return new TypeSafeDecisionProvider(config.typesafe, async () => {
      try { return await credentials.resolve() } catch { throw new DecisionError('AUTH') }
    })
    case 'nimble': return new NimbleDecisionProvider(config.nimble, async () => {
      if (!config.nimble.credentialRef) return undefined
      try {
        const native = ctx.get('credentials', false) as TypeSafeCredentialProvider | undefined
        const value = (await native?.resolve(config.nimble.credentialRef))?.value
        if (!value) throw new DecisionError('AUTH')
        return value
      } catch { throw new DecisionError('AUTH') }
    })
    }
  }, databaseDecisionStore(runtime), { memoryReuse, semanticCompaction, repositoryRoot,
    selectionStore: databaseDecisionSelection(runtime, repositoryRoot, resolveDecisionConfiguration(configuration, repositoryRoot)),
    resolveConfiguration: (config, signal) => discoverLayaConfiguration(config, repositoryRoot, signal),
    configurationCheck: async (config, signal) => {
      signal.throwIfAborted()
      if (config.provider === 'typesafe') {
        try { return canonicalContentHash(await credentials.resolve()) } catch { return false }
      }
      if (config.provider === 'laya-coreml') return true
      if (!config.nimble.credentialRef) return true
      try {
        const native = ctx.get('credentials', false) as TypeSafeCredentialProvider | undefined
        const credential = (await native?.resolve(config.nimble.credentialRef))?.value
        return credential ? canonicalContentHash(credential) : false
      } catch { return false }
    } })
}
export function mountDecisionCommand(commands: { register(definition: DshNativeCommandDefinition): () => void }, service: DecisionService,
  modelAutoStatus?: (invocation: Parameters<DshNativeCommandDefinition['handler']>[0]) => Promise<unknown>): () => void {
  const usage = '/kioku-decisions use jev | use laya | use nimble | use default | status | probe | install-laya'
  const providers: Record<string, DecisionConfiguration['provider'] | 'default'> = { jev: 'typesafe', typesafe: 'typesafe', laya: 'laya-coreml', 'laya-coreml': 'laya-coreml', nimble: 'nimble', default: 'default' }
  return commands.register({ name: 'kioku-decisions', description: 'Switch Jev / Laya / Nimble or inspect status. install-laya connects to an existing worker or shows setup instructions.', input: { hint: 'use jev | use laya | use nimble | use default | status | probe | install-laya' },
    handler: async invocation => {
      const action = invocation.rawInput.trim(), args = action.split(/\s+/)
      try {
        invocation.signal.throwIfAborted()
        if (action === 'install-laya' || args[0] === 'use' && args.length === 2 && Object.hasOwn(providers, args[1]!)) {
          await service.selectProvider(action === 'install-laya' ? 'laya-coreml' : providers[args[1]!]!, invocation.signal)
          const status = service.status() as { provider: string; model: string | null }
          return { kind: 'success', text: `判定を ${status.provider} (${status.model ?? '未設定'}) に切り替えました。このプロジェクトの次のリクエストから適用し、再起動後も保持します。進行中のリクエストは元の設定を維持します。` }
        }
        if (action === 'probe') {
          const readiness = await service.probe(invocation.signal, true)
          if (readiness.state !== 'ready') return { kind: 'error', text: `判定を利用できません (${readiness.reason ?? readiness.state})。Layaは start-laya の起動状態、Jevは /kioku-typesafe-key status を確認してください。` }
        } else if (action && action !== 'status') return { kind: 'error', text: usage }
        const inspected = await service.inspectStatus(invocation.signal) as Record<string, unknown>
        const status = JSON.stringify({ ...inspected, ...(modelAutoStatus ? { modelAuto: await modelAutoStatus(invocation) } : {}) }, null, 2)
        return { kind: 'success', text: action ? status : `${usage}\n${status}` }
      } catch (error) {
        const code = invocation.signal.aborted ? 'DECISION_CANCELLED' : error instanceof DecisionError ? error.code : 'DECISION_SELECTION_FAILED'
        if (action === 'install-laya' && code === 'DECISION_UNAVAILABLE') return { kind: 'error', text: `Layaへ接続できません (${code})。導入済みならターミナルで start-laya を起動し、/kioku-decisions use laya を実行してください。未導入の場合は [Layaの導入手順](https://github.com/askdkc/kiokuko-dsh/blob/main/docs/Laya-CoreML-ja.md) を確認してください。このコマンドはPythonやモデルを自動インストールしません。` }
        const hint = code === 'DECISION_UNSUPPORTED' ? 'Layaの応答形式、または設定に明示したモデル・fingerprintを確認してください。通常の start-laya にはモデル・fingerprintの固定は不要です。'
          : code === 'DECISION_AUTH' ? '/kioku-typesafe-key でAPIキーを登録・確認してください。'
          : 'Layaは start-laya の起動状態、Nimbleは接続設定を確認してください。別のDSHで切り替えた場合は、このDSHを再起動してから操作してください。'
        return { kind: 'error', text: `切り替え・確認に失敗しました (${code})。${hint} ${usage}` }
      }
    } })
}
