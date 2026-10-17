import { constants } from 'node:os'

/** Verification-only projection. Unknown text is omitted, never copied into evidence. */
const points = new Set(['skill-enable', 'skill-planning-enable', 'skill-describe-enable', 'skill-workflow-enable', 'skill-workflow-recover', 'skill-policy-enable', 'skill-admission', 'pack-install', 'pack-check'])
const codes = new Set(['EPERM', 'EACCES', 'ENOENT', 'ENOTFOUND', 'ENOTCACHED', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ERESOLVE', 'EINTEGRITY', 'ABORT_ERR', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'COMPILE_FAILED', 'COMPILE_TIMEOUT', 'RUNTIME_MISSING', 'RUNTIME_IDENTITY', 'RECOVERY_REQUIRED', 'SCOPE_CONFLICT', 'CONFLICT', 'TASK_MODE_ACTIVE', 'CODING_CHOICE_PENDING', 'LISP_DISABLED', 'HOST_STOPPED', 'HOST_LOCK', 'CANCELLED', 'OUTPUT_LIMIT', 'STOP_UNCONFIRMED', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_PNPM_META_FETCH_FAIL', 'VALIDATION_ERROR', 'SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_CANTOPEN', 'E401', 'E403', 'E404'])
const codePattern = new RegExp(`\\b(?:${[...codes].join('|')})\\b`, 'gu')
const categories = [
  ['sandbox_denied', /sandbox_apply:\s*Operation not permitted/iu],
  ['permission_denied', /\b(?:EPERM|EACCES)\b/u],
  ['cache_missing', /\bENOTCACHED\b/u],
  ['dns_failure', /\bENOTFOUND\b/u],
  ['dependency_conflict', /\bERESOLVE\b/u],
  ['lisp_preparation_failed', /Lisp の準備に失敗|\bCOMPILE_FAILED\b/u],
  ['recovery_required', /\bRECOVERY_REQUIRED\b|Lisp の起動・復旧が必要/u],
]
const stops = new Set(['completed', 'cancelled', 'interrupted', 'stopped', 'error', 'failed', 'stop', 'tool-calls', 'max-tokens', 'length', 'aborted'])
const kinds = new Set(['success', 'error', 'blocked', 'failed', 'ready'])
const signals = new Set(Object.keys(constants.signals))
const own = (object, key) => object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined
const known = (value, allowed, missing = null) => typeof value === 'string' && allowed.has(value) ? value : missing
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const pointOf = value => known(value, points, 'unknown')

