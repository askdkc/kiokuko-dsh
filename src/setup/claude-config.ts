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
  if (server === undefined || !hasExactKeys(server, ['type', 'command', 'args', 'env'])) return false;
  if (server.type !== 'stdio' || !isNonEmptyCommand(server.command)) return false;
  if (!Array.isArray(server.args) || server.args.length !== 1 || server.args[0] !== 'mcp') return false;
  const environment = object(server.env);
  return environment !== undefined
    && hasExactKeys(environment, [SKILL_DISCOVERY_ENV])
    && isSkillDiscoveryMode(environment[SKILL_DISCOVERY_ENV]);
}

/** Detect an already managed Claude Kiokuko MCP identity without changing it. */
export function hasCanonicalClaudeMcpConfig(existing: string | undefined): boolean {
  if (existing === undefined) return false;
  assertStrictJsonSyntax(
    existing,
    { allowTrailingComma: false, disallowComments: true },
    'Claude user config is not a valid JSON object with unique keys',
  );
  const errors: ParseError[] = [];
  const parsed = parse(existing, errors, { allowTrailingComma: false, disallowComments: true });
  const root = object(parsed);
  if (errors.length > 0 || root === undefined) return false;
  return isCanonicalManagedServer(object(root.mcpServers)?.kiokuko);
}

function validation(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function conflict(): never {
  setupMcpIdentityConflict('claude', 'Claude user config already contains a conflicting kiokuko MCP server');
}

export function renderClaudeConfig(
  existing: string | undefined,
  command = 'kiokuko',
  skillDiscoveryMode?: SkillDiscoveryMode,
  options: { replaceConflictingIdentity?: boolean } = {},
): DelimitedBlockResult {
  if (!isNonEmptyCommand(command)) validation('Claude MCP command must be a non-empty executable path or name');
  if (skillDiscoveryMode !== undefined && !isSkillDiscoveryMode(skillDiscoveryMode)) {
    validation('Claude Skill discovery mode is invalid');
  }
  if (options.replaceConflictingIdentity !== undefined
    && typeof options.replaceConflictingIdentity !== 'boolean') {
    validation('Claude MCP replacement authorization is invalid');
  }
  const source = existing ?? '{}\n';
  assertStrictJsonSyntax(
    source,
    { allowTrailingComma: false, disallowComments: true },
    'Claude user config is not a valid JSON object with unique keys',
  );
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length > 0 || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    validation('Claude user config is not a valid JSON object');
  }
  const root = parsed as Record<string, unknown>;
  const mcpServers = object(root.mcpServers);
  if (root.mcpServers !== undefined && mcpServers === undefined) validation('Claude user config has an invalid mcpServers object');
  const currentServer = mcpServers?.kiokuko;
  const canonicalServer = currentServer !== undefined && isCanonicalManagedServer(currentServer)
    ? currentServer
    : undefined;
  if (currentServer !== undefined && canonicalServer === undefined && !options.replaceConflictingIdentity) conflict();
  const currentEnvironment = canonicalServer === undefined ? undefined : object(canonicalServer.env);
  const effectiveSkillDiscoveryMode = skillDiscoveryMode
    ?? (currentEnvironment?.[SKILL_DISCOVERY_ENV] as SkillDiscoveryMode | undefined)
    ?? 'official';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const edits = modify(source, ['mcpServers', 'kiokuko'], {
    type: 'stdio',
    command,
    args: ['mcp'],
    env: { [SKILL_DISCOVERY_ENV]: effectiveSkillDiscoveryMode },
  }, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  const content = applyEdits(source, edits);
  return {
    content,
    action: existing === undefined ? 'created' : content === existing ? 'unchanged' : 'updated',
  };
}
