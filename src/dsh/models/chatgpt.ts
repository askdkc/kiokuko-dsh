import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createChatGPT, type CredentialEncryption } from "./vendor/chatgpt-devkit/index.js";
import type { PiAiProvider } from "./vendor/pi-ai.js";

export function chatGPTEncryption(directory: string): CredentialEncryption {
  // Each SDK directory has a separate lock and a separate OS-keystore key.
  const account = createHash("sha256").update(resolve(directory)).digest("hex");
  const entry = async () => {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry("kiokuko-dsh.chatgpt", account, { linux: { store: "secret-service" } });
  };
  return {
    id: "kiokuko-os-keyring-aes256gcm-v1",
    async isAvailable() { await (await entry()).getSecret(); return true; },
    async encrypt(text) {
      const store = await entry();
      const saved = await store.getSecret();
      const key = saved ? Buffer.from(saved) : randomBytes(32);
      if (!saved) await store.setSecret(key);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    async decrypt(bytes) {
      const key = await (await entry()).getSecret();
      if (!key) throw new Error("Missing ChatGPT storage key");
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

export function chatGPTAccount(directory: string, openBrowser: (url: string) => void) {
  return createChatGPT({
    appName: "Kiokuko DSH", appId: "kiokuko-dsh", redirectPort: 0,
    storageDir: directory, credentialEncryption: chatGPTEncryption(directory), openBrowser,
  });
}

export type ChatGPTAccount = Pick<ReturnType<typeof chatGPTAccount>, "getSession" | "signIn" | "disconnect" | "listModels" | "requestResponses">;

// pi-ai builds the DSH messages and tool schema. Only the DevKit supplies the
// real credential, inside its authenticated request to the fixed OpenAI origin.
export function chatGPTProvider(source: PiAiProvider, account: ChatGPTAccount): PiAiProvider {
  const transport: typeof fetch = async (input, init) => {
    if (String(input) !== "https://api.openai.com/v1/responses" || init?.method !== "POST" || typeof init.body !== "string")
      throw new Error("Unexpected ChatGPT Responses request");
    return account.requestResponses(init.body, init.signal ?? undefined);
  };
  return {
    ...source,
    stream: (model, context, options) => source.stream({ ...model, provider: "openai" }, context, Object.assign({}, options, { fetch: transport })),
    streamSimple: (model, context, options) => source.streamSimple({ ...model, provider: "openai" }, context, { ...options, fetch: transport }),
  };
}
