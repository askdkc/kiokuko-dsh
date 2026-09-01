import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { KiokukoError } from '../errors.js';
import { assertStrictJsonSyntax } from './strict-json.js';

export type EnnoSetupMode = 'on' | 'off';
export type EnnoHookClient = 'codex' | 'claude';

export interface OptionalRenderedFile {
  content: string | undefined;
  action: 'created' | 'updated' | 'unchanged' | 'deleted';
}

const OPENCODE_MARKER = '// Managed by `kiokuko setup`: Enno-Oduno v1';

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validateExecutable(command: string): void {
  if (!/^[A-Za-z0-9_./:\\-]+$/u.test(command) || command.includes('\0')) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      'Enno-Oduno hook command must be an executable name or path without whitespace or shell metacharacters',
    );
  }
}

function hookCommand(command: string, client: EnnoHookClient): string {
  validateExecutable(command);
  return `${command} enno hook --client ${client} --input-json -`;
}

function managedHandler(command: string, client: EnnoHookClient): Record<string, unknown> {
  return client === 'codex'
    ? {
        type: 'command',
        command: hookCommand(command, client),
        timeout: 10,
        statusMessage: 'Checking Enno-Oduno run',
      }
    : {
        type: 'command',
        command: hookCommand(command, client),
        timeout: 10,
      };
}

function isExactObject(value: unknown, expected: Record<string, unknown>): boolean {
  const candidate = object(value);
  if (candidate === undefined) return false;
  const keys = Object.keys(candidate);
  return keys.length === Object.keys(expected).length
    && keys.every((key) => candidate[key] === expected[key]);
}

function containsEnnoIdentity(value: unknown): boolean {
  const candidate = object(value);
  return typeof candidate?.command === 'string'
    && candidate.command.includes('enno hook --client');
}

function parseHookRoot(source: string, client: EnnoHookClient): Record<string, unknown> {
  assertStrictJsonSyntax(
    source,
    { allowTrailingComma: false, disallowComments: true },
    `${client === 'codex' ? 'Codex hooks' : 'Claude settings'} is not a valid JSON object with unique keys`,
  );
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: false, disallowComments: true });
  const root = object(parsed);
  if (errors.length > 0 || root === undefined) {
    throw new KiokukoError('VALIDATION_ERROR', `${client === 'codex' ? 'Codex hooks' : 'Claude settings'} is not a valid JSON object`);
  }
  return root;
}

function stopGroups(root: Record<string, unknown>): unknown[] {
  const hooks = object(root.hooks);
  if (root.hooks !== undefined && hooks === undefined) {
    throw new KiokukoError('VALIDATION_ERROR', 'Hook configuration has an invalid hooks object');
  }
  const stop = hooks?.Stop;
  if (stop !== undefined && !Array.isArray(stop)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Hook configuration has an invalid Stop hook list');
  }
  return stop === undefined ? [] : stop;
}

function managedGroupIndex(groups: unknown[], expected: Record<string, unknown>): number {
  let exact = -1;
  for (const [index, value] of groups.entries()) {
    const group = object(value);
    if (group === undefined || !Array.isArray(group.hooks)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Stop hook entries must contain a hooks array');
    }
    for (const handler of group.hooks) {
      if (isExactObject(handler, expected)) {
        if (exact !== -1) throw new KiokukoError('CONFLICT', 'Duplicate managed Enno-Oduno Stop hooks were found');
        exact = index;
      } else if (containsEnnoIdentity(handler)) {
        throw new KiokukoError('CONFLICT', 'An unmanaged or modified Enno-Oduno Stop hook already exists');
      }
    }
  }
  return exact;
}

