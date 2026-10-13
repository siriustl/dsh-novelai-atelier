/** Shared workbench data helpers: timestamps, validation, conflict errors. */
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export class ConflictError extends Error {}
export class KeyError extends Error {}

export function utcnow(): Date { return new Date() }

/** Python datetime.isoformat(timespec='microseconds') shape in +00:00. */
export function timestamp(value?: Date | string | null): string {
  const d = asUtc(value)
  return d.toISOString().replace('Z', '000+00:00') // 2026-09-20T12:34:56.123000+00:00
}

export function asUtc(value?: Date | string | null): Date {
  if (value == null) return utcnow()
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('时间无效')
    return value
  }
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/u.test(value)) throw new Error('时间必须包含时区')
  const match = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):?(\d{2}))$/u.exec(value)
  if (!match) throw new Error('时间必须是有效 ISO 日期和时间')
  calendarInstant(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0))
  if (Number(match[10] ?? 0) > 23 || Number(match[11] ?? 0) > 59) throw new Error('时间偏移无效')
  // Date truncates sub-millisecond digits, including our persisted microseconds.
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) throw new Error('时间无效')
  return d
}

/** Validate before Date can normalize an impossible calendar date or 24:00. */
function calendarInstant(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  if (![year, month, day, hour, minute, second].every(Number.isInteger) || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59)
    throw new Error('计划本地日期或时间无效')
  const date = new Date(0)
  // setUTCFullYear avoids Date.UTC's special interpretation of years 0 through 99.
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day)
    throw new Error('计划本地日期无效')
  return date.getTime()
}

export function money(value: unknown, name = '预算'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000)
    throw new Error(`${name}必须是有限非负数`)
  return value
}

export function integer(value: unknown, name: string, low: number, high: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high)
    throw new Error(`${name}必须是 ${low}–${high} 的整数`)
  return value
}

export function encode(value: unknown): string {
  const result = JSON.stringify(value)
  if (result === undefined) throw new Error('数据必须是有限 JSON 值')
  if (result.length > 16 * 1024 * 1024) throw new Error('数据超过 16 MiB 限制')
  return result
}

export function randomId(): string {
  const hex = '0123456789abcdef'
  let out = ''
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  for (const b of bytes) { out += hex[b >> 4]; out += hex[b & 15] }
  return out
}

export const nowStamp = () => timestamp()

/** Atomic JSON document persistence (write temp + rename). */
export class JsonDoc<T> {
  constructor(private path: string, private initial: T) {}

  load(): T {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(this.initial)
      throw error
    }
  }

  save(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${randomId()}.tmp`
    writeFileSync(tmp, JSON.stringify(value))
    try {
      renameSync(tmp, this.path)
    } catch (error) {
      try { unlinkSync(tmp) } catch { /* ignore */ }
      throw error
    }
  }

  exists(): boolean { return existsSync(this.path) }
}

function zonedFormatter(zone: string): Intl.DateTimeFormat {
  // gregory retains BC/AD era fields that some ICU iso8601 formatters omit.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
    era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function wallTimestamp(formatter: Intl.DateTimeFormat, instant: Date): number {
  const parts = formatter.formatToParts(instant)
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  const year = parts.find((part) => part.type === 'era')?.value === 'BC' ? 1 - get('year') : get('year')
  return calendarInstant(year, get('month'), get('day'), get('hour'), get('minute'), get('second'))
}

/** Enumerate observed offsets, then require an exact wall-clock round trip.
 * IANA offsets lie within 24 hours; minute sampling also retains historical
 * second-based offsets. A fold selects the earliest match, a gap has none. */
function matchingLocalInstant(naive: number, formatter: Intl.DateTimeFormat): Date | null {
  const offsets = new Set<number>()
  let earliest: number | null = null
  const dayMs = 24 * 60 * 60000
  for (let sample = naive - dayMs; sample <= naive + dayMs; sample += 60000) {
    const offset = wallTimestamp(formatter, new Date(sample)) - sample
    if (offsets.has(offset)) continue
    offsets.add(offset)
    const candidate = naive - offset
    if (wallTimestamp(formatter, new Date(candidate)) === naive && (earliest === null || candidate < earliest)) earliest = candidate
  }
  return earliest === null ? null : new Date(earliest)
}

/** Convert a naive local wall clock to UTC; reject gaps and choose the earlier fold. */
export function localInstant(year: number, month: number, day: number, hour: number, minute: number, zone: string, second = 0): Date {
  const naive = calendarInstant(year, month, day, hour, minute, second)
  const instant = matchingLocalInstant(naive, zonedFormatter(zone))
  if (!instant) throw new Error('计划本地时间在该时区不存在')
  return instant
}

/** Next daily occurrence strictly after `after`; skip gaps, use each fold only once. */
export function nextDaily(after: Date, clock: string, zoneName: string): Date {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(clock)
  if (!match) throw new Error('每日计划需要 HH:MM 时间')
  asUtc(after)
  const hour = Number(match[1]), minute = Number(match[2])
  const formatter = zonedFormatter(zoneName)
  const localDate = new Date(wallTimestamp(formatter, after))
  localDate.setUTCHours(hour, minute, 0, 0)
  for (let days = 0; days < 370; days++) {
    const instant = matchingLocalInstant(localDate.getTime(), formatter)
    if (instant && instant.getTime() > after.getTime()) return instant
    localDate.setUTCDate(localDate.getUTCDate() + 1)
  }
  throw new Error('无法计算下次执行时间')
}

export function validTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch { return false }
}
