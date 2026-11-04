import { stripVTControlCharacters } from 'node:util'
import { z } from 'zod'
import { hasExplicitTestCases, parseNodeTapSummary, type TapSummary } from '../node-tap-summary.js'

type TestRunner = 'node' | 'vitest'
interface Failure { name: string; message?: string; file?: string; line?: number; column?: number }
interface Report { summary: TapSummary; failures: Failure[]; failuresOmitted: number; hasCases: boolean; failed: boolean }
const MAX_FAILURES = 8
const LOG_CHARS = 24_000
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

function location(text: string): Pick<Failure, 'file' | 'line' | 'column'> {
  const match = /^(.+):(\d+):(\d+)$/u.exec(text)
  return match ? { file: match[1]!, line: Number(match[2]), column: Number(match[3]) } : {}
}

function tapField(block: string, field: string): string | undefined {
  const value = new RegExp(`^ +${field}: (.+)$`, 'mu').exec(block)?.[1]
  return value?.replace(/^'(.*)'$/u, '$1').replace(/''/gu, "'")
}

function nodeReport(output: string): Report | undefined {
  const summary = parseNodeTapSummary(output, true)
  if (!summary) return
  const failures: Failure[] = []
  let failureCount = 0
  for (const match of output.matchAll(/^( *)not ok \d+ - (.+)\n(?:\1  ---\r?\n([\s\S]*?)^\1  \.\.\.$)?/gmu)) {
    const name = match[2]!.trimEnd(), detail = match[3] ?? ''
    if (/ # (?:TODO|SKIP)\b/iu.test(name) || tapField(detail, 'failureType') === 'subtestsFailed') continue
    failureCount++
    if (failures.length >= MAX_FAILURES) continue
    const where = location(tapField(detail, 'location') ?? '')
    const message = tapField(detail, 'error')
    failures.push({ name, ...where, ...(message && message !== '|-' && message !== '>' ? { message } : {}) })
  }
  return { summary, failures, failuresOmitted: Math.max(0, failureCount - failures.length),
    hasCases: hasExplicitTestCases(output), failed: summary.fail > 0 || summary.cancelled > 0 }
}

function parseVitest(output: string): z.infer<typeof vitestReport> | undefined {
  let report: z.infer<typeof vitestReport> | undefined
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.includes('"numTotalTests"')) continue
    let value: unknown
    try { value = JSON.parse(trimmed) } catch { continue }
    const parsed = vitestReport.safeParse(value)
    if (!parsed.success) continue
    if (report) return undefined
    report = parsed.data
  }
  return report
}

function vitestResult(output: string): Report | undefined {
  const report = parseVitest(output)
  if (!report) return
  const { numTotalTests: tests, numPassedTests: pass, numFailedTests: fail, numPendingTests: skipped, numTodoTests: todo } = report
  if (tests !== pass + fail + skipped + todo) return
  const failures: Failure[] = []
  let failureCount = 0, observedCases = 0, observedFailures = 0
  for (const file of report.testResults) {
    observedCases += file.assertionResults.length
    let failedAssertions = 0
    for (const item of file.assertionResults) {
      if (item.status !== 'failed') continue
      failedAssertions++
      failureCount++
      if (failures.length < MAX_FAILURES) {
        const message = item.failureMessages[0]
        failures.push({ name: item.fullName, file: file.name, ...item.location, ...(message ? { message } : {}) })
      }
    }
    observedFailures += failedAssertions
    if (file.status !== 'failed' || failedAssertions) continue
    failureCount++
    if (failures.length < MAX_FAILURES) failures.push({ name: file.name, file: file.name, message: file.message })
  }
  if (observedCases !== tests || observedFailures !== fail) return
  return { summary: { tests, pass, fail, skipped, todo, cancelled: 0 }, failures,
    failuresOmitted: failureCount - failures.length, hasCases: tests > 0, failed: !report.success || failureCount > 0 }
}

const shorten = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text
const limitLog = (text: string) => text.length <= LOG_CHARS ? text
  : `${text.slice(0, LOG_CHARS / 2)}\n[log shortened]\n${text.slice(-LOG_CHARS / 2)}`

/** Project runner evidence without changing the process receipt or rerunning the command. */
export function reportTestResult(runner: TestRunner, value: unknown) {
  const result = value as {
    code: number | null; signal?: string | null; stdout: string; stderr: string
    timedOut?: boolean; stdoutTruncated?: boolean; stderrTruncated?: boolean
    receipt?: { cancelled?: boolean; timedOut?: boolean; outputComplete?: boolean; displayedBytes?: number; observedBytes?: number }
  }
  const { code, stdout, stderr, receipt } = result
  const interrupted = result.signal || result.timedOut || receipt?.cancelled || receipt?.timedOut
  const incomplete = result.stdoutTruncated || receipt?.outputComplete === false
    || (receipt?.displayedBytes !== undefined && receipt.observedBytes !== undefined && receipt.displayedBytes < receipt.observedBytes)
  const output = stripVTControlCharacters(stdout).replace(/\r\n/gu, '\n')
  const report = interrupted || incomplete ? undefined : runner === 'node' ? nodeReport(output) : vitestResult(output)
  const testStatus = interrupted || !Number.isInteger(code) ? 'unknown'
    : code !== 0 || report?.failed ? 'failed'
    : report?.hasCases && report.summary.pass > 0 ? 'passed' : 'unknown'
  const failures = (report?.failures ?? []).map(({ name, file, message, ...position }) => ({
    name: shorten(name, 240), ...(file ? { file: shorten(file, 512) } : {}),
    ...(message ? { message: shorten(message, 600) } : {}), ...position,
  }))
  const diagnostic = testStatus !== 'passed' && failures.length === 0
    ? stripVTControlCharacters(stderr.trim() || stdout.trim()).slice(-1200) : ''
  return { ...result, runner, testStatus, summary: report?.summary ?? null, failures,
    failuresOmitted: report?.failuresOmitted ?? 0,
    ...(diagnostic ? { diagnostic } : {}),
    logsTruncated: !!(incomplete || result.stderrTruncated || stdout.length > LOG_CHARS || stderr.length > LOG_CHARS),
    stdout: limitLog(stdout), stderr: limitLog(stderr) }
}
