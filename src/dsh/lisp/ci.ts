import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join, relative } from 'node:path'
import type { DshUserQuestions } from '../user-interaction.js'
import { LispError, fail, digest, type LispOwner } from './contracts.js'
import { checkedBytes, snapshot } from './files.js'
import { confirm } from './approval.js'

export type LispCiRequest =
  | { kind: 'list-runs'; limit: number }
  | { kind: 'failed-log'; runId: string }
  | { kind: 'verify'; target: keyof typeof VERIFIERS; script?: string | undefined }

interface CommandResult { code: number; stdout: string; stderr: string }
type CommandRunner = (file: string, args: string[], options: { cwd: string; timeoutMs: number; signal: AbortSignal }) => Promise<CommandResult>

const OUTPUT_LIMIT = 1024 * 1024
const VERIFIERS = {
  typecheck: { file: 'npm', args: ['run', 'typecheck'], timeoutMs: 120_000 },
  lisp: { file: 'npm', args: ['run', 'test:lisp'], timeoutMs: 300_000 },
  test: { file: 'npm', args: ['test'], timeoutMs: 300_000 },
  build: { file: 'npm', args: ['run', 'build'], timeoutMs: 180_000 },
  package: { file: 'npm', args: ['run', 'pack:check'], timeoutMs: 180_000 },
  vendor: { file: 'npm', args: ['run', 'verify:lisp:vendor'], timeoutMs: 60_000 },
} as const

async function trustedExecutable(name: 'gh' | 'npm', repositoryRoot: string): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      const executable = await realpath(join(directory, name))
      const inside = relative(repositoryRoot, executable)
      if (inside === '' || (!inside.startsWith('..') && inside !== '..')) continue
      await access(executable, constants.X_OK)
      return executable
    } catch { /* try the next fixed PATH entry */ }
  }
  throw new LispError('HOST_EXECUTABLE_MISSING', `${name} が信頼できるホスト PATH に見つかりません。`)
}

const runCommand: CommandRunner = async (file, args, options) => {
  if (file !== 'gh' && file !== 'npm') fail('HOST_COMMAND_REFUSED', '許可されていないホストコマンドです。')
  const executable = await trustedExecutable(file, options.cwd)
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: OUTPUT_LIMIT, signal: options.signal, env: process.env }, (error, stdout, stderr) => {
      if (options.signal.aborted) return reject(new LispError('CANCELLED', 'ホスト処理を取り消しました。'))
      if (error && (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new LispError('OUTPUT_LIMIT', 'ホスト処理の出力が上限を超えました。'))
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
      resolve({ code, stdout: String(stdout).slice(-OUTPUT_LIMIT), stderr: String(stderr).slice(-OUTPUT_LIMIT) })
    })
  })
}

async function scriptsFor(owner: LispOwner): Promise<Record<string, string>> {
  const file = await snapshot(owner.root, 'package.json', [])
  if (!file.exists) return {}
  if (file.size! > 1024 * 1024) throw new LispError('PACKAGE_INVALID', 'package.json が大きすぎます。', 'package.json を確認してください。')
  let parsed: unknown
  try { parsed = JSON.parse((await checkedBytes(file)).toString('utf8')) }
  catch { throw new LispError('PACKAGE_INVALID', 'package.json を読み取れません。', 'package.json のJSONを修正してください。') }
  const scripts = parsed && typeof parsed === 'object' && 'scripts' in parsed ? parsed.scripts : undefined
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {}
  return Object.fromEntries(Object.entries(scripts).filter(([, value]) => typeof value === 'string' && value.trim()))
}
const scriptFor = (target: keyof typeof VERIFIERS, scripts: Record<string, string>, selected?: string) =>
  selected ?? (target === 'test' ? 'test' : target === 'typecheck' && !Object.hasOwn(scripts, 'typecheck') && Object.hasOwn(scripts, 'check') ? 'check' : VERIFIERS[target].args[1]!)

