import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import type { ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";
import {
  adapterBuiltinProviders,
  type PiAiProvider,
  type PiAiCredentialStore,
} from "./vendor/pi-ai.js";
import {
  credentialKey,
  type Connection,
  type InfronServiceTier,
} from "./contracts.js";
import type { CredentialFile } from "./vendor/credentials.js";

type PiModel = ReturnType<PiAiProvider["getModels"]>[number];
/** Compose the public payload hook after any caller hook; the closure freezes tier. */
export function infronProvider(
  source: PiAiProvider,
  tier: InfronServiceTier,
  report?: (tier: InfronServiceTier | "unknown") => void,
): PiAiProvider {
  const options = (input: any = {}) => ({
    ...input,
    fetch: observeTier(input.fetch ?? globalThis.fetch, report),
    onPayload: async (body: unknown, model: unknown) => {
      report?.("unknown");
      const changed = await input.onPayload?.(body, model);
      const value = changed ?? body;
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Infron payload must be an object");
      const data = value as Record<string, unknown>,
        provider = data.provider;
      if (
        provider !== undefined &&
        (!provider || typeof provider !== "object" || Array.isArray(provider))
      )
        throw new Error("Infron provider payload must be an object");
      return {
        ...data,
        provider: { ...(provider as object | undefined), service_tier: tier },
      };
    },
  });
  return {
    ...source,
    stream: ((model: any, context: any, input: any) =>
      source.stream(model, context, options(input))) as PiAiProvider["stream"],
    streamSimple: (model, context, input) =>
      source.streamSimple(model, context, options(input)),
  };
}
/** Inspect bounded SSE metadata while forwarding exactly the original bytes. */
function observeTier(
  fetcher: typeof fetch,
  report?: (tier: InfronServiceTier | "unknown") => void,
): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (
      !report ||
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    )
      return response;
    const decoder = new TextDecoder();
    let line = "",
      discarding = false;
    const observer = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        for (const char of decoder.decode(chunk, { stream: true })) {
          if (char === "\n") {
            if (!discarding && line.startsWith("data:")) {
              try {
                const value = JSON.parse(line.slice(5));
                const actual =
                  value.provider?.service_tier ?? value.service_tier;
                if (actual === "standard" || actual === "flex") report(actual);
              } catch {
                /* Non-JSON SSE events and DONE carry no tier. */
              }
            }
            line = "";
            discarding = false;
          } else if (!discarding) {
            if (line.length >= 65_536) {
              line = "";
              discarding = true;
            } else line += char;
          }
        }
      },
    });
    return new Response(response.body.pipeThrough(observer), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
export function sharedCredentialStore(
  store: CredentialFile,
  connections: readonly Connection[],
): PiAiCredentialStore {
  const keys = new Map(connections.map((c) => [c.id, credentialKey(c)]));
  const key = (id: string) => keys.get(id) ?? id;
  return {
    read: (id) => store.read(key(id)),
    modify: (id, fn) => store.modify(key(id), fn),
    delete: (id) => store.delete(key(id)),
    list: async () => {
      const rows = await store.list();
      return connections.flatMap((c) =>
        rows
          .filter((r) => r.providerId === credentialKey(c))
          .map((r) => ({ ...r, providerId: c.id })),
      );
    },
  };
}
/** Build owned immutable profiles from the adapter's exact catalog instance. */
export function connectionProfile(
  connection: Connection,
  report?: (tier: InfronServiceTier | "unknown") => void,
): ResolvedPiAiProviderProfile {
  // The Anthropic SDK appends /v1/messages itself. Accept an API prefix ending
  // in /v1 in the shared editor without sending /v1/v1/messages.
  const baseURL = connection.protocol === "messages"
    ? connection.baseURL.replace(/\/v1\/?$/, "")
    : connection.baseURL;
  const catalog = adapterBuiltinProviders();
  const original = catalog.find((p) => p.id === credentialKey(connection));
  const protocolSource = catalog.find(
    (p) =>
      p.id ===
      (connection.protocol === "messages"
        ? "anthropic"
        : connection.protocol === "responses"
          ? "openai"
          : "openrouter"),
  );
  const source = connection.kind === "codex" ? original : protocolSource;
  if (!source)
    throw new Error("Installed adapter does not provide the selected protocol");
  const api =
    connection.kind === "codex"
      ? "openai-codex-responses"
      : connection.protocol === "responses"
        ? "openai-responses"
        : connection.protocol === "messages"
          ? "anthropic-messages"
          : "openai-completions";
  const shipped = original?.getModels() ?? [];
  const models: PiModel[] = connection.models.length
    ? connection.models.map(
        (m) =>
          ({
            id: m.id,
            name: m.name,
            provider: connection.id,
            api,
            baseUrl: baseURL,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            reasoning: m.reasoning,
            input: m.image ? ["text", "image"] : ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }) as PiModel,
      )
    : shipped.map(
        (m) =>
          ({
            ...m,
            provider: connection.id,
            baseUrl: baseURL,
            api,
          }) as PiModel,
      );
  let provider: PiAiProvider = {
    ...source,
    id: connection.id,
    name: connection.name,
    baseUrl: baseURL,
    getModels: () => models,
    getAllModels: () => models,
    auth: original?.auth ?? {
      apiKey: {
        name: "Connection key",
        resolve: async ({ credential }) => ({
          auth:
            credential?.type === "api_key" && credential.key
              ? { apiKey: credential.key }
              : {},
          source: connection.name,
        }),
      },
    },
  };
  delete (provider as { refreshModels?: unknown }).refreshModels;
  if (connection.kind === "infron")
    provider = infronProvider(provider, connection.serviceTier, report);
  return {
    provider: connection.id,
    displayName: connection.name,
    api,
    baseURL,
    piProvider: provider,
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    retryPolicy: resolveRetryPolicy(undefined, connection.id),
  };
}
