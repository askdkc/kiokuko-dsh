import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { KiokukoModelsService } from "./service.js";
import { ModelsConfigStore } from "./config-store.js";
import { mounted } from "./session-selection.js";
export { getHeadWorkerSessionSelection, getHeadWorkerForSession, clearHeadWorkerForSession, updateHeadWorkerEffortForSession } from "./session-selection.js";
import {
  CredentialFile,
  defaultCredentialsFile,
} from "./vendor/credentials.js";

export const MODELS_PATH = "/api/kiokuko.models";
/** Secret operations are POST-only and never reflect input or provider response bodies. */
export async function modelsResponse(
  service: KiokukoModelsService,
  request: Request,
): Promise<Response> {
  const headers = { "cache-control": "no-store" },
    url = new URL(request.url);
  try {
    if (request.method === "GET") {
      const op = url.searchParams.get("op"),
        id = url.searchParams.get("id") ?? "";
      return Response.json(
        op === "auth"
          ? service.authStatus(id)
          : op === "models"
            ? await service.models(id)
            : await service.list(url.searchParams.get("sessionId") ?? undefined),
        { headers },
      );
    }
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers });
    // The native connection transport validates its token. Also refuse cross-origin form posts.
    // The bridge normalizes Request.url to its internal authority. Host retains
    // the browser authority, which the native transport already authenticates.
    const origin = request.headers.get("origin"),
      host = request.headers.get("host");
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin && new URL(origin).host !== (host ?? url.host))
    )
      return Response.json(
        { error: "Origin mismatch" },
        { status: 403, headers },
      );
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      return Response.json(
        { error: "JSON required" },
        { status: 415, headers },
      );
    const text = await request.text();
    if (text.length > 512_000) throw new Error("Request exceeds limit");
    const body = JSON.parse(text) as any,
      id = typeof body.id === "string" ? body.id : "";
    if (body.op === "save") {
      await service.save(body.connection, body.revision);
    } else if (body.op === "key") {
      await service.setKey(id, body.key);
    } else if (body.op === "logout") {
      await service.logout(id);
    } else if (body.op === "refresh") {
      await service.refresh(id);
    } else if (body.op === "login") {
      return Response.json(
        { operationId: service.startLogin(id) },
        { headers },
      );
    } else if (body.op === "answer") {
      service.answer(id, body.answer);
    } else if (body.op === "cancel") {
      service.cancel(id);
    } else if (body.op === "head-worker") {
      if (body.scope !== "current" && body.scope !== "default") throw new Error("Head/worker selection scope is invalid");
      await service.selectHeadWorker(body.configuration, body.scope, body.revision, body.sessionId);
    } else if (body.op === "select") {
      if (body.scope !== "current" && body.scope !== "default")
        throw new Error("Invalid selection scope");
      await service.select(id, body.model, body.scope, body.sessionId);
    } else throw new Error("Unknown operation");
    return Response.json({ ok: true }, { headers });
  } catch (error) {
    // Only locally generated, bounded diagnostics; validation/provider/token errors are not wire-safe.
    const message = error instanceof Error ? error.message : "";
    const safe =
      /^(Unknown |Connection |Configuration |Model discovery |No models |No authentication |Authentication |OAuth |Codex |Saving the default |Open a chat |Model is not available |This connection |Enter a valid |Origin |JSON |Request exceeds|Installed adapter|Kiokuko Models|Head\/worker)/.test(
        message,
      )
        ? message.slice(0, 300)
        : "Operation failed; check configuration, permissions or authentication and retry";
    return Response.json({ error: safe }, { status: 400, headers });
  }
}
/** Restore saved providers on every host; expose management only on Web. */
export async function mountKiokukoModels(
  ctx: Context,
): Promise<() => Promise<void>> {
  const get = (name: string): any => ctx.get(name, false),
    profile = get("profileContext"),
    connection = get("connection"),
    llm = get("llm");
  if (!profile || !llm) return async () => {};
  if (mounted.has(llm)) return async () => {};
  const web = !["dsh-cli", "dsh-tui"].includes(profile.name);
  const agents = { get: (id: string) => get("agents")?.get(id) };
  const sessions = { get: (id: string) => get("sessions")?.get(id) };
  const selections = new Map<
    any,
    {
      current: { provider: string; model: string } | undefined;
      assembled: { provider: string; model: string } | undefined;
      dispose: () => void;
    }
  >();
  const service = new KiokukoModelsService({
    llm,
    sessionCreatedAt: sessionId => {
      const session = agents?.get(sessionId)?.session ?? sessions?.get(sessionId);
      return session?.id === sessionId && typeof session.header?.createdAt === "number" ? session.header.createdAt : undefined;
    },
    onCurrentHeadWorkerChange: sessionId => (ctx as unknown as { parallel(name: string, sessionId: string): Promise<void> }).parallel("kiokuko/head-worker-selected", sessionId),
    assertCurrent: (sessionId) => {
      const agent = agents?.get(sessionId);
      if (!agent) throw new Error("Open a chat before selecting its model");
      if (agent.status === "running") throw new Error("Connection selection must wait until this chat is idle");
    },
    config: new ModelsConfigStore(join(profile.dir, "kiokuko-models.json")),
    credentials: new CredentialFile(defaultCredentialsFile()),
    attachments: () => get("attachments"),
    selectCurrent: async (sessionId, binding) => {
      const agent = agents?.get(sessionId);
      if (!agent) throw new Error("Open a chat before selecting its model");
      if (agent.status === "running")
        throw new Error(
          "Connection selection must wait until this chat is idle",
        );
      // Current DSH owns the selection projection and switch listener on Agent.
      // Installing the older ref-based listener would leave that state unused.
      if (typeof agent.model?.select === "function") {
        agent.model.select(binding);
        return;
      }
      let selection = selections.get(agent);
      if (!selection) {
        const ref = {
          current: undefined as { provider: string; model: string } | undefined,
          assembled: undefined as
            { provider: string; model: string } | undefined,
        };
        selection = { ...ref, dispose: () => {} };
        selection.dispose = Reflect.apply(installModelSelection, undefined, [agent.ctx, selection]);
        selections.set(agent, selection);
      }
      agent.session.append("model/selection", binding);
      selection.current = binding;
    },
    saveDefault: async (binding) => {
      const defaults = get("agentDefaultModel");
      if (!defaults) throw new Error("Saving the default is unavailable");
      await defaults.saveSelection(binding);
    },
  });
  await service.start();
  mounted.set(llm, service);
  const releases: Array<() => unknown> = [];
  try {
    releases.push(
      ctx.on(
        "agent/request" as any,
        async (payload: any, next: () => Promise<any>) => {
          const binding = await next();
          service.bindRequest(
            payload.signal,
            binding,
            payload.turn,
            payload.step,
          );
          return binding;
        },
        { prepend: true },
      ),
    );
    const mountWeb = (scope: Context) => {
      const transport = scope.get("connection", false) as any;
      if (transport?.fetch) releases.push(transport.fetch.register({
        path: MODELS_PATH, methods: ["GET", "POST"], requestBody: "buffered",
        fetch: (request: Request) => modelsResponse(service, request),
      }));
    };
    if (web && connection?.fetch) mountWeb(ctx);
    else if (web && typeof ctx.inject === "function") {
      const scope = ctx.inject(["connection"], mountWeb);
      releases.push(() => scope.dispose());
    }
    const commands = get("commands");
    if (web && commands)
      releases.push(
        commands.register({
          name: "kiokuko",
          input: { hint: "model" },
          recordInput: false,
          description: "Open Kiokuko Models: /kiokuko model",
          handler: async (invocation: { rawInput: string }) =>
            invocation.rawInput.trim() === "model"
              ? { kind: "success", text: "Kiokuko Models" }
              : {
                  kind: "error",
                  text: "Use /kiokuko model. Credentials belong in the masked Settings form.",
                },
        }),
      );
  } catch (error) {
    mounted.delete(llm);
    await Promise.allSettled(releases.reverse().map(async (release) => release()));
    await service.close();
    throw error;
  }
  return async () => {
    mounted.delete(llm);
    for (const release of releases.reverse()) release();
    for (const selection of selections.values()) selection.dispose();
    await service.close();
  };
}
