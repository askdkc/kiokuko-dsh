import { KiokukoError } from '../errors.js';
import { ENNO_CLIENT_KINDS, type EnnoClientKind } from './types.js';

export interface TaskClientHint {
  kind?: string;
  version?: string;
  sessionId?: string;
}

export interface TaskClientHintInput {
  kind?: string | undefined;
  version?: string | undefined;
  sessionId?: string | undefined;
}

export interface McpClientImplementation {
  name: string;
  title?: string | undefined;
  version: string;
}

const CLIENT_ALIASES: Readonly<Record<EnnoClientKind, readonly string[]>> = {
  codex: ['codex', 'codex-mcp-client'],
  claude: ['claude', 'claude-ai', 'claude-code'],
  opencode: ['opencode'],
  dsh: ['dsh', 'deepseek-harness'],
};

function normalizedClientName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200
    || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  return value.normalize('NFKC').toLowerCase();
}

function boundedVersion(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100
    || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  return value;
}

export function identifyEnnoClientKind(value: unknown): EnnoClientKind | null {
  const normalized = normalizedClientName(value);
  if (normalized === null) return null;
  return ENNO_CLIENT_KINDS.find((kind) => CLIENT_ALIASES[kind].includes(normalized)) ?? null;
}

export function identifyMcpClientKind(client: McpClientImplementation | undefined): EnnoClientKind | null {
  if (client === undefined) return null;
  const fromName = identifyEnnoClientKind(client.name);
  const fromTitle = identifyEnnoClientKind(client.title);
  if (fromName !== null && fromTitle !== null && fromName !== fromTitle) {
    throw new KiokukoError('CONFLICT', 'MCP client identity is contradictory');
  }
  return fromName ?? fromTitle;
}

export function resolveTaskPrepareClient(
  explicit: TaskClientHintInput | undefined,
  runtime: McpClientImplementation | undefined,
): TaskClientHint | undefined {
  const runtimeKind = identifyMcpClientKind(runtime);
  const explicitKind = identifyEnnoClientKind(explicit?.kind);
  if (runtimeKind !== null && explicit?.kind !== undefined && explicitKind !== runtimeKind) {
    throw new KiokukoError('CONFLICT', 'Explicit client identity conflicts with the MCP client');
  }
  if (runtimeKind !== null) {
    const runtimeVersion = boundedVersion(runtime?.version);
    return {
      kind: runtimeKind,
      ...(runtimeVersion === undefined ? {} : { version: runtimeVersion }),
      ...(explicit?.sessionId === undefined ? {} : { sessionId: explicit.sessionId }),
    };
  }
  if (explicit !== undefined) {
    return {
      ...(explicit.kind === undefined ? {} : { kind: explicit.kind }),
      ...(explicit.version === undefined ? {} : { version: explicit.version }),
      ...(explicit.sessionId === undefined ? {} : { sessionId: explicit.sessionId }),
    };
  }
  if (runtime === undefined) return undefined;
  const runtimeVersion = boundedVersion(runtime.version);
  return {
    kind: runtime.name,
    ...(runtimeVersion === undefined ? {} : { version: runtimeVersion }),
  };
}
