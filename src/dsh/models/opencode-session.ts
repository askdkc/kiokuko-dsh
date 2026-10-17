/** OpenCode routing metadata for transports owned by this plugin. */
import { randomUUID } from 'node:crypto';
import type { PiAiProvider } from './vendor/pi-ai.js';

/** Keep deployment headers; otherwise use the conversation or a fresh one-shot identity. */
export function openCodeSessionHeaders(sessionId: string | undefined, headers: Record<string, string | null> = {}): Record<string, string | null> {
  if (Object.keys(headers).some(name => name.toLowerCase() === 'x-opencode-session')) return headers;
  return { ...headers, 'x-opencode-session': sessionId || randomUUID() };
}

/** Compose the public Provider stream hooks after protocol selection, without changing a host adapter. */
export function openCodeSessionProvider(provider: PiAiProvider, endpoint: string): PiAiProvider {
  const url = new URL(endpoint);
  if (url.origin !== 'https://opencode.ai' || !/^\/zen\/(?:go\/)?v1\/?$/.test(url.pathname)) return provider;
  // Erase only the protocol type parameter here; every protocol receives the same common header option.
  type StreamArgs = Parameters<PiAiProvider['stream']>;
  const stream = (model: StreamArgs[0], context: StreamArgs[1], options: StreamArgs[2]) =>
    provider.stream(model, context, { ...options, headers: openCodeSessionHeaders(options?.sessionId, options?.headers) });
  return {
    ...provider,
    stream,
    streamSimple: (model, context, options) => provider.streamSimple(model, context, { ...options, headers: openCodeSessionHeaders(options?.sessionId, options?.headers) }),
  };
}
