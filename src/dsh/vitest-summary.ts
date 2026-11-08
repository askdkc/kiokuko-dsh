import { z } from 'zod'
import type { TapSummary } from './node-tap-summary.js'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const vitestReport = z.object({
  numTotalTests: count, numPassedTests: count, numFailedTests: count,
  numPendingTests: count, numTodoTests: count, success: z.boolean(),
  testResults: z.array(z.object({
    name: z.string(), status: z.enum(['passed', 'failed']), message: z.string(),
    assertionResults: z.array(z.object({
      fullName: z.string(), status: z.string(), failureMessages: z.array(z.string()),
      location: z.object({ line: count, column: count }).optional(),
    })),
  })),
})

/** Check the reporter's totals against its individual assertions before using them. */
export function parseVitestReport(output: string) {
  let report: z.infer<typeof vitestReport> | undefined
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.includes('"numTotalTests"')) continue
    let value: unknown
    try { value = JSON.parse(trimmed) } catch { continue }
    const parsed = vitestReport.safeParse(value)
    if (!parsed.success) continue
    if (report) return
    report = parsed.data
  }
  if (!report) return
  const { numTotalTests: tests, numPassedTests: pass, numFailedTests: fail,
    numPendingTests: skipped, numTodoTests: todo, testResults } = report
  if (tests !== pass + fail + skipped + todo) return
  let observedCases = 0, observedFailures = 0
  for (const file of testResults) {
    observedCases += file.assertionResults.length
    observedFailures += file.assertionResults.filter(item => item.status === 'failed').length
  }
  if (observedCases !== tests || observedFailures !== fail) return
  const summary: TapSummary = { tests, pass, fail, skipped, todo, cancelled: 0 }
  return { testResults, summary, failed: !report.success || fail > 0 || testResults.some(file => file.status === 'failed') }
}
