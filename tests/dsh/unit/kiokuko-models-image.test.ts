import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmDiscoveredModel, LlmAdapter } from "@deepseek-ai/dsh-llm";
import { KiokukoModelsService } from "../../../src/dsh/models/service.js";
import { ModelsConfigStore } from "../../../src/dsh/models/config-store.js";
import { CredentialFile } from "../../../src/dsh/models/vendor/credentials.js";
import { ConnectionSchema } from "../../../src/dsh/models/contracts.js";
import { connectionProfile } from "../../../src/dsh/models/profiles.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "models-image-")),
    store = new CredentialFile(join(dir, "credentials.json"));
  let adapter: LlmAdapter | undefined,
    routes: string[] = [];
  const llm = {
    registerAdapter(ids: string[], value: LlmAdapter) {
      adapter = value;
      routes = [...ids];
      const dispose = () => {
        routes = [];
      };
      (dispose as { replace?: unknown }).replace = (ids: readonly string[]) => {
        routes = [...ids];
      };
      return dispose;
    },
    async resolveCallConfig(binding: unknown) {
      return binding;
    },
    async discoverModels(
      namespace: string,
      request: unknown,
    ): Promise<readonly LlmDiscoveredModel[]> {
      assert.equal(namespace, "llm-pi-ai");
      return discover(request);
    },
  };
  let discover: (request: unknown) => Promise<readonly LlmDiscoveredModel[]> =
    async () => [];
  const config = new ModelsConfigStore(join(dir, "models.json"));
  const service = new KiokukoModelsService({
    llm: llm as never,
    config,
    credentials: store,
  });
  await service.start();
  return {
    store,
    service,
    config,
    discover(fn: (request: unknown) => Promise<readonly LlmDiscoveredModel[]>) {
      discover = fn;
    },
    async close() {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function gatewayConnection(models: unknown[] = []) {
  return ConnectionSchema.parse({
    id: "kiokuko-gateway",
    kind: "custom",
    name: "Gateway",
    baseURL: "https://gateway.example/v1",
    protocol: "chat-completions",
    models,
  });
}

test("refresh adopts an endpoint-declared image capability into the stored row", async () => {
  const f = await fixture();
  try {
    const c = gatewayConnection();
    await f.service.save(c, 0);
    await f.service.setKey(c.id, "private-gateway-key");
    // The Infron listing shape: modalities disclosed, image among them.
    f.discover(async () => [
      {
        id: "gateway-vision",
        name: "Gateway Vision",
        contextWindow: 1_000_000,
        maxTokens: 131_100,
        inputModalities: ["text", "image"],
      },
    ]);
    await f.service.refresh(c.id);
    const stored = (await f.config.read()).connections[0]!;
    assert.equal(stored.models[0]!.image, true);
    const profile = connectionProfile(stored);
    assert.deepEqual(profile.piProvider!.getModels()[0]!.input, ["text", "image"]);
  } finally {
    await f.close();
  }
});

test("refresh preserves a manually declared image over a modality-silent relisting", async () => {
  const f = await fixture();
  try {
    const c = gatewayConnection([
      {
        id: "gateway-vision",
        name: "Gateway Vision",
        contextWindow: 1_000_000,
        maxTokens: 131_100,
        reasoning: false,
        image: true,
      },
    ]);
    await f.service.save(c, 0);
    await f.service.setKey(c.id, "private-gateway-key");
    // The relisting stays silent about modalities; the stored declaration must
    // survive a routine refresh instead of being reset to text-only.
    f.discover(async () => [{ id: "gateway-vision", name: "Gateway Vision" }]);
    await f.service.refresh(c.id);
    const stored = (await f.config.read()).connections[0]!;
    assert.equal(stored.models[0]!.image, true);
  } finally {
    await f.close();
  }
});

test("refresh keeps an endpoint text-only declaration authoritative over a stale image row", async () => {
  const f = await fixture();
  try {
    const c = gatewayConnection([
      {
        id: "gateway-now-text",
        name: "Gateway Now Text",
        contextWindow: 1_000_000,
        maxTokens: 131_100,
        reasoning: false,
        image: true,
      },
    ]);
    await f.service.save(c, 0);
    await f.service.setKey(c.id, "private-gateway-key");
    f.discover(async () => [
      { id: "gateway-now-text", name: "Gateway Now Text", inputModalities: ["text"] },
    ]);
    await f.service.refresh(c.id);
    const stored = (await f.config.read()).connections[0]!;
    assert.equal(stored.models[0]!.image, false);
  } finally {
    await f.close();
  }
});

test("an Infron-shaped listing with image modalities stores the route as vision-capable", async () => {
  const f = await fixture();
  try {
    const c = ConnectionSchema.parse({
      id: "kiokuko-infron",
      kind: "infron",
      name: "Infron",
      baseURL: "https://llm.onerouter.pro/v1",
      protocol: "chat-completions",
    });
    await f.service.save(c, 0);
    await f.store.modify("infron", async () => ({
      type: "api_key",
      key: "synthetic-infron-key",
    }));
    f.discover(async () => [
      {
        id: "z-ai/glm-5.3-flash",
        name: "Z.AI: GLM 5.3 Flash",
        contextWindow: 1_000_000,
        maxTokens: 131_100,
        inputModalities: ["text", "image"],
      },
    ]);
    await f.service.refresh(c.id);
    const stored = (await f.config.read()).connections.find(
      (v) => v.id === c.id,
    )!;
    const row = stored.models.find((m) => m.id === "z-ai/glm-5.3-flash")!;
    assert.equal(row.image, true);
    const profile = connectionProfile(stored);
    assert.deepEqual(
      profile.piProvider!.getModels().find((m) => m.id === "z-ai/glm-5.3-flash")!
        .input,
      ["text", "image"],
    );
  } finally {
    await f.close();
  }
});
