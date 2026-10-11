import { registerOwnedModels } from "./metadata.js";
import { randomUUID } from "node:crypto";
import {
  LlmAdapter,
  type LlmRuntime,
  type GenerateOptions,
  type StreamChunk,
  type PreparedAdapterCall,
} from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import {
  ConnectionSchema,
  credentialKey,
  type Connection,
  type InfronServiceTier,
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
import { connectionProfile, sharedCredentialStore } from "./profiles.js";
import { OpenCodeAdapter } from "./vendor/opencode-adapter.js";
import {
  OpenCodeCatalog,
  type OpenCodeRoute,
} from "./vendor/opencode-catalog.js";
import { OPEN_CODE_SNAPSHOTS } from "./vendor/opencode-owned.generated.js";
import type { ModelRoute } from "../model-configuration.js";

type Route = {
  connection: Connection;
  adapter: LlmAdapter;
  underlying: string;
};
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
          provider: r.underlying,
          signal: AbortSignal.any([
            ...(options.signal ? [options.signal] : []),
            this.lifecycle,
          ]),
        });
      },
    };
  }
  private async *run(call: PreparedAdapterCall, options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.lifecycle.throwIfAborted();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.active.add(done);
    try {
      yield* call.stream(options);
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
  llm: Pick<LlmRuntime, "registerAdapter" | "resolveCallConfig">;
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
    );
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
  async list() {
    const auth = await this.options.credentials.describe();
    return {
      revision: this.document.revision,
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
        version: 1 as const,
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
    const c = this.require(id),
      signal = this.lifecycle.signal;
    if (c.kind === "opencode" || c.kind === "opencode-go") {
      const state = await this.catalogs.get(c.kind)!.refresh();
      if (state.warning) throw new Error(state.warning);
      this.publish(this.build(this.document.connections));
      return;
    }
    if (c.kind === "codex") return;
    const key = await this.apiKey(c),
      headers: Record<string, string> = {
        accept: "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      };
    if (c.protocol === "messages" && key) {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    }
    let response: Response;
    const baseURL = c.baseURL.replace(/\/+$/, "");
    try {
      response = await fetch(
        `${baseURL}${c.protocol === "messages" && !baseURL.endsWith("/v1") ? "/v1" : ""}/models`,
        {
          headers,
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          redirect: "error",
        },
      );
    } catch {
      throw new Error("Model discovery could not reach the connection");
    }
    if (!response.ok)
      throw new Error(
        `Model discovery failed (HTTP ${response.status}); check authentication or register models manually`,
      );
    const json = (await response.json()) as any;
    if (!Array.isArray(json.data))
      throw new Error("Model discovery returned an invalid list");
    const shipped =
      adapterBuiltinProviders()
        .find((p) => p.id === credentialKey(c))
        ?.getModels() ?? [];
    const models = json.data.flatMap((r: any) => {
      const known = shipped.find((m) => m.id === r.id),
        prior = c.models.find((m) => m.id === r.id);
      const parsed = ManualModelSchema.safeParse({
        id: r.id,
        name: r.name ?? r.id,
        contextWindow:
          r.context_length ??
          r.context_window ??
          known?.contextWindow ??
          prior?.contextWindow,
        maxTokens:
          r.max_output_tokens ??
          r.max_completion_tokens ??
          r.top_provider?.max_completion_tokens ??
          known?.maxTokens ??
          prior?.maxTokens,
        reasoning: known?.reasoning ?? prior?.reasoning ?? false,
        image: known?.input.includes("image") ?? prior?.image ?? false,
      });
      return parsed.success ? [parsed.data] : [];
    });
    if (!models.length)
      throw new Error(
        "No models with known context/output limits; register models manually",
      );
    await this.save({ ...c, models }, this.document.revision);
  }
  async select(
    id: string,
    model: string,
    scope: "current" | "default",
    sessionId?: string,
  ): Promise<void> {
    const c = this.require(id);
    if (!(await this.models(id)).some((m) => m.id === model))
      throw new Error("Model is not available; connect and refresh first");
    const binding = { provider: c.id, model };
    await this.options.llm.resolveCallConfig(binding);
    if (scope === "default") {
      if (!this.options.saveDefault)
        throw new Error("Saving the default is unavailable");
      await this.options.saveDefault(binding);
    } else {
      if (!sessionId || !this.options.selectCurrent)
        throw new Error("Open a chat before selecting its model");
      await this.options.selectCurrent(sessionId, binding);
    }
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