/** Discovery is read-only; missing scripts never need a model-driven trial run. */
export async function describeVerifiers(owner: LispOwner): Promise<unknown> {
  const scripts = await scriptsFor(owner)
  return Object.fromEntries(Object.keys(VERIFIERS).map(key => {
    const target = key as keyof typeof VERIFIERS, script = scriptFor(target, scripts)
    return [target, { script, available: Object.hasOwn(scripts, script), ...(target === 'test' ? { focused: Object.keys(scripts).filter(key => /^test(?::[A-Za-z0-9._-]+)*$/u.test(key)) } : {}) }]
  }))
}

/** Host-only CI adapter. Credentials remain in the host child process and are never copied into the Lisp worker. */
export function createLispCiAdapter(questions?: DshUserQuestions, runner: CommandRunner = runCommand) {
  return async (owner: LispOwner, request: LispCiRequest, signal: AbortSignal): Promise<unknown> => {
    if (request.kind === 'list-runs') {
      const result = await runner('gh', ['run', 'list', '--limit', String(request.limit), '--json', 'databaseId,name,status,conclusion,headBranch,headSha,url'], { cwd: owner.root, timeoutMs: 30_000, signal })
      if (result.code !== 0) fail('CI_COMMAND_FAILED', result.stderr || 'GitHub CI の一覧を取得できませんでした。')
      try { return { source: 'github', repositoryRoot: owner.root, runs: JSON.parse(result.stdout) } }
      catch { fail('CI_RESPONSE_INVALID', 'GitHub CI の応答を解釈できません。') }
    }
    if (request.kind === 'failed-log') {
      const result = await runner('gh', ['run', 'view', request.runId, '--log-failed'], { cwd: owner.root, timeoutMs: 60_000, signal })
      if (result.code !== 0) fail('CI_COMMAND_FAILED', result.stderr || 'GitHub CI の失敗ログを取得できませんでした。')
      return { source: 'github', repositoryRoot: owner.root, runId: request.runId, log: result.stdout }
    }
    const scripts = await scriptsFor(owner)
    if (request.script !== undefined && (request.target !== 'test' || !/^test(?::[A-Za-z0-9._-]+)*$/u.test(request.script))) {
      return { target: request.target, state: 'NOT_APPLIED', code: 'INVALID_TEST_SCRIPT', reason: 'invalid_input', message: 'script は test 対象の test または test:* のみ指定できます。' }
    }
    const script = scriptFor(request.target, scripts, request.script)
    if (!Object.hasOwn(scripts, script)) return { target: request.target, state: 'NOT_APPLIED', code: 'SCRIPT_MISSING', reason: 'script_missing', script,
      message: `package.json に ${script} がありません。実行・確認はしていません。`, availableScripts: Object.keys(scripts) }
    const command = { ...VERIFIERS[request.target], args: script === 'test' ? ['test'] : ['run', script] }
    const approval = await confirm(questions, owner.agentId, {
      id: `lisp-ci-${randomUUID()}`, header: 'Lisp · 検証実行の確認', question: `${script} を実行しますか？`,
      detail: `実行: ${command.file} ${command.args.join(' ')}\nスクリプト: ${scripts[script]}\n作業ディレクトリ: ${owner.root}\nタイムアウト: ${command.timeoutMs} ms\nテスト・ビルド成果物が作成される場合があります。`,
      options: [{ label: '実行しない' }, { label: 'この検証を実行' }], intent: { kind: 'plan-review', approve: 'この検証を実行' },
    }, signal)
    if (!approval.approved) return { target: request.target, script, state: 'NOT_APPLIED', reason: approval.reason }
    if (digest(scripts) !== digest(await scriptsFor(owner))) return { target: request.target, script, state: 'NOT_APPLIED', code: 'TARGET_CHANGED', reason: 'scripts_changed', message: '確認中にnpmスクリプトが変わりました。実行していません。' }
    const result = await runner(command.file, [...command.args], { cwd: owner.root, timeoutMs: command.timeoutMs, signal })
    return { target: request.target, script, state: result.code === 0 ? 'SUCCEEDED' : 'FAILED', ...result }
  }
}
