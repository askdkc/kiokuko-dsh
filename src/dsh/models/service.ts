import { registerOwnedModels } from "./metadata.js";
import { randomUUID } from "node:crypto";
import {
  INVALID_CREDENTIAL_CODE,
  ReasoningEffortId,
  LlmAdapter,
  type LlmDiscoveredModel,
  type LlmRuntime,
  type GenerateOptions,
  type StreamChunk,
  type PreparedAdapterCall,
} from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import {
  ConnectionSchema,
  CONNECTION_DEFAULTS,
  credentialKey,
  type Connection,
  type InfronServiceTier,
  type ManualModel,
  type ModelsDocument,
  ManualModelSchema,
} from "./contracts.js";
import { ModelsConfigStore } from "./config-store.js";
import { CredentialFile, asStoredCredential } from "./vendor/credentials.js";
import { adapterBuiltinProviders } from "./vendor/pi-ai.js";
import type {
  AuthEvent,
  AuthPrompt,
  AuthInteraction,
} from "./vendor/auth-contract.js";
import { loginNous, refreshNous } from "./vendor/nous-oauth.js";
import {
  connectionProfile,
  OUTPUT_TOKEN_MARGIN,
  protocolApi,
  requestMaxTokens,
  sharedCredentialStore,
  storableMaxTokens,
} from "./profiles.js";
import { OpenCodeAdapter } from "./vendor/opencode-adapter.js";
import {
  OpenCodeCatalog,
  type OpenCodeRoute,
} from "./vendor/opencode-catalog.js";
import { OPEN_CODE_SNAPSHOTS } from "./vendor/opencode-owned.generated.js";
import { readModelCatalog, type DshModelCatalog, type ModelRoute } from "../model-configuration.js";
import { HeadWorkerConfigurationSchema, headWorkerCandidates, validateHeadWorker, type HeadWorkerConfiguration } from "../head-worker-configuration.js";

type Route = {
  connection: Connection;
  adapter: LlmAdapter;
  underlying: string;
};
/**
 * Capacities for a discovered model whose endpoint and catalog disclose none.
 * These are the pi-ai profile defaults (`defaultContextWindow`,
 * `defaultMaxTokens`), so the stored row matches what the adapter resolves for
 * that same route instead of inventing a third number.
 */
const DEFAULT_CONTEXT_WINDOW = 262_144,
  DEFAULT_MAX_TOKENS = 32_768;
