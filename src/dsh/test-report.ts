import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { hasExplicitTestCases, parseNodeTapSummary, type TapSummary } from './node-tap-summary.js'
import { parseVitestReport } from './vitest-summary.js'

type TestRunner = 'node' | 'vitest'
interface SourceLocation { file: string; line: number; column: number }
interface Failure extends Partial<SourceLocation> { name: string; message?: string; assertionLocation?: SourceLocation }
interface Report { summary: TapSummary; failures: Failure[]; failuresOmitted: number; hasCases: boolean; failed: boolean }
const MAX_FAILURES = 8
const LOG_CHARS = 24_000

function location(text: string): SourceLocation | undefined {
  const match = /^(.+):(\d+):(\d+)$/u.exec(text)
  return match ? { file: match[1]!, line: Number(match[2]), column: Number(match[3]) } : undefined
}

function vitestAssertionLocation(message: string): SourceLocation | undefined {
  if (!/^AssertionError(?=[:\s]|$)/u.test(message)) return
  for (const [, frame] of message.matchAll(/^[ \t]+at (?:async )?(.+)$/gmu)) {
    if (!frame) continue
    const source = isAbsolute(frame) || frame.startsWith('file://') ? frame : / \((.+)\)$/u.exec(frame)?.[1]
    const position = source && location(source)
    if (!position || !Number.isSafeInteger(position.line) || position.line < 1 ||
      !Number.isSafeInteger(position.column) || position.column < 1) continue
    let { file } = position
    if (file.startsWith('file://')) {
      try { file = fileURLToPath(file) } catch { continue }
    }
    if (isAbsolute(file) && !file.split(/[\\/]/u).includes('node_modules')) return { ...position, file }
  }
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
  let failed = summary.fail > 0 || summary.cancelled > 0
  for (const match of output.matchAll(/^( *)not ok \d+ - (.+)\n(?:\1  ---\r?\n([\s\S]*?)^\1  \.\.\.$)?/gmu)) {
    const name = match[2]!.trimEnd(), detail = match[3] ?? ''
    if (/ # (?:TODO|SKIP)\b/iu.test(name)) continue
    failed = true
    if (tapField(detail, 'failureType') === 'subtestsFailed') continue
    failureCount++
    if (failures.length >= MAX_FAILURES) continue
    const where = location(tapField(detail, 'location') ?? '')
    const message = tapField(detail, 'error')
    failures.push({ name, ...where, ...(message && message !== '|-' && message !== '>' ? { message } : {}) })
  }
  return { summary, failures, failuresOmitted: Math.max(0, failureCount - failures.length),
    hasCases: hasExplicitTestCases(output), failed }
}

function vitestResult(output: string): Report | undefined {
  const report = parseVitestReport(output)
  if (!report) return
  const failures: Failure[] = []
  let failureCount = 0
  for (const file of report.testResults) {
    let failedAssertions = 0
    for (const item of file.assertionResults) {
      if (item.status !== 'failed') continue
      failedAssertions++
      failureCount++
      if (failures.length < MAX_FAILURES) {
        const message = item.failureMessages[0]
        const assertionLocation = message && vitestAssertionLocation(message)
        failures.push({ name: item.fullName, file: file.name, ...item.location,
          ...(message ? { message } : {}), ...(assertionLocation ? { assertionLocation } : {}) })
      }
    }
    if (file.status !== 'failed' || failedAssertions) continue
    failureCount++
    if (failures.length < MAX_FAILURES) failures.push({ name: file.name, file: file.name, message: file.message })
  }
  return { summary: report.summary, failures, failuresOmitted: failureCount - failures.length,
    hasCases: report.summary.tests > 0, failed: report.failed }
}

const shorten = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text
function limitLog(text: string, limit = LOG_CHARS): string {
  if (text.length <= limit) return text
  const marker = '\n[log shortened]\n'
  const head = Math.floor((limit - marker.length) / 2)
  const tail = limit - marker.length - head
  return text.slice(0, head) + marker + text.slice(-tail)
}

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
    ? limitLog(stripVTControlCharacters(stderr.trim() || stdout.trim()), 1200) : ''
  return { ...result, runner, testStatus, summary: report?.summary ?? null, failures,
    failuresOmitted: report?.failuresOmitted ?? 0, ...(diagnostic ? { diagnostic } : {}),
    logsTruncated: !!(incomplete || result.stderrTruncated || stdout.length > LOG_CHARS || stderr.length > LOG_CHARS),
    stdout: limitLog(stdout), stderr: limitLog(stderr) }
}
