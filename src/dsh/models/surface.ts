import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { join } from "node:path";
import { KiokukoModelsService } from "./service.js";
import { ModelsConfigStore } from "./config-store.js";
import {
  CredentialFile,
  defaultCredentialsFile,
} from "./vendor/credentials.js";

const mounted = new WeakMap<object, KiokukoModelsService>();
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
            : await service.list(),
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
      /^(Unknown |Connection |Configuration |Model discovery |No models |No authentication |Authentication |OAuth |Codex |Saving the default |Open a chat |Model is not available |This connection |Enter a valid |Origin |JSON |Request exceeds|Installed adapter|Kiokuko Models)/.test(
        message,
      )
        ? message.slice(0, 300)
        : "Operation failed; check configuration, permissions or authentication and retry";
    return Response.json({ error: safe }, { status: 400, headers });
  }
}
/** Web-only management; the TUI's /auth remains owned by its existing plugin. */
export async function mountKiokukoModels(
  ctx: Context,
): Promise<() => Promise<void>> {
  const get = (name: string): any => ctx.get(name, false),
    profile = get("profileContext"),
    connection = get("connection"),
    llm = get("llm");
  if (
    !profile ||
    ["dsh-cli", "dsh-tui"].includes(profile.name) ||
    !connection?.fetch ||
    !llm
  )
    return async () => {};
  if (mounted.has(llm)) return async () => {};
  const agents = get("agents"),
    defaults = get("agentDefaultModel");
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
      await llm.resolveCallConfig(binding);
      let selection = selections.get(agent);
      if (!selection) {
        const ref = {
          current: undefined as { provider: string; model: string } | undefined,
          assembled: undefined as
            { provider: string; model: string } | undefined,
        };
        selection = { ...ref, dispose: () => {} };
        selection.dispose = installModelSelection(agent.ctx, selection);
        selections.set(agent, selection);
      }
      agent.session.append("model/selection", binding);
      selection.current = binding;
    },
    saveDefault: async (binding) => {
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
    releases.push(
      connection.fetch.register({
        path: MODELS_PATH,
        methods: ["GET", "POST"],
        requestBody: "buffered",
        fetch: (r: Request) => modelsResponse(service, r),
      }),
    );
    const commands = get("commands");
    if (commands)
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
