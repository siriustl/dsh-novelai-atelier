import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { Workbench } from '../src/workbench/app.ts'
import { Backup } from '../src/workbench/backup.ts'
import { createApiHandler } from '../src/workbench/web.ts'
import { encodePng } from '../src/core/png.ts'

const roots: string[] = []
const servers: Server[] = []
function workbench(): Workbench { const root = mkdtempSync(join(tmpdir(), 'nai-web-')); roots.push(root); return new Workbench(root) }
async function serve(wb: Workbench, permitted = true): Promise<string> {
  const handler = createApiHandler({ workbench: wb, checkRequest: async () => permitted })
  const server = createServer((req, res) => { void handler(req, res, '/api/nai') }); servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as any).port}/api/nai/api`
}
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('workbench HTTP boundaries', () => {
  it('rejects unauthenticated requests before reading data', async () => {
    const wb = workbench(); const bootstrap = vi.spyOn(wb, 'bootstrap')
    const base = await serve(wb, false)
    expect((await fetch(base + '/bootstrap')).status).toBe(403)
    expect(bootstrap).not.toHaveBeenCalled()
  })

  it('serves registered images but refuses arbitrary files and external asset paths', async () => {
    const wb = workbench(); const base = await serve(wb)
    const asset = await wb.assets.add(encodePng(1, 1, new Uint8Array([10, 20, 30, 255])), 'pixel.png')
    expect((await fetch(base + '/files/' + encodeURIComponent(String(asset['path'])))).status).toBe(200)
    const privateFile = join(wb.root, 'private.txt'); writeFileSync(privateFile, 'private local content')
    expect((await fetch(base + '/files/' + encodeURIComponent(privateFile))).status).toBe(403)
    const poisoned = wb.store.addAsset({ path: privateFile, mime: 'image/png' })
    expect((await fetch(base + '/assets/' + poisoned['id'] + '/file')).status).toBe(403)
    expect((await fetch(base + '/files/%ZZ')).status).toBe(400)
  })

  it('awaits draft proposal validation and returns the actual persisted revision', async () => {
    const wb = workbench(); const base = await serve(wb)
    const response = await fetch(base + '/assistant/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft_id: 'main', base_revision: 0, patch: { request: { prompt: 'Valid offline draft' } } }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'main', revision: 1, request: { prompt: 'Valid offline draft' } })
    const invalid = await fetch(base + '/assistant/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft_id: 'main', base_revision: 1, patch: { request: { steps: 99 } } }) })
    expect(invalid.status).toBe(400)
    expect(wb.store.getDraft()['revision']).toBe(1)
  })

  it('rejects an oversized artwork before attempting to package it', async () => {
    const wb = workbench(); const base = await serve(wb)
    const path = join(wb.root, 'large.png'); writeFileSync(path, new Uint8Array(0)); truncateSync(path, 49 * 1024 * 1024)
    const job = wb.store.recordDirectJob({ operation: 'generate', request: {} }, { assets: [{ id: 'large', path, mime: 'image/png' }] }, 0)
    const response = await fetch(base + '/gallery/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [job['id']] }) })
    expect(response.status).toBe(413)
  })

  it('returns 413 for oversized JSON and applies deletion revision guards', async () => {
    const wb = workbench(); const base = await serve(wb)
    const entry = wb.store.saveEntry({ kind: 'character', name: 'test', data: { prompt: 'boy' } })
    expect((await fetch(base + '/library/' + entry['id'] + '?revision=99', { method: 'DELETE' })).status).toBe(409)
    expect(wb.store.listEntries()).toHaveLength(1)
    expect((await fetch(base + '/library/' + entry['id'] + '?revision=' + entry['revision'], { method: 'DELETE' })).status).toBe(200)
    expect((await fetch(base + '/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: 'x'.repeat(2 * 1024 * 1024) }) })).status).toBe(413)
  })
})

function alteredBackup(wb: Workbench, mutate: (manifest: any) => void): string {
  const exported = new Backup(wb).export()
  const files = unzipSync(readFileSync(exported.path))
  const manifest = JSON.parse(strFromU8(files['workbench.json']!))
  mutate(manifest)
  files['workbench.json'] = strToU8(JSON.stringify(manifest))
  const path = join(wb.root, 'altered.zip'); writeFileSync(path, zipSync(files)); return path
}

describe('backup import security', () => {
  it('rejects arbitrary imported asset paths without changing live state', () => {
    const wb = workbench(); const original = JSON.stringify(wb.store.data)
    const path = alteredBackup(wb, (manifest) => { manifest.tables.assets.push({ id: 'bad', data: JSON.stringify({ path: 'C:/private/token.txt' }) }) })
    expect(() => new Backup(wb).restore(path)).toThrow(/素材必须/)
    expect(JSON.stringify(wb.store.data)).toBe(original)
  })

  it('keeps default private endpoints and model settings instead of importing remote destinations', () => {
    const wb = workbench()
    const path = alteredBackup(wb, (manifest) => { manifest.tables.kv.push({ key: 'settings', value: JSON.stringify({ nai_base_url: 'https://attacker.invalid', proxy_url: 'http://attacker.invalid', ai: { dsh_provider: 'attacker' }, ai_profiles: { remote: { dsh_provider: 'attacker' } } }) }) })
    const before = wb.settings.raw()
    new Backup(wb).restore(path)
    expect(wb.settings.raw()['nai_base_url']).toBe(before['nai_base_url'])
    expect(wb.settings.raw()['proxy_url']).toBe(before['proxy_url'])
    expect(wb.settings.raw()['ai']).toEqual(before['ai'])
    expect(wb.settings.raw()['ai_profiles']).toEqual({})
  })
})
