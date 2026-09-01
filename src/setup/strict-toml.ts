import { KiokukoError } from '../errors.js';

export interface TomlDefinition {
  path: readonly string[];
  offset: number;
}

export interface TomlStatement {
  startOffset: number;
  endOffset: number;
  definitions: readonly TomlDefinition[];
}

export interface StrictTomlDocument {
  definitions: readonly TomlDefinition[];
  statements: readonly TomlStatement[];
}

type TableKind = 'root' | 'implicit' | 'explicit' | 'dotted' | 'inline';

interface TableNode {
  kind: TableKind;
  children: Map<string, SemanticNode>;
}

interface ArrayTableNode {
  kind: 'array-table';
  elements: TableNode[];
}

interface ValueNode {
  kind: 'value';
}

type SemanticNode = TableNode | ArrayTableNode | ValueNode;

const VALUE_NODE: ValueNode = { kind: 'value' };

function invalidToml(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Codex config is not valid TOML');
}

function isTomlControl(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (codePoint <= 0x08) || (codePoint >= 0x0a && codePoint <= 0x1f) || codePoint === 0x7f;
}

function trimStatement(source: string): { text: string; leading: number } {
  const leading = /^[ \t\r]*/u.exec(source)![0].length;
  const trailing = /[ \t\r]*$/u.exec(source)![0].length;
  return {
    text: source.slice(leading, source.length - trailing),
    leading,
  };
}

function logicalStatements(source: string): Array<{
  text: string;
  offset: number;
  startOffset: number;
  endOffset: number;
}> {
  const result: Array<{
    text: string;
    offset: number;
    startOffset: number;
    endOffset: number;
  }> = [];
  let start = 0;
  let quote: '"' | "'" | '"""' | "'''" | undefined;
  let escaped = false;
  let comment = false;
  let square = 0;
  let curly = 0;
  for (let index = 0; index <= source.length; index += 1) {
    const character = source[index] ?? '\n';
    if (comment) {
      if (character === '\n') comment = false;
      else {
        if (character === '\r') {
          if (source[index + 1] !== '\n') invalidToml();
        } else if (character !== '\t' && isTomlControl(character)) invalidToml();
        continue;
      }
    } else if (quote !== undefined) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === '\\') escaped = true;
      else if ((quote === '"""' || quote === "'''") && source.startsWith(quote, index)) {
        index += 2;
        quote = undefined;
      } else if ((quote === '"' || quote === "'") && character === quote) {
        quote = undefined;
      } else if ((quote === '"' || quote === "'") && character === '\n') {
        invalidToml();
      }
      continue;
    } else if (source.startsWith('"""', index) || source.startsWith("'''", index)) {
      quote = source.slice(index, index + 3) as '"""' | "'''";
      index += 2;
      continue;
    } else if (character === '"' || character === "'") {
      quote = character;
      continue;
    } else if (character === '#') {
      comment = true;
      continue;
    } else if (character === '[') square += 1;
    else if (character === ']') square -= 1;
    else if (character === '{') curly += 1;
    else if (character === '}') curly -= 1;

    if (square < 0 || curly < 0) invalidToml();
    if (character === '\n' && square === 0 && curly === 0) {
      const raw = source.slice(start, index);
      const trimmed = trimStatement(raw);
      const text = trimmed.text;
      if (text.length > 0 && !text.startsWith('#')) {
        result.push({
          text,
          offset: start + trimmed.leading,
          startOffset: start,
          endOffset: Math.min(index + 1, source.length),
        });
      }
      start = index + 1;
    }
  }
  if (quote !== undefined || square !== 0 || curly !== 0) invalidToml();
  return result;
}

function withoutComments(source: string): string {
  let output = '';
  let quote: '"' | "'" | '"""' | "'''" | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote !== undefined) {
      output += character;
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === '\\') escaped = true;
      else if ((quote === '"""' || quote === "'''") && source.startsWith(quote, index)) {
        output += source.slice(index + 1, index + 3);
        index += 2;
        quote = undefined;
      } else if ((quote === '"' || quote === "'") && character === quote) quote = undefined;
    } else if (source.startsWith('"""', index) || source.startsWith("'''", index)) {
      quote = source.slice(index, index + 3) as '"""' | "'''";
      output += quote;
      index += 2;
    } else if (character === '"' || character === "'") {
      quote = character;
      output += character;
    } else if (character === '#') {
      while (index + 1 < source.length && source[index + 1] !== '\n') index += 1;
    } else {
      output += character;
    }
  }
  return trimStatement(output).text;
}

