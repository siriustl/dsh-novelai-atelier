import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { createApiHandler } from '../src/workbench/web.ts'
import { Workbench } from '../src/workbench/app.ts'
import { Backup } from '../src/workbench/backup.ts'
import { Store } from '../src/workbench/store.ts'
import { Worker } from '../src/workbench/worker.ts'

const roots: string[] = []
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'nai-durable-review-'))
  roots.push(root)
  return root
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const snapshot = { operation: 'generate', request: { prompt: 'offline test', max_anlas: 3 } }

describe('reviewed persistence boundaries', () => {
  it('preserves local connection settings when a fresh backup has no settings row', () => {
    const source = new Workbench(temporary())
    const target = new Workbench(temporary())
    const exported = new Backup(source).export()
    expect(source.store.data.kv).not.toHaveProperty('settings')
    target.settings.save({
      nai_token: 'pst-isolated-backup-test-token',
      nai_base_url: 'https://local.invalid', proxy_url: 'http://proxy.invalid',
      output_directory: join(target.root, 'custom-output'),
      ai: { dsh_provider: 'local-provider', dsh_model: 'local-model' },
    })
    const profile = target.settings.saveProfile({ name: 'local profile', dsh_provider: 'profile-provider', dsh_model: 'profile-model' })
    const before = target.settings.raw()
    new Backup(target).restore(exported.path)
    for (const key of ['nai_secret', 'nai_base_url', 'proxy_url', 'output_directory', 'ai', 'ai_profiles']) {
      expect(target.settings.raw()[key]).toEqual(before[key])
    }
    expect(target.settings.naiToken()).toBe('pst-isolated-backup-test-token')
    expect(target.settings.profiles().some((item) => item.id === profile.id)).toBe(true)
    const reopened = new Workbench(target.root)
    expect(reopened.settings.naiToken()).toBe('pst-isolated-backup-test-token')
    expect(reopened.settings.aiConfig()).toEqual(target.settings.aiConfig())
  })

  it.each([false, true])('rolls back a failed settings write with an existing row: %s', (existing) => {
    const store = new Store(temporary())
    if (existing) store.saveSettings({ nai_base_url: 'https://original.invalid', ai: { dsh_model: 'original' } })
    const before = structuredClone(store.data)
    const persist = vi.spyOn(store as unknown as { persist: () => void }, 'persist').mockImplementationOnce(() => { throw new Error('isolated disk failure') })
    expect(() => store.saveSettings({ nai_base_url: 'https://unsaved.invalid' })).toThrow('isolated disk failure')
    expect(store.data).toEqual(before)
    persist.mockRestore()
    store.setPaused(true)
    expect(new Store(roots[roots.length - 1]!).getSettings()).toEqual(existing ? { nai_base_url: 'https://original.invalid', ai: { dsh_model: 'original' } } : {})
  })

  it('rejects a submission whose validation spans a restore', async () => {
    const source = new Workbench(temporary()), target = new Workbench(temporary())
    const exported = new Backup(source).export()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const validate = vi.spyOn(target, 'validate').mockImplementation(async () => {
      await pending
      return { resolved_request: snapshot.request }
    })
    const submission = target.submitJobs({ request: snapshot.request, max_total_anlas: 3, draft_revision: 0 }, 'before-restore')
    expect(validate).toHaveBeenCalledOnce()
    new Backup(target).restore(exported.path)
    const restored = structuredClone(target.store.data)
    release()
    await expect(submission).rejects.toThrow(/恢复|刷新/)
    expect(target.store.data).toEqual(restored)
    expect(target.store.listJobs()).toEqual([])
  })

  it.each(['schedule', 'proposal'])('rejects a stale asynchronous %s write after restore', async (kind) => {
    const source = new Workbench(temporary()), target = new Workbench(temporary())
    const exported = new Backup(source).export()
    let release!: () => void, entered!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const validating = new Promise<void>((resolve) => { entered = resolve })
    vi.spyOn(target, 'validate').mockImplementation(async () => {
      entered()
      await pending
      return { resolved_request: snapshot.request }
    })
    const write = kind === 'schedule'
      ? target.saveSchedule({ name: 'stale schedule', kind: 'once', at: new Date(Date.now() + 3600_000).toISOString(), request: snapshot.request, max_total_anlas: 3, enabled: false })
      : target.applyProposal({ base_revision: 0, patch: { request: { prompt: 'stale proposal' } } })
    await validating
    new Backup(target).restore(exported.path)
    const restored = structuredClone(target.store.data)
    release()
    await expect(write).rejects.toThrow(/恢复|刷新/)
    expect(target.store.data).toEqual(restored)
  })

  it('rejects a slow pre-restore draft write but allows a delayed read', async () => {
    const source = new Workbench(temporary()), target = new Workbench(temporary())
    const exported = new Backup(source).export()
    let bodyStarted!: () => void
    const receivedBody = new Promise<void>((resolve) => { bodyStarted = resolve })
    let authenticated!: () => void
    let readObserved!: () => void
    const readStarted = new Promise<void>((resolve) => { readObserved = resolve })
    const handler = createApiHandler({ workbench: target, checkRequest: async (req) => {
      if (req.method === 'GET') {
        readObserved()
        await new Promise<void>((resolve) => { authenticated = resolve })
      }
      return true
    } })
    const server: Server = createServer((req, res) => {
      req.pause()
      req.once('data', bodyStarted)
      void handler(req, res, '/api/nai')
      queueMicrotask(() => req.resume())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const body = JSON.stringify({ id: 'main', revision: 0, name: 'stale overwrite' })
      let status = 0
      const response = new Promise<void>((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port, path: '/api/nai/api/draft', method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
          status = res.statusCode!
          res.resume()
          res.on('end', resolve)
        })
        req.on('error', reject)
        req.write(body.slice(0, 5))
        void receivedBody.then(() => {
          new Backup(target).restore(exported.path)
          req.end(body.slice(5))
        }).catch(reject)
      })
      await response
      expect(status).toBe(409)
      expect(target.store.getDraft().name).not.toBe('stale overwrite')
      const delayedRead = fetch(`http://127.0.0.1:${port}/api/nai/api/draft`)
      await readStarted
      new Backup(target).restore(exported.path)
      authenticated()
      expect((await delayedRead).status).toBe(200)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('never executes a failed queue submission and permits an idempotent retry', async () => {
    const store = new Store(temporary())
    const previous = store.createJobs([snapshot], 3, 'previous')[0]!
    store.cancelJob(String(previous.id))
    const before = structuredClone(store.data)
    const persist = vi.spyOn(store, 'internalPersist').mockImplementationOnce(() => { throw new Error('isolated disk failure') })
    expect(() => store.createJobs([snapshot], 3, 'failed-submit')).toThrow('isolated disk failure')
    expect(store.data).toEqual(before)
    expect(store.getSubmission('failed-submit', store.data.batches[0]!.fingerprint)).toBeNull()
    persist.mockRestore()
    const runner = vi.fn(async () => ({ anlas_spent: 0 }))
    const worker = new Worker(store, runner)
    expect(await worker.tick()).toBeNull()
    expect(runner).not.toHaveBeenCalled()
    const retry = store.createJobs([snapshot], 3, 'failed-submit')
    expect(retry).toHaveLength(1)
    expect(store.createJobs([snapshot], 3, 'failed-submit')).toEqual(retry)
    expect((await worker.tick())!.id).toBe(retry[0]!.id)
    expect(runner).toHaveBeenCalledOnce()
    expect(new Store(roots[roots.length - 1]!).listJobs()).toHaveLength(2)
  })
})
