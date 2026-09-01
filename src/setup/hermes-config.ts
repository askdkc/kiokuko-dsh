import { parseDocument, isMap, isNode, isPair, isScalar, isSeq, type Pair, type YAMLMap } from 'yaml';
import { KiokukoError } from '../errors.js';
import { isSkillDiscoveryMode, SKILL_DISCOVERY_ENV } from '../skills/config.js';
import type { SkillDiscoveryMode } from '../skills/types.js';
import type { DelimitedBlockResult } from './managed-text.js';
import { setupMcpIdentityConflict } from './mcp-conflict.js';

export const HERMES_MANAGED_MARKER = 'Managed by `kiokuko setup`.';

type HermesMap = YAMLMap<unknown, unknown>;

function scalarValue(value: unknown): unknown {
  return isScalar(value) ? value.value : undefined;
}

function findKeyPair(map: HermesMap, key: string): Pair | undefined {
  return map.items.find((item) => isPair(item) && scalarValue(item.key) === key);
}

function hasManagedMarker(pair: Pair): boolean {
  return isNode(pair.value) && pair.value.commentBefore?.trim() === HERMES_MANAGED_MARKER;
}

function hasCanonicalManagedShape(pair: Pair): boolean {
  if (!isMap(pair.value)) return false;
  const fields = pair.value.items.map((item) => isPair(item) ? scalarValue(item.key) : undefined);
  if (fields.length !== 3
    || new Set(fields).size !== fields.length
    || !fields.includes('command')
    || !fields.includes('args')
    || fields.some((field) => field !== 'command' && field !== 'args' && field !== 'env')) return false;
  const commandNode = pair.value.get('command', true);
  const argsNode = pair.value.get('args', true);
  const command = scalarValue(commandNode);
  if (typeof command !== 'string'
    || command.trim().length === 0
    || command.includes('\0')
    || !isSeq(argsNode)
    || argsNode.items.length !== 1
    || scalarValue(argsNode.items[0]) !== 'mcp') return false;
  const envNode = pair.value.get('env', true);
  if (!isMap(envNode) || envNode.items.length !== 1) return false;
  const environmentPair = envNode.items[0];
  return isPair(environmentPair)
    && scalarValue(environmentPair.key) === SKILL_DISCOVERY_ENV
    && isSkillDiscoveryMode(scalarValue(environmentPair.value));
}

function currentManagedCommand(pair: Pair): string | undefined {
  if (!hasCanonicalManagedShape(pair)) return undefined;
  const command = scalarValue((pair.value as HermesMap).get('command', true));
  return typeof command === 'string' ? command : undefined;
}

function currentManagedSkillDiscoveryMode(pair: Pair): SkillDiscoveryMode | undefined {
  if (!hasCanonicalManagedShape(pair) || !isMap(pair.value)) return undefined;
  const environment = pair.value.get('env', true);
  if (!isMap(environment)) return undefined;
  const mode = scalarValue(environment.get(SKILL_DISCOVERY_ENV, true));
  return isSkillDiscoveryMode(mode) ? mode : undefined;
}

function hasRequestedState(pair: Pair, command: string, skillDiscoveryMode: SkillDiscoveryMode): boolean {
  return currentManagedCommand(pair) === command
    && currentManagedSkillDiscoveryMode(pair) === skillDiscoveryMode;
}

function validation(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Hermes config is not a valid YAML mapping');
}

function conflict(): never {
  setupMcpIdentityConflict('hermes', 'Hermes config already contains a conflicting kiokuko MCP server');
}

function managedHermesServerValue(
  document: ReturnType<typeof parseDocument>,
  command: string,
  skillDiscoveryMode: SkillDiscoveryMode,
) {
  const value = document.createNode({
    command,
    args: ['mcp'],
    env: { [SKILL_DISCOVERY_ENV]: skillDiscoveryMode },
  });
  if (!isNode(value)) validation();
  value.commentBefore = ` ${HERMES_MANAGED_MARKER}`;
  return value;
}

function serializeHermesDocument(
  document: ReturnType<typeof parseDocument>,
  source: string,
  existing: string | undefined,
): DelimitedBlockResult {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const serialized = document.toString({ lineWidth: 0 }).replaceAll('\r\n', '\n');
  const content = serialized.replaceAll('\n', eol);
  return {
    content,
    action: existing === undefined ? 'created' : content === existing ? 'unchanged' : 'updated',
  };
}

export function renderHermesConfig(
  existing: string | undefined,
  command = 'kiokuko',
  skillDiscoveryMode?: SkillDiscoveryMode,
  options: { replaceConflictingIdentity?: boolean } = {},
): DelimitedBlockResult {
  if (typeof command !== 'string' || command.trim().length === 0 || command.includes('\0')) {
    throw new KiokukoError('VALIDATION_ERROR', 'Hermes MCP command must be a non-empty executable path or name');
  }
  if (skillDiscoveryMode !== undefined && !isSkillDiscoveryMode(skillDiscoveryMode)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Hermes Skill discovery mode is invalid');
  }
  if (options.replaceConflictingIdentity !== undefined
    && typeof options.replaceConflictingIdentity !== 'boolean') {
    throw new KiokukoError('VALIDATION_ERROR', 'Hermes MCP replacement authorization is invalid');
  }
  const source = existing ?? '';
  const document = parseDocument(source);
  if (document.errors.length > 0) validation();

  let contents: unknown = document.contents;
  if (contents === null) {
    const created = document.createNode({}) as unknown as HermesMap;
    document.contents = created as never;
    contents = created;
  }
  if (!isMap(contents)) validation();

  let mcpServers: unknown = contents.get('mcp_servers', true);
  if (mcpServers !== undefined && !isMap(mcpServers)) validation();
  if (mcpServers === undefined) {
    const created = document.createNode({}) as unknown as HermesMap;
    contents.set('mcp_servers', created);
    mcpServers = created;
  }

  const serverMap = mcpServers as HermesMap;
  const existingPair = findKeyPair(serverMap, 'kiokuko');
  if (existingPair !== undefined) {
    if (!hasManagedMarker(existingPair) || !hasCanonicalManagedShape(existingPair)) {
      if (!options.replaceConflictingIdentity) conflict();
      existingPair.value = managedHermesServerValue(
        document,
        command,
        skillDiscoveryMode ?? 'official',
      );
      return serializeHermesDocument(document, source, existing);
    }
    const currentSkillDiscoveryMode = currentManagedSkillDiscoveryMode(existingPair);
    if (currentSkillDiscoveryMode === undefined) conflict();
    const effectiveSkillDiscoveryMode = skillDiscoveryMode ?? currentSkillDiscoveryMode;
    if (hasRequestedState(existingPair, command, effectiveSkillDiscoveryMode)) return { content: source, action: 'unchanged' };
    if (!isMap(existingPair.value)) conflict();
    existingPair.value.set('command', command);
    existingPair.value.set('env', { [SKILL_DISCOVERY_ENV]: effectiveSkillDiscoveryMode });
    return serializeHermesDocument(document, source, existing);
  }

  const effectiveSkillDiscoveryMode = skillDiscoveryMode ?? 'official';
  const pair = document.createPair(
    'kiokuko',
    managedHermesServerValue(document, command, effectiveSkillDiscoveryMode),
  ) as unknown as Pair;
  serverMap.add(pair);
  return serializeHermesDocument(document, source, existing);
}
