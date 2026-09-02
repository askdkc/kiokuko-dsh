import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(entryPath);
  }
  return files.sort();
}

function packageMarkdownPaths(): Promise<string[]> {
  return Promise.all([
    markdownFiles(path.join(repositoryRoot, 'docs')),
    markdownFiles(path.join(repositoryRoot, 'skills')),
    markdownFiles(path.join(repositoryRoot, 'templates')),
    Promise.resolve(['README.md', 'README.ja.md', 'README.zh-CN.md', 'README.ko.md', 'PERMISSIONS.md']
      .map((name) => path.join(repositoryRoot, name))),
  ]).then((groups) => groups.flat().sort());
}

interface BashFence {
  readonly startLine: number;
  readonly lines: readonly string[];
}

function bashFences(content: string): BashFence[] {
  const lines = content.split(/\r?\n/u);
  const fences: BashFence[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^```(?:bash|sh|shell)\s*$/u.exec(lines[index] ?? '');
    if (opening === null) continue;
    const body: string[] = [];
    const startLine = index + 1;
    index += 1;
    for (; index < lines.length && lines[index] !== '```'; index += 1) body.push(lines[index] ?? '');
    fences.push({ startLine, lines: body });
  }
  return fences;
}

function commandLines(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

test('package Markdown exposes only DSH executable commands', async () => {
  const files = await packageMarkdownPaths();
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const lines = content.split(/\r?\n/u);
    for (const fence of bashFences(content)) {
      const commands = commandLines(fence.lines);
      for (const command of commands) {
        assert.doesNotMatch(command, /^(?:if\s+!\s+)?kiokuko(?:\s|$)/u, `${path.relative(repositoryRoot, file)}:${fence.startLine}`);
      }
      if (commands.some((command) => /\bpnpm\s+dsh\b/u.test(command))) {
        const context = lines.slice(Math.max(0, fence.startLine - 16), fence.startLine).join('\n');
        assert.match(context, /DeepSeek Harness.{0,8}checkout|DSH checkout/u, `${path.relative(repositoryRoot, file)}:${fence.startLine}`);
      }
      for (const command of commands.filter((line) => /\bdsh\s+plugin\b.*\badd\s+\/absolute\/path\/to\//u.test(line))) {
        assert.match(command, /^dsh\s+plugin\b/u, `${path.relative(repositoryRoot, file)}:${fence.startLine}`);
        assert.doesNotMatch(command, /\bpnpm\s+dsh\b/u, `${path.relative(repositoryRoot, file)}:${fence.startLine}`);
      }
    }
    assert.doesNotMatch(content, /\]\([^)]*(?:cli-contract|agent-file|client-compatibility)\.md(?:#[^)]*)?\)/u, path.relative(repositoryRoot, file));
  }
});

test('generic CLI documentation files are removed from the DSH package surface', () => {
  for (const name of ['docs/cli-contract.md', 'docs/agent-file.md', 'docs/client-compatibility.md']) {
    assert.equal(false, existsSync(path.join(repositoryRoot, name)), name);
  }
});

test('all maintained README command columns use the same DSH launcher contract', async () => {
  const files = ['README.md', 'README.ja.md', 'README.zh-CN.md', 'README.ko.md'];
  const requiredCommands = [
    'dsh plugin --profile web add kiokuko-dsh',
    'dsh --profile web --dump-config',
    'dsh plugin --profile web add /absolute/path/to/kiokuko-dsh',
    'dsh web',
    'dsh plugin --profile web remove kiokuko-dsh',
  ];
  for (const name of files) {
    const content = await readFile(path.join(repositoryRoot, name), 'utf8');
    for (const command of requiredCommands) assert.match(content, new RegExp(command.replaceAll('/', '\\/'), 'u'), name);
  }
});