export function renderEnnoStopHook(
  existing: string | undefined,
  client: EnnoHookClient,
  command: string,
  mode: EnnoSetupMode,
): OptionalRenderedFile {
  if (mode !== 'on' && mode !== 'off') throw new KiokukoError('VALIDATION_ERROR', 'Enno-Oduno setup mode must be on or off');
  if (existing === undefined && mode === 'off') return { content: undefined, action: 'unchanged' };
  const source = existing ?? '{}\n';
  const root = parseHookRoot(source, client);
  const groups = stopGroups(root);
  const expected = managedHandler(command, client);
  const index = managedGroupIndex(groups, expected);
  let nextGroups = groups;
  if (mode === 'on' && index === -1) nextGroups = [...groups, { hooks: [expected] }];
  if (mode === 'off' && index !== -1) {
    const group = object(groups[index])!;
    const hooks = (group.hooks as unknown[]).filter((handler) => !isExactObject(handler, expected));
    nextGroups = hooks.length === 0
      ? groups.filter((_, candidateIndex) => candidateIndex !== index)
      : groups.map((value, candidateIndex) => candidateIndex === index ? { ...group, hooks } : value);
  }
  if (nextGroups === groups) return { content: existing, action: 'unchanged' };
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const content = applyEdits(source, modify(source, ['hooks', 'Stop'], nextGroups, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  }));
  return {
    content,
    action: existing === undefined ? 'created' : 'updated',
  };
}

export function renderOpenCodeEnnoPlugin(
  existing: string | undefined,
  command: string,
  mode: EnnoSetupMode,
): OptionalRenderedFile {
  validateExecutable(command);
  const expected = `${OPENCODE_MARKER}\n`
    + `const command = ${JSON.stringify(command)};\n`
    + 'const warned = "Kiokuko Enno-Oduno adapter unavailable; allowing OpenCode to stop.";\n'
    + 'const processedIdles = new Map();\n\n'
    + 'export const KiokukoEnnoOduno = async ({ client, directory }) => ({\n'
    + '  event: async ({ event }) => {\n'
    + '    if (event.type !== "session.idle") return;\n'
    + '    const sessionId = event.properties?.sessionID;\n'
    + '    if (typeof sessionId !== "string" || sessionId.length === 0) return;\n'
    + '    let terminalMessageId;\n'
    + '    try {\n'
    + '      const session = await client.session.get({ path: { id: sessionId } });\n'
    + '      if (session.data?.parentID) return;\n'
    + '      if (!session.data) throw new Error("session lookup failed");\n'
    + '      const messages = await client.session.messages({ path: { id: sessionId } });\n'
    + '      const terminalMessage = Array.isArray(messages.data) ? messages.data.at(-1) : undefined;\n'
    + '      terminalMessageId = terminalMessage?.info?.id;\n'
    + '      if (typeof terminalMessageId !== "string" || terminalMessageId.length === 0) return;\n'
    + '      if (processedIdles.get(sessionId) === terminalMessageId) return;\n'
    + '      processedIdles.set(sessionId, terminalMessageId);\n'
    + '      const child = Bun.spawn([command, "enno", "hook", "--client", "opencode", "--input-json", "-"], {\n'
    + '        stdin: "pipe", stdout: "pipe", stderr: "pipe",\n'
    + '      });\n'
    + '      child.stdin.write(JSON.stringify({ sessionId, cwd: directory }));\n'
    + '      child.stdin.end();\n'
    + '      let timeoutId;\n'
    + '      const timer = new Promise((_, reject) => { timeoutId = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, 10000); });\n'
    + '      let output;\n'
    + '      try { output = await Promise.race([new Response(child.stdout).text(), timer]); }\n'
    + '      finally { clearTimeout(timeoutId); }\n'
    + '      const decision = JSON.parse(output);\n'
    + '      if (decision.continue !== true || typeof decision.reason !== "string") return;\n'
    + '      await client.session.prompt({ path: { id: sessionId }, body: { parts: [{ type: "text", text: decision.reason }] } });\n'
    + '    } catch {\n'
    + '      if (processedIdles.get(sessionId) === terminalMessageId) processedIdles.delete(sessionId);\n'
    + '      console.warn(warned);\n'
    + '    }\n'
    + '  },\n'
    + '});\n';
  if (existing !== undefined && existing !== expected) {
    const description = existing.includes(OPENCODE_MARKER) ? 'modified' : 'unmanaged';
    throw new KiokukoError('CONFLICT', `The OpenCode Enno-Oduno plugin path contains a ${description} file`);
  }
  if (mode === 'off') {
    return existing === undefined
      ? { content: undefined, action: 'unchanged' }
      : { content: undefined, action: 'deleted' };
  }
  return existing === undefined
    ? { content: expected, action: 'created' }
    : { content: existing, action: 'unchanged' };
}
