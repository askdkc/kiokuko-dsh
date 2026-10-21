import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiokukoModelsService } from "../../../src/dsh/models/service.js";
import { ModelsConfigStore } from "../../../src/dsh/models/config-store.js";
import { CredentialFile } from "../../../src/dsh/models/vendor/credentials.js";
import { modelsResponse } from "../../../src/dsh/models/surface.js";

const pair = { preset: "gpt-6.1-sol-deepseek-v4.1-flash" as const,
  head: { provider: "openai", model: "gpt-6.1-sol" },
  worker: { provider: "deepseek-official", model: "deepseek-flash" } };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "head-worker-settings-"));
  const config = new ModelsConfigStore(join(dir, "models.json"));
  const credentials = new CredentialFile(join(dir, "credentials.json"));
  let unavailable = false, running = false;
  const llm = {
    registerAdapter() { const dispose = () => {}; dispose.replace = () => {}; return dispose; },
    discoverModels: async () => [],
    listProviders: () => [{ id: "openai", name: "OpenAI" }, { id: "deepseek-official", name: "DeepSeek", route: {provider:"deepseek-official", family:"deepseek" as const, connection:"api" as const, protocol:"chat-completions" as const} }],
    listModels: async (provider: string) => unavailable && provider === pair.worker.provider ? [] : [
      { provider, id: provider === pair.head.provider ? pair.head.model : pair.worker.model, name: provider },
    ],
    resolveCallConfig: async (binding: any) => {
      if (unavailable && binding.provider === pair.worker.provider) throw new Error("unavailable");
      return binding;
    },
  };
  // This injected catalog is a read-only fixture, unlike native discovery.
  const options = { llm, catalog:llm, config, credentials, now: () => 1_000, sessionCreatedAt: (_id: string): number | undefined => 2_000, assertCurrent: (id: string) => {
    if (!["a", "b", "c"].includes(id)) throw new Error("Open a chat before selecting its model");
    if (running) throw new Error("Connection selection must wait until this chat is idle");
  } };
  const service = new KiokukoModelsService(options);
  await service.start();
  return { service, config, options, llm,
    unavailable(value: boolean) { unavailable = value }, running(value: boolean) { running = value },
    close: async () => { await service.close(); await rm(dir, { recursive: true, force: true }); } };
}
const post = (service: KiokukoModelsService, body: Record<string, unknown>) => modelsResponse(service, new Request("http://localhost/api/kiokuko.models", {method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body)}));

test("HTTP inventory never authenticates candidates and a saved matching pair stays unverified", async () => {
  const f = await fixture();
  let resolutions = 0;
  f.llm.resolveCallConfig = async binding => { resolutions++; return binding; };
  try {
    for (let i = 0; i < 2; i++) {
      const response = await modelsResponse(f.service, new Request("http://localhost/api/kiokuko.models"));
      assert.equal(response.status, 200);
      assert.equal(resolutions, 0);
    }
    await f.service.selectHeadWorker(pair, "default", (await f.service.list()).revision);
    assert.equal(resolutions, 2, "one resolution for each exact selected binding");
    const selected = await f.service.list();
    assert.equal(selected.headWorker.currentAvailable, null, "inventory cannot attest authentication");
    assert.equal(resolutions, 2);
  } finally { await f.close(); }
});

test("pair settings stay opt-in, persist per chat and freeze defaults for previously seen chats", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.headWorkerSelection("a")).configuration, undefined);
    await f.service.selectHeadWorker(pair, "default", (await f.service.list()).revision);
    assert.equal((await f.service.headWorkerSelection("a")).configuration, undefined);
    assert.deepEqual((await f.service.headWorkerSelection("b")).configuration, pair);
    await f.service.selectHeadWorker(null, "default", (await f.service.list()).revision);
    assert.deepEqual((await f.service.headWorkerSelection("b")).configuration, pair);
    assert.equal((await f.service.headWorkerSelection("c")).configuration, undefined);
    const reopened = new KiokukoModelsService(f.options);
    await reopened.start();
    assert.deepEqual((await reopened.headWorkerSelection("b")).configuration, pair);
    await reopened.close();
  } finally { await f.close(); }
});

