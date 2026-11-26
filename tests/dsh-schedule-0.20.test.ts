import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { Workbench } from '../src/workbench/app.ts'
import { createApiHandler } from '../src/workbench/web.ts'
import { registerTools } from '../src/tools.ts'
import {
  buildNaiSchedulePrompt,
  isNaiScheduleTask,
  legacyPlanToDshPayload,
  NAI_SCHEDULE_MARKER,
  normalizeDshTiming,
  type DshScheduleService,
} from '../src/workbench/dshSchedule.ts'

const roots: string[] = []
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'nai-dsh-sched-')); roots.push(d); return d }
afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }) })

function createMemoryDshSchedule(): DshScheduleService & { tasks: Map<string, Record<string, any>>; runs: string[] } {
  const tasks = new Map<string, Record<string, any>>()
  const runs: string[] = []
  let seq = 1
  return {
    tasks,
    runs,
    deliveryLimits: () => ({ newSessionIntervalSeconds: 60 }),
    async create(req) {
      const id = `schedule-${seq++}`
      const now = new Date().toISOString()
      const row: Record<string, any> = {
        id, title: req.title, prompt: req.prompt,
        kind: req.timing.kind,
        ...(req.timing.kind === 'daily' ? { time: req.timing.daily.time, timeZone: req.timing.daily.time_zone } : {}),
        ...(req.timing.kind === 'weekly' ? { time: req.timing.weekly.time, timeZone: req.timing.weekly.time_zone, weekdays: req.timing.weekly.weekdays } : {}),
        ...(req.timing.kind === 'every' ? { everySeconds: req.timing.every_seconds } : {}),
        ...(req.timing.kind === 'rrule' ? { rrule: req.timing.rrule } : {}),
        status: 'active',
        scheduledAt: '2030-01-01T01:00:00.000Z',
        scheduledAtLocal: '2030-01-01T09:00:00+08:00',
        target: req.target ?? { kind: 'new_once', create: {} },
        updatedAt: now,
      }
      tasks.set(id, row)
      return structuredClone(row)
    },
    async list(req = {}) {
      const items = [...tasks.values()].filter((t) => req.active === undefined || (t['status'] === 'active') === req.active)
      return { items: items.map((t) => structuredClone(t)), shown: items.length, total: items.length, limit: req.limit ?? 100, offset: req.offset ?? 0 }
    },
    async catalog() {
      return [...tasks.values()].map((t) => structuredClone(t))
    },
    async view({ id }) {
      const row = tasks.get(id)
      return row ? structuredClone(row) : { id, code: 'schedule_not_found' }
    },
    async history({ id }) {
      if (!tasks.has(id)) return { id, code: 'schedule_not_found' }
      return { id, records: runs.filter((r) => r === id).map((r, i) => ({ messageId: `msg-${i}`, deliveredAt: '2030-01-01T01:00:01Z', targetSessionId: 'session-1', trigger: 'manual' })) }
    },
    async run({ id }) {
      const row = tasks.get(id)
      if (!row) return { id, code: 'schedule_not_found' }
      runs.push(id)
      return structuredClone(row)
    },
    async edit(req) {
      const row = tasks.get(req.id)
      if (!row) return { id: req.id, code: 'schedule_not_found' }
      if (req.expectedUpdatedAt && req.expectedUpdatedAt !== row['updatedAt']) return { id: req.id, code: 'schedule_conflict' }
      if (req.action === 'delete') { tasks.delete(req.id); return { id: req.id, deleted: true } }
      if (req.patch?.title !== undefined) row['title'] = req.patch.title
      if (req.patch?.prompt !== undefined) row['prompt'] = req.patch.prompt
      if (req.patch?.active !== undefined) row['status'] = req.patch.active ? 'active' : 'paused'
      if (req.patch?.target !== undefined) row['target'] = req.patch.target
      if (req.patch?.timing !== undefined) row['kind'] = req.patch.timing.kind
      row['updatedAt'] = new Date(Date.now() + 1000).toISOString()
      return structuredClone(row)
    },
  }
}

