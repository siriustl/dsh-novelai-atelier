import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { Workbench } from '../src/workbench/app.ts'
import { Worker } from '../src/workbench/worker.ts'
import { createDshLlmBridge } from '../src/workbench/dshLlm.ts'
import { Backup } from '../src/workbench/backup.ts'
import { createApiHandler } from '../src/workbench/web.ts'
import { createServer } from 'node:http'
import { encodePng } from '../src/core/png.ts'

const roots: string[] = []
const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'nai-state-')); roots.push(root); return root }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const workbench = () => new Workbench(temporary())

describe('conversation profile routing', () => {
  it('uses the saved profile route instead of the default workbench channel', async () => {
    const wb = workbench()
    wb.settings.save({ ai: { dsh_provider: 'default-p', dsh_model: 'default-m' } })
    const profile = wb.settings.saveProfile({ name: 'selected', dsh_provider: 'selected-p', dsh_model: 'selected-m' })
    const stream = vi.fn(async function* () { yield { type: 'text-delta', text: 'OK' } })
    wb.setDshLlm(createDshLlmBridge({ stream }, () => ({ provider: 'host-p', model: 'host-m' })))
    const conv = wb.store.saveConversation({ profile_id: profile.id })
    const run = wb.conversations.start(String(conv.id), { message: 'suggest a landscape' }, 'profile-route')
    await vi.waitFor(() => expect(wb.store.getAssistantRun(String(run.id)).status).toBe('completed'))
    expect(stream).toHaveBeenCalledOnce()
    expect(stream.mock.calls[0]![0]).toMatchObject({ provider: 'selected-p', model: 'selected-m' })
  })
})

describe('idle worker persistence and wake waiters', () => {
  it('does not persist an unchanged idle queue or paused queue', () => {
    const wb = workbench(); const persist = vi.spyOn(wb.store, 'internalPersist')
    expect(wb.store.claimJob()).toBeNull(); expect(wb.store.claimScheduleRun()).toBeNull()
    expect(persist).not.toHaveBeenCalled()
    wb.store.setPaused(true); persist.mockClear()
    expect(wb.store.claimJob()).toBeNull(); expect(wb.store.claimScheduleRun()).toBeNull()
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

  it('removes expired idle wake callbacks and clears callbacks on explicit wake', async () => {
    vi.useFakeTimers()
    const worker = new Worker(workbench().store, async () => ({}), null, 10) as any
    for (let i = 0; i < 20; i++) {
      const pending = worker.waitInterval()
      expect(worker.wakeWaiters).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(10); await pending
      expect(worker.wakeWaiters).toHaveLength(0)
    }
    const pending = worker.waitInterval(); worker.wake(); await pending
    expect(worker.wakeWaiters).toHaveLength(0); expect(vi.getTimerCount()).toBe(0)
  })
})

describe('reviewable action asynchronous validation and nested conflicts', () => {
  it('does not persist a draft-create proposal whose request fails asynchronous validation', async () => {
    const wb = workbench()
    await expect(wb.workspace.propose('drafts.create', { draft: { name: 'invalid', request: { prompt: 'forest', steps: 99 } } })).rejects.toThrow()
    expect(wb.store.data.workspace_proposals).toHaveLength(0)
    expect(wb.store.listDrafts()).toHaveLength(1)
  })

  it('waits for a schedule copy before recording its result and replays the complete receipt', async () => {
    const wb = workbench()
    const schedule = await wb.saveSchedule({ name: 'original', kind: 'once', at: new Date(Date.now() + 3600_000).toISOString(), request: { prompt: 'forest' }, enabled: false })
    const proposal = await wb.workspace.propose('schedules.copy', { schedule_id: schedule.id })
    const result = await wb.workspace.apply(String(proposal.id))
    expect(result.result).toMatchObject({ name: 'original · 副本', enabled: false })
    expect(await wb.workspace.apply(String(proposal.id))).toEqual(result)
    expect(wb.store.listSchedules()).toHaveLength(2)
  })

  it('rejects a settings action after a nested DSH channel change', async () => {
    const wb = workbench()
    const proposal = await wb.workspace.propose('settings.update', { settings: { output_directory: join(wb.root, 'new-output') } })
    wb.settings.save({ ai: { dsh_model: 'changed-after-review' } })
    await expect(wb.workspace.apply(String(proposal.id))).rejects.toThrow(/已更改/)
    expect(wb.settings.raw().output_directory).not.toBe(join(wb.root, 'new-output'))
  })
})

describe('compact bootstrap compatibility', () => {
  it('returns recent 12 jobs and global counters without parsing library or schedule records', () => {
    const wb = workbench()
    wb.store.saveEntry({ kind: 'character', name: 'one', data: { prompt: 'girl' } })
    const jobs = wb.store.createJobs(Array.from({ length: 20 }, () => ({ operation: 'generate', request: { prompt: 'forest' } })), 0)
    const entries = vi.spyOn(wb.store, 'listEntries'), schedules = vi.spyOn(wb.store, 'listSchedules')
    const compact = wb.bootstrap(true)
    expect(compact.summary).toEqual({ active_jobs: 20, library_count: 1, schedule_count: 0 })
    expect((compact.jobs as any[]).map((j) => j.id)).toEqual(jobs.slice(-12).reverse().map((j) => j.id))
    expect(compact).not.toHaveProperty('library'); expect(compact).not.toHaveProperty('schedules')
    expect(entries).not.toHaveBeenCalled(); expect(schedules).not.toHaveBeenCalled()
    const legacy = wb.bootstrap()
    expect(legacy.library).toHaveLength(1); expect(legacy.jobs).toHaveLength(20); expect(legacy.schedules).toEqual([])
  })
})

describe('authenticated backend route contracts', () => {
  it('returns compact bootstrapping and complete awaited action receipts', async () => {
    const wb = workbench()
    const handler = createApiHandler({ workbench: wb, checkRequest: async () => true })
    const server = createServer((req, res) => { void handler(req, res, '/api/nai') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const base = `http://127.0.0.1:${address.port}/api/nai/api`
    try {
      const compact = await (await fetch(base + '/bootstrap?compact=true')).json()
      expect(compact.summary).toEqual({ active_jobs: 0, library_count: 0, schedule_count: 0 })
      expect(compact).not.toHaveProperty('library')
      expect(await (await fetch(base + '/bootstrap')).json()).toHaveProperty('library')
      const proposal = await wb.workspace.propose('drafts.create', { draft: { name: 'reviewed', request: { prompt: 'forest' } } })
      const applied = await fetch(base + '/assistant/actions/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposal_id: proposal.id }) })
      expect(applied.status).toBe(200)
      expect(await applied.json()).toMatchObject({ action: 'drafts.create', draft: { name: 'reviewed' }, result: { draft: { name: 'reviewed' } } })
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
      expect(strFromU8(bytes)).not.toContain(token)
      if (name.startsWith('files/')) expect(name.slice(6, name.lastIndexOf('.'))).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
    new Backup(restored).restore(exported.path)
    const job = restored.store.listJobs()[0]!
    const localReceiptPath = (job.result as any).record_path
    const localBytes = readFileSync(localReceiptPath)
    const localReceipt = JSON.parse(localBytes.toString('utf8'))
    expect(localReceipt.request.image_path).toContain(restored.root)
    expect(existsSync(localReceipt.request.image_path)).toBe(true)
    expect(JSON.stringify(localReceipt)).not.toContain(original.root)
    expect(basename(localReceiptPath, '.json')).toBe(createHash('sha256').update(localBytes).digest('hex'))
    expect(restored.settings.public().token_configured).toBe(false)
  })
})