test("pair selection validates both exact bindings, scopes and revisions without changing existing settings", async () => {
  const f = await fixture();
  try {
    const revision = (await f.service.list()).revision;
    f.unavailable(true);
    await assert.rejects(f.service.selectHeadWorker(pair, "current", revision, "a"), /Head\/worker/);
    assert.equal((await f.service.list()).revision, revision);
    f.unavailable(false);
    await assert.rejects(f.service.selectHeadWorker(pair, "current", revision, "missing"), /Open a chat/);
    f.running(true);
    await assert.rejects(f.service.selectHeadWorker(pair, "current", revision, "a"), /idle/);
    f.running(false);
    await f.service.selectHeadWorker(pair, "current", revision, "a");
    await assert.rejects(f.service.selectHeadWorker(null, "current", revision, "a"), /changed/);
    assert.deepEqual((await f.service.headWorkerSelection("a")).configuration, pair);
    const before = (await f.service.headWorkerSelection("a")).revision;
    await f.service.selectHeadWorker(null, "current", (await f.service.list()).revision, "a");
    await f.service.selectHeadWorker(pair, "current", (await f.service.list()).revision, "a");
    assert.ok((await f.service.headWorkerSelection("a")).revision > before);
    assert.equal((await f.config.read()).defaultHeadWorker, undefined);
  } finally { await f.close(); }
});

test("settings HTTP flow reports unavailable reasons and accepts only deliberate scoped pair writes", async () => {
  const f = await fixture();
  try {
    const initial = await (await modelsResponse(f.service, new Request("http://localhost/api/kiokuko.models?sessionId=a"))).json();
    assert.deepEqual(initial.headWorker.candidates.heads, [pair.head]);
    assert.deepEqual(initial.headWorker.candidates.workers, [pair.worker]);
    const applied = await post(f.service, {op:"head-worker", configuration:pair, scope:"current", sessionId:"a", revision:initial.revision});
    assert.equal(applied.status, 200);
    assert.equal((await post(f.service, {op:"head-worker", configuration:pair, scope:"default", revision:initial.revision})).status, 400);
    assert.equal((await post(f.service, {op:"head-worker", configuration:pair, scope:"other", revision:(await f.service.list()).revision})).status, 400);
    f.unavailable(true);
    const missing = await f.service.list("a");
    assert.equal(missing.headWorker.candidates.workers.length, 0);
    assert.ok(missing.headWorker.candidates.problems.length);
    assert.deepEqual(missing.headWorker.current, pair, "unavailable selection remains visible rather than silently substituting");
  } finally { await f.close(); }
});

test("catalog outages keep connection management available and never expose provider diagnostics", async () => {
  const f = await fixture();
  try {
    f.llm.listProviders = () => { throw new Error("private-provider-credential") };
    const response = await modelsResponse(f.service, new Request("http://localhost/api/kiokuko.models"));
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(state.connections, []);
    assert.ok(state.headWorker.candidates.problems.length);
    assert.doesNotMatch(JSON.stringify(state), /private-provider-credential/);
    const result = await post(f.service, {op:"head-worker", configuration:pair, scope:"default", revision:state.revision});
    assert.equal(result.status, 400);
    assert.doesNotMatch(await result.text(), /private-provider-credential/);
  } finally { await f.close(); }
});

test("explicit current pair changes notify routing, while a default change leaves current tasks untouched", async () => {
  const f = await fixture();
  const changes: string[] = [];
  try {
    const service = new KiokukoModelsService({...f.options, onCurrentHeadWorkerChange:id=>{ changes.push(id); }});
    await service.start();
    await service.selectHeadWorker(pair, "default", (await service.list()).revision);
    assert.deepEqual(changes, []);
    await service.selectHeadWorker(pair, "current", (await service.list()).revision, "a");
    await service.selectHeadWorker(null, "current", (await service.list()).revision, "a");
    assert.deepEqual(changes, ["a", "a"]);
    await service.close();
  } finally { await f.close(); }
});

test("reselecting the exact pair head preserves worker routing, while a different head restores ordinary selection", async () => {
  const f = await fixture();
  const service = new KiokukoModelsService({...f.options, selectCurrent:async()=>{}, saveDefault:async()=>{}});
  try {
    const head = {provider:"kiokuko-fixture-head", model:"gpt-6.1-sol"}, configuration = {...pair, head};
    const models = [head.model, "ordinary-model"].map(id=>({id,name:id,contextWindow:262144,maxTokens:32768}));
    f.llm.listProviders = () => [{id:head.provider,name:"Fixture Sol"},{id:pair.worker.provider,name:"DeepSeek",route:{provider:pair.worker.provider,family:"deepseek",connection:"api",protocol:"chat-completions"}}];
    f.llm.listModels = async provider => (provider===head.provider ? models : [{id:pair.worker.model,name:"Flash"}]).map(m=>({...m,provider}));
    await service.start();
    await service.save({id:head.provider,kind:"custom",name:"Fixture Sol",baseURL:"http://127.0.0.1:12345/v1",protocol:"chat-completions",models},0);
    await service.setKey(head.provider,"isolated-fixture-key");
    await service.selectHeadWorker(configuration,"current",(await service.list()).revision,"a");
    await service.selectHeadWorker(configuration,"default",(await service.list()).revision);
    const generation=(await service.headWorkerSelection("a")).revision;
    await service.select(head.provider,head.model,"current","a");
    await service.select(head.provider,head.model,"default");
    assert.equal((await service.headWorkerSelection("a")).revision,generation);
    assert.deepEqual((await service.headWorkerSelection("a")).configuration,configuration);
    assert.deepEqual((await f.config.read()).defaultHeadWorker,configuration);
    await service.select(head.provider,"ordinary-model","current","a");
    assert.equal((await service.headWorkerSelection("a")).configuration,undefined);
    assert.deepEqual((await f.config.read()).defaultHeadWorker,configuration);
    await service.select(head.provider,"ordinary-model","default");
    assert.equal((await f.config.read()).defaultHeadWorker,undefined);
  } finally { await service.close(); await f.close(); }
});