/** A stable registered adapter; each prepared call retains its own generation. */
class ModelsAdapter extends LlmAdapter {
  routes = new Map<string, Route>();
  private readonly active = new Set<Promise<void>>();
  private readonly requests = new WeakMap<
    AbortSignal,
    { key: string; route: Route }
  >();
  constructor(
    private readonly lifecycle: AbortSignal,
    private readonly store: CredentialFile,
    private readonly onRejection: (
      provider: string,
      model: string,
      error: unknown,
    ) => Promise<void>,
  ) {
    super();
  }
  private route(id: string): Route {
    const route = this.routes.get(id);
    if (!route) throw new Error("Connection no longer registered");
    return route;
  }
  bindRequest(
    signal: AbortSignal,
    provider: string,
    model: string,
    turn: number,
    step: number,
  ): void {
    const route = this.routes.get(provider);
    if (!route) return;
    const key = JSON.stringify([provider, model, turn, step]);
    if (this.requests.get(signal)?.key !== key)
      this.requests.set(signal, { key, route });
  }
  override providerInfo(id: string) {
    return { id, name: this.route(id).connection.name };
  }
  override providerRetryPolicy(id: string) {
    const r = this.route(id);
    return r.adapter.providerRetryPolicy(r.underlying);
  }
  override async listModels(id: string) {
    const r = this.route(id);
    if (
      r.connection.kind !== "ollama" &&
      !(await this.store.read(credentialKey(r.connection)))
    )
      return [];
    return (await r.adapter.listModels(r.underlying)).map((m) => ({
      ...m,
      provider: id,
    }));
  }
  override async resolveModel(id: string, model: string, signal?: AbortSignal) {
    const r = this.route(id);
    return {
      ...(await r.adapter.resolveModel(r.underlying, model, signal)),
      provider: id,
    };
  }
  override async prepareCall(
    id: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const frozen = signal ? this.requests.get(signal) : undefined;
    const r =
        frozen?.route.connection.id === id ? frozen.route : this.route(id),
      call = await r.adapter.prepareCall(r.underlying, model, signal);
    return {
      model: { ...call.model, provider: id },
      stream: (options) => {
        if (options.provider !== id || options.model !== model)
          throw new Error("Prepared connection identity mismatch");
        return this.run(call, {
          ...options,
          // Metadata alone is not enforced by pi-ai's stream API. Preserve the
          // prepared generation while bounding both omitted and explicit budgets.
          maxTokens: requestMaxTokens(call.model.defaultMaxTokens, call.model.context?.contextWindow, options.maxTokens),
          provider: r.underlying,
          signal: AbortSignal.any([
            ...(options.signal ? [options.signal] : []),
            this.lifecycle,
          ]),
        }, id);
      },
    };
  }
  private async *run(call: PreparedAdapterCall, options: GenerateOptions, provider: string): AsyncIterable<StreamChunk> {
    this.lifecycle.throwIfAborted();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.active.add(done);
    try {
      for await (const chunk of call.stream(options)) {
        // pi-ai reports provider failures in-band; retain its original finish.
        if (chunk.type === "finish" && chunk.reason.kind === "error") {
          await this.onRejection(provider, options.model, new Error(chunk.reason.failure.message));
        }
        yield chunk;
      }
    } catch (error) {
      // A rejection that names the endpoint's own ceiling teaches the stored
      // output cap; the provider's failure still reaches the caller unchanged.
      await this.onRejection(provider, options.model, error);
      throw error;
    } finally {
      this.active.delete(done);
      finish();
    }
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* (
      await this.prepareCall(options.provider, options.model, options.signal)
    ).stream(options);
  }
}
interface AuthRun {
  id: string;
  connectionId: string;
  status: "pending" | "success" | "cancelled" | "error";
  events: AuthEvent[];
  prompt?: AuthPrompt;
  error?: string;
  abort: AbortController;
  answer?: { resolve: (text: string) => void; reject: (error: Error) => void };
  done: Promise<void>;
}
export interface ModelsServiceOptions {
  llm: Pick<
    LlmRuntime,
    "registerAdapter" | "resolveCallConfig" | "discoverModels"
  >;
  catalog?: DshModelCatalog;
  sessionCreatedAt?: (sessionId: string) => number | undefined;
  now?: () => number;
  assertCurrent?: (sessionId: string) => void | Promise<void>;
  onCurrentHeadWorkerChange?: (sessionId: string) => void | Promise<void>;
  config: ModelsConfigStore;
  credentials: CredentialFile;
  attachments?: () => any;
  selectCurrent?: (
    sessionId: string,
    binding: { provider: string; model: string },
  ) => Promise<void>;
  saveDefault?: (binding: { provider: string; model: string }) => Promise<void>;
}