export function reasonSummary(value) {
  const found = new Set(), reported = new Set(), labels = new Set()
  let characters = 0, visited = 0, truncated = false, codeProvided = false
  function visit(item, depth = 0) {
    if (++visited > 128 || depth > 5) { truncated = true; return }
    if (typeof item === 'string') {
      const text = item.length > 32768 ? item.slice(0, 16384) + '\n' + item.slice(-16384) : item
      characters += text.length; truncated ||= item.length > text.length
      if (/^\s*[{[]/u.test(text)) {
        try { visit(JSON.parse(text), depth + 1); return } catch {}
      }
      for (const match of text.matchAll(codePattern)) found.add(match[0])
      for (const [label, pattern] of categories) if (pattern.test(text)) labels.add(label)
      return
    }
    if (!item || typeof item !== 'object') return
    if (Array.isArray(item)) { for (const child of item.slice(0, 16)) visit(child, depth + 1); truncated ||= item.length > 16; return }
    const rawCode = own(item, 'code'); codeProvided ||= rawCode !== undefined
    const code = known(rawCode, codes)
    if (code) { found.add(code); reported.add(code) }
    for (const key of ['text', 'message', 'reason', 'error', 'cause', 'blocker', 'blockers']) visit(own(item, key), depth + 1)
  }
  visit(value)
  return { codeProvided, codes: [...found].sort(), reportedCodes: [...reported].sort(), categories: labels.size ? [...labels].sort() : [value == null ? 'not-provided' : 'unclassified'], text: '[free text omitted]', characters, truncated }
}
function resultSummary(result) {
  const reason = reasonSummary(result)
  return { kind: known(own(result, 'kind'), kinds, own(result, 'ok') === false ? 'error' : own(result, 'ok') === true ? 'success' : 'unknown'), code: reason.reportedCodes[0] ?? null, codeProvided: reason.codeProvided, reason }
}
export function commandDiagnostic({ point, command, result }) {
  return { schema: 'verification-diagnostic-v1', point: pointOf(point), command: known(command, new Set(['enable', 'enable-task', 'recover'])), ...resultSummary(result) }
}
function toolMessage(message) {
  if (own(message, 'role') === 'tool') return message
  const content = own(message, 'content')
  return Array.isArray(content) ? content.findLast(block => own(block, 'type') === 'tool-result') : undefined
}
function summarizeTool(message, source) {
  if (!message) return null
  const content = own(message, 'content'); const values = []
  if (Array.isArray(content)) for (const block of content.slice(0, 8)) {
    const text = own(block, 'text')
    if (own(block, 'type') === 'text' && typeof text === 'string') {
      if (text.length > 32768) values.push(text)
      else { try { values.push(JSON.parse(text)) } catch { values.push(text) } }
    }
  }
  const reason = reasonSummary(values), structured = values.find(value => value && typeof value === 'object')
  return { source, isError: own(message, 'isError') === true, kind: resultSummary(structured).kind, state: known(own(structured, 'state'), new Set(['blocked', 'ready', 'completed', 'preparing', 'awaiting_lisp_choice', 'verifying_goal', 'cancelled', 'superseded'])), next: known(own(structured, 'next'), new Set(['resolve_blocker', 'propose_goal_items_and_criteria', 'revise_goal_for_scope_change', 'answer_lisp_choice', 'implement_and_verify_item', 'verify_final_goal', 'completed', 'cancelled', 'superseded'])), blockerKind: known(own(own(structured, 'blocker'), 'kind'), new Set(['runtime', 'retry_budget', 'permission', 'environment'])), code: reason.reportedCodes[0] ?? null, reason }
}
export function admissionDiagnostic({ point, requests = [], events = [], status, expectedRounds, pendingResponses, error, turnFailed = false }) {
  const recent = Array.isArray(events) ? events.slice(-2048) : []
  const start = recent.findLastIndex(row => own(row, 'type') === 'turn/start')
  const current = start >= 0 ? recent.slice(start) : recent
  const event = current.findLast(row => own(row, 'type') === 'tool/result')
  let last = summarizeTool(toolMessage(own(own(event, 'data'), 'message')), 'session')
  if (event && !last) last = { source: 'session', format: 'unrecognized', kind: 'unknown', code: null, reason: reasonSummary(own(event, 'data')) }
  if (start < 0 && !event && !last && Array.isArray(requests)) {
    const messages = own(requests.at(-1), 'messages')
    if (Array.isArray(messages)) last = summarizeTool(messages.map(toolMessage).filter(Boolean).at(-1), 'request')
  }
  const end = current.findLast(row => own(row, 'type') === 'turn/end')
  const reason = own(own(end, 'data'), 'reason')
  return { schema: 'verification-diagnostic-v1', point: pointOf(point), expectedRounds: integer(expectedRounds), observedRounds: Array.isArray(requests) ? requests.length : 0, pendingResponses: integer(pendingResponses), agentStatus: known(status, new Set(['idle', 'running', 'busy', 'stopped']), 'unknown'), stopReason: own(reason, 'kind') === undefined ? 'not-recorded' : known(own(reason, 'kind'), stops, 'unclassified'), stopDetail: reasonSummary(reason), turnFailed: turnFailed === true, failure: reasonSummary(error), lastToolResult: last }
}
export function processDiagnostic({ point, success = false, error, stderr, elapsedMs, timeoutMs, timedOut = null }) {
  const rawCode = own(error, 'code')
  return { schema: 'verification-diagnostic-v1', point: pointOf(point), success, exitCode: success ? 0 : integer(rawCode), code: known(rawCode, codes), codeProvided: rawCode !== undefined, signal: known(own(error, 'signal'), signals), killed: typeof own(error, 'killed') === 'boolean' ? own(error, 'killed') : null, timedOut: typeof timedOut === 'boolean' ? timedOut : null, terminationRequested: timedOut === true ? 'SIGTERM' : null, elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : null, timeoutMs: integer(timeoutMs), stderrSummary: reasonSummary(own(error, 'stderr') ?? stderr), errorSummary: reasonSummary(own(error, 'message')) }
}
/** Injectable execution/clock/timer boundary; no argv, environment or raw output escapes. */
export async function observeProcess(run, { point, timeoutMs, now = () => performance.now(), schedule = setTimeout, clear = clearTimeout }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new TypeError('Invalid diagnostic deadline')
  const started = now(), controller = new AbortController()
  let timedOut = false
  const timer = schedule(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    const result = await run(controller.signal)
    // A command which resolves after the deadline still did not meet the deadline.
    return { ok: !timedOut, diagnostic: processDiagnostic({ point, success: !timedOut, stderr: own(result, 'stderr'), elapsedMs: now() - started, timeoutMs, timedOut }) }
  } catch (error) {
    return { ok: false, diagnostic: processDiagnostic({ point, error, elapsedMs: now() - started, timeoutMs, timedOut }) }
  } finally { clear(timer) }
}

/** Assertions expose only the projected diagnostic, including for malformed result kinds. */
export function requireCommandSuccess(input) {
  const diagnostic = commandDiagnostic(input)
  if (diagnostic.kind !== 'success') throw new Error(JSON.stringify(diagnostic))
  return diagnostic
}
export function requireAdmissionRounds(input) {
  const diagnostic = admissionDiagnostic(input)
  if (diagnostic.turnFailed || diagnostic.observedRounds !== diagnostic.expectedRounds) throw new Error(JSON.stringify(diagnostic))
  return diagnostic
}
