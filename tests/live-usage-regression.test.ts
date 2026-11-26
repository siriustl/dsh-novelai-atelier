import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workbench } from '../src/workbench/app.ts'
import { Store } from '../src/workbench/store.ts'
import { registerTools } from '../src/tools.ts'

const roots: string[] = []
const temporary = () => { const p = mkdtempSync(join(tmpdir(), 'nai-live-regression-')); roots.push(p); return p }
afterEach(() => { vi.restoreAllMocks(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })

describe('direct gallery reported spend regression', () => {
  it.each([null, undefined])('keeps unknown charge %s as null on completed jobs across reopen', async (anlas) => {
    const root = temporary(), wb = new Workbench(root)
    const result: Record<string, unknown> = { id: 'unknown', operation: 'generate', artifact_paths: [], max_anlas: 5 }
    if (anlas !== undefined) result.anlas_spent = anlas
    await wb.registerDirectGeneration(result, { model: 'v5', prompt: '1boy', max_anlas: 5 })
    const store = new Store(root), job = store.getJob('unknown')
    expect(job).toMatchObject({ status: 'completed', actual_anlas: null })
    expect(job).not.toHaveProperty('reserved_anlas')
    expect(store.getBatch(String(job.batch_id))).toMatchObject({ spent: 0, reserved: 0 })
    expect(store.getPaused()).toBe(false)
    expect(result).not.toHaveProperty('assets')
  })
  it('records a reported zero without a false pause', async () => {
    const wb = new Workbench(temporary())
    await wb.registerDirectGeneration({ id: 'free', artifact_paths: [], anlas_spent: 0 }, { max_anlas: 0 })
    expect(wb.store.getJob('free')).toMatchObject({ status: 'completed', actual_anlas: 0 })
    expect(wb.store.getPaused()).toBe(false)
  })
  it('retains reported spend above an obsolete ceiling without pausing', () => {
    const store = new Store(temporary())
    const job = store.recordDirectJob({ operation: 'generate', request: { max_anlas: 5 } }, { id: 'over' }, 6)
    expect(job).toMatchObject({ status: 'completed', actual_anlas: 6 })
    expect(store.getBatch(String(job.batch_id))).toMatchObject({ spent: 6, reserved: 0 })
    expect(store.getPaused()).toBe(false)
  })
})

describe('schedule status inspection via DSH bridge', () => {
  const harness = () => {
    const wb = new Workbench(temporary()), tools = new Map<string, any>()
    const tasks = new Map<string, Record<string, unknown>>()
    wb.setDshSchedule({
      async create(req) {
        const id = `schedule-${tasks.size + 1}`
        const row = { id, title: req.title, prompt: req.prompt, kind: req.timing.kind, status: 'active', scheduledAt: '2030-01-01T00:00:00Z', target: req.target ?? { kind: 'new_once' }, updatedAt: '2030-01-01T00:00:00Z' }
        tasks.set(id, row); return row
      },
      async list() { const items = [...tasks.values()]; return { items, shown: items.length, total: items.length, limit: 100, offset: 0 } },
      async view({ id }) { return tasks.get(id) ?? { id, code: 'schedule_not_found' } },
      async history({ id }) { return { id, records: [{ deliveredAt: '2030-01-01T00:00:01Z', targetSessionId: 'session-1', trigger: 'scheduled' }] } },
      async run({ id }) { return tasks.get(id) ?? { id, code: 'schedule_not_found' } },
      async edit(req) { const row = tasks.get(req.id); if (!row) return { id: req.id, code: 'schedule_not_found' }; if (req.action === 'delete') { tasks.delete(req.id); return { id: req.id, deleted: true } } return row },
    })
    registerTools({ effect: (fn: () => void) => fn(), tools: { register: (t: any) => tools.set(t.name, t) } } as never, wb)
    return { wb, run: (args: Record<string, unknown>) => tools.get('nai_workbench_status').execute(args, { signal: new AbortController().signal }) }
  }
  it('returns DSH task details and delivery history without mutating store', async () => {
    const { wb, run } = harness()
    const created = await wb.createDshSchedule({ title: 'status', kind: 'daily', time: '09:00', instruction: 'draw a boy' })
    const before = JSON.stringify(wb.store.data)
    const result = await run({ schedule_id: created['id'], job_id: '' })
    expect(result.task).toMatchObject({ id: created['id'], title: 'status', status: 'active' })
    expect(result.history.records).toHaveLength(1)
    expect(JSON.stringify(wb.store.data)).toBe(before)
  })
  it('rejects simultaneous targets and nonexistent tasks without mutation', async () => {
    const { wb, run } = harness(), before = JSON.stringify(wb.store.data)
    await expect(run({ job_id: 'job', schedule_id: 'plan' })).rejects.toThrow(/cannot be combined/)
    await expect(run({ schedule_id: 'absent' })).rejects.toThrow()
    expect(JSON.stringify(wb.store.data)).toBe(before)
  })
  it('accepts blank optional targets and lists DSH schedules in the overview', async () => {
    const { wb, run } = harness()
    const created = await wb.createDshSchedule({ title: 'status', kind: 'interval', interval_minutes: 5, instruction: 'draw a boy' })
    const result = await run({ job_id: '', schedule_id: ' ' })
    expect(result.dsh_schedule_available).toBe(true)
    expect(result.schedules[0]).toMatchObject({ id: created['id'], title: 'status', status: 'active', kind: 'every' })
  })
})
