export interface TapSummary { tests: number; pass: number; fail: number; cancelled: number; skipped: number; todo: number }
const TAP_KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const

/** Accept only a complete final Node TAP trailer, never a previewed progress line. */
export function parseNodeTapSummary(output: string): TapSummary | undefined {
  if (Buffer.byteLength(output) > 64_000 || /(?:truncated|Output capped|middle pruned)/iu.test(output)) return undefined
  const values = new Map<string, number>()
  for (const match of output.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gmu)) {
    values.set(match[1]!, Number(match[2]))
  }
  if (TAP_KEYS.some(key => !Number.isSafeInteger(values.get(key))) || !values.get('tests')) return undefined
  const summary = Object.fromEntries(TAP_KEYS.map(key => [key, values.get(key)!])) as unknown as TapSummary
  return summary.tests === summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo ? summary : undefined
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