function consumeQuotedString(source: string, start: number): { end: number; value: string } {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") invalidToml();
  let result = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === quote) return { end: index + 1, value: result };
    if (character === '\n' || character === '\r' || isTomlControl(character)) invalidToml();
    if (quote === "'" || character !== '\\') {
      result += character;
      continue;
    }
    const escape = source[index + 1];
    if (escape === undefined) invalidToml();
    const simpleEscapes: Readonly<Record<string, string>> = {
      b: '\b',
      t: '\t',
      n: '\n',
      f: '\f',
      r: '\r',
      '"': '"',
      '\\': '\\',
    };
    if (Object.hasOwn(simpleEscapes, escape)) {
      result += simpleEscapes[escape]!;
      index += 1;
      continue;
    }
    if (escape !== 'u' && escape !== 'U') invalidToml();
    const digits = escape === 'u' ? 4 : 8;
    const hexadecimal = source.slice(index + 2, index + 2 + digits);
    if (hexadecimal.length !== digits || !/^[0-9A-Fa-f]+$/u.test(hexadecimal)) invalidToml();
    const codePoint = Number.parseInt(hexadecimal, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) invalidToml();
    result += String.fromCodePoint(codePoint);
    index += 1 + digits;
  }
  invalidToml();
}

function keyPath(source: string): string[] {
  const result: string[] = [];
  let index = 0;
  while (index < source.length) {
    while (source[index] === ' ' || source[index] === '\t') index += 1;
    let key: string;
    if (source[index] === '"' || source[index] === "'") {
      const parsed = consumeQuotedString(source, index);
      key = parsed.value;
      index = parsed.end;
    } else {
      const match = /^[A-Za-z0-9_-]+/u.exec(source.slice(index));
      if (match === null) invalidToml();
      key = match[0];
      index += key.length;
    }
    if (key.length === 0) invalidToml();
    result.push(key);
    while (source[index] === ' ' || source[index] === '\t') index += 1;
    if (index === source.length) return result;
    if (source[index] !== '.') invalidToml();
    index += 1;
  }
  invalidToml();
}

function equalsOutsideKeyQuotes(source: string): number {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote !== undefined) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '=') return index;
  }
  return -1;
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
  return day <= monthLengths[month - 1]!;
}

function validTime(hour: number, minute: number, second: number): boolean {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

function validDateTime(value: string): boolean {
  const dateTime = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:(?:[Zz])|([+-])(\d{2}):(\d{2}))?)?$/u.exec(value);
  if (dateTime !== null) {
    if (!validDate(Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3]))) return false;
    if (dateTime[4] === undefined) return true;
    if (!validTime(Number(dateTime[4]), Number(dateTime[5]), Number(dateTime[6]))) return false;
    return dateTime[8] === undefined || (Number(dateTime[8]) <= 23 && Number(dateTime[9]) <= 59);
  }
  const time = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/u.exec(value);
  return time !== null && validTime(Number(time[1]), Number(time[2]), Number(time[3]));
}

function validScalar(value: string): boolean {
  return /^(?:true|false|[+-]?(?:inf|nan))$/u.test(value)
    || /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/u.test(value)
    || /^0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/u.test(value)
    || /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?|[eE][+-]?[0-9](?:_?[0-9])*)$/u.test(value)
    || validDateTime(value);
}

function newTable(kind: TableKind): TableNode {
  return { kind, children: new Map() };
}

function defineDottedKey(table: TableNode, path: readonly string[], node: SemanticNode): void {
  if (path.length === 0) invalidToml();
  let current = table;
  for (const segment of path.slice(0, -1)) {
    const existing = current.children.get(segment);
    if (existing === undefined) {
      const dotted = newTable('dotted');
      current.children.set(segment, dotted);
      current = dotted;
      continue;
    }
    if (existing.kind !== 'dotted') invalidToml();
    current = existing;
  }
  const final = path[path.length - 1]!;
  if (current.children.has(final)) invalidToml();
  current.children.set(final, node);
}

