import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { reflectRepositoryTurn } from "../../../src/dsh/repository-learning-reflector.js";
import { nativeMock } from "../helpers/native-mock.js";

const packages =
  process.env.KIOKUKO_DSH_PACKAGE_ROOT ??
  join(process.cwd(), "tests/fixtures/dsh-runtime/node_modules");
const available = existsSync(
  join(packages, "@deepseek-ai/dsh-llm/lib/index.js"),
);
if (!available && process.env.KIOKUKO_REQUIRE_DSH_NATIVE === "1")
  throw new Error("Configured native DSH LLM fixture is unavailable");
const load = (name: string) =>
  import(
    pathToFileURL(join(packages, "@deepseek-ai", name, "lib/index.js")).href
  );

test(
  "repository turn reflection uses real DSH prepareCall and adapter dispatch without an agent/tool loop",
  { skip: !available, timeout: 10_000 },
  async () => {
    const [cordis, llm] = await Promise.all([load("cordis"), load("dsh-llm")]);
    const ctx = new cordis.Context();
    try {
      await ctx.plugin(llm.default);
      const mock = nativeMock(llm);
      const lesson = {
        hypothesis: "This path requires escaped JSON.",
        applicability: "JSON generation in this repository.",
        nextAction: "Serialize an object.",
        verifyWith: "Parse output as JSON.",
        evidenceRefs: ["native:session-native:3"],
      };
      class ReflectionAdapter extends llm.LlmAdapter {
        readonly requests: any[] = [];
        async resolveModel(provider: string, model: string) {
          return { provider, id: model, name: model };
        }
        async listModels(provider: string) {
          return [{ provider, id: "mock", name: "mock" }];
        }
        async *stream(options: any) {
          this.requests.push(options);
          yield* mock.textResponse(JSON.stringify({ lessons: [lesson] }));
        }
      }
      const model = new ReflectionAdapter();
      ctx.llm.registerAdapter(["native-learning"], model);
      const result = await reflectRepositoryTurn(
        ctx,
        {
          model: {
            current: () => ({ provider: "native-learning", model: "mock" }),
          },
          session: { id: "session-native" },
        },
        {
          sessionId: "session-native",
          turnId: 1,
          outcome: "completed",
          request: "Check JSON output.",
          summary: "JSON parse passed.",
          evidenceRefs: ["native:session-native:3"],
          observations: [
            {
              ref: "native:session-native:3",
              type: "tool/result",
              text: "JSON parse passed.",
            },
          ],
          priorCompact: "",
        },
      );
      assert.equal(result.status, "model", JSON.stringify(result));
      assert.deepEqual(result.lessons, [lesson]);
      assert.equal(model.requests.length, 1);
      assert.equal(model.requests[0].provider, "native-learning");
      assert.equal(model.requests[0].purpose, "compaction");
      assert.deepEqual(model.requests[0].tools, []);
      assert.equal(model.requests[0].maxTokens, 2048);
    } finally {
      await ctx.fiber.dispose();
    }
  },
);
