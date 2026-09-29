import { z } from 'zod'
import { KiokukoError } from '../errors.js'

export const MemoryRetrievalConfig = z.object({
  mode: z.enum(['off', 'observe', 'active']).default('off'),
  maxRelatedCandidates: z.number().int().min(1).max(120).default(24),
  parseAbsoluteDates: z.boolean().default(true),
  defaultTimeBasis: z.enum(['recorded', 'occurred']).default('occurred'),
  timeZone: z.string().min(1).max(128).default('UTC'),
}).strict().superRefine((value, ctx) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }).format(0) }
  catch { ctx.addIssue({ code: 'custom', path: ['timeZone'], message: 'Time zone must be a supported IANA identifier' }) }
})
export type MemoryRetrievalConfig = z.output<typeof MemoryRetrievalConfig>

export const MemoryTimeConstraint = z.object({
  version: z.literal(1),
  basis: z.enum(['recorded', 'occurred']),
  // Only restriction semantics are implemented. Reject a requested boost rather
  // than silently ignoring it and widening the result set.
  mode: z.literal('restrict'),
  startMs: z.number().int().nonnegative().max(8_640_000_000_000_000),
  endMs: z.number().int().positive().max(8_640_000_000_000_000),
  anchorTimeMs: z.number().int().nonnegative().max(8_640_000_000_000_000),
  timeZone: z.string().min(1).max(128),
}).strict().refine(value => value.endMs > value.startMs, 'Time range must be non-empty')
export type MemoryTimeConstraint = z.infer<typeof MemoryTimeConstraint>

function dateParts(value: number, timeZone: string): [number, number, number, number, number, number] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value))
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value)
  return [get('year'), get('month'), get('day'), get('hour'), get('minute'), get('second')]
}

function localMidnight(year: number, month: number, day: number, timeZone: string): number | undefined {
  try {
    const target = Date.UTC(year, month - 1, day)
    let guess = target
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [actualYear, actualMonth, actualDay, hour, minute, second] = dateParts(guess, timeZone)
      const represented = Date.UTC(actualYear, actualMonth - 1, actualDay, hour, minute, second)
      const next = guess + (target - represented)
      if (next === guess) break
      guess = next
    }
    const [actualYear, actualMonth, actualDay, hour, minute, second] = dateParts(guess, timeZone)
    return actualYear === year && actualMonth === month && actualDay === day && hour === 0 && minute === 0 && second === 0
      ? guess
      : undefined
  } catch {
    return undefined
  }
}

function parseCalendarDate(value: string): [number, number, number] | undefined {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  const japanese = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u.exec(value)
  const match = iso ?? japanese
  if (!match) return undefined
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return undefined
  return [year, month, day]
}

function shiftDate(value: [number, number, number], days: number): [number, number, number] {
  const date = new Date(Date.UTC(value[0], value[1] - 1, value[2] + days))
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
}

