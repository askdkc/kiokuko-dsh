import { z } from "zod";

const identity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u)
  .refine(
    (value) => value === value.trim(),
    "Identifiers must not have surrounding whitespace",
  );
export const ModelRouteSchema = z
  .object({
    provider: identity,
    family: z.enum([
      "openai",
      "deepseek",
      "opencode-go",
      "opencode-zen",
      "openrouter",
      "orcarouter",
      "ollama",
      "other",
    ]).refine((value): boolean => value !== "orcarouter", "OrcaRouter requires model reselection"),
    connection: z.enum(["api", "codex", "local"]).default("api"),
    protocol: z
      .enum(["responses", "chat-completions", "messages", "unknown"])
      .default("unknown"),
  })
  .strict();
/** Released configurations are readable; new configuration writes use ModelRouteSchema. */
export const LegacyModelRouteSchema = ModelRouteSchema.extend({family: z.enum(['openai','deepseek','opencode-go','opencode-zen','openrouter','orcarouter','ollama','other'])})
export type ModelRoute = z.infer<typeof LegacyModelRouteSchema>;
export const ModelBindingSchema = z
  .object({
    provider: identity,
    model: identity,
    reasoningEffort: identity.optional(),
  })
  .strict();
export type ModelBinding = z.infer<typeof ModelBindingSchema>;
export const ModelConfigurationSchema = z
  .object({
    routeBindings: z.array(ModelRouteSchema).max(128).optional(),
    /** Historical Enno-era role names; retained only to read already-persisted rows. */
    roles: z
      .object({
        ideal: ModelBindingSchema,
        zenki: ModelBindingSchema,
        goki: ModelBindingSchema,
        worker: ModelBindingSchema,
        check: ModelBindingSchema,
      })
      .strict(),
    template: z
      .object({ id: identity, version: z.number().int().positive() })
      .strict()
      .optional(),
    custom: z.boolean(),
    maxConcurrentChildren: z.number().int().min(1).max(8),
  })
  .strict();
export const LegacyModelConfigurationSchema = ModelConfigurationSchema.extend({routeBindings:z.array(LegacyModelRouteSchema).max(128).optional()})
export type ModelConfiguration = z.infer<typeof LegacyModelConfigurationSchema>;
export const ModelConfigurationDraftSchema = ModelConfigurationSchema.extend({
  roles: ModelConfigurationSchema.shape.roles.partial(),
});
export const LegacyModelConfigurationDraftSchema = ModelConfigurationDraftSchema.extend({ routeBindings: z.array(LegacyModelRouteSchema).max(128).optional() });
export type ModelConfigurationDraft = z.infer<
  typeof ModelConfigurationDraftSchema
