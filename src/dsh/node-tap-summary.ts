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

/** Cargo emits one terminal summary for each harness, including doc tests. */
export function parseCargoSummary(output: string): TapSummary | undefined {
  const starts = [...output.matchAll(/^running (\d+) tests?\s*$/gmu)]
  const ends = [...output.matchAll(/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in .+$/gmu)]
  if (!starts.length || starts.length !== ends.length) return undefined
  const total: TapSummary = {tests:0,pass:0,fail:0,cancelled:0,skipped:0,todo:0}
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i]!, start = starts[i]!
    const pass = Number(end[2]), fail = Number(end[3]), skipped = Number(end[4]) + Number(end[5])
    if (start.index! >= end.index! || (i > 0 && start.index! <= ends[i - 1]!.index!)
      || Number(start[1]) !== pass + fail + skipped || end[1] === 'FAILED' && fail === 0) return undefined
    total.tests += Number(start[1]); total.pass += pass; total.fail += fail; total.skipped += skipped
    total.filtered=(total.filtered??0)+Number(end[6]);total.measured=(total.measured??0)+Number(end[5])
  }
  return total.tests > 0 ? total : undefined
}

export function parseTestSummary(output: string, completeHostOutput = false): TapSummary | undefined {
  return parseNodeTapSummary(output, completeHostOutput) ?? parseCargoSummary(output)
}

export function selectedNodeTestCommand(command: string): boolean {
  if (/[;&|><`$()\\'"\n\r]/u.test(command)) return false
  const args = command.trim().split(/\s+/u)
  if (!/(?:^|[/\\])node(?:\.exe)?$/iu.test(args[0] ?? '')) return false
  if (!args.includes('--test') || !args.includes('--test-reporter=tap')
    || args.some(arg => ['--eval', '-e', '--print', '-p'].includes(arg))) return false
  return args.some(arg => /\.test\.(?:ts|js|mjs)$/u.test(arg)
    && !pathIsUnsafe(arg))
}

function pathIsUnsafe(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || value.split(/[\\/]/u).includes('..')
}