describe('DSH native schedule bridge (0.20.0)', () => {
  it('normalizes daily, weekly, interval, once, cron, and rrule timings cleanly', () => {
    expect(normalizeDshTiming({ kind: 'daily', time: '08:30', timezone: 'Asia/Shanghai' })).toEqual({
      kind: 'daily', daily: { time: '08:30:00', time_zone: 'Asia/Shanghai' },
    })
    expect(normalizeDshTiming({ kind: 'weekly', time: '20:00', weekdays: [1, 5], timezone: 'Asia/Shanghai' })).toEqual({
      kind: 'weekly', weekly: { time: '20:00:00', time_zone: 'Asia/Shanghai', weekdays: [1, 5] },
    })
    expect(normalizeDshTiming({ kind: 'interval', interval_minutes: 30 })).toEqual({ kind: 'every', every_seconds: 1800 })
    expect(normalizeDshTiming({ kind: 'once', at: '2030-05-01 09:00', timezone: 'Asia/Shanghai' })).toEqual({
      kind: 'at', at: '2030-05-01T01:00:00.000Z',
    })
    expect(normalizeDshTiming({ rrule: 'DTSTART;TZID=Asia/Shanghai:20300101T090000\nRRULE:FREQ=DAILY' })).toEqual({
      kind: 'rrule', rrule: 'DTSTART;TZID=Asia/Shanghai:20300101T090000\nRRULE:FREQ=DAILY',
    })
    expect(() => normalizeDshTiming({ kind: 'daily', time: '99:99' })).toThrow()
    expect(() => normalizeDshTiming({ kind: 'interval', interval_minutes: 0 })).toThrow()
  })

  it('compiles structured NAI schedule prompts with bootstrap, library refs, output_subdir, and endpoint', () => {
    const prompt = buildNaiSchedulePrompt({
      mode: 'ai',
      instruction: '画一张雨夜咖啡馆窗边插画',
      randomize: '服装配色与镜头景别',
      library_refs: ['char-1'],
      model: 'nai-diffusion-5-full',
      v5_tier: 'medium',
      count: 2,
      output_subdir: 'rainy-cafe',
      endpoint: 'ep_carpool',
    }, [{ id: 'char-1', name: '雪乃' }])
    expect(prompt).toContain(NAI_SCHEDULE_MARKER)
    expect(prompt).toContain('nai_use_tools({enabled:true})')
    expect(prompt).toContain('nai_library_read({ids:["char-1"]})')
    expect(prompt).toContain('雪乃 (char-1)')
    expect(prompt).toContain('output_subdir: "rainy-cafe"')
    expect(prompt).toContain('endpoint: "ep_carpool"')
    expect(prompt).toContain('v5_tier=medium')
    expect(isNaiScheduleTask({ prompt })).toBe(true)
    expect(isNaiScheduleTask({ prompt: 'Remind me to drink water' })).toBe(false)
  })

  it('drives save/list/view/run/delete through nai_schedule_save and captures calling session actor', async () => {
    const wb = new Workbench(tempDir())
    const dsh = createMemoryDshSchedule()
    wb.setDshSchedule(dsh)
    // Add an unrelated DSH task to verify filtering
    await dsh.create({ title: '喝水提醒', prompt: '提醒喝水', timing: { kind: 'every', every_seconds: 3600 } })

    const tools = new Map<string, any>()
    registerTools({ effect: (fn: () => void) => fn(), tools: { register: (t: any) => tools.set(t.name, t) } } as never, wb)
    const runTool = (args: Record<string, unknown>, actor?: any) =>
      tools.get('nai_schedule_save').execute(args, { signal: new AbortController().signal, agent: actor })

    const created = await runTool({
      title: '每日角色打卡',
      kind: 'daily',
      time: '09:00',
      target: 'this_session',
      instruction: '清晨光影插画',
      output_subdir: 'daily',
    }, { session: { id: 'sess-42', header: { cwd: 'D:\\work' } } })

    expect(created).toMatchObject({ title: '每日角色打卡', status: 'active', target: { kind: 'session', sessionId: 'sess-42' } })
    expect((await runTool({ action: 'list' })).tasks).toHaveLength(1)
    expect((await runTool({ action: 'list', all: true })).tasks).toHaveLength(2)

    await runTool({ action: 'run', id: created.id })
    const viewed = await runTool({ action: 'view', id: created.id })
    expect(viewed.history.records).toHaveLength(1)

    const paused = await runTool({ id: created.id, active: false, expected_updated_at: created.updatedAt })
    expect(paused.status).toBe('paused')

    const deleted = await runTool({ action: 'delete', id: created.id })
    expect(deleted).toEqual({ deleted: true, id: created.id })
    expect((await runTool({ action: 'list' })).tasks).toHaveLength(0)
  })

  it('exposes /schedules CRUD and one-click legacy schedule migration over HTTP API', async () => {
    const wb = new Workbench(tempDir())
    const dsh = createMemoryDshSchedule()
    wb.setDshSchedule(dsh)
    // Seed a legacy pre-0.20 schedule row directly in workbench.json
    wb.store.data.schedules.push({
      id: 'legacy-1',
      revision: 2,
      enabled: 1,
      next_run: '2030-01-01T01:00:00Z',
      runs: 3,
      spent: 0,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      data: JSON.stringify({
        name: '旧版晨图', kind: 'daily', time: '08:00', timezone: 'Asia/Shanghai',
        execution_mode: 'ai', count: 1, output_subdir: 'old-morning',
        ai_recipe: { instruction: '治愈风景画', library_refs: [] },
        request: { model: 'nai-diffusion-5-full', prompt: '' },
      }),
    })
    wb.store.internalPersist()

    const converted = legacyPlanToDshPayload(wb.store.getSchedule('legacy-1'))
    expect(converted.title).toBe('旧版晨图')
    expect(converted.prompt).toContain('治愈风景画')
    expect(converted.prompt).toContain('output_subdir: "old-morning"')

    const handler = createApiHandler({ workbench: wb, checkRequest: async () => true })
    const server = createServer((req, res) => { void handler(req, res, '/api/nai') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/nai/api`
    try {
      const initial = await (await fetch(base + '/schedules')).json()
      expect(initial.available).toBe(true)
      expect(initial.tasks).toHaveLength(0)
      expect(initial.legacy).toHaveLength(1)

      const migrated = await (await fetch(base + '/schedules/legacy/legacy-1/migrate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete_legacy: true }),
      })).json()
      expect(migrated.migrated).toBe(true)
      expect(migrated.task.title).toBe('旧版晨图')

      const after = await (await fetch(base + '/schedules')).json()
      expect(after.tasks).toHaveLength(1)
      expect(after.legacy).toHaveLength(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