function validateValue(
  source: string,
  basePath: readonly string[],
  offset: number,
  definitions: TomlDefinition[],
): SemanticNode {
  let index = 0;
  const space = (): void => {
    while (
      source[index] === ' '
      || source[index] === '\t'
      || source[index] === '\r'
      || source[index] === '\n'
    ) index += 1;
  };
  const value = (path: readonly string[], recordDefinitions: boolean): SemanticNode => {
    space();
    // Multiline strings are deliberately outside this fail-closed subset. Accepting
    // them requires implementing TOML's quote-run and line-continuation grammar.
    if (source.startsWith('"""', index) || source.startsWith("'''", index)) invalidToml();
    const character = source[index];
    if (character === '"' || character === "'") {
      index = consumeQuotedString(source, index).end;
      return VALUE_NODE;
    }
    if (character === '[') {
      index += 1;
      space();
      if (source[index] === ']') {
        index += 1;
        return VALUE_NODE;
      }
      for (;;) {
        value(path, false);
        space();
        if (source[index] === ']') {
          index += 1;
          return VALUE_NODE;
        }
        if (source[index] !== ',') invalidToml();
        index += 1;
        space();
        if (source[index] === ']') {
          index += 1;
          return VALUE_NODE;
        }
      }
    }
    if (character === '{') {
      if (source.slice(index).includes('\n')) invalidToml();
      const inline = newTable('inline');
      index += 1;
      space();
      if (source[index] === '}') {
        index += 1;
        return inline;
      }
      for (;;) {
        const remainder = source.slice(index);
        const equals = equalsOutsideKeyQuotes(remainder);
        if (equals < 0) invalidToml();
        const nested = keyPath(trimStatement(remainder.slice(0, equals)).text);
        index += equals + 1;
        const fullPath = [...path, ...nested];
        if (recordDefinitions) definitions.push({ path: fullPath, offset });
        const nestedValue = value(fullPath, recordDefinitions);
        defineDottedKey(inline, nested, nestedValue);
        space();
        if (source[index] === '}') {
          index += 1;
          return inline;
        }
        if (source[index] !== ',') invalidToml();
        index += 1;
        space();
        if (source[index] === '}') invalidToml();
      }
    }
    const dateTimeWithSpace = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?/u.exec(source.slice(index));
    const scalar = dateTimeWithSpace ?? /^[^ \t\r\n,}\]]+/u.exec(source.slice(index));
    if (scalar === null || !validScalar(scalar[0])) invalidToml();
    index += scalar[0].length;
    return VALUE_NODE;
  };
  space();
  const result = value(basePath, true);
  space();
  if (index !== source.length) invalidToml();
  return result;
}

function openTable(root: TableNode, path: readonly string[], arrayTable: boolean): TableNode {
  if (path.length === 0) invalidToml();
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const existing = current.children.get(segment);
    if (existing === undefined) {
      const implicit = newTable('implicit');
      current.children.set(segment, implicit);
      current = implicit;
      continue;
    }
    if (existing.kind === 'array-table') {
      const latest = existing.elements.at(-1);
      if (latest === undefined) invalidToml();
      current = latest;
      continue;
    }
    if (existing.kind !== 'implicit' && existing.kind !== 'explicit') invalidToml();
    current = existing;
  }

  const final = path[path.length - 1]!;
  const existing = current.children.get(final);
  if (arrayTable) {
    if (existing === undefined) {
      const element = newTable('explicit');
      current.children.set(final, { kind: 'array-table', elements: [element] });
      return element;
    }
    if (existing.kind !== 'array-table') invalidToml();
    const element = newTable('explicit');
    existing.elements.push(element);
    return element;
  }

  if (existing === undefined) {
    const explicit = newTable('explicit');
    current.children.set(final, explicit);
    return explicit;
  }
  if (existing.kind !== 'implicit') invalidToml();
  existing.kind = 'explicit';
  return existing;
}

/** Validate the complete TOML document and retain statement boundaries for safe rewrites. */
export function parseStrictTomlDocument(source: string): StrictTomlDocument {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\r' && source[index + 1] !== '\n') invalidToml();
  }
  const definitions: TomlDefinition[] = [];
  const statements: TomlStatement[] = [];
  const root = newTable('root');
  let currentTable: string[] = [];
  let currentNode = root;
  for (const raw of logicalStatements(source)) {
    const definitionStart = definitions.length;
    const statement = withoutComments(raw.text);
    if (statement.length === 0) continue;
    const arrayTable = statement.startsWith('[[');
    if (statement.startsWith('[')) {
      if (statement.includes('\n') || statement.includes('\r')) invalidToml();
      const closing = arrayTable ? ']]' : ']';
      if (!statement.endsWith(closing)) invalidToml();
      currentTable = keyPath(trimStatement(
        statement.slice(arrayTable ? 2 : 1, arrayTable ? -2 : -1),
      ).text);
      currentNode = openTable(root, currentTable, arrayTable);
      definitions.push({ path: currentTable, offset: raw.offset });
      statements.push({
        startOffset: raw.startOffset,
        endOffset: raw.endOffset,
        definitions: definitions.slice(definitionStart),
      });
      continue;
    }
    const equals = equalsOutsideKeyQuotes(statement);
    if (equals < 0) invalidToml();
    const rawKey = statement.slice(0, equals);
    if (rawKey.includes('\n') || rawKey.includes('\r')) invalidToml();
    const localPath = keyPath(trimStatement(rawKey).text);
    const fullPath = [...currentTable, ...localPath];
    definitions.push({ path: fullPath, offset: raw.offset });
    const rawValue = trimStatement(statement.slice(equals + 1)).text;
    if (rawValue.length === 0) invalidToml();
    const node = validateValue(rawValue, fullPath, raw.offset + equals + 1, definitions);
    defineDottedKey(currentNode, localPath, node);
    statements.push({
      startOffset: raw.startOffset,
      endOffset: raw.endOffset,
      definitions: definitions.slice(definitionStart),
    });
  }
  return { definitions, statements };
}

/** Validate the complete TOML document and return every semantic table/key definition. */
export function parseStrictTomlDefinitions(source: string): TomlDefinition[] {
  return [...parseStrictTomlDocument(source).definitions];
}
