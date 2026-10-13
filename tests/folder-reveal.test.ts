import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openFolder } from '../src/workbench/reveal.ts'
import { Workbench } from '../src/workbench/app.ts'
import { createApiHandler } from '../src/workbench/web.ts'
import { encodePng } from '../src/core/png.ts'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
const roots: string[] = []
const servers: Server[] = []
function child() {
  const process = Object.assign(new EventEmitter(), { unref: vi.fn() })
  vi.mocked(spawn).mockReturnValue(process as any)
  return process
}
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(spawn).mockReset()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('folder launcher', () => {
  it('launches a visible Explorer with one literal argument in the desktop Node environment', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const launcher = child(), path = 'C:\\images & drafts\\作品, [1]'
    const pending = openFolder(path)
    expect(spawn).toHaveBeenCalledWith(join(process.env['SystemRoot'] || 'C:\\Windows', 'explorer.exe'), [path], { shell: false, stdio: 'ignore', windowsHide: false })
    launcher.emit('spawn'); launcher.emit('close', 1, null)
    await expect(pending).resolves.toBeUndefined()
    expect(launcher.unref).toHaveBeenCalledOnce()
  })
  it('reports a missing Windows launcher instead of claiming success', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const launcher = child(), pending = openFolder('C:\\images')
    launcher.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(pending).rejects.toMatchObject({ name: 'FolderOpenError', message: expect.stringContaining('ENOENT') })
  })
  it.each(['linux', 'darwin'] as const)('waits for the %s launcher and reports a nonzero exit', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    const launcher = child(), pending = openFolder('/images')
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    launcher.emit('spawn'); await Promise.resolve()
    expect(settled).toBe(false)
    launcher.emit('close', 3, null)
    await expect(pending).rejects.toThrow('3')
  })
  it('accepts a successful POSIX launcher exit', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const launcher = child(), pending = openFolder('/images')
    launcher.emit('spawn'); launcher.emit('close', 0, null)
    await expect(pending).resolves.toBeUndefined()
  })
  it('bounds a stalled launcher without killing a user file manager', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux'); vi.useFakeTimers()
    const launcher = child(), pending = openFolder('/images')
    const rejected = expect(pending).rejects.toThrow('启动超时')
    launcher.emit('spawn'); await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(launcher.unref).toHaveBeenCalledOnce()
  })
})

async function server(permitted: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'nai-reveal-')); roots.push(root)
  const wb = new Workbench(root)
  const asset = await wb.assets.add(encodePng(1, 1, new Uint8Array([10, 20, 30, 255])), 'pixel.png')
  const job = wb.store.recordDirectJob({ operation: 'generate', request: {} }, { assets: [asset] }, 0)
  const handle = createApiHandler({ workbench: wb, checkRequest: async () => permitted })
  const http = createServer((req, res) => { void handle(req, res, '/api/nai') }); servers.push(http)
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(http.address() as any).port}/api/nai/api/gallery/reveal`
  return { asset, job, post: (body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
}

describe('authenticated gallery reveal HTTP route', () => {
  it('rejects an unauthenticated reveal before invoking the launcher', async () => {
    const api = await server(false)
    expect((await api.post({ job_id: api.job.id, asset_id: api.asset.id })).status).toBe(403)
    expect(spawn).not.toHaveBeenCalled()
  })
  it('refuses a foreign asset and a client path without launching it', async () => {
    const api = await server(true)
    const response = await api.post({ job_id: api.job.id, asset_id: 'foreign', path: 'C:/private' })
    expect(response.status).toBe(400)
    expect(spawn).not.toHaveBeenCalled()
  })
  it('returns a visible launch acknowledgement for the registered directory', async () => {
    const api = await server(true)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const launcher = child()
    vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => launcher.emit('spawn')); return launcher as any })
    const response = await api.post({ job_id: api.job.id, asset_id: api.asset.id, path: 'C:/private' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ opened: true, directory: dirname(String(api.asset.path)), path: api.asset.path })
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual([dirname(String(api.asset.path))])
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ windowsHide: false })
  })
  it('returns an actionable 503 launcher failure instead of a generic config error', async () => {
    const api = await server(true), launcher = child()
    vi.mocked(spawn).mockImplementation(() => { queueMicrotask(() => launcher.emit('error', new Error('ENOENT'))); return launcher as any })
    const response = await api.post({ job_id: api.job.id, asset_id: api.asset.id })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'FOLDER_OPEN_FAILED', error: expect.stringContaining('ENOENT') })
  })
})