function relativeDateRange(
  value: string,
  anchorTimeMs: number,
  timeZone: string,
): { start: [number, number, number]; end: [number, number, number] } | undefined {
  const match = /\b(today|yesterday|this week|last week|this month|last month)\b|今日|昨日|今週|先週|今月|先月/iu.exec(value)?.[0]?.toLowerCase()
  if (!match) return undefined
  const [year, month, day] = dateParts(anchorTimeMs, timeZone)
  const today: [number, number, number] = [year, month, day]
  const monthStart: [number, number, number] = [year, month, 1]
  const weekStart = shiftDate(today, -((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7))
  switch (match) {
    case 'today': case '今日': return { start: today, end: shiftDate(today, 1) }
    case 'yesterday': case '昨日': return { start: shiftDate(today, -1), end: today }
    case 'this week': case '今週': return { start: weekStart, end: shiftDate(weekStart, 7) }
    case 'last week': case '先週': return { start: shiftDate(weekStart, -7), end: weekStart }
    case 'this month': case '今月': return { start: monthStart, end: month === 12 ? [year + 1, 1, 1] : [year, month + 1, 1] }
    case 'last month': case '先月': return month === 1
      ? { start: [year - 1, 12, 1], end: monthStart }
      : { start: [year, month - 1, 1], end: monthStart }
    default: return undefined
  }
}

function dateConstraint(
  startDate: [number, number, number],
  endDate: [number, number, number],
  options: { basis: MemoryTimeConstraint['basis']; anchorTimeMs: number; timeZone: string },
): MemoryTimeConstraint | undefined {
  const startMs = localMidnight(...startDate, options.timeZone)
  const endMs = localMidnight(...endDate, options.timeZone)
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return undefined
  return MemoryTimeConstraint.parse({ version: 1, basis: options.basis, mode: 'restrict', startMs, endMs,
    anchorTimeMs: options.anchorTimeMs, timeZone: options.timeZone })
}

/** Parse only explicit, complete calendar dates. Relative phrases are left to the caller. */
export function parseUnambiguousMemoryTime(
  text: string,
  options: { basis: MemoryTimeConstraint['basis']; anchorTimeMs: number; timeZone: string },
): MemoryTimeConstraint | undefined {
  const source = text.normalize('NFKC')
  const datePattern = '(?<!\\d)(?:\\d{4}-\\d{2}-\\d{2}|\\d{4}年\\d{1,2}月\\d{1,2}日)(?![\\dTt:])'
  const range = new RegExp(`(?:from\\s+)?(${datePattern})\\s*(?:\\.\\.|〜|~|から|to|until)\\s*(?:to\\s+|until\\s+)?(${datePattern})`, 'iu').exec(source)
  const dateMatches = [...source.matchAll(new RegExp(datePattern, 'gu'))]
  const relativeMatches = [...source.matchAll(/\b(?:today|yesterday|this week|last week|this month|last month)\b|今日|昨日|今週|先週|今月|先月/giu)]
  if (relativeMatches.length > 1 || relativeMatches.length > 0 && dateMatches.length > 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'Memory time expression is ambiguous')
  }
  if (relativeMatches.length === 1) {
    const relative = relativeDateRange(source, options.anchorTimeMs, options.timeZone)
    const constraint = relative && dateConstraint(relative.start, relative.end, options)
    if (!constraint) throw new KiokukoError('VALIDATION_ERROR', 'Memory time expression cannot be resolved')
    return constraint
  }
  if (range && dateMatches.length !== 2 || !range && dateMatches.length > 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'Memory time expression is ambiguous')
  }
  if (dateMatches.length === 0) return undefined
  if (!range) {
    const match = dateMatches[0]!
    const prefix = source.slice(0, match.index)
    const suffix = source.slice(match.index + match[0].length)
    // Do not turn open-ended comparisons into a single calendar day. Their
    // boundaries need separate range semantics and must fail closed until
    // those semantics are represented by a structured constraint.
    if (/\b(?:before|after|since|until|through|prior\s+to|from|between)\s*$/iu.test(prefix)
      || /^\s*(?:before|after|since|until|through|prior\s+to|to|and\s+after)\b/iu.test(suffix)
      || /(?:以前|以降|以後|まで|より前|より後|から)\s*$/u.test(prefix)
      || /^\s*(?:以前|以降|以後|まで|より前|より後|から)/u.test(suffix)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Open-ended memory time expressions require structured bounds')
    }
  }
  const startText = range?.[1] ?? dateMatches[0]?.[0]
  const endText = range?.[2] ?? dateMatches[0]?.[0]
  if (!startText || !endText) return undefined
  const startDate = parseCalendarDate(startText), endDate = parseCalendarDate(endText)
  if (!startDate || !endDate) throw new KiokukoError('VALIDATION_ERROR', 'Memory time expression contains an invalid date')
  // Include the full end calendar day. Compute it in UTC first so DST does not
  // turn a local day into a fixed 24-hour interval.
  const constraint = dateConstraint(startDate, shiftDate(endDate, 1), options)
  if (!constraint) throw new KiokukoError('VALIDATION_ERROR', 'Memory time range is empty or reversed')
  return constraint
}

export function validateMemoryTimeConstraint(value: unknown): MemoryTimeConstraint {
  try {
    return MemoryTimeConstraint.parse(value)
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'Memory time constraint is invalid')
  }
}

export function timeConstraintForRequest(
  text: string,
  config: MemoryRetrievalConfig,
  anchorTimeMs = Date.now(),
): MemoryTimeConstraint | undefined {
  if (config.mode === 'off' || !config.parseAbsoluteDates) return undefined
  return parseUnambiguousMemoryTime(text, { basis: config.defaultTimeBasis, anchorTimeMs, timeZone: config.timeZone })
}
