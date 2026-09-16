import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join, relative } from 'node:path'
import type { DshUserQuestions } from '../user-interaction.js'
import { LispError, fail, type LispOwner } from './contracts.js'

export type LispCiRequest =
  | { kind: 'list-runs'; limit: number }
  | { kind: 'failed-log'; runId: string }
  | { kind: 'verify'; target: keyof typeof VERIFIERS }

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

async function approveVerifier(questions: DshUserQuestions | undefined, owner: LispOwner, target: string, command: typeof VERIFIERS[keyof typeof VERIFIERS], signal: AbortSignal): Promise<boolean> {
  if (!questions || signal.aborted) return false
  const id = `lisp-ci-${randomUUID()}`
  const label = 'この検証を実行'
  try {
    const answer = await questions.ask({ agent: { id: owner.agentId }, signal, questions: [{
      id, header: 'Lisp · 検証実行の確認', question: `${target} を実行しますか？`,
      detail: `実行: ${command.file} ${command.args.join(' ')}\n作業ディレクトリ: ${owner.root}\nタイムアウト: ${command.timeoutMs} ms\nテスト・ビルド成果物が作業ディレクトリに作成される場合があります。拒否・取消・無回答では実行しません。`,
      options: [{ label: '実行しない' }, { label }], intent: { kind: 'plan-review', approve: label },
    }] })
    return !signal.aborted && answer.answers.length === 1 && answer.answers[0]?.id === id && !answer.answers[0].custom && answer.answers[0].selected.length === 1 && answer.answers[0].selected[0] === label
  } catch { return false }
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
    const command = VERIFIERS[request.target]
    if (!await approveVerifier(questions, owner, request.target, command, signal)) return { target: request.target, state: 'NOT_APPLIED' }
    const result = await runner(command.file, [...command.args], { cwd: owner.root, timeoutMs: command.timeoutMs, signal })
    return { target: request.target, state: result.code === 0 ? 'SUCCEEDED' : 'FAILED', ...result }
  }
}
