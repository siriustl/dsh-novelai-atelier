import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type Rec } from '../src/workbench/store.ts'
import { asUtc, localInstant, nextDaily, timestamp } from '../src/workbench/util.ts'

const roots: string[] = []
function store(): Store {
  const root = mkdtempSync(join(tmpdir(), 'nai-schedule-time-'))
  roots.push(root)
  return new Store(root)
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function schedule(overrides: Rec = {}): Rec {
  return {
    name: 'schedule time', enabled: true, kind: 'once', timezone: 'Asia/Shanghai',
    at: '2026-10-02T01:30:45', operation: 'generate',
    request: { prompt: '1boy', max_anlas: 0 }, max_runs: 10, missed_policy: 'once',
    ...overrides,
  }
}
const iso = (value: unknown) => asUtc(String(value)).toISOString()

const invalidDates = [
  '2026-02-29T01:30:00', '2028-02-30T01:30:00', '2026-04-31T01:30:00',
  '2026-00-10T01:30:00', '2026-13-01T01:30:00', '2026-10-00T01:30:00',
  '2026-10-32T01:30:00', '2026-10-02T24:00:00', '2026-10-02T25:00:00',
  '2026-10-02T01:60:00', '2026-10-02T01:30:60',
]

describe('strict zoned ISO timestamps', () => {
  it.each(['Z', '+08:00', '-0400'])('rejects impossible calendar fields with %s', (suffix) => {
    for (const value of invalidDates) expect(() => asUtc(value + suffix), value + suffix).toThrow()
  })

  it.each(['+24:00', '-24:00', '+08:60', '-1260'])('rejects invalid offset %s', (offset) => {
    expect(() => asUtc('2026-10-02T01:30:45' + offset)).toThrow()
  })

  it('requires a timezone and rejects malformed timestamps and invalid Date objects', () => {
    for (const value of ['2026-10-02T01:30:45', '2026-10-02Z', '2026-10-02T1:30Z'])
      expect(() => asUtc(value)).toThrow()
    expect(() => asUtc(new Date(NaN))).toThrow()
  })

  it('retains seconds, valid leap days and persisted microseconds', () => {
    expect(asUtc('2028-02-29T01:30:45.123456+08:00').toISOString()).toBe('2028-02-28T17:30:45.123Z')
    expect(asUtc('2028-02-29T01:30:45.123456+0800').toISOString()).toBe('2028-02-28T17:30:45.123Z')
    expect(asUtc('2028-02-29T01:30:45.123456Z').toISOString()).toBe('2028-02-29T01:30:45.123Z')
    const persisted = timestamp(new Date('2026-10-02T01:30:45.123Z'))
    expect(persisted).toBe('2026-10-02T01:30:45.123000+00:00')
    expect(timestamp(persisted)).toBe(persisted)
    expect(asUtc('2026-10-02 01:30+08:00').toISOString()).toBe('2026-10-01T17:30:00.000Z')
  })

  it('validates centuries without the Date.UTC year-0-to-99 remapping', () => {
    expect(asUtc('0099-01-01T00:00:00Z').getUTCFullYear()).toBe(99)
    expect(asUtc('2000-02-29T00:00:00Z').getUTCDate()).toBe(29)
    expect(() => asUtc('1900-02-29T00:00:00Z')).toThrow()
  })
})

describe('Shanghai schedule calendar boundaries', () => {
  it.each([
    ['2026-10-02T01:30:45', '2026-10-01T17:30:45.000Z'],
    ['2028-02-29T01:30', '2028-02-28T17:30:00.000Z'],
    ['2028-02-29T00:00:45', '2028-02-28T16:00:45.000Z'],
  ])('preserves local date/time for %s', (at, expected) => {
    const s = store(), input = schedule({ at })
    expect(iso(s.previewSchedule(input).next_run)).toBe(expected)
    const saved = s.saveSchedule(input)
    expect(iso(saved.at)).toBe(expected)
    expect(iso(saved.next_run)).toBe(expected)
  })

  it.each(['', 'Z', '+08:00', '-0400'])('rejects invalid once dates atomically with suffix %s', (suffix) => {
    const s = store(), before = JSON.stringify(s.data)
    for (const value of invalidDates) {
      const input = schedule({ at: value + suffix })
      expect(() => s.previewSchedule(input)).toThrow(/有效 ISO at/u)
      expect(() => s.saveSchedule(input)).toThrow(/有效 ISO at/u)
      expect(JSON.stringify(s.data)).toBe(before)
    }
  })

  it('advances daily dates across a leap day and a year boundary', () => {
    expect(nextDaily(asUtc('2028-02-28T16:00:00Z'), '00:00', 'Asia/Shanghai').toISOString()).toBe('2028-02-29T16:00:00.000Z')
    expect(nextDaily(asUtc('2026-12-31T16:00:45Z'), '00:00', 'Asia/Shanghai').toISOString()).toBe('2027-01-01T16:00:00.000Z')
  })
})

const dstCases = [
  {
    zone: 'America/New_York',
    gap: [2026, 3, 8, 2, 30] as const, gapAt: '2026-03-08T02:30:45', gapClock: '02:30',
    gapAfter: '2026-03-08T05:00:00Z', gapNext: '2026-03-09T06:30:00.000Z',
    fold: [2026, 11, 1, 1, 30] as const, foldAt: '2026-11-01T01:30:45', foldClock: '01:30',
    foldBefore: '2026-11-01T04:00:00Z', first: '2026-11-01T05:30:00.000Z',
    second: '2026-11-01T06:30:00.000Z', foldNext: '2026-11-02T06:30:00.000Z',
  },
  {
    zone: 'Europe/Berlin',
    gap: [2026, 3, 29, 2, 30] as const, gapAt: '2026-03-29T02:30:45', gapClock: '02:30',
    gapAfter: '2026-03-28T23:00:00Z', gapNext: '2026-03-30T00:30:00.000Z',
    fold: [2026, 10, 25, 2, 30] as const, foldAt: '2026-10-25T02:30:45', foldClock: '02:30',
    foldBefore: '2026-10-24T22:00:00Z', first: '2026-10-25T00:30:00.000Z',
    second: '2026-10-25T01:30:00.000Z', foldNext: '2026-10-26T01:30:00.000Z',
  },
  {
    zone: 'Australia/Lord_Howe',
    gap: [2026, 10, 4, 2, 15] as const, gapAt: '2026-10-04T02:15:45', gapClock: '02:15',
    gapAfter: '2026-10-03T13:30:00Z', gapNext: '2026-10-04T15:15:00.000Z',
    fold: [2026, 4, 5, 1, 45] as const, foldAt: '2026-04-05T01:45:45', foldClock: '01:45',
    foldBefore: '2026-04-04T13:00:00Z', first: '2026-04-04T14:45:00.000Z',
    second: '2026-04-04T15:15:00.000Z', foldNext: '2026-04-05T15:15:00.000Z',
  },
]

for (const test of dstCases) {
  describe(test.zone + ' DST scheduling', () => {
    it('rejects a nonexistent naive once instant without changing store state', () => {
      const [year, month, day, hour, minute] = test.gap
      expect(() => localInstant(year, month, day, hour, minute, test.zone, 45)).toThrow(/不存在/u)
      const s = store(), before = JSON.stringify(s.data)
      const input = schedule({ timezone: test.zone, at: test.gapAt })
      expect(() => s.previewSchedule(input)).toThrow(/有效 ISO at/u)
      expect(() => s.saveSchedule(input)).toThrow(/有效 ISO at/u)
      expect(JSON.stringify(s.data)).toBe(before)
    })

    it('chooses the earlier ambiguous once instant and preserves seconds', () => {
      const [year, month, day, hour, minute] = test.fold
      const expected = test.first.replace(':00.000Z', ':45.000Z')
      expect(localInstant(year, month, day, hour, minute, test.zone, 45).toISOString()).toBe(expected)
      const s = store(), input = schedule({ timezone: test.zone, at: test.foldAt })
      expect(iso(s.previewSchedule(input).next_run)).toBe(expected)
      expect(iso(s.saveSchedule(input).next_run)).toBe(expected)
    })

    it('skips the missing daily time rather than advancing it on the same date', () => {
      expect(nextDaily(asUtc(test.gapAfter), test.gapClock, test.zone).toISOString()).toBe(test.gapNext)
      const s = store()
      const saved = s.saveSchedule(schedule({ kind: 'daily', timezone: test.zone, time: test.gapClock }), null, test.gapAfter)
      expect(iso(saved.next_run)).toBe(test.gapNext)
      expect(s.listScheduleRuns(String(saved.id))).toEqual([])
    })

    it('uses only the earlier daily occurrence, even between fold instants', () => {
      expect(nextDaily(asUtc(test.foldBefore), test.foldClock, test.zone).toISOString()).toBe(test.first)
      for (const after of [test.first, new Date((Date.parse(test.first) + Date.parse(test.second)) / 2).toISOString(), test.second])
        expect(nextDaily(asUtc(after), test.foldClock, test.zone).toISOString()).toBe(test.foldNext)
      const s = store()
      const saved = s.saveSchedule(schedule({ kind: 'daily', timezone: test.zone, time: test.foldClock }), null, test.foldBefore)
      expect(s.tickSchedules(test.first)).toHaveLength(1)
      expect(iso(s.getSchedule(String(saved.id)).next_run)).toBe(test.foldNext)
      expect(s.tickSchedules(test.second)).toEqual([])
      expect(s.listScheduleRuns(String(saved.id))).toHaveLength(1)
    })
  })
}

describe('DST boundaries and explicit offsets', () => {
  it('allows the first valid time after the Lord Howe half-hour gap', () => {
    expect(localInstant(2026, 10, 4, 2, 30, 'Australia/Lord_Howe', 45).toISOString()).toBe('2026-10-03T15:30:45.000Z')
  })

  it('keeps an explicit offset unambiguous even inside a local gap or fold', () => {
    const s = store()
    expect(iso(s.saveSchedule(schedule({ timezone: 'America/New_York', at: '2026-03-08T02:30:45-05:00' })).next_run)).toBe('2026-03-08T07:30:45.000Z')
    expect(iso(s.saveSchedule(schedule({ timezone: 'America/New_York', at: '2026-11-01T01:30:45-05:00' })).next_run)).toBe('2026-11-01T06:30:45.000Z')
  })

  it.each(['24:00', '12:60', '1:30', '12:30:45'])('rejects an invalid daily clock %s', (clock) => {
    expect(() => nextDaily(asUtc('2026-01-01T00:00:00Z'), clock, 'Asia/Shanghai')).toThrow()
  })

  it('does not hide unknown timezone or invalid after errors as daily gaps', () => {
    expect(() => nextDaily(asUtc('2026-01-01T00:00:00Z'), '12:00', 'Unknown/Zone')).toThrow()
    expect(() => nextDaily(new Date(NaN), '12:00', 'Asia/Shanghai')).toThrow()
  })
})

describe('skipped calendar days and early ISO years', () => {
  it('rejects the entire missing Apia date and advances daily to December 31', () => {
    expect(() => localInstant(2011, 12, 30, 12, 0, 'Pacific/Apia')).toThrow(/不存在/u)
    const s = store(), before = JSON.stringify(s.data)
    expect(() => s.saveSchedule(schedule({ timezone: 'Pacific/Apia', at: '2011-12-30T12:00:00' }))).toThrow(/有效 ISO at/u)
    expect(JSON.stringify(s.data)).toBe(before)
    const after = asUtc('2011-12-29T22:00:00Z')
    const expected = '2011-12-30T22:00:00.000Z'
    expect(nextDaily(after, '12:00', 'Pacific/Apia').toISOString()).toBe(expected)
    expect(iso(s.saveSchedule(schedule({ kind: 'daily', timezone: 'Pacific/Apia', time: '12:00' }), null, after).next_run)).toBe(expected)
  })

  it.each([0, 1, 9, 99])('preserves ISO year %i in local and daily conversions', (year) => {
    const y = String(year).padStart(4, '0')
    expect(asUtc(`${y}-01-01T00:00:45Z`).getUTCFullYear()).toBe(year)
    expect(localInstant(year, 1, 1, 0, 0, 'UTC', 45).toISOString()).toBe(`${y}-01-01T00:00:45.000Z`)
    expect(nextDaily(asUtc(`${y}-01-01T00:00:45Z`), '00:00', 'UTC').toISOString()).toBe(`${y}-01-02T00:00:00.000Z`)
  })

  it('uses the proleptic Gregorian leap rule for year zero', () => {
    expect(localInstant(0, 2, 29, 0, 0, 'UTC').toISOString()).toBe('0000-02-29T00:00:00.000Z')
    expect(() => localInstant(99, 2, 29, 0, 0, 'UTC')).toThrow()
  })
})

describe('natural schedule exhaustion is not edit cancellation', () => {
  it.each(['once', 'daily', 'interval'])('allows the final AI %s run to finish after max_runs disables the schedule', (kind) => {
    const s = store(), current = '2026-10-01T17:29:45Z'
    const saved = s.saveSchedule(schedule({
      kind, time: '01:30', interval_minutes: 1, max_runs: 1,
      execution_mode: 'ai', ai_recipe: { instruction: 'Keep the authorized request' },
    }), null, current)
    const due = String(saved.next_run)
    expect(s.tickSchedules(due)).toEqual([])
    expect(s.getSchedule(String(saved.id))).toMatchObject({ enabled: false, runs: 1, next_run: null })
    const run = s.claimScheduleRun(due)
    expect(run).not.toBeNull()
    const result = s.finishScheduleRun(run!, {
      now: due, plan: { snapshots: [{ operation: 'generate', request: { prompt: '1boy', max_anlas: 0 } }] },
    })
    expect(result).toMatchObject({ outcome: 'queued' })
    expect(result.jobs).toHaveLength(1)
    expect(s.getSchedule(String(saved.id))).toMatchObject({ enabled: false, runs: 1, next_run: null })
  })

  it('still cancels an AI occurrence when the user edits the schedule', () => {
    const s = store(), saved = s.saveSchedule(schedule({
      max_runs: 1, execution_mode: 'ai', ai_recipe: { instruction: 'Keep the authorized request' },
    }))
    const due = String(saved.next_run)
    s.tickSchedules(due)
    const run = s.claimScheduleRun(due)
    expect(run).not.toBeNull()
    s.saveSchedule({ name: 'edited schedule', expected_revision: saved.revision }, String(saved.id), due)
    expect(s.finishScheduleRun(run!, {
      now: due, plan: { snapshots: [{ operation: 'generate', request: { prompt: '1boy', max_anlas: 0 } }] },
    })).toMatchObject({ outcome: 'cancelled' })
    expect(s.data.jobs).toHaveLength(0)
  })
})
