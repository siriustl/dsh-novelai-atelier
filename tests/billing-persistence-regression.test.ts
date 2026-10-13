import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/workbench/store.ts'
import { JsonDoc } from '../src/workbench/util.ts'
import { JobNotSubmitted, Worker } from '../src/workbench/worker.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nai-accounting-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const snapshot = (budget: number) => ({ operation: 'generate', request: { prompt: 'test', max_anlas: budget } })

describe('fail-closed document load', () => {
  it('initializes a missing document but never overwrites malformed existing bytes', () => {
    const missing = new JsonDoc(join(root, 'missing.json'), { value: 1 })
    expect(missing.load()).toEqual({ value: 1 })
    const path = join(root, 'workbench.json')
    const damaged = '{"jobs":[{"status":"running"}],"kv":'
    writeFileSync(path, damaged)
    expect(() => new Store(root)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(damaged)
  })

  it('does not convert other filesystem errors into a fresh document', () => {
    expect(() => new JsonDoc(root, { value: 1 }).load()).toThrow()
  })
})

describe('reported spend is informational', () => {
  it('records a reported charge without pausing or disabling the schedule', () => {
    const store = new Store(root)
    const schedule = store.saveSchedule({
      name: 'reported spend', kind: 'interval', interval_minutes: 5,
      operation: 'generate', request: snapshot(0).request, count: 1, max_runs: 3,
      max_total_anlas: 0, enabled: true,
    })
    const jobs = store.createJobs([snapshot(0)], 0, null, { scheduleId: String(schedule.id) })
    const claimed = store.claimJob()!
    expect(claimed.id).toBe(jobs[0]!.id)
    const result = store.finishJob(String(claimed.id), { result: { anlas_spent: 2 } })
    expect(result).toMatchObject({ status: 'completed', actual_anlas: 2 })
    expect(store.getPaused()).toBe(false)
    expect(store.getBatch(String(claimed.batch_id)).spent).toBe(2)
    expect(store.getSchedule(String(schedule.id))).toMatchObject({ spent: 2, enabled: true })
    const reopened = new Store(root)
    expect(reopened.getJob(String(claimed.id))).toMatchObject({ status: 'completed', actual_anlas: 2 })
    expect(reopened.getPaused()).toBe(false)
    expect(reopened.getSchedule(String(schedule.id)).enabled).toBe(true)
  })

  it.each([{}, { anlas_spent: null }, { anlas_spent: 0 }])('completes a successful result without requiring billing evidence: %j', (result) => {
    const store = new Store(root)
    store.createJobs([snapshot(0)], 0)
    const claimed = store.claimJob()!
    expect(store.finishJob(String(claimed.id), { result })).toMatchObject({ status: 'completed', actual_anlas: result.anlas_spent ?? null })
    expect(store.getPaused()).toBe(false)
  })
})

describe('worker uncertain outcomes', () => {
  it.each([0, 5])('preserves unknown spend as an ordinary failure and continues with legacy budget %i', async (budget) => {
    const store = new Store(root)
    const jobs = store.createJobs([snapshot(budget), snapshot(budget)], budget)
    let calls = 0
    const worker = new Worker(store, async () => {
      if (++calls === 1) throw new Error('connection lost after submission')
      return { artifact_paths: ['result.png'] }
    })
    const failed = (await worker.tick())!
    expect(failed).toMatchObject({ id: jobs[0]!.id, status: 'failed', actual_anlas: null })
    expect(store.getBatch(String(failed.batch_id)).reserved).toBe(0)
    expect(store.getPaused()).toBe(false)
    expect(await worker.tick()).toMatchObject({ id: jobs[1]!.id, status: 'completed', actual_anlas: null })
    expect(calls).toBe(2)
  })

  it('records a proven pre-submission failure as zero without pausing', async () => {
    const store = new Store(root)
    store.createJobs([snapshot(5)], 5)
    const worker = new Worker(store, async () => { throw new JobNotSubmitted('failed preflight') })
    expect(await worker.tick()).toMatchObject({ status: 'failed', actual_anlas: 0 })
    expect(store.getPaused()).toBe(false)
  })
})
