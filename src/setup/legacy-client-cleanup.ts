import { createHash } from 'node:crypto';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { KiokukoError } from '../errors.js';
import { assertStrictJsonSyntax } from './strict-json.js';

const CLAUDE_HOOK_EVENT = 'UserPromptSubmit';
const LEGACY_HOOK_INPUT = Object.freeze({
  prompt: '${prompt}',
  cwd: '${cwd}',
  sessionId: '${session_id}',
});
const LEGACY_HOOK_STATUS = 'Kiokuko: recalling relevant memory';

export const LEGACY_OPENCODE_LOOP_GUARD_MARKER = '// Managed by `kiokuko setup`: OpenCode loop guard v1';

const LEGACY_OPENCODE_LOOP_GUARD_SHA256 = new Set([
  '9a9a5430942a3632c7b73958d49fc5e456b439741ef31db34fec38c2ebcb9f0a',
  '6910ad5cae126371397ca3dda4adadca8b07f80dcd4ba995192c46e167758cde',
  'a34f3e3c3009ae622bda92a77ea33cc24aaa75ab05a338f795acbe8346effbfe',
  'd86f45354797f586748fd7beaa6c66c8df0705a0ac7d07db45118aa1dbdccece',
  '598d919ed088e725311e567d3ee305bdbb026b538972c41e84ed450d4cd79620',
  '04898710f67a451177e351f5343aed2b2a9c75c4fcc233829b2062aa804bd040',
  'd044cc7947dd4b41e14ed8891a01f21bb28f83c14765e542192172202e7ab6b2',
  '26facf4203b66c25d0305a7ec919cfba6e55e4b2b4dcd7333af0002eb87255d2',
  '4226cfe43306871e3fda95f87e4d4c1c98c54150e8a9ec876e941d7aaf5a8431',
  'efe0b9274b6f0de8976989639810cff6d55f50d759a6e1a3839834f3b3386931',
  '2aecaf04354cb76d0e2c8fa63f96f7fb91e8bd3720aaee827e5794f0eb6d94a6',
  '361c7b1a8d0993597d139ab6703d130d788dfcf01e4911bb7966c54afa57201b',
]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidClaudeSettings(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Claude settings are not a valid JSON object with valid hook arrays');
}

function legacyClaudeHookConflict(): never {
  throw new KiokukoError('CONFLICT', 'Claude settings contain an ambiguous or modified legacy Kiokuko prompt hook; remove it manually before running setup');
}

function validateHookGroups(value: unknown): asserts value is JsonObject[] {
  if (!Array.isArray(value)) invalidClaudeSettings();
  for (const group of value) {
    if (!isObject(group) || (group.matcher !== undefined && typeof group.matcher !== 'string') || !Array.isArray(group.hooks)) invalidClaudeSettings();
    for (const handler of group.hooks) {
      if (!isObject(handler)) invalidClaudeSettings();
    }
  }
}

function validateSettings(value: unknown): asserts value is JsonObject {
  if (!isObject(value)) invalidClaudeSettings();
  if (value.hooks === undefined) return;
  if (!isObject(value.hooks)) invalidClaudeSettings();
  for (const groups of Object.values(value.hooks)) validateHookGroups(groups);
}

function hasLegacyIdentityPart(handler: JsonObject): boolean {
  if (handler.server === 'kiokuko'
    || handler.tool === 'claude_prompt_context'
    || handler.statusMessage === LEGACY_HOOK_STATUS) return true;
  if (!isObject(handler.input)) return false;
  const inputMatches = [
    handler.input.prompt === LEGACY_HOOK_INPUT.prompt,
    handler.input.cwd === LEGACY_HOOK_INPUT.cwd,
    handler.input.sessionId === LEGACY_HOOK_INPUT.sessionId,
  ].filter(Boolean).length;
  return inputMatches >= 2
    || (handler.type === 'mcp_tool' && handler.timeout === 5 && inputMatches >= 1);
}

function isCanonicalLegacyHook(handler: JsonObject): boolean {
  const keys = Object.keys(handler).sort();
  if (keys.join('\0') !== ['input', 'server', 'statusMessage', 'timeout', 'tool', 'type'].sort().join('\0')) return false;
  if (
    handler.type !== 'mcp_tool'
    || handler.server !== 'kiokuko'
    || handler.tool !== 'claude_prompt_context'
    || handler.timeout !== 5
    || handler.statusMessage !== LEGACY_HOOK_STATUS
    || !isObject(handler.input)
  ) return false;
  const inputKeys = Object.keys(handler.input).sort();
  return inputKeys.join('\0') === Object.keys(LEGACY_HOOK_INPUT).sort().join('\0')
    && handler.input.prompt === LEGACY_HOOK_INPUT.prompt
    && handler.input.cwd === LEGACY_HOOK_INPUT.cwd
    && handler.input.sessionId === LEGACY_HOOK_INPUT.sessionId;
}

function formattingOptions(source: string): { insertSpaces: boolean; tabSize: number; eol: '\n' | '\r\n' } {
  const indentation = source.match(/^([ \t]+)(?=["}])/mu)?.[1];
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  if (indentation?.includes('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indentation?.length || 2, eol };
}

/** Remove one exact hook written by the retired Claude integration. */
export function cleanupLegacyClaudePromptHook(source: string): string {
  assertStrictJsonSyntax(
    source,
    { allowTrailingComma: false, disallowComments: true },
    'Claude settings are not a valid JSON object with unique keys',
  );
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length > 0) invalidClaudeSettings();
  validateSettings(parsed);

  const hooks = parsed.hooks as JsonObject | undefined;
  const matches: Array<{ event: string; groupIndex: number; handlerIndex: number }> = [];
  for (const [event, groupsValue] of Object.entries(hooks ?? {})) {
    const groups = groupsValue as JsonObject[];
    groups.forEach((group, groupIndex) => {
      (group.hooks as JsonObject[]).forEach((handler, handlerIndex) => {
        if (!hasLegacyIdentityPart(handler)) return;
        if (event !== CLAUDE_HOOK_EVENT || !isCanonicalLegacyHook(handler)) legacyClaudeHookConflict();
        matches.push({ event, groupIndex, handlerIndex });
      });
    });
  }
  if (matches.length === 0) return source;
  if (matches.length !== 1) legacyClaudeHookConflict();

  const groups = (hooks?.[CLAUDE_HOOK_EVENT] as JsonObject[]).map((group) => ({
    ...group,
    hooks: [...group.hooks as JsonObject[]],
  }));
  const match = matches[0]!;
  const group = groups[match.groupIndex]!;
  (group.hooks as JsonObject[]).splice(match.handlerIndex, 1);
  if ((group.hooks as JsonObject[]).length === 0 && Object.keys(group).length === 1) {
    groups.splice(match.groupIndex, 1);
  }

  const edits = modify(source, ['hooks', CLAUDE_HOOK_EVENT], groups.length === 0 ? undefined : groups, {
    formattingOptions: formattingOptions(source),
  });
  return applyEdits(source, edits);
}

/** Accept only byte-exact files emitted by the retired OpenCode guard renderer. */
export function assertExactLegacyOpenCodeLoopGuard(source: string): void {
  if (!source.startsWith(`${LEGACY_OPENCODE_LOOP_GUARD_MARKER}\n`)
    && !source.startsWith(`${LEGACY_OPENCODE_LOOP_GUARD_MARKER}\r\n`)) {
    throw new KiokukoError('CONFLICT', 'The retired OpenCode Kiokuko plugin path contains an unmanaged file; move or remove it before running setup');
  }
  const digest = createHash('sha256').update(source).digest('hex');
  if (!LEGACY_OPENCODE_LOOP_GUARD_SHA256.has(digest)) {
    throw new KiokukoError('CONFLICT', 'The retired OpenCode Kiokuko plugin was modified; move or remove it before running setup');
  }
}
