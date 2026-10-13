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

describe('live schedule request regression', () => {
  it('normalizes aliases and dimensions, preserving the resolved request on rename', async () => {
    const wb = new Workbench(temporary())
    const plan = await wb.saveSchedule({ name: 'alias', enabled: false, kind: 'once', at: '2030-01-01T01:00:00Z', timezone: 'Asia/Shanghai', operation: 'generate', count: 1, max_runs: 1, max_total_anlas: 0, request: { model: 'v5', sampler: 'Euler', prompt: '1boy, solo, anime illustration', width: 800, height: 1200, seed: 42, max_anlas: 0 } })
    expect(plan.request).toMatchObject({ model: 'nai-diffusion-5-full', sampler: 'k_euler', width: 832, height: 1216, seed: 42 })
    const renamed = await wb.saveSchedule({ name: 'renamed' }, String(plan.id))
    expect(renamed.request).toEqual(plan.request)
    expect(renamed.enabled).toBe(false)
  })
  it('rejects invalid aliases without persisting a plan or jobs', async () => {
    const wb = new Workbench(temporary())
    await expect(wb.saveSchedule({ name: 'bad', enabled: false, kind: 'interval', interval_minutes: 5, operation: 'generate', request: { model: 'not-a-model', prompt: '1boy' } })).rejects.toThrow()
    expect(wb.store.listSchedules()).toEqual([])
    expect(wb.store.listJobs()).toEqual([])
  })
  it('renaming a spent one-shot does not implicitly rearm it', () => {
    const store = new Store(temporary())
    const now = '2026-10-01T00:00:00Z'
    const plan = store.saveSchedule({ name: 'once', enabled: true, kind: 'once', at: now, count: 1, max_runs: 2, operation: 'generate', request: { prompt: '1boy', max_anlas: 0 } }, null, now)
    store.tickSchedules(now)
    expect(store.getSchedule(String(plan.id))).toMatchObject({ enabled: false, runs: 1, next_run: null })
    const renamed = store.saveSchedule({ name: 'renamed' }, String(plan.id), now)
    expect(renamed).toMatchObject({ enabled: false, runs: 1, next_run: null })
    expect(store.tickSchedules(now)).toEqual([])
    expect(store.saveSchedule({ enabled: true }, String(plan.id), now).enabled).toBe(true)
  })
})

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

describe('schedule status inspection', () => {
  const harness = () => {
    const wb = new Workbench(temporary()), tools = new Map<string, any>()
    registerTools({ effect: (fn: () => void) => fn(), tools: { register: (t: any) => tools.set(t.name, t) } } as never, wb)
    return { wb, run: (args: Record<string, unknown>) => tools.get('nai_workbench_status').execute(args, { signal: new AbortController().signal }) }
  }
  it('returns schedule history and assets without frozen connection secrets or submission', async () => {
    const { wb, run } = harness(), stamp = '2030-01-01T00:00:00Z'
    const plan = wb.store.saveSchedule({ name: 'status', enabled: true, kind: 'once', at: stamp, operation: 'generate', request: { prompt: '1boy', max_anlas: 0 }, snapshot: { context: { nai_secret: 'sealed-test-secret', proxy_url: 'private-proxy' } } }, null, stamp)
    wb.store.tickSchedules(stamp)
    const job = wb.store.claimJob(stamp)!
    wb.store.finishJob(String(job.id), { result: { anlas_spent: 0, assets: [{ id: 'asset' }] } })
    const before = JSON.stringify(wb.store.data)
    const result = await run({ schedule_id: plan.id, job_id: '' })
    expect(result.schedule).toMatchObject({ enabled: false, runs: 1, spent: 0 })
    expect(result.runs[0]).toMatchObject({ outcome: 'completed', job_ids: [job.id] })
    expect(result.runs[0].jobs[0].assets).toEqual([{ id: 'asset' }])
    expect(JSON.stringify(result)).not.toContain('sealed-test-secret')
    expect(JSON.stringify(result)).not.toContain('private-proxy')
    expect(JSON.stringify(wb.store.data)).toBe(before)
  })
  it('rejects simultaneous targets and nonexistent plans without mutation', async () => {
    const { wb, run } = harness(), before = JSON.stringify(wb.store.data)
    await expect(run({ job_id: 'job', schedule_id: 'plan' })).rejects.toThrow(/cannot be combined/)
    await expect(run({ schedule_id: 'absent' })).rejects.toThrow()
    expect(JSON.stringify(wb.store.data)).toBe(before)
  })
  it('accepts blank optional targets and includes schedule counters in the overview', async () => {
    const { wb, run } = harness()
    const plan = wb.store.saveSchedule({ name: 'status', enabled: false, kind: 'interval', interval_minutes: 5, operation: 'generate', request: { prompt: '1boy', max_anlas: 0 }, max_runs: 2 })
    const result = await run({ job_id: '', schedule_id: ' ' })
    expect(result.schedules[0]).toMatchObject({ id: plan.id, runs: 0, max_runs: 2, execution_mode: 'fixed' })
    expect(result.schedules[0]).not.toHaveProperty('spent')
    expect(result.schedules[0]).not.toHaveProperty('reserved')
  })
})
