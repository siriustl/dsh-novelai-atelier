import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/workbench/store.ts'
import { Worker } from '../src/workbench/worker.ts'
import { Workbench } from '../src/workbench/app.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nai-simple-store-')) })
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); rmSync(root, { recursive: true, force: true }) })
const snapshot = { operation: 'generate', request: { prompt: 'forest', max_anlas: 9 } }
const stamp = '2030-01-01T00:00:00Z'
const intervalPlan = () => ({ name: 'interval', enabled: true, kind: 'interval', interval_minutes: 5, operation: 'generate', request: snapshot.request, count: 2, max_runs: 2, max_total_anlas: 0 })
const failNextWrite = (store: Store) => vi.spyOn(store, 'internalPersist').mockImplementationOnce(() => { throw new Error('disk full') })

describe('transaction persistence rollback', () => {
  it('failed claim leaves the job queued without a ghost running job, then persists a retry', () => {
    const store = new Store(root)
    const job = store.createJobs([snapshot], 0)[0]!
    const before = structuredClone(store.data)
    failNextWrite(store)
    expect(() => store.claimJob(stamp)).toThrow('disk full')
    expect(store.data).toEqual(before)
    expect(store.getJob(String(job.id))).toMatchObject({ status: 'queued', attempts: 0, started_at: null })
    expect(new Store(root).data).toEqual(before)
    expect(store.claimJob(stamp)).toMatchObject({ id: job.id, status: 'running', attempts: 1 })
    expect(new Store(root).getJob(String(job.id))).toMatchObject({ status: 'running', attempts: 1 })
    store.finishJob(String(job.id), { result: { artifact_paths: ['forest.png'] } })
    expect(new Store(root).getJob(String(job.id))).toMatchObject({ status: 'completed', actual_anlas: null })
  })

  it('failed new entry never resurfaces through an unrelated successful write', () => {
    const store = new Store(root)
    const before = structuredClone(store.data)
    failNextWrite(store)
    expect(() => store.saveEntry({ kind: 'character', name: 'failed new', data: { prompt: 'girl' } })).toThrow('disk full')
    expect(store.data).toEqual(before)
    store.setPaused(false)
    expect(new Store(root).listEntries()).toEqual([])
    const saved = store.saveEntry({ kind: 'character', name: 'successful new', data: { prompt: 'boy' } })
    expect(new Store(root).getEntry(String(saved.id))).toMatchObject({ name: 'successful new', revision: 0 })
  })

  it('failed entry update restores content and revision through a later unrelated write', () => {
    const store = new Store(root)
    const entry = store.saveEntry({ kind: 'character', name: 'original', data: { prompt: 'girl' } })
    const before = structuredClone(store.data)
    failNextWrite(store)
    expect(() => store.saveEntry({ name: 'failed update', data: { prompt: 'boy' } }, String(entry.id), 0)).toThrow('disk full')
    expect(store.data).toEqual(before)
    store.createJobs([snapshot], 0)
    expect(new Store(root).getEntry(String(entry.id))).toEqual(entry)
    const saved = store.saveEntry({ name: 'successful update' }, String(entry.id), 0)
    expect(new Store(root).getEntry(String(entry.id))).toMatchObject({ name: saved.name, revision: 1 })
  })

  it('failed schedule creation leaves no schedule to resurrect and a retry persists', () => {
    const store = new Store(root)
    const before = structuredClone(store.data)
    failNextWrite(store)
    expect(() => store.saveSchedule(intervalPlan(), null, stamp)).toThrow('disk full')
    expect(store.data).toEqual(before)
    store.setPaused(false)
    expect(new Store(root).listSchedules()).toEqual([])
    const plan = store.saveSchedule(intervalPlan(), null, stamp)
    expect(new Store(root).getSchedule(String(plan.id))).toMatchObject({ name: 'interval', enabled: true, runs: 0 })
  })

  it('failed schedule update rolls back cancellations of pending jobs', () => {
    const store = new Store(root)
    const plan = store.saveSchedule(intervalPlan(), null, stamp)
    const jobs = store.tickSchedules('2030-01-01T00:05:00Z')
    const before = structuredClone(store.data)
    failNextWrite(store)
    expect(() => store.saveSchedule({ name: 'failed rename', enabled: false }, String(plan.id), stamp)).toThrow('disk full')
    expect(store.data).toEqual(before)
    store.setPaused(false)
    const reopened = new Store(root)
    expect(reopened.getSchedule(String(plan.id))).toMatchObject({ name: 'interval', enabled: true, revision: 0 })
    expect(jobs.map((job) => reopened.getJob(String(job.id)).status)).toEqual(['queued', 'queued'])
  })

  it('failed schedule tick rolls back jobs, batches, run history and occurrence counters', () => {
    const store = new Store(root)
    const plan = store.saveSchedule(intervalPlan(), null, stamp)
    const before = structuredClone(store.data)
    const due = '2030-01-01T00:05:00Z'
    failNextWrite(store)
    expect(() => store.tickSchedules(due)).toThrow('disk full')
    expect(store.data).toEqual(before)
    expect(new Store(root).data).toEqual(before)
    store.setPaused(false)
    expect(new Store(root).listScheduleRuns(String(plan.id))).toEqual([])
    const jobs = store.tickSchedules(due)
    expect(jobs).toHaveLength(2)
    expect(store.tickSchedules(due)).toEqual([])
    const reopened = new Store(root)
    expect(reopened.listJobs()).toHaveLength(2)
    expect(reopened.data.batches).toHaveLength(1)
    expect(reopened.listScheduleRuns(String(plan.id))).toHaveLength(1)
    expect(reopened.getSchedule(String(plan.id))).toMatchObject({ runs: 1, enabled: true })
  })

  it('failed finish does not commit a result or duplicate reported spend on retry', () => {
    const store = new Store(root)
    const job = store.createJobs([snapshot], 0)[0]!
    store.claimJob(stamp)
    const before = structuredClone(store.data)
    failNextWrite(store)
    expect(() => store.finishJob(String(job.id), { result: { anlas_spent: 3 } })).toThrow('disk full')
    expect(store.data).toEqual(before)
    expect(new Store(root).getJob(String(job.id))).toMatchObject({ status: 'running', actual_anlas: null })
    store.finishJob(String(job.id), { result: { anlas_spent: 3 } })
    const reopened = new Store(root)
    expect(reopened.getBatch(String(job.batch_id)).spent).toBe(3)
    expect(reopened.getJob(String(job.id))).toMatchObject({ status: 'completed', actual_anlas: 3 })
  })

  it('failed direct registration leaves no gallery record or orphan batch', () => {
    const store = new Store(root)
    const before = structuredClone(store.data)
    failNextWrite(store)
    expect(() => store.recordDirectJob(snapshot, { id: 'direct' }, null)).toThrow('disk full')
    expect(store.data).toEqual(before)
    store.setPaused(false)
    expect(new Store(root).listJobs()).toEqual([])
    expect(new Store(root).data.batches).toEqual([])
    store.recordDirectJob(snapshot, { id: 'direct' }, null)
    expect(new Store(root).getJob('direct')).toMatchObject({ status: 'completed', actual_anlas: null })
  })
})

