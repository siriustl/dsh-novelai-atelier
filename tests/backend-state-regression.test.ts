import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { Workbench } from '../src/workbench/app.ts'
import { Worker } from '../src/workbench/worker.ts'
import { Backup } from '../src/workbench/backup.ts'
import { createApiHandler } from '../src/workbench/web.ts'
import { createServer } from 'node:http'
import { encodePng } from '../src/core/png.ts'

const roots: string[] = []
const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'nai-state-')); roots.push(root); return root }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const workbench = () => new Workbench(temporary())

describe('idle worker persistence and wake waiters', () => {
  it('does not persist an unchanged idle queue or paused queue', () => {
    const wb = workbench(); const persist = vi.spyOn(wb.store, 'internalPersist')
    expect(wb.store.claimJob()).toBeNull()
    expect(persist).not.toHaveBeenCalled()
    wb.store.setPaused(true); persist.mockClear()
    expect(wb.store.claimJob()).toBeNull()
    expect(persist).not.toHaveBeenCalled()
  })

  it('claims and persists jobs regardless of legacy batch spending limits', () => {
    const wb = workbench()
    const job = wb.store.createJobs([{ operation: 'generate', request: { prompt: 'x', max_anlas: 1 } }], 1)[0]!
    wb.store.data.batches[0]!.spent = 100
    const persist = vi.spyOn(wb.store, 'internalPersist')
    expect(wb.store.claimJob()).toMatchObject({ id: job.id, status: 'running' })
    expect(persist).toHaveBeenCalledOnce()
    expect(wb.store.getPaused()).toBe(false)
  })

  it('wakes immediately on explicit wake and clears timers on stop', async () => {
    vi.useFakeTimers()
    const worker = new Worker(workbench().store, async () => ({}), 1000)
    const tickSpy = vi.spyOn(worker, 'tick').mockResolvedValue(null)
    worker.start()
    expect(vi.getTimerCount()).toBe(1)
    worker.wake()
    await Promise.resolve()
    expect(tickSpy).toHaveBeenCalledTimes(1)
    worker.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('compact bootstrap compatibility', () => {
  it('returns recent 12 jobs and global counters without parsing library or schedule records', () => {
    const wb = workbench()
    wb.store.saveEntry({ kind: 'character', name: 'one', data: { prompt: 'girl' } })
    const jobs = wb.store.createJobs(Array.from({ length: 20 }, () => ({ operation: 'generate', request: { prompt: 'forest' } })), 0)
    const entries = vi.spyOn(wb.store, 'listEntries'), schedules = vi.spyOn(wb.store, 'listSchedules')
    const compact = wb.bootstrap(true)
    expect(compact.summary).toEqual({ active_jobs: 20, library_count: 1, legacy_schedule_count: 0 })
    expect((compact.jobs as any[]).map((j) => j.id)).toEqual(jobs.slice(-12).reverse().map((j) => j.id))
    expect(compact).not.toHaveProperty('library'); expect(compact).not.toHaveProperty('legacy_schedules')
    expect(entries).not.toHaveBeenCalled(); expect(schedules).not.toHaveBeenCalled()
    const full = wb.bootstrap()
    expect(full.library).toHaveLength(1); expect(full.jobs).toHaveLength(20); expect(full.legacy_schedules).toEqual([])
  })
})

describe('authenticated backend route contracts', () => {
  it('returns compact bootstrapping and draft creation over authenticated routes', async () => {
    const wb = workbench()
    const handler = createApiHandler({ workbench: wb, checkRequest: async () => true })
    const server = createServer((req, res) => { void handler(req, res, '/api/nai') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const base = `http://127.0.0.1:${address.port}/api/nai/api`
    try {
      const compact = await (await fetch(base + '/bootstrap?compact=true')).json()
      expect(compact.summary).toEqual({ active_jobs: 0, library_count: 0, legacy_schedule_count: 0 })
      expect(compact).not.toHaveProperty('library')
      expect(await (await fetch(base + '/bootstrap')).json()).toHaveProperty('library')
      const created = await fetch(base + '/drafts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: { name: 'reviewed', request: { prompt: 'forest' } } }) })
      expect(created.status).toBe(200)
      expect(wb.store.listDrafts()).toHaveLength(2)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('credential-free portable receipt files', () => {
  it('redacts receipt blobs, rehashes them, and relocates their inputs across workbenches', async () => {
    const original = workbench(), restored = workbench()
    const token = 'pst-backup-credential-must-never-travel'
    original.settings.save({ nai_token: token })
    const asset = await original.assets.add(encodePng(1, 1, new Uint8Array([10, 20, 30, 255])), 'source.png')
    const receiptPath = join(original.root, 'receipt.json')
    const receipt = { id: '20260920T123456Z-abcdef0123', operation: 'img2img', status: 'generated', request: { prompt: 'accidentally pasted ' + token, image_path: asset.path, max_anlas: 0 }, api_payload: { input: token }, artifact_paths: [asset.path], nai_token: token }
    writeFileSync(receiptPath, JSON.stringify(receipt))
    original.store.recordDirectJob({ operation: 'img2img', request: receipt.request }, { record_path: receiptPath, artifact_paths: [asset.path], assets: [asset] }, 0)
    const liveBefore = JSON.stringify(original.store.data)
    const exported = new Backup(original).export()
    expect(JSON.stringify(original.store.data)).toBe(liveBefore)
    const files = unzipSync(readFileSync(exported.path))
    const manifest = JSON.parse(strFromU8(files['workbench.json']!))
    const portableRecord = JSON.parse(manifest.tables.jobs[0].result).record_path
    const member = portableRecord.slice('@file/'.length)
    const portableReceipt = JSON.parse(strFromU8(files[member]!))
    expect(portableReceipt).not.toHaveProperty('nai_token')
    expect(JSON.stringify(portableReceipt)).not.toContain(token)
    expect(portableReceipt.request.image_path).toMatch(/^@file\/files\//)
    for (const [name, bytes] of Object.entries(files)) {
      // Endpoint tokens travel in the settings row by design; receipts and assets must not.
      if (name !== 'workbench.json') expect(strFromU8(bytes)).not.toContain(token)
      if (name.startsWith('files/')) expect(name.slice(6, name.lastIndexOf('.'))).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
    const exportedSettings = JSON.parse(manifest.tables.kv.find((row: Rec) => row.key === 'settings').value)
    expect(exportedSettings.nai_endpoints[0].token).toBe(token)
    new Backup(restored).restore(exported.path)
    const job = restored.store.listJobs()[0]!
    const localReceiptPath = (job.result as any).record_path
    const localBytes = readFileSync(localReceiptPath)
    const localReceipt = JSON.parse(localBytes.toString('utf8'))
    expect(localReceipt.request.image_path).toContain(restored.root)
    expect(existsSync(localReceipt.request.image_path)).toBe(true)
    expect(JSON.stringify(localReceipt)).not.toContain(original.root)
    expect(basename(localReceiptPath, '.json')).toBe(createHash('sha256').update(localBytes).digest('hex'))
    expect(restored.settings.public().token_configured).toBe(true)
  })
})
