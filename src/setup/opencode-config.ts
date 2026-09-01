import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { KiokukoError } from '../errors.js';
import { isSkillDiscoveryMode, SKILL_DISCOVERY_ENV } from '../skills/config.js';
import type { SkillDiscoveryMode } from '../skills/types.js';
import type { DelimitedBlockResult } from './managed-text.js';
import { setupMcpIdentityConflict } from './mcp-conflict.js';
import { assertStrictJsonSyntax } from './strict-json.js';

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isNonEmptyCommand(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function isCanonicalManagedServer(value: unknown): value is Record<string, unknown> {
  const server = object(value);
  if (server === undefined || !hasExactKeys(server, ['type', 'command', 'enabled', 'environment'])) return false;
  if (server.type !== 'local' || server.enabled !== true) return false;
  if (!Array.isArray(server.command)
    || server.command.length !== 2
    || !isNonEmptyCommand(server.command[0])
    || server.command[1] !== 'mcp') return false;
  const environment = object(server.environment);
  return environment !== undefined
    && hasExactKeys(environment, [SKILL_DISCOVERY_ENV])
    && isSkillDiscoveryMode(environment[SKILL_DISCOVERY_ENV]);
}

/** Detect an already managed OpenCode Kiokuko MCP identity without changing it. */
export function hasCanonicalOpenCodeMcpConfig(existing: string | undefined): boolean {
  if (existing === undefined) return false;
  assertStrictJsonSyntax(
    existing,
    { allowTrailingComma: true, disallowComments: false },
    'OpenCode config is not a valid JSON/JSONC object with unique keys',
  );
  const errors: ParseError[] = [];
  const parsed = parse(existing, errors, { allowTrailingComma: true, disallowComments: false });
  const root = object(parsed);
  if (errors.length > 0 || root === undefined) return false;
  return isCanonicalManagedServer(object(root.mcp)?.kiokuko);
}

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function conflict(): never {
  setupMcpIdentityConflict('opencode', 'OpenCode config already contains a conflicting kiokuko MCP server');
}

export function renderOpenCodeConfig(
  existing: string | undefined,
  command = 'kiokuko',
  skillDiscoveryMode?: SkillDiscoveryMode,
  options: { replaceConflictingIdentity?: boolean } = {},
): DelimitedBlockResult {
  if (!isNonEmptyCommand(command)) validation('OpenCode MCP command must be a non-empty executable path or name');
  if (skillDiscoveryMode !== undefined && !isSkillDiscoveryMode(skillDiscoveryMode)) {
    validation('OpenCode Skill discovery mode is invalid');
  }
  if (options.replaceConflictingIdentity !== undefined
    && typeof options.replaceConflictingIdentity !== 'boolean') {
    validation('OpenCode MCP replacement authorization is invalid');
  }
  const source = existing ?? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  assertStrictJsonSyntax(
    source,
    { allowTrailingComma: true, disallowComments: false },
    'OpenCode config is not a valid JSON/JSONC object with unique keys',
  );
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    validation('OpenCode config is not a valid JSON/JSONC object');
  }
  const root = parsed as Record<string, unknown>;
  const mcp = object(root.mcp);
  if (root.mcp !== undefined && mcp === undefined) validation('OpenCode config has an invalid mcp object');
  const currentServer = mcp?.kiokuko;
  const canonicalServer = currentServer !== undefined && isCanonicalManagedServer(currentServer)
    ? currentServer
    : undefined;
  if (currentServer !== undefined && canonicalServer === undefined && !options.replaceConflictingIdentity) conflict();
  const currentEnvironment = canonicalServer === undefined ? undefined : object(canonicalServer.environment);
  const effectiveSkillDiscoveryMode = skillDiscoveryMode
    ?? (currentEnvironment?.[SKILL_DISCOVERY_ENV] as SkillDiscoveryMode | undefined)
    ?? 'official';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const edits = modify(source, ['mcp', 'kiokuko'], {
    type: 'local',
    command: [command, 'mcp'],
    enabled: true,
    environment: { [SKILL_DISCOVERY_ENV]: effectiveSkillDiscoveryMode },
  }, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  const content = applyEdits(source, edits);
  return {
    content,
    action: existing === undefined ? 'created' : content === existing ? 'unchanged' : 'updated',
  };
}
