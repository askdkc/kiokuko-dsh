/** Historical receipts may retain optional filtered/measured metadata. */
export interface TapSummary { tests: number; pass: number; fail: number; cancelled: number; skipped: number; todo: number; filtered?:number; measured?:number }
const TAP_KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const

/** Accept only a complete final Node TAP trailer, never a previewed progress line. */
export function parseNodeTapSummary(output: string, completeHostOutput = false): TapSummary | undefined {
  if (!completeHostOutput && (Buffer.byteLength(output) > 64_000 || /(?:truncated|Output capped|middle pruned)/iu.test(output))) return undefined
  const values = new Map<string, number>()
  for (const match of output.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gmu)) {
    values.set(match[1]!, Number(match[2]))
  }
  if (TAP_KEYS.some(key => !Number.isSafeInteger(values.get(key))) || !values.get('tests')) return undefined
  const summary = Object.fromEntries(TAP_KEYS.map(key => [key, values.get(key)!])) as unknown as TapSummary
  return summary.tests === summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo ? summary : undefined
}

export function parseTestSummary(output: string, completeHostOutput = false): TapSummary | undefined {
  return parseNodeTapSummary(output, completeHostOutput)
}

/** Vitest's TAP reporter declares a plan at every level and closes suites with braces. */
export function parseVitestTapSummary(output: string): TapSummary | undefined {
  const lines = output.trimEnd().split(/\r?\n/u)
  const start = lines.indexOf('TAP version 13')
  if (start < 0) return
  const summary: TapSummary = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 }
  const suites: { planned: number; seen: number }[] = []
  let needsPlan = true
  for (const line of lines.slice(start + 1)) {
    if (needsPlan) {
      const plan = /^( *)1\.\.([1-9]\d*)$/u.exec(line)
      const planned = Number(plan?.[2])
      if (plan?.[1]?.length !== suites.length * 4 || !Number.isSafeInteger(planned)) return
      suites.push({ planned, seen: 0 })
      needsPlan = false
      continue
    }
    const suite = suites.at(-1)!
    const indent = ' '.repeat((suites.length - 1) * 4)
    if (suites.length > 1 && line === indent.slice(4) + '}') {
      if (suite.seen !== suite.planned) return
      suites.pop()
      continue
    }
    if (line.startsWith(indent + '    # ')) continue
    const result = /^( *)(not ok|ok) (\d+) - (.+)$/u.exec(line)
    if (result?.[1]?.length !== indent.length || ++suite.seen > suite.planned || Number(result[3]) !== suite.seen) return
    const name = result[4]!
    const status = / # (SKIP|TODO)(?: \{)?$/u.exec(name)?.[1]
    if (name.endsWith(' {')) {
      if (status || result[2] !== 'ok') return
      needsPlan = true
    } else {
      if (suites.length === 1) return // A file without test cases cannot establish coverage.
      summary.tests++
      summary[status === 'SKIP' ? 'skipped' : status === 'TODO' ? 'todo' : result[2] === 'ok' ? 'pass' : 'fail']++
    }
  }
  const root = suites[0]
  if (!needsPlan && suites.length === 1 && root!.seen === root!.planned && summary.tests > 0) return summary
}

/** Node counts an assertion-free test file as a passing implicit file test. */
export function hasExplicitTestCases(output: string): boolean {
  return [...output.matchAll(/^\s*# Subtest: (.+)\s*$/gmu)]
    .some(match => !/(?:^|[/\\])[^/\\]*\.(?:ts|[cm]?js)$/u.test(match[1]!.trim()))
}

export function selectedNodeTestCommand(command: string): boolean {
  if (/[;&|><`$()\\'"\n\r]/u.test(command)) return false
  const args = command.trim().split(/\s+/u)
  if (!/(?:^|[/\\])node(?:\.exe)?$/iu.test(args[0] ?? '')) return false
  if (!args.includes('--test') || !args.includes('--test-reporter=tap')
    || args.some(arg => ['--eval', '-e', '--print', '-p'].includes(arg))) return false
  return args.some(arg => /\.(?:ts|[cm]?js)$/u.test(arg)
    && !pathIsUnsafe(arg))
}

function pathIsUnsafe(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || value.split(/[\\/]/u).includes('..')
}