describe('simplified queue and gallery lifecycle', () => {
  it('keeps a generated result after a failed finish write and retries storage before another job', async () => {
    const wb = new Workbench(root)
    const jobs = wb.store.createJobs([snapshot, snapshot], 0)
    const result = { artifact_paths: ['original.png'], assets: [{ id: 'image', path: 'original.png' }], anlas_spent: null }
    const runner = vi.fn(async () => {
      failNextWrite(wb.store)
      return result
    })
    wb.worker = new Worker(wb.store, runner)
    vi.spyOn(wb.worker as any, 'waitInterval').mockResolvedValue(undefined)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await (wb.worker as any).safeTick()
    expect(runner).toHaveBeenCalledOnce()
    expect(wb.store.getJob(String(jobs[0]!.id))).toMatchObject({ status: 'running', result: null })
    expect(wb.store.getJob(String(jobs[1]!.id)).status).toBe('queued')
    expect(wb.bootstrap().worker_error).toContain('disk full')
    expect(log).toHaveBeenCalledOnce()
    expect(wb.store.getPaused()).toBe(false)
    expect(await wb.worker.tick(stamp)).toMatchObject({ id: jobs[0]!.id, status: 'completed', actual_anlas: null, result })
    expect(runner).toHaveBeenCalledOnce()
    expect(wb.bootstrap().worker_error).toBeNull()
    const reopened = new Store(root)
    expect(reopened.getJob(String(jobs[0]!.id))).toMatchObject({ status: 'completed', result })
    expect(reopened.getJob(String(jobs[1]!.id)).status).toBe('queued')
  })

  it('duplicate direct result ids are idempotent without duplicate accounting or writes', () => {
    const store = new Store(root)
    const first = store.recordDirectJob(snapshot, { id: 'direct', artifact_paths: ['first.png'] }, 3)
    const before = structuredClone(store.data)
    const persist = vi.spyOn(store, 'internalPersist')
    const second = store.recordDirectJob({ operation: 'upscale', request: { prompt: 'different' } }, { id: 'direct', artifact_paths: ['second.png'] }, 100)
    expect(second).toEqual(first)
    expect(store.data).toEqual(before)
    expect(persist).not.toHaveBeenCalled()
    const reopened = new Store(root)
    expect(reopened.listJobs()).toHaveLength(1)
    expect(reopened.data.batches).toHaveLength(1)
    expect(reopened.getBatch(String(first.batch_id)).spent).toBe(3)
  })

  it('unknown direct failures leave enabled schedules unchanged and independent jobs runnable', () => {
    const store = new Store(root)
    const plan = store.saveSchedule(intervalPlan(), null, stamp)
    const beforeSchedule = store.getSchedule(String(plan.id))
    const job = store.recordDirectJob(snapshot, { id: 'lost', submission_outcome_unknown: true, error: 'connection lost' }, null)
    expect(job).toMatchObject({ status: 'failed', actual_anlas: null })
    expect(store.getSchedule(String(plan.id))).toEqual(beforeSchedule)
    expect(store.getPaused()).toBe(false)
    const next = store.createJobs([snapshot], 0)[0]!
    expect(store.claimJob(stamp)).toMatchObject({ id: next.id, status: 'running' })
  })

  it('a worker failure does not alter enabled schedules or retry the failed job', async () => {
    const store = new Store(root)
    const plan = store.saveSchedule(intervalPlan(), null, stamp)
    const beforeSchedule = store.getSchedule(String(plan.id))
    const jobs = store.createJobs([snapshot, snapshot], 0)
    const runner = vi.fn().mockRejectedValueOnce(new Error('connection lost after POST')).mockResolvedValueOnce({ artifact_paths: ['new.png'] })
    const worker = new Worker(store, runner)
    expect(await worker.tick(stamp)).toMatchObject({ id: jobs[0]!.id, status: 'failed', actual_anlas: null })
    expect(store.getSchedule(String(plan.id))).toEqual(beforeSchedule)
    expect(await worker.tick(stamp)).toMatchObject({ id: jobs[1]!.id, status: 'completed', actual_anlas: null })
    expect(runner).toHaveBeenCalledTimes(2)
    expect(store.getPaused()).toBe(false)
  })

  it('ignores a legacy billing marker without reading, removing or blocking on it', () => {
    const markerPath = join(root, 'billing-review-required.json')
    const marker = 'not valid JSON, must never be read by the store'
    writeFileSync(markerPath, marker)
    vi.mocked(readFileSync).mockClear()
    const store = new Store(root)
    store.saveSettings({ output_directory: root })
    store.recoverInterrupted()
    const job = store.createJobs([snapshot], 0)[0]!
    expect(store.claimJob()).toMatchObject({ id: job.id, status: 'running' })
    expect(store.getPaused()).toBe(false)
    expect(vi.mocked(readFileSync).mock.calls.some(([path]) => String(path) === markerPath)).toBe(false)
    expect(readFileSync(markerPath, 'utf8')).toBe(marker)
  })

  it('retains count limits and schedule run limits despite obsolete monetary fields', () => {
    const store = new Store(root)
    expect(() => store.saveSchedule({ ...intervalPlan(), count: 51 }, null, stamp)).toThrow()
    expect(() => store.saveSchedule({ ...intervalPlan(), max_runs: 0 }, null, stamp)).toThrow()
    const plan = store.saveSchedule({ ...intervalPlan(), max_runs: 1 }, null, stamp)
    expect(store.tickSchedules('2030-01-01T00:05:00Z')).toHaveLength(2)
    expect(store.getSchedule(String(plan.id))).toMatchObject({ runs: 1, enabled: false, next_run: null })
    expect(store.tickSchedules('2030-01-01T00:10:00Z')).toEqual([])
    expect(() => store.scheduleOnce(String(plan.id), 0, 'more')).toThrow(/次数上限/)
  })
})

