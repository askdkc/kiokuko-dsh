import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { KiokukoModelsService } from "../../../src/dsh/models/service.js";
import { ModelsConfigStore } from "../../../src/dsh/models/config-store.js";
import { CredentialFile } from "../../../src/dsh/models/vendor/credentials.js";
import { modelsResponse, mountKiokukoModels } from "../../../src/dsh/models/surface.js";
import { ConnectionSchema, CONNECTION_DEFAULTS, CONNECTION_KINDS, credentialKey } from "../../../src/dsh/models/contracts.js";
import { connectionProfile } from "../../../src/dsh/models/profiles.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "models-test-")),
    store = new CredentialFile(join(dir, "credentials.json"));
  let adapter: LlmAdapter | undefined,
    routes: string[] = [],
    disposed = false;
  const llm = {
    registerAdapter(ids: string[], value: LlmAdapter) {
      adapter = value;
      routes = ids;
      const dispose = () => {
        disposed = true;
        routes = [];
      };
      dispose.replace = (ids: readonly string[]) => {
        routes = [...ids];
      };
      return dispose;
    },
    async resolveCallConfig(binding: any) {
      assert.ok(routes.includes(binding.provider));
      await adapter!.resolveModel(binding.provider, binding.model);
      return binding;
    },
  };
  const selected: any[] = [],
    defaults: any[] = [];
  const config = new ModelsConfigStore(join(dir, "models.json"));
  const service = new KiokukoModelsService({
    llm,
    config,
    credentials: store,
    selectCurrent: async (id, binding) => {
      selected.push({ id, binding });
    },
    saveDefault: async (binding) => {
      defaults.push(binding);
    },
  });
  await service.start();
  return {
    dir,
    store,
    llm,
    service,
    config,
    adapter: () => adapter!,
    routes: () => routes,
    selected,
    defaults,
    disposed: () => disposed,
    async close() {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const model = {
  id: "z-ai/glm-5.3",
  name: "GLM",
  contextWindow: 1024000,
  maxTokens: 128000,
  reasoning: false,
  image: false,
};
function connection(baseURL: string, kind = "infron", id = "kiokuko-infron") {
  return ConnectionSchema.parse({
    id,
    kind,
    name: kind,
    baseURL,
    protocol: "chat-completions",
    models: [model],
  });
}

test("all supported connection kinds register stable owned routes and custom protocols remain explicit", async () => {
  const f = await fixture();
  try {
    let revision = 0;
    for (const kind of CONNECTION_KINDS) {
      const [name, baseURL, protocol] = CONNECTION_DEFAULTS[kind];
      const value = ConnectionSchema.parse({ id: `kiokuko-${kind}`, kind, name, baseURL, protocol,
        models: ["custom", "infron", "ollama", "nous"].includes(kind) ? [model] : [] });
      await f.service.save(value, revision++);
      if (kind !== "ollama") await f.store.modify(credentialKey(value), async () => kind === "codex"
        ? { type: "oauth", access: "fixture-token", refresh: "fixture-refresh", expires: Date.now() + 60_000 }
        : { type: "api_key", key: "fixture-key" });
      const models = await f.service.models(value.id);
      assert.ok(models.every((m) => m.provider === value.id));
      assert.ok(models.length > 0, `${kind} has a usable shipped or explicitly registered catalog`);
    }
    assert.deepEqual(f.routes(), CONNECTION_KINDS.map((kind) => `kiokuko-${kind}`));
    assert.equal(CONNECTION_KINDS.includes("orcarouter" as any), false);
    for (const [protocol, api] of [["chat-completions", "openai-completions"], ["responses", "openai-responses"], ["messages", "anthropic-messages"]]) {
      const profile = connectionProfile(ConnectionSchema.parse({ ...connection("http://localhost:8080", "custom", "kiokuko-protocol"), protocol }));
      assert.equal(profile.api, api);
      assert.equal(profile.piProvider!.getModels()[0]!.api, api);
    }
    assert.throws(() => ConnectionSchema.parse({ ...connection("http://localhost:8080"), protocol: "responses" }));
    assert.doesNotMatch(JSON.stringify(await f.service.list()), /fixture-token|fixture-refresh|fixture-key/);
  } finally { await f.close(); }
});

test("a partial Web mount releases acquired routes and request hooks before a retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "models-mount-"));
  const previous = process.env.DSH_AUTH_CREDENTIALS;
  process.env.DSH_AUTH_CREDENTIALS = join(dir, "credentials.json");
  let released = 0, fail = true;
  const llm = {};
  const services: Record<string, unknown> = {
    profileContext: { name: "web", dir }, llm,
    connection: { fetch: { register: () => () => released++ } },
    commands: { register: () => { if (fail) throw new Error("registration failed"); return () => released++ } },
  };
  const ctx = { get: (name: string) => services[name], on: () => () => released++ } as any;
  try {
    await assert.rejects(mountKiokukoModels(ctx), /registration failed/);
    assert.equal(released, 2);
    fail = false;
    const close = await mountKiokukoModels(ctx);
    await close();
    assert.equal(released, 5);
  } finally {
    if (previous === undefined) delete process.env.DSH_AUTH_CREDENTIALS; else process.env.DSH_AUTH_CREDENTIALS = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("profile connections and shared CLI authentication remain separate; no secrets in HTTP or selections", async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.service.list()).connections, []);
    await f.service.save(connection("http://127.0.0.1:8080"), 0);
    assert.deepEqual(f.routes(), ["kiokuko-infron"]);
    assert.deepEqual(await f.service.models("kiokuko-infron"), []);
    const cli = new CredentialFile(f.store.path);
    await cli.modify("infron", async () => ({
      type: "api_key",
      key: "private-test-key",
    }));
    assert.equal((await f.service.models("kiokuko-infron")).length, 1);
    const response = await modelsResponse(
      f.service,
      new Request("http://localhost/api/kiokuko.models"),
    );
    assert.doesNotMatch(await response.text(), /private-test-key/);
    assert.doesNotMatch(
      await readFile(join(f.dir, "models.json"), "utf8"),
      /private-test-key/,
    );
    await f.service.select("kiokuko-infron", model.id, "current", "chat-a");
    assert.equal(f.defaults.length, 0);
    assert.equal(f.selected.length, 1);
    await f.service.select("kiokuko-infron", model.id, "default");
    assert.equal(f.defaults.length, 1);
    await assert.rejects(
      f.service.save(
        { ...connection("http://127.0.0.1:8080"), serviceTier: "flex" },
        0,
      ),
      /changed/,
    );
    await f.service.logout("kiokuko-infron");
    assert.equal(await cli.read("infron"), undefined);
    assert.equal((await stat(f.store.path)).mode & 0o777, 0o600);
  } finally {
    await f.close();
  }
  assert.equal(f.disposed(), true);
});
test("shared credential lock serializes concurrent token refresh and preserves unrelated providers", async () => {
  const f = await fixture();
  try {
    await f.store.modify("openai-codex", async () => ({
      type: "oauth",
      access: "old",
      refresh: "old",
      expires: 0,
    }));
    const cli = new CredentialFile(f.store.path);
    let calls = 0;
    await Promise.all(
      [f.store, cli].map((store) =>
        store.modify("openai-codex", async (current) => {
          if (current?.type === "oauth" && current.expires === 0) {
            calls++;
            await new Promise((r) => setTimeout(r, 20));
            return {
              type: "oauth",
              access: "new",
              refresh: "new",
              expires: 9999999999999,
            };
          }
          return current;
        }),
      ),
    );
    assert.equal(calls, 1);
    await cli.modify("deepseek", async () => ({
      type: "api_key",
      key: "other",
    }));
    await f.store.delete("openai-codex");
    assert.equal((await cli.read("deepseek"))?.type, "api_key");
  } finally {
    await f.close();
  }
});
test("actual registered PiAiAdapter freezes Infron tier at preparation and native retry; other providers are clean", async () => {
  const bodies: any[] = [],
    headers: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    headers.push(req.headers);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const part = body.messages.some((m: any) => m.role === "tool")
      ? { content: "Tool complete" }
      : { content: "Connected" };
    res.end(
      "data: " +
        JSON.stringify({
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1,
          model: model.id,
          provider: { service_tier: "standard" },
          choices: [
            {
              index: 0,
              delta: { role: "assistant", ...part },
              finish_reason: null,
            },
          ],
        }) +
        "\n\ndata: " +
        JSON.stringify({
          id: "chat-1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port,
    f = await fixture();
  try {
    const c = connection(`http://127.0.0.1:${port}/v1`);
    await f.service.save(c, 0);
    await f.service.setKey(c.id, "test-key");
    const signal = new AbortController().signal;
    f.service.bindRequest(signal, { provider: c.id, model: model.id }, 1, 0);
    const prepared = await f.adapter().prepareCall(c.id, model.id, signal);
    await f.service.save({ ...c, serviceTier: "flex" }, 1);
    const options = {
      provider: c.id,
      model: model.id,
      messages: [
        createUserMessage({
          content: [{ type: "text" as const, text: "hello" }],
          source: { kind: "user" as const },
        }),
      ],
      signal,
    };
    const first = await collect(prepared.stream(options));
    assert.ok(first.some((c) => c.type === "finish"));
    assert.equal(bodies[0].provider.service_tier, "standard");
    assert.equal(bodies[0].extra_body, undefined);
    f.service.bindRequest(signal, options, 1, 0);
    await collect(f.adapter().stream(options));
    assert.equal(
      bodies[1].provider.service_tier,
      "standard",
      "native retry re-preparation keeps its original route generation",
    );
    f.service.bindRequest(signal, options, 1, 1);
    await collect(f.adapter().stream(options));
    assert.equal(bodies[2].provider.service_tier, "flex");
    const status = (await f.service.list()).connections[0]!;
    assert.equal(status.lastRequestedTier, "flex");
    assert.equal(
      status.actualTier,
      "standard",
      "reported fallback differs from requested tier",
    );
    const other = connection(c.baseURL, "custom", "kiokuko-custom");
    await f.service.save(other, 2);
    await f.service.setKey(other.id, "other-key");
    await collect(f.adapter().stream({ ...options, provider: other.id }));
    assert.equal(bodies[3].provider, undefined);
    assert.ok(headers.every((h) => h.authorization?.startsWith("Bearer ")));
    assert.ok(headers.every((h) => h["user-agent"]));
  } finally {
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of source) rows.push(row);
  return rows;
}

test("custom Responses and Messages send their actual protocol bodies and complete streamed output", async () => {
  const requests: Array<{path:string;body:any;headers:any}> = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push({path:req.url!,body:JSON.parse(text),headers:req.headers});
    res.writeHead(200, {"content-type":"text/event-stream"});
    const item = {id:"msg_fixture",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"PROTOCOL CONNECTED",annotations:[]}]};
    const events = req.url!.endsWith("/responses") ? [
      {type:"response.created",response:{id:"resp_fixture"}},
      {type:"response.output_item.added",output_index:0,item:{...item,content:[]}},
      {type:"response.output_text.delta",output_index:0,content_index:0,delta:"PROTOCOL CONNECTED"},
      {type:"response.output_item.done",output_index:0,item},
      {type:"response.completed",response:{id:"resp_fixture",status:"completed",output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}},
    ] : [
      {type:"message_start",message:{id:"msg_fixture",type:"message",role:"assistant",model:model.id,content:[],usage:{input_tokens:1,output_tokens:0}}},
      {type:"content_block_start",index:0,content_block:{type:"text",text:""}},
      {type:"content_block_delta",index:0,delta:{type:"text_delta",text:"PROTOCOL CONNECTED"}},
      {type:"content_block_stop",index:0},
      {type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:1}},
      {type:"message_stop"},
    ];
    res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const f = await fixture();
  try {
    const baseURL = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    for (const [revision,protocol] of ["responses","messages"].entries()) {
      const c = ConnectionSchema.parse({...connection(baseURL,"custom",`kiokuko-${protocol}`),protocol});
      await f.service.save(c, revision);
      await f.service.setKey(c.id,"protocol-key");
      const chunks = await collect(f.adapter().stream({provider:c.id,model:model.id,messages:[createUserMessage({content:[{type:"text",text:"hello"}],source:{kind:"user"}})]}));
      assert.ok(chunks.some(chunk=>chunk.type==="finish"));
      assert.match(JSON.stringify(chunks),/PROTOCOL CONNECTED/);
    }
    assert.deepEqual(requests.map(r=>new URL(r.path,"http://localhost").pathname),["/v1/responses","/v1/messages"]);
    assert.ok(Array.isArray(requests[0]!.body.input));
    assert.ok(Array.isArray(requests[1]!.body.messages));
    assert.equal(requests[0]!.headers.authorization,"Bearer protocol-key");
    assert.equal(requests[1]!.headers["x-api-key"],"protocol-key");
    assert.ok(requests.every(r=>r.body.provider===undefined&&r.body.extra_body===undefined));
  } finally {
    await f.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(()=>resolve()));
  }
});

