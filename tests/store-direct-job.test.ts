import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/workbench/store.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'nai-direct-'))

describe('recordDirectJob', () => {
  it('direct tool generations appear in the gallery and searches', () => {
    const dir = tmp()
    try {
      const store = new Store(dir)
      const result = {
        id: '20260922T165605Z-a5ea82de-6', operation: 'generate', status: 'generated',
        image_path: 'C:/x/out.png', artifact_paths: ['C:/x/out.png'],
        anlas_spent: 0, seed: 42,
      }
      const snapshot = { operation: 'generate', request: { model: 'nai-diffusion-4-5-full', prompt: 'silver hair test', width: 512, height: 768 }, library_refs: [] }
      const job = store.recordDirectJob(snapshot, { ...result, assets: [{ id: 'a1', path: 'C:/x/out.png', mime: 'image/png', name: 'out.png' }] }, 0)
      expect(job['status']).toBe('completed')
      expect(job['id']).toBe(result.id)
      // gallery default view shows it, with searchable prompt and working asset view
      const page = store.queryJobs({ query: 'silver hair' }) as { items: Array<Record<string, unknown>>; total: number }
      expect(page.total).toBe(1)
      expect(page.items[0]!['id']).toBe(result.id)
      expect((page.items[0]!['assets'] as Array<Record<string, unknown>>)[0]!['id']).toBe('a1')
      // non-image records don't leak into image filters and curate still works
      store.curateJobs([result.id], { archived: true })
      expect((store.queryJobs({}) as { total: number }).total).toBe(0)
      expect((store.queryJobs({ archived: true }) as { total: number }).total).toBe(1)
      // listJobs (bootstrap) includes it
      expect(store.listJobs().some((j) => j['id'] === result.id)).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('spends are recorded and id stays unique across repeats', () => {
    const dir = tmp()
    try {
      const store = new Store(dir)
      const snapshot = { operation: 'upscale', request: { image_path: 'C:/x/in.png', max_anlas: 12 }, library_refs: [] }
      store.recordDirectJob(snapshot, { id: 'op-1', operation: 'upscale', artifact_paths: ['C:/x/in.png'] }, 12)
      store.recordDirectJob({ ...snapshot }, { id: 'op-2', operation: 'upscale', artifact_paths: ['C:/x/in.png'] }, 0)
      const jobs = store.listJobs()
      const first = jobs.find((j) => j['id'] === 'op-1')!
      expect(first['actual_anlas']).toBe(12)
      expect(first['status']).toBe('completed')
      // free generations record a confirmed 0, same as the queue path
      expect(jobs.find((j) => j['id'] === 'op-2')!['actual_anlas']).toBe(0)
      expect(jobs.filter((j) => j['id'] === 'op-1').length).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('clearStaleInternalErrorPause', () => {
  it('clears an internal-error pause persisted by an older session when nothing is actionable', () => {
    const dir = tmp()
    try {
      const store = new Store(dir)
      store.setPaused(true, '队列发生内部错误（Error），请检查任务记录')
      expect(store.getPaused()).toBe(true)
      expect(store.clearStaleInternalErrorPause()).toBe(true)
      expect(store.getPaused()).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('clears stale internal-error pauses with queued work but preserves running and manual pauses', () => {
    const dir = tmp()
    try {
      const store = new Store(dir)
      store.createJobs([{ operation: 'generate', request: { model: 'nai-diffusion-4-5-full', width: 512, height: 768, max_anlas: 0 } }], 0)
      store.setPaused(true, '队列发生内部错误（Error），请检查任务记录')
      expect(store.clearStaleInternalErrorPause()).toBe(true)
      expect(store.getPaused()).toBe(false)
      expect(store.claimJob()).toMatchObject({ status: 'running' })
      store.setPaused(true, '队列发生内部错误（Error），请检查任务记录')
      expect(store.clearStaleInternalErrorPause()).toBe(false)
      store.setPaused(true, '用户手动暂停')
      expect(store.clearStaleInternalErrorPause()).toBe(false)
      expect(store.getPaused()).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each([{ notSubmitted: true }, { actualAnlas: 0 }])('confirmed zero-spend failure settles without pausing: %j', (billing) => {
    const dir = tmp()
    try {
      const store = new Store(dir)
      const jobs = store.createJobs([{ operation: 'generate', request: { model: 'nai-diffusion-5-full', width: 832, height: 1216, max_anlas: 0 } }], 0)
      const job = store.claimJob()!
      expect(job['id']).toBe(jobs[0]!['id'])
      const finished = store.finishJob(job['id'] as string, { error: 'Confirmed rejected before submission or verified zero debit', ...billing })
      expect(finished['status']).toBe('failed')
      expect(finished['actual_anlas']).toBe(0)
      expect(store.getPaused()).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('unknown zero-budget failure does not pause or block the next job', () => {
    const dir = tmp()
    try {
      const store = new Store(dir)
      const jobs = store.createJobs([{ operation: 'generate', request: { max_anlas: 0 } }, { operation: 'generate', request: { max_anlas: 0 } }], 0)
      const job = store.claimJob()!
      const finished = store.finishJob(job['id'] as string, { error: 'Connection lost after submission' })
      expect(finished['status']).toBe('failed')
      expect(finished['actual_anlas']).toBeNull()
      expect(store.getPaused()).toBe(false)
      expect(store.claimJob()).toMatchObject({ id: jobs[1]!.id, status: 'running' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
