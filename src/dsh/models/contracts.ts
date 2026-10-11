import { z } from "zod";
export const CONNECTION_KINDS = [
  "openai",
  "codex",
  "claude",
  "xai",
  "deepseek",
  "opencode",
  "opencode-go",
  "openrouter",
  "nous",
  "infron",
  "ollama",
  "custom",
] as const;
export type InfronServiceTier = "standard" | "flex";
export const ManualModelSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    name: z.string().trim().min(1).max(256),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    reasoning: z.boolean().default(false),
    image: z.boolean().default(false),
  })
  .strict();
export const ConnectionSchema = z
  .object({
    id: z.string().regex(/^kiokuko-[a-z0-9-]{1,64}$/),
    kind: z.enum(CONNECTION_KINDS),
    name: z.string().trim().min(1).max(128),
    baseURL: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const u = new URL(value);
        return (
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          (u.protocol === "https:" ||
            (u.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
        );
      }, "Use HTTPS or a loopback HTTP URL without credentials, query or fragment"),
    protocol: z.enum(["chat-completions", "responses", "messages"]),
    serviceTier: z.enum(["standard", "flex"]).default("standard"),
    models: z.array(ManualModelSchema).max(1024).default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === "infron" && v.protocol !== "chat-completions")
      ctx.addIssue({
        code: "custom",
        message: "Infron requires Chat Completions",
      });
    if (v.kind === "codex" && v.protocol !== "responses")
      ctx.addIssue({ code: "custom", message: "Codex requires Responses" });
  });
export type Connection = z.infer<typeof ConnectionSchema>;
export type ManualModel = z.infer<typeof ManualModelSchema>;
export const ModelsDocumentSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    connections: z.array(ConnectionSchema).max(128),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.connections.map((c) => c.id)).size ===
      value.connections.length,
    "Connection IDs must be unique",
  );
export type ModelsDocument = z.infer<typeof ModelsDocumentSchema>;
export const CONNECTION_DEFAULTS = {
  openai: ["OpenAI API", "https://api.openai.com/v1", "responses"],
  codex: ["Codex", "https://chatgpt.com/backend-api/codex", "responses"],
  claude: ["Claude", "https://api.anthropic.com", "messages"],
  xai: ["xAI", "https://api.x.ai/v1", "chat-completions"],
  deepseek: ["DeepSeek", "https://api.deepseek.com/v1", "chat-completions"],
  opencode: ["OpenCode Zen", "https://opencode.ai/zen/v1", "chat-completions"],
  "opencode-go": [
    "OpenCode Go",
    "https://opencode.ai/zen/go/v1",
    "chat-completions",
  ],
  openrouter: [
    "OpenRouter",
    "https://openrouter.ai/api/v1",
    "chat-completions",
  ],
  nous: [
    "Nous / Hermes",
    "https://inference-api.nousresearch.com/v1",
    "chat-completions",
  ],
  infron: ["Infron", "https://llm.onerouter.pro/v1", "chat-completions"],
  ollama: ["Ollama", "http://localhost:11434/v1", "chat-completions"],
  custom: ["Custom connection", "http://localhost:8080/v1", "chat-completions"],
} as const;
/** Routes and the shared CLI credential addresses have independent identities. */
export function credentialKey(connection: Connection): string {
  return connection.kind === "codex"
    ? "openai-codex"
    : connection.kind === "claude"
      ? "anthropic"
      : connection.kind === "custom"
        ? connection.id
        : connection.kind;
}