test("failed config saves roll back live registrations and secrets never enter a failure response", async (t) => {
  const f = await fixture();
  try {
    const original = f.config.write.bind(f.config);
    const failing = t.mock.method(f.config, "write", async () => {
      throw new Error("write denied private-canary");
    });
    await assert.rejects(
      f.service.save(connection("http://127.0.0.1:8080"), 0),
      /write denied/,
    );
    assert.deepEqual((await f.service.list()).connections, []);
    assert.deepEqual(f.routes(), []);
    failing.mock.restore();
    f.config.write = original;
    await f.service.save(connection("http://127.0.0.1:8080"), 0);
    t.mock.method(f.store, "modify", async () => {
      throw new Error("write denied private-canary");
    });
    const response = await modelsResponse(
      f.service,
      new Request("http://localhost/api/kiokuko.models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "key",
          id: "kiokuko-infron",
          key: "private-canary",
        }),
      }),
    );
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /private-canary/);
    const crossSite = await modelsResponse(
      f.service,
      new Request("http://internal/api/kiokuko.models", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://evil.test",
          host: "localhost",
        },
        body: "{}",
      }),
    );
    assert.equal(crossSite.status, 403);
  } finally {
    await f.close();
  }
});

test("shared Nous device OAuth supports cancellation, re-login, CLI visibility and logout without token disclosure", async (t) => {
  const f = await fixture();
  let authorized = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/device/code"))
        return Response.json({
          device_code: "device-fixture",
          user_code: "USER-CODE",
          verification_uri: "https://example.com/login",
          verification_uri_complete: "https://example.com/login?code=USER-CODE",
          expires_in: 600,
          interval: 1,
        });
      assert.ok(url.endsWith("/oauth/token"));
      return authorized
        ? Response.json({
            access_token: "secret-access-canary",
            refresh_token: "secret-refresh-canary",
            expires_in: 3600,
          })
        : Response.json({ error: "authorization_pending" }, { status: 400 });
    },
  );
  try {
    const c = connection("http://127.0.0.1:8080", "nous", "kiokuko-nous");
    await f.service.save(c, 0);
    const cancelled = f.service.startLogin(c.id);
    await until(() => f.service.authStatus(cancelled).events.length > 0);
    f.service.cancel(cancelled);
    await until(() => f.service.authStatus(cancelled).status === "cancelled");
    assert.equal(await f.store.read("nous"), undefined);
    authorized = true;
    const next = f.service.startLogin(c.id);
    await until(() => f.service.authStatus(next).status === "success");
    assert.equal(
      (await new CredentialFile(f.store.path).read("nous"))?.type,
      "oauth",
    );
    assert.doesNotMatch(
      JSON.stringify(f.service.authStatus(next)),
      /secret-access-canary|secret-refresh-canary/,
    );
    assert.doesNotMatch(
      JSON.stringify(await f.service.list()),
      /secret-access-canary|secret-refresh-canary/,
    );
    await f.service.logout(c.id);
    assert.equal(
      await new CredentialFile(f.store.path).read("nous"),
      undefined,
    );
  } finally {
    await f.close();
  }
});
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "operation must settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('plugin shutdown aborts and drains an active provider stream before releasing its registration',async()=>{
  let requested!:()=>void;
  const received=new Promise<void>(resolve=>{requested=resolve});
  const server=createServer(async(req,res)=>{for await(const _part of req){}res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();requested()});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const f=await fixture();
  try{
    const c=connection(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`);
    await f.service.save(c,0);await f.service.setKey(c.id,'fixture-key');
    let settled=false;
    const streaming=collect(f.adapter().stream({provider:c.id,model:model.id,messages:[createUserMessage({content:[{type:'text',text:'hello'}],source:{kind:'user'}})]})).finally(()=>{settled=true});
    await received;await f.service.close();await streaming;
    assert.equal(settled,true);assert.equal(f.disposed(),true);
    await assert.rejects(collect(f.adapter().stream({provider:c.id,model:model.id,messages:[]})));
  }finally{await f.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
