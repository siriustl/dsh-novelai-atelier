import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unzipSync } from 'fflate'
import { Workbench } from '../src/workbench/app.ts'
import { createApiHandler } from '../src/workbench/web.ts'
import { encodePng, decodePng } from '../src/core/png.ts'

const fixtures: Array<{ wb: Workbench; server: Server }> = []
const png = () => encodePng(2, 2, new Uint8Array(16).fill(255), { text: [{ keyword: 'Description', text: 'private' }] })
async function fixture() {
  const wb = new Workbench(mkdtempSync(join(tmpdir(), 'nai-upgrade-http-')))
  const handler = createApiHandler({ workbench: wb, checkRequest: async () => true })
  const server = createServer((req, res) => { void handler(req, res, '/custom/nai') })
  fixtures.push({ wb, server })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(server.address() as any).port}/custom/nai/api`
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { wb, base, post }
}
afterEach(async () => {
  for (const { wb, server } of fixtures.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    wb.stop()
    rmSync(wb.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('inspiration API routing', () => {
  it('forwards pagination and source errors under a custom API prefix', async () => {
    const { wb, base } = await fixture()
    const result = { query: 'sky', source: 'all', page: 2, total: 1, hasMore: true, errors: [{ source: 'danbooru', code: 'HTTP_403', message: 'blocked' }], items: [{ id: 'pixiv_1', source: 'pixiv', prompt: 'sky' }] }
    const search = vi.spyOn(wb.inspiration, 'search').mockResolvedValue(result as never)
    const response = await fetch(base + '/inspiration/search?query=sky&source=all&page=2&limit=15')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(result)
    expect(search).toHaveBeenCalledWith({ query: 'sky', source: 'all', page: 2, limit: 15, signal: expect.any(AbortSignal) })
  })
  it.each(['page=0', 'page=-1', 'page=2.5', 'page=NaN', 'limit=0', 'limit=51'])('rejects invalid pagination %s before fetching', async (query) => {
    const { wb, base } = await fixture()
    const search = vi.spyOn(wb.inspiration, 'search')
    expect((await fetch(base + '/inspiration/search?' + query)).status).toBe(400)
    expect(search).not.toHaveBeenCalled()
  })
  it('validates and forwards the optional Pixiv exclusion filter', async () => {
    const { wb, base } = await fixture()
    const result = { query: 'forest', source: 'pixiv', page: 1, total: 0, hasMore: false, errors: [], items: [] }
    const search = vi.spyOn(wb.inspiration, 'search').mockResolvedValue(result as never)
    const response = await fetch(base + '/inspiration/search?q=forest&source=pixiv&pixivAi=exclude')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(result)
    expect(search).toHaveBeenCalledWith({ query: 'forest', source: 'pixiv', page: 1, limit: 24, pixivAi: 'exclude', signal: expect.any(AbortSignal) })
  })
  it.each(['only', '', 'human', '2'])('rejects unsupported Pixiv filters before fetching (%s)', async (filter) => {
    const { wb, base } = await fixture()
    const search = vi.spyOn(wb.inspiration, 'search')
    expect((await fetch(base + '/inspiration/search?pixivAi=' + filter)).status).toBe(400)
    expect(search).not.toHaveBeenCalled()
  })
  it('fetches real detail through the authenticated API surface', async () => {
    const { wb, base } = await fixture()
    const detail = vi.spyOn(wb.inspiration, 'detail').mockResolvedValue({ id: 'aitag_42', source: 'aitag', title: 'work', prompt: 'actual metadata' })
    const response = await fetch(base + '/inspiration/detail?source=aitag&id=42')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ prompt: 'actual metadata' })
    expect(detail).toHaveBeenCalledWith({ source: 'aitag', id: '42', signal: expect.any(AbortSignal) })
  })
  it.each(['http://cdn.donmai.us/a.png', 'https://cdn.donmai.us:8443/a.png', 'https://user:pass@i.pximg.net/a.png', 'https://i.pximg.net.evil.invalid/a.png', 'file:///C:/secret.png', 'http://127.0.0.1/a.png'])('refuses unsafe image relay %s', async (url) => {
    const { wb, base } = await fixture()
    const image = vi.spyOn(wb.inspiration, 'fetchImage')
    expect((await fetch(base + '/inspiration/image?url=' + encodeURIComponent(url))).status).toBe(403)
    expect(image).not.toHaveBeenCalled()
  })
  it('relays Pixiv images with private caching and no MIME sniffing', async () => {
    const { wb, base } = await fixture()
    vi.spyOn(wb.inspiration, 'fetchImage').mockResolvedValue({ buffer: png(), contentType: 'image/png' })
    const response = await fetch(base + '/inspiration/image?url=' + encodeURIComponent('https://s.pximg.net/a.png'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('private')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png())
  })
})

describe('gallery metadata-cleaning boundaries', () => {
  it('refuses arbitrary unregistered local files and poisoned asset records', async () => {
    const { wb, post } = await fixture()
    const path = join(wb.root, 'private.png')
    writeFileSync(path, png())
    expect((await post('/gallery/clean-image', { path })).status).toBe(403)
    const asset = wb.store.addAsset({ path, mime: 'image/png' })
    expect((await post('/gallery/clean-image', { asset_id: asset['id'] })).status).toBe(403)
  })
  it('cleans registered PNGs without mutating originals', async () => {
    const { wb, post } = await fixture()
    const asset = await wb.assets.add(png(), 'original.png')
    const response = await post('/gallery/clean-image', { asset_id: asset['id'], mode: 'all' })
    expect(response.status).toBe(200)
    expect(decodePng(new Uint8Array(await response.arrayBuffer())).text).toEqual([])
    expect((await post('/gallery/clean-image', { path: asset['path'], mode: 'prompts' })).status).toBe(200)
  })
  it('rejects oversized images before reading them', async () => {
    const { wb, post } = await fixture()
    const asset = await wb.assets.add(png(), 'original.png')
    truncateSync(String(asset['path']), 49 * 1024 * 1024)
    expect((await post('/gallery/clean-image', { asset_id: asset['id'] })).status).toBe(413)
  })
  it('does not silently deliver an empty ZIP when nothing can be cleaned', async () => {
    const { wb, post } = await fixture()
    const job = wb.store.recordDirectJob({ operation: 'generate', request: {} }, { assets: [] }, 0)
    expect((await post('/gallery/clean-export', { ids: [job['id']] })).status).toBe(400)
  })
  it('deduplicates selections and exports only cleaned PNG bytes', async () => {
    const { wb, post } = await fixture()
    const asset = await wb.assets.add(png(), 'original.png')
    const job = wb.store.recordDirectJob({ operation: 'generate', request: {} }, { assets: [asset] }, 0)
    const response = await post('/gallery/clean-export', { ids: [job['id'], job['id']], mode: 'all' })
    expect(response.status).toBe(200)
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(Object.keys(files)).toEqual(['artwork-1.png'])
    expect(decodePng(files['artwork-1.png']!).text).toEqual([])
  })
})