test("explicit native reasoning changes preserve worker, advance only the current generation and reject unavailable effort", async () => {
  const f = await fixture();
  try {
    await f.service.selectHeadWorker(pair,"default",(await f.service.list()).revision);
    const before=await f.service.headWorkerSelection("a");
    await f.service.updateHeadWorkerEffort("a","high");
    const after=await f.service.headWorkerSelection("a");
    assert.equal(after.configuration?.head.reasoningEffort,"high");
    assert.deepEqual(after.configuration?.worker,pair.worker);
    assert.ok(after.revision>before.revision);
    assert.deepEqual((await f.config.read()).defaultHeadWorker,pair);
    await f.service.updateHeadWorkerEffort("a","high");
    assert.equal((await f.service.headWorkerSelection("a")).revision,after.revision);
    f.llm.resolveCallConfig=async()=>{throw new Error("private unavailable effort");};
    await assert.rejects(f.service.updateHeadWorkerEffort("a","unknown"),/Head\/worker reasoning effort is unavailable/);
    assert.equal((await f.service.headWorkerSelection("a")).revision,after.revision);
  } finally {await f.close();}
});

test("connection edits retain pair state and failed durable writes cannot change its generation", async () => {
  const f = await fixture();
  try {
    await f.service.selectHeadWorker(pair,"current",(await f.service.list()).revision,"a");
    const before=await f.service.headWorkerSelection("a");
    await f.service.save({id:"kiokuko-unrelated",kind:"custom",name:"Unrelated",baseURL:"http://localhost:12345/v1",protocol:"chat-completions",models:[]},(await f.service.list()).revision);
    assert.deepEqual(await f.service.headWorkerSelection("a"),before);
    f.config.write=async()=>{throw new Error("fixture save failed");};
    await assert.rejects(f.service.selectHeadWorker(null,"current",(await f.service.list()).revision,"a"),/fixture save failed/);
    assert.deepEqual(await f.service.headWorkerSelection("a"),before);
    assert.deepEqual((await f.config.read()).sessionHeadWorkers?.a,pair);
  } finally {await f.close();}
});

test("a default never affects unseen old or unverified chats, including after service restart", async () => {
  const f = await fixture();
  try {
    await f.service.selectHeadWorker(pair,"default",(await f.service.list()).revision);
    assert.equal((await f.config.read()).defaultHeadWorkerSelectedAt,1_000);
    const restarted = new KiokukoModelsService({...f.options, sessionCreatedAt:id=>id==="old"?500:id==="new"?2_000:undefined});
    await restarted.start();
    assert.equal((await restarted.list("old")).headWorker.current,null);
    assert.equal((await restarted.headWorkerSelection("old")).configuration,undefined);
    assert.equal((await restarted.headWorkerSelection("unknown")).configuration,undefined);
    assert.deepEqual((await restarted.headWorkerSelection("new")).configuration,pair);
    await restarted.selectHeadWorker(pair,"current",(await restarted.list()).revision,"a");
    assert.deepEqual((await restarted.headWorkerSelection("a")).configuration,pair,"explicit selection is valid even without a timestamp");
    await restarted.close();
  } finally {await f.close();}
});

test("superseded native picker callbacks cannot overwrite a newer explicit settings selection", async () => {
  const f = await fixture();
  try {
    await f.service.selectHeadWorker(pair,"current",(await f.service.list()).revision,"a");
    const before=await f.service.headWorkerSelection("a");
    let current=true;
    const update=f.service.updateHeadWorkerEffort("a","high",()=>current);
    current=false;
    await update;
    await f.service.clearHeadWorker("a",()=>current);
    assert.deepEqual(await f.service.headWorkerSelection("a"),before);
    await f.service.clearHeadWorker("a",()=>true);
    assert.equal((await f.service.headWorkerSelection("a")).configuration,undefined);
  } finally {await f.close();}
});
