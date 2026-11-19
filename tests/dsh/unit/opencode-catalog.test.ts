import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCatalog } from "../../../src/dsh/models/vendor/opencode-catalog.js";

const baseModel = {
  name: "DeepSeek V4.1 Flash",
  limit: { context: 1_000_000, output: 384_000 },
  modalities: { input: ["text", "image"], output: ["text"] },
  tool_call: true,
  reasoning: true,
  temperature: true,
  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
};

test("OpenCode route protocol applies when model provider metadata only overrides the API URL", () => {
  const snapshot = normalizeCatalog(
    "opencode-go",
    ["deepseek-v4.1-flash"],
    {
      npm: "@ai-sdk/openai-compatible",
      models: {
        "deepseek-v4.1-flash": {
          ...baseModel,
          provider: { api: "https://opencode.ai/inference/go/openai/v1" },
        },
      },
    },
    1,
  );

  assert.deepEqual(snapshot.excluded, []);
  assert.equal(snapshot.models[0]?.id, "deepseek-v4.1-flash");
  assert.equal(snapshot.models[0]?.protocol, "chat");
});

test("OpenCode rejects an explicit unsupported model protocol override", () => {
  const snapshot = normalizeCatalog(
    "opencode-go",
    ["deepseek-v4.1-flash"],
    {
      npm: "@ai-sdk/openai-compatible",
      models: {
        "deepseek-v4.1-flash": {
          ...baseModel,
          provider: { npm: "@unknown/provider" },
        },
      },
    },
    1,
  );

  assert.deepEqual(snapshot.models, []);
  assert.deepEqual(snapshot.excluded, [
    {
      id: "deepseek-v4.1-flash",
      reason: "unsupported or unknown wire protocol",
    },
  ]);
});