describe('legacy persisted state migration', () => {
  it.each(['needs_review', 'budget_blocked', 'running'])('normalizes legacy %s jobs once without resubmitting them', (status) => {
    const initial = new Store(root)
    const jobs = initial.createJobs([snapshot, snapshot], 0)
    initial.data.jobs[0]!.status = status
    initial.data.jobs[0]!.result = JSON.stringify({ artifact_paths: ['existing.png'] })
    initial.data.jobs[0]!.reserved = 9
    initial.data.jobs[1]!.status = status
    initial.data.jobs[1]!.reserved = 9
    initial.data.batches[0]!.reserved = 18
    initial.internalPersist()
    const store = new Store(root)
    expect(store.recoverInterrupted()).toBe(2)
    expect(store.getJob(String(jobs[0]!.id))).toMatchObject({ status: 'completed', actual_anlas: null })
    expect(store.getJob(String(jobs[1]!.id))).toMatchObject({ status: 'failed', actual_anlas: null })
    expect(store.data.jobs.every((job) => job.reserved === 0)).toBe(true)
    expect(store.getBatch(String(jobs[0]!.batch_id)).reserved).toBe(0)
    expect(store.claimJob()).toBeNull()
    const reopened = new Store(root)
    expect(reopened.recoverInterrupted()).toBe(0)
    expect(reopened.listJobs().map((job) => job.status).sort()).toEqual(['completed', 'failed'])
    const fresh = reopened.createJobs([snapshot], 0)[0]!
    expect(reopened.claimJob()).toMatchObject({ id: fresh.id, status: 'running' })
  })

  it.each([
    ['任务结果或计费需要核对；不会自动重试', false],
    ['队列发生内部错误（Error），请检查任务记录', false],
    ['用户手动暂停', true],
    ['备份恢复后暂停，等待核对', true],
    ['用户暂停：稍后核对图片', true],
    ['上次运行中断，需要核对任务结果', false],
    [null, true],
  ] as const)('migrates only obsolete automatic pauses: %s', (reason, paused) => {
    const initial = new Store(root)
    initial.setPaused(true, reason)
    const store = new Store(root)
    store.recoverInterrupted()
    expect(store.getPaused()).toBe(paused)
    expect(new Store(root).getPaused()).toBe(paused)
  })
})