export class KiokukoModelsService {
  private document: ModelsDocument = {
    version: 1,
    revision: 0,
    connections: [],
  };
  private readonly lifecycle = new AbortController();
  private readonly adapter: ModelsAdapter;
  private registration: ReturnType<LlmRuntime["registerAdapter"]> | undefined;
  private readonly catalogs = new Map<OpenCodeRoute, OpenCodeCatalog>();
  private readonly tiers = new Map<
    string,
    { requested: InfronServiceTier; actual: InfronServiceTier | "unknown" }
  >();
  private readonly logins = new Map<string, AuthRun>();
  private mutations: Promise<unknown> = Promise.resolve();
  private releaseMetadata: (() => void) | undefined;
  private closed = false;
  constructor(private readonly options: ModelsServiceOptions) {
    this.adapter = new ModelsAdapter(
      this.lifecycle.signal,
      options.credentials,
      (provider, model, error) => this.learnCeiling(provider, model, error),
    );
  }
  /**
   * A provider rejection that names its own ceiling ("max_completion_tokens=…
   * cannot be greater than max_model_len=…") is the only place a deployment
   * discloses a limit below its listing. Record it as that model's output cap —
   * never the context window, never upward, only for the route and model that
   * failed — so the next request fits. Best effort: the provider's failure is
   * what the caller sees.
   */
  private async learnCeiling(
    provider: string,
    model: string,
    error: unknown,
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : "",
      match = /max_model_len=(?:max_total_tokens=)?(\d{1,9})(?!\d)/.exec(detail);
    if (!match || !detail.includes("max_completion_tokens")) return;
    const c = this.document.connections.find((v) => v.id === provider),
      row = c?.models.find((m) => m.id === model),
      capped = Math.max(1, Number(match[1]) - OUTPUT_TOKEN_MARGIN);
    if (!c || !row || capped >= row.maxTokens) return;
    try {
      await this.save(
        {
          ...c,
          models: c.models.map((m) =>
            m.id === model ? { ...m, maxTokens: capped } : m,
          ),
        },
        this.document.revision,
      );
    } catch {
      // Learning is best effort; a concurrent save wins over this correction.
    }
  }
  bindRequest(
    signal: AbortSignal,
    binding: { provider?: string; model?: string },
    turn: number,
    step: number,
  ): void {
    if (binding.provider && binding.model)
      this.adapter.bindRequest(
        signal,
        binding.provider,
        binding.model,
        turn,
        step,
      );
  }
  async start(): Promise<void> {
    this.document = await this.options.config.read();
    this.publish(this.build(this.document.connections));
    this.releaseMetadata = registerOwnedModels(this.options.llm, this);
  }
  private require(id: string): Connection {
    const c = this.document.connections.find((c) => c.id === id);
    if (!c) throw new Error("Unknown connection");
    return c;
  }
  routeMetadata(id: string): ModelRoute | undefined {
    const c = this.document.connections.find((c) => c.id === id);
    if (!c) return undefined;
    return {
      provider: id,
      family:
        c.kind === "codex"
          ? "openai"
          : ["openai", "deepseek", "openrouter", "ollama"].includes(c.kind)
            ? (c.kind as ModelRoute["family"])
            : c.kind === "opencode"
              ? "opencode-zen"
              : c.kind === "opencode-go"
                ? "opencode-go"
                : "other",
      connection:
        c.kind === "codex" ? "codex" : c.kind === "ollama" ? "local" : "api",
      protocol: c.protocol,
    };
  }
  private catalog(): DshModelCatalog {
    if (this.options.catalog) return this.options.catalog;
    const native = this.options.llm as ModelsServiceOptions["llm"] & Partial<DshModelCatalog>;
    return {
      listProviders: () => native.listProviders?.() ?? this.document.connections.map(c => ({ id: c.id, name: c.name, route: this.routeMetadata(c.id)! })),
      listModels: id => native.listModels?.(id) ?? this.adapter.listModels(id),
      resolveCallConfig: binding => this.options.llm.resolveCallConfig({ provider: binding.provider, model: binding.model,
        ...(binding.reasoningEffort !== undefined ? { reasoningEffort: ReasoningEffortId(binding.reasoningEffort) } : {}) }),
    };
  }
  private defaultFor(sessionId: string): HeadWorkerConfiguration | undefined {
    const createdAt = this.options.sessionCreatedAt?.(sessionId), selectedAt = this.document.defaultHeadWorkerSelectedAt;
    // Unseen old chats and unverifiable sessions never silently adopt a new default.
    return createdAt !== undefined && Number.isFinite(createdAt) && selectedAt !== undefined && createdAt >= selectedAt
      ? this.document.defaultHeadWorker : undefined;
  }
  private selectionFor(sessionId?: string) {
    return sessionId && Object.hasOwn(this.document.sessionHeadWorkers ?? {}, sessionId)
      ? this.document.sessionHeadWorkers![sessionId] ?? undefined
      : sessionId ? this.defaultFor(sessionId) : this.document.defaultHeadWorker;
  }
  async list(sessionId?: string) {
    const candidates = await headWorkerCandidates(await readModelCatalog(this.catalog()).catch(() => ({ providers: [], models: [], failures: [] })), []);
    const auth = await this.options.credentials.describe();
    return {
      revision: this.document.revision,
      headWorker: {
        candidates, current: this.selectionFor(sessionId) ?? null, default: this.document.defaultHeadWorker ?? null,
        currentAvailable: !this.selectionFor(sessionId) || (
          candidates.heads.some(b => b.provider === this.selectionFor(sessionId)!.head.provider && b.model === this.selectionFor(sessionId)!.head.model) &&
          candidates.workers.some(b => b.provider === this.selectionFor(sessionId)!.worker.provider && b.model === this.selectionFor(sessionId)!.worker.model)
        ),
      },
      connections: this.document.connections.map((c) => {
        const row = auth.find((a) => a.provider === credentialKey(c));
        const run = [...this.logins.values()].find(
          (r) => r.connectionId === c.id && r.status === "pending",
        );
        return {
          ...c,
          credentialKey: credentialKey(c),
          connected: c.kind === "ollama" || !!row,
          authState: run
            ? "authenticating"
            : row?.expired
              ? "reauthentication-may-be-required"
              : row || c.kind === "ollama"
                ? "connected"
                : "disconnected",
          oauth:
            c.kind === "nous" ||
            !!adapterBuiltinProviders().find((p) => p.id === credentialKey(c))
              ?.auth.oauth,
          requestedTier: c.kind === "infron" ? c.serviceTier : undefined,
          actualTier:
            c.kind === "infron"
              ? (this.tiers.get(c.id)?.actual ?? "unknown")
              : undefined,
          lastRequestedTier:
            c.kind === "infron" ? this.tiers.get(c.id)?.requested : undefined,
        };
      }),
    };
  }
  async save(input: unknown, revision: number): Promise<void> {
    return this.serial(async () => {
      const c = ConnectionSchema.parse(input);
      if (
        c.kind === "codex" &&
        c.baseURL !== "https://chatgpt.com/backend-api/codex"
      )
        throw new Error("Codex OAuth requires the official endpoint");
      const previous = this.document.connections.find((v) => v.id === c.id);
      if (
        (c.kind === "opencode" || c.kind === "opencode-go") &&
        (c.baseURL !==
          (c.kind === "opencode"
            ? "https://opencode.ai/zen/v1"
            : "https://opencode.ai/zen/go/v1") ||
          c.protocol !== "chat-completions")
      )
        throw new Error(
          "Connection uses the official OpenCode catalog; use a custom connection for other endpoints",
        );
      if (previous && previous.kind !== c.kind)
        throw new Error("Connection kind cannot change; add a new connection");
      const next = {
        ...this.document,
        revision: revision + 1,
        connections: [
          ...this.document.connections.filter((v) => v.id !== c.id),
          c,
        ],
      };
      if (revision !== this.document.revision)
        throw new Error("Configuration changed; reload before saving");
      const routes = this.build(next.connections),
        previousRoutes = this.adapter.routes;
      this.publish(routes);
      try {
        await this.options.config.write(next, revision);
      } catch (error) {
        this.publish(previousRoutes);
        throw error;
      }
      this.document = next;
    });
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.mutations.then(() => {
      if (this.closed) throw new Error("Models service stopped");
      return action();
    });
    this.mutations = run.catch(() => undefined);
    return run;
  }
  private build(connections: readonly Connection[]): Map<string, Route> {
    const routes = new Map<string, Route>();
    for (const c of connections) {
      if (c.kind === "opencode" || c.kind === "opencode-go") {
        let catalog = this.catalogs.get(c.kind);
        if (!catalog) {
          catalog = new OpenCodeCatalog(c.kind, OPEN_CODE_SNAPSHOTS[c.kind]);
          this.catalogs.set(c.kind, catalog);
        }
        routes.set(c.id, {
          connection: c,
          underlying: c.kind,
          adapter: new OpenCodeAdapter({
            catalogs: new Map([[c.kind, catalog]]),
            store: this.options.credentials,
            ...(this.options.attachments
              ? { attachments: this.options.attachments }
              : {}),
          }),
        });
      } else {
        const profile = connectionProfile(c, (tier) =>
            this.tiers.set(c.id, { requested: c.serviceTier, actual: tier }),
          ),
          credentials = sharedCredentialStore(this.options.credentials, [c]);
        const adapter = new PiAiAdapter({
          profiles: () => new Map([[c.id, profile]]),
          resolveApiKey: async () => this.apiKey(c),
          auth: {
            credentials,
            authContext: {
              env: async () => undefined,
              fileExists: async () => false,
            },
          },
          ...(this.options.attachments
            ? { resolveAttachments: this.options.attachments }
            : {}),
        });
        routes.set(c.id, { connection: c, underlying: c.id, adapter });
      }
    }
    return routes;
  }
  private publish(routes: Map<string, Route>): void {
    const old = this.adapter.routes;
    this.adapter.routes = routes;
    try {
      if (this.registration) this.registration.replace([...routes.keys()]);
      else if (routes.size)
        this.registration = this.options.llm.registerAdapter(
          [...routes.keys()],
          this.adapter,
        );
    } catch (e) {
      this.adapter.routes = old;
      throw e;
    }
  }
  private async apiKey(c: Connection): Promise<string | undefined> {
    if (c.kind === "ollama") return "ollama";
    const current = await this.options.credentials.read(credentialKey(c));
    if (!current)
      throw new Error("Connection is signed out; sign in in Kiokuko Models");
    if (current.type === "api_key") return current.key;
    if (c.kind !== "nous") return undefined;
    const refreshed = await this.options.credentials.modify(
      "nous",
      async (latest) =>
        latest?.type === "oauth" && latest.expires <= Date.now() + 60_000
          ? refreshNous(latest, "hermes-cli")
          : latest,
    );
    if (refreshed?.type !== "oauth")
      throw new Error("Nous requires reauthentication");
    return refreshed.access;
  }
  async setKey(id: string, key: string): Promise<void> {
    const c = this.require(id);
    if (c.kind === "codex" || c.kind === "ollama")
      throw new Error("This connection does not use API keys");
    if (!key.trim() || key.length > 16_384)
      throw new Error("Enter a valid API key");
    this.cancelConnectionLogins(c);
    await this.options.credentials.modify(credentialKey(c), async () => ({
      type: "api_key",
      key: key.trim(),
    }));
    this.registration?.replace([...this.adapter.routes.keys()]);
  }
  private cancelConnectionLogins(c: Connection): void {
    for (const run of this.logins.values())
      if (
        credentialKey(this.require(run.connectionId)) === credentialKey(c) &&
        run.status === "pending"
      )
        this.cancel(run.id);
  }
  async logout(id: string): Promise<void> {
    const c = this.require(id);
    this.cancelConnectionLogins(c);
    await this.options.credentials.delete(credentialKey(c));
    this.registration?.replace([...this.adapter.routes.keys()]);
  }
  async models(id: string) {
    this.require(id);
    return this.adapter.listModels(id);
  }
  async refresh(id: string): Promise<void> {
    const c = this.require(id);
    if (c.kind === "opencode" || c.kind === "opencode-go") {
      const state = await this.catalogs.get(c.kind)!.refresh();
      if (state.warning) throw new Error(state.warning);
      this.publish(this.build(this.document.connections));
      return;
    }
    if (c.kind === "codex") return;
    const key = await this.apiKey(c),
      models = this.adopt(c, await this.discover(c, key));
    if (!models.length)
      throw new Error(
        "Model discovery returned no models; register models manually",
      );
    await this.save({ ...c, models }, this.document.revision);
  }
  /**
   * Ask the adapter for the models this connection serves. A route the
   * installed pi-ai catalog ships answers from that catalog, capacities
   * included and without a network call; every other endpoint — a gateway, a
   * self-hosted server — is interrogated over the wire. Nothing is stored, so a
   * failed interrogation leaves the saved connections untouched.
   */
  private async discover(
    c: Connection,
    key: string | undefined,
  ): Promise<readonly LlmDiscoveredModel[]> {
    const catalog = this.catalogRoute(c),
      timeout = AbortSignal.timeout(15_000);
    try {
      return await this.options.llm.discoverModels(
        "llm-pi-ai",
        {
          ...(catalog === undefined ? {} : { provider: catalog }),
          baseURL: c.baseURL,
          api: protocolApi(c.protocol),
          ...(key ? { apiKey: key } : {}),
        },
        AbortSignal.any([this.lifecycle.signal, timeout]),
      );
    } catch (error) {
      if (this.closed || this.lifecycle.signal.aborted)
        throw new Error("Model discovery cancelled");
      if (timeout.aborted)
        throw new Error("Model discovery timed out; check the endpoint");
      // Route on the harness code, never on message text; the detail is kept
      // only because it names the user's own endpoint and refusal status.
      const code = (error as { code?: unknown }).code;
      if (code === "NO_DISCOVERY")
        throw new Error(
          "Model discovery is unavailable in this profile; register models manually",
        );
      if (code === "DISCOVERY_UNSUPPORTED")
        throw new Error(
          "Model discovery does not support this protocol; register models manually",
        );
      if (code === "ABORTED") throw new Error("Model discovery cancelled");
      if (code === INVALID_CREDENTIAL_CODE)
        throw new Error(
          "Model discovery rejected this API key; paste the raw key only",
        );
      const detail = error instanceof Error ? error.message : "";
      throw new Error(
        `Model discovery failed: ${(detail || "the endpoint did not answer with a model list").slice(0, 200)}`,
      );
    }
  }
  /**
   * Choose the catalog route to name when asking for models. Naming it lets the
   * adapter answer from its own registry, which is right only while the
   * connection still points at that provider's own endpoint: an edited Base URL
   * is a different service that must be interrogated instead.
   */
  private catalogRoute(c: Connection): string | undefined {
    if (c.kind === "custom") return undefined;
    const [, standard] = CONNECTION_DEFAULTS[c.kind];
    return c.baseURL.replace(/\/+$/, "") === standard.replace(/\/+$/, "")
      ? credentialKey(c)
      : undefined;
  }
  /**
   * Adopt discovered rows as stored models. Capacities the endpoint withholds
   * come from the adapter's catalog entry, the row already stored for that id,
   * or the pi-ai profile defaults the native Models page applies to the same
   * route — so an id-only listing still yields a usable model instead of
   * failing the whole refresh.
   */
  private adopt(
    c: Connection,
    discovered: readonly LlmDiscoveredModel[],
  ): ManualModel[] {
    const shipped =
      adapterBuiltinProviders()
        .find((p) => p.id === credentialKey(c))
        ?.getModels() ?? [];
    return discovered.flatMap((entry) => {
      const known = shipped.find((m) => m.id === entry.id),
        prior = c.models.find((m) => m.id === entry.id),
        contextWindow =
          entry.contextWindow ??
          known?.contextWindow ??
          prior?.contextWindow ??
          DEFAULT_CONTEXT_WINDOW,
        parsed = ManualModelSchema.safeParse({
          id: entry.id,
          name: entry.name ?? entry.id,
          contextWindow,
          maxTokens: storableMaxTokens(
            entry.maxTokens ??
              known?.maxTokens ??
              prior?.maxTokens ??
              DEFAULT_MAX_TOKENS,
            contextWindow,
          ),
          reasoning: known?.reasoning ?? prior?.reasoning ?? false,
          image:
            entry.inputModalities !== undefined
              ? entry.inputModalities.includes("image")
              : (known?.input.includes("image") ?? prior?.image ?? false),
        });
      return parsed.success ? [parsed.data] : [];
    });
  }
  /** Snapshot once, including an ordinary-model choice, so defaults only affect new chats. */
  async headWorkerSelection(sessionId: string): Promise<{ configuration?: HeadWorkerConfiguration; revision: number }> {
    this.checkSessionId(sessionId);
    return this.serial(async () => {
      if (!Object.hasOwn(this.document.sessionHeadWorkers ?? {}, sessionId))
        await this.writeHeadWorker(this.defaultFor(sessionId) ?? null, "current", sessionId);
      const configuration = this.document.sessionHeadWorkers![sessionId];
      return {
        ...(configuration ? { configuration: structuredClone(configuration) } : {}),
        revision: this.document.sessionHeadWorkerRevisions?.[sessionId] ?? 0,
      };
    });
  }
  private checkSessionId(sessionId: unknown): asserts sessionId is string {
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256 || /[\p{Cc}\p{Cf}]/u.test(sessionId))
      throw new Error("Open a chat before selecting its model");
  }
  private async writeHeadWorker(configuration: HeadWorkerConfiguration | null, scope: "current" | "default", sessionId?: string): Promise<void> {
    const revision = this.document.revision + 1;
    const next: ModelsDocument = scope === "current" ? {
      ...this.document, revision,
      sessionHeadWorkers: { ...this.document.sessionHeadWorkers, [sessionId!]: configuration },
      sessionHeadWorkerRevisions: { ...this.document.sessionHeadWorkerRevisions, [sessionId!]: revision },
    } : { ...this.document, revision };
    if (scope === "default") {
      if (configuration) {
        next.defaultHeadWorker = configuration;
        next.defaultHeadWorkerSelectedAt = (this.options.now ?? Date.now)();
      } else {
        delete next.defaultHeadWorker;
        delete next.defaultHeadWorkerSelectedAt;
      }
    }
    await this.options.config.write(next, this.document.revision);
    this.document = next;
  }
  async selectHeadWorker(input: unknown, scope: "current" | "default", revision: number, sessionId?: string): Promise<void> {
    return this.serial(async () => {
      if (scope !== "current" && scope !== "default") throw new Error("Head/worker selection scope is invalid");
      if (revision !== this.document.revision) throw new Error("Configuration changed; reload before saving");
      const parsed = input === null ? null : HeadWorkerConfigurationSchema.safeParse(input);
      if (parsed && !parsed.success) throw new Error("Head/worker configuration is invalid; choose both exact models");
      const configuration = parsed?.success ? parsed.data : null;
      if (configuration) {
        let available = false;
        try { available = !(await validateHeadWorker(configuration, this.catalog())).length; } catch { /* Do not expose provider diagnostics or credentials. */ }
        if (!available) throw new Error("Head/worker unavailable; verify both exact connections and models, then reload");
      }
      if (scope === "current") {
        this.checkSessionId(sessionId);
        if (!this.options.assertCurrent) throw new Error("Open a chat before selecting its model");
        await this.options.assertCurrent(sessionId);
      }
      await this.writeHeadWorker(configuration, scope, sessionId);
      if (scope === "current") await this.options.onCurrentHeadWorkerChange?.(sessionId!);
    });
  }
  /** An explicit native effort change keeps the pair and revokes older worker generations. */
  async updateHeadWorkerEffort(sessionId: string, reasoningEffort: string, isCurrent: () => boolean = () => true): Promise<void> {
    this.checkSessionId(sessionId);
    return this.serial(async () => {
      if (!isCurrent()) return;
      const current = this.selectionFor(sessionId);
      if (!current || current.head.reasoningEffort === reasoningEffort) return;
      const parsed = HeadWorkerConfigurationSchema.safeParse({ ...current, head: { ...current.head, reasoningEffort } });
      if (!parsed.success) throw new Error("Head/worker reasoning effort is invalid");
      let available = false;
      try { available = !(await validateHeadWorker(parsed.data, this.catalog())).length; } catch { /* Keep provider details private. */ }
      if (!available) throw new Error("Head/worker reasoning effort is unavailable; reload and select an available effort");
      if (!isCurrent()) return;
      await this.writeHeadWorker(parsed.data, "current", sessionId);
    });
  }
  /** Native model picker selections explicitly leave pair mode in just this chat. */
  async clearHeadWorker(sessionId: string, isCurrent: () => boolean = () => true): Promise<void> {
    this.checkSessionId(sessionId);
    return this.serial(async () => {
      if (!isCurrent()) return;
      await this.writeHeadWorker(null, "current", sessionId);
    });
  }
  async select(
    id: string,
    model: string,
    scope: "current" | "default",
    sessionId?: string,
  ): Promise<void> {
    return this.serial(async () => {
      const c = this.require(id);
      if (!(await this.models(id)).some((m) => m.id === model))
        throw new Error("Model is not available; connect and refresh first");
      const binding = { provider: c.id, model };
      await this.options.llm.resolveCallConfig(binding);
      if (scope === "default") {
        if (!this.options.saveDefault) throw new Error("Saving the default is unavailable");
        await this.options.saveDefault(binding);
        const pair = this.document.defaultHeadWorker;
        if (pair && (pair.head.provider !== binding.provider || pair.head.model !== binding.model))
          await this.writeHeadWorker(null, "default");
      } else {
        if (!sessionId || !this.options.selectCurrent) throw new Error("Open a chat before selecting its model");
        const pair = this.selectionFor(sessionId);
        await this.options.selectCurrent(sessionId, binding);
        if (!pair || pair.head.provider !== binding.provider || pair.head.model !== binding.model)
          await this.writeHeadWorker(null, "current", sessionId);
      }
    });
  }
  startLogin(id: string): string {
    const c = this.require(id);
    if (
      [...this.logins.values()].some(
        (r) =>
          r.status === "pending" &&
          credentialKey(this.require(r.connectionId)) === credentialKey(c),
      )
    )
      throw new Error("Authentication is already running");
    const oauth = adapterBuiltinProviders().find(
      (p) => p.id === credentialKey(c),
    )?.auth.oauth;
    if (!oauth && c.kind !== "nous")
      throw new Error("OAuth is unavailable for this connection");
    const run: AuthRun = {
      id: randomUUID(),
      connectionId: id,
      status: "pending",
      events: [],
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.logins.set(run.id, run);
    const bridge: AuthInteraction = {
      signal: run.abort.signal,
      notify: (event) => {
        if (!run.abort.signal.aborted) {
          run.events.push(event);
          if (run.events.length > 128) run.events.shift();
        }
      },
      prompt: (prompt) =>
        new Promise((resolve, reject) => {
          run.prompt = prompt;
          run.answer = { resolve, reject };
        }),
    };
    run.abort.signal.addEventListener(
      "abort",
      () => {
        run.answer?.reject(new Error("Authentication cancelled"));
        delete run.answer;
        delete run.prompt;
      },
      { once: true },
    );
    run.done = (async () => {
      try {
        const credential = asStoredCredential(
          c.kind === "nous"
            ? await loginNous(bridge, "hermes-cli")
            : await oauth!.login(bridge),
        );
        run.abort.signal.throwIfAborted();
        if (!credential) throw new Error("Invalid authentication result");
        await this.options.credentials.modify(
          credentialKey(c),
          async (current) => (run.abort.signal.aborted ? current : credential),
        );
        run.abort.signal.throwIfAborted();
        run.status = "success";
        this.registration?.replace([...this.adapter.routes.keys()]);
      } catch {
        run.status = run.abort.signal.aborted ? "cancelled" : "error";
        run.error =
          run.status === "error"
            ? "Authentication failed; retry login"
            : "Authentication cancelled";
      } finally {
        delete run.answer;
        delete run.prompt;
      }
    })();
    return run.id;
  }
  authStatus(id: string) {
    const run = this.logins.get(id);
    if (!run) throw new Error("Unknown authentication operation");
    return {
      id: run.id,
      connectionId: run.connectionId,
      status: run.status,
      events: run.events,
      prompt: run.prompt,
      error: run.error,
    };
  }
  answer(id: string, value: string): void {
    const run = this.logins.get(id);
    if (!run?.answer || run.status !== "pending")
      throw new Error("No authentication prompt is pending");
    const answer = run.answer;
    delete run.answer;
    delete run.prompt;
    answer.resolve(value);
  }
  cancel(id: string): void {
    const run = this.logins.get(id);
    if (run?.status === "pending") run.abort.abort();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.lifecycle.abort();
    for (const run of this.logins.values()) this.cancel(run.id);
    this.registration?.();
    this.releaseMetadata?.();
    await this.adapter.drain();
    await Promise.allSettled([...this.logins.values()].map((r) => r.done));
    for (const c of this.catalogs.values()) await c.dispose();
    await this.mutations;
  }
}