>;
export interface ConfiguredModel {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly inputModalities?: readonly string[];
}
export interface ResolvedModelInfo extends ConfiguredModel {
  readonly context?: { readonly contextWindow: number };
  readonly reasoning?: { readonly efforts: readonly { readonly id: string }[] };
}
export interface ConfiguredProvider {
  readonly id: string;
  readonly name: string;
  readonly route?: ModelRoute;
}
export interface DshModelCatalog {
  listProviders():
    readonly ConfiguredProvider[] | PromiseLike<readonly ConfiguredProvider[]>;
  listModels(provider: string): PromiseLike<readonly ConfiguredModel[]>;
  /** Optional non-authenticating inventory seam. Native adapters must not use listModels for display. */
  listModelsForDisplay?(provider: string): PromiseLike<readonly ConfiguredModel[] | {
    readonly models: readonly ConfiguredModel[]; readonly complete: boolean;
  }>;
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): PromiseLike<ResolvedModelInfo>;
  /** Native adapter validation; protocol and authentication remain owned by DSH. */
  resolveCallConfig?(
    binding: ModelBinding,
    signal?: AbortSignal,
  ): PromiseLike<ModelBinding>;
}
export interface ModelCatalogSnapshot {
  readonly providers: readonly ConfiguredProvider[];
  readonly models: readonly ConfiguredModel[];
  readonly failures: readonly string[];
  /** Registered providers with no non-authenticating catalog; selected IDs still require live validation. */
  readonly unverifiedProviders?: readonly string[];
  readonly resolveCallConfig?: (
    binding: ModelBinding,
  ) => PromiseLike<ModelBinding>;
}
export async function readModelCatalog(
  llm: DshModelCatalog,
  onlyProviders?: readonly string[],
): Promise<ModelCatalogSnapshot> {
  const providers = (await llm.listProviders()).filter(
    (provider) => provider.id !== "orcarouter" && provider.route?.family !== "orcarouter"
      && (onlyProviders === undefined || onlyProviders.includes(provider.id)),
  );
  const results = await Promise.allSettled(
    providers.map((provider) => onlyProviders === undefined && llm.listModelsForDisplay
      ? llm.listModelsForDisplay(provider.id) : llm.listModels(provider.id)),
  );
  const models: ConfiguredModel[] = [],
    failures: string[] = [], unverifiedProviders: string[] = [];
  results.forEach((result, index) => {
    const provider = providers[index]!;
    if (result.status === "rejected") {
      failures.push(provider.id);
      return;
    }
    const metadata = 'models' in result.value ? result.value : undefined;
    if (metadata?.complete === false) unverifiedProviders.push(provider.id);
    const seen = new Set<string>();
    for (const model of metadata ? metadata.models : result.value as readonly ConfiguredModel[]) {
      if (
        model.provider !== provider.id ||
        !identity.safeParse(model.id).success ||
        seen.has(model.id)
      ) {
        failures.push(provider.id);
        continue;
      }
      seen.add(model.id);
      models.push({ provider: provider.id, id: model.id, name: model.name });
    }
  });
  return {
    providers: providers.map((p) => {
      const route = ModelRouteSchema.safeParse(p.route);
      return {
        id: p.id,
        name: p.name,
        ...(route.success && route.data.provider === p.id
          ? { route: route.data }
          : {}),
      };
    }),
    models,
    failures,
    ...(unverifiedProviders.length ? { unverifiedProviders } : {}),
    ...(llm.resolveCallConfig
      ? {
          resolveCallConfig: (binding: ModelBinding) =>
            llm.resolveCallConfig!(binding),
        }
      : {}),
  };
}
/** Native connection metadata takes precedence over old duplicate declarations. */
export function modelRoutesForCatalog(
  catalog: ModelCatalogSnapshot,
  declared: readonly ModelRoute[],
): ModelRoute[] {
  const native = catalog.providers.flatMap((provider) =>
    provider.route ? [provider.route] : [],
  );
  return [
    ...native,
    ...declared.filter(
      (route) => !native.some((current) => current.provider === route.provider),
    ),
  ];
}
/** A host adapter may supply transport evidence; a UI answer cannot assert it. */
export interface DshModelCompatibility {
  inspect(
    binding: ModelBinding,
    route: ModelRoute,
  ): PromiseLike<{
    readonly protocol: ModelRoute["protocol"];
    readonly goSessionHeaders: boolean;
  }>;
}
export async function modelBindingProblems(
  bindings: readonly { label: string; binding: ModelBinding }[],
  catalog: ModelCatalogSnapshot,
  routes: readonly ModelRoute[],
  compatibility?: DshModelCompatibility,
  validation: 'catalog' | 'connection' = 'connection',
): Promise<string[]> {
  const problems: string[] = [];
  const validations = new Map<string, PromiseLike<ModelBinding>>();
  for (const { label, binding } of bindings) {
    if (binding.provider === 'orcarouter' || routes.some(route => route.provider === binding.provider && route.family === 'orcarouter')) {
      problems.push(`${label}: OrcaRouter はサポートを終了しました。接続とモデルを選び直してください (${binding.provider})`);
      continue;
    }
    if (catalog.failures.includes(binding.provider)) {
      problems.push(
        `${label}: 接続のモデル一覧を取得できません (${binding.provider})`,
      );
      continue;
    }
    if (
      !catalog.models.some(
        (m) => m.provider === binding.provider && m.id === binding.model,
      )
      && !(validation === 'catalog' && catalog.unverifiedProviders?.includes(binding.provider)
        && catalog.providers.some(provider => provider.id === binding.provider))
    ) {
      problems.push(
        `${label}: 設定済みモデルがありません (${binding.provider} / ${binding.model})`,
      );
      continue;
    }
    // A catalog match is a candidate, not authentication or transport evidence.
    if (validation === 'catalog') continue;
    if (catalog.resolveCallConfig) {
      try {
        const key = JSON.stringify(binding);
        let validation = validations.get(key);
        if (!validation) {
          validation = catalog.resolveCallConfig({ ...binding });
          validations.set(key, validation);
        }
        const resolved = await validation;
        if (
          resolved.provider !== binding.provider ||
          resolved.model !== binding.model
        )
          throw new Error("DSH returned a different provider/model");
        if (binding.reasoningEffort !== undefined && resolved.reasoningEffort !== binding.reasoningEffort)
          throw new Error("DSH returned a different reasoning effort");
      } catch (error) {
        problems.push(
          `${label}: DSHのモデル設定を確認してください (${binding.provider} / ${binding.model}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }
    const route = routes.find((r) => r.provider === binding.provider);
    // Older hosts still route registered models themselves. Optional legacy
    // declarations can supply compatibility checks, but are not a second setup.
    if (!route) continue;
    let evidence:
      Awaited<ReturnType<DshModelCompatibility["inspect"]>> | undefined;
    try {
      evidence = await compatibility?.inspect(binding, route);
    } catch {
      /* unverified */
    }
    if (
      binding.model === "gpt-6-astra" &&
      (evidence?.protocol ?? route.protocol) !== "responses"
    )
      problems.push(`${label}: AstraにはResponses接続が必要です`);
    if (route.family === "opencode-go" && evidence?.goSessionHeaders !== true)
      problems.push(
        `${label}: OpenCode Goの親・子・補助要求のセッション情報は互換性の確認が必要です`,
      );
  }
  return [...new Set(problems)];
}
