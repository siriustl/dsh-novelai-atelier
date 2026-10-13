import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import sharp from 'sharp'
import { applyStoreEntries } from '../src/workbench/storeEntries.ts'
import { emptyStoreData } from '../src/workbench/storeDoc.ts'
import type { Store, Rec } from '../src/workbench/store.ts'
import { Workbench } from '../src/workbench/app.ts'
import { createApiHandler } from '../src/workbench/web.ts'
import { encodePng } from '../src/core/png.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function memoryStore(): Store {
  const data = emptyStoreData()
  const store = {
    data,
    internalPersist: vi.fn(),
    _findEntry: (id: string) => data.entries.find((entry) => entry.id === id),
    _entryRow: (row: Rec) => ({ ...row, data: JSON.parse(String(row['data'])) }),
  } as unknown as Store
  applyStoreEntries(store)
  return store
}

const validEntry = { id: 'first', kind: 'character', name: 'Valid character', data: { prompt: 'boy' } }

describe('review fixes: atomic library imports', () => {
  it.each([
    { id: 'bad', kind: 'unknown', name: 'Invalid kind', data: {} },
    { id: 'bad', kind: 'blend', name: 'Invalid dependency', data: { artists: [{ id: 'missing' }] } },
    { id: 'bad', kind: 'character', name: 'Invalid example', data: { examples: ['missing'] } },
  ])('does not retain a valid first entry when a later entry is invalid', (bad) => {
    const store = memoryStore()
    const before = JSON.stringify(store.data)
    expect(() => store.importEntries([validEntry, bad])).toThrow()
    expect(JSON.stringify(store.data)).toBe(before)
    expect(store.internalPersist).not.toHaveBeenCalled()
  })

  it('does not partly overwrite an existing entry on a failed merge', () => {
    const store = memoryStore()
    const existing = store.saveEntry({ kind: 'character', name: 'Existing', data: { prompt: 'original' } })
    const before = JSON.stringify(store.data)
    vi.mocked(store.internalPersist).mockClear()
    expect(() => store.importEntries([
      { ...validEntry, id: existing['id'], data: { prompt: 'replacement' } },
      { id: 'bad', kind: 'invalid', name: 'Bad', data: {} },
    ], { [String(existing['id'])]: 'update' }, { [String(existing['id'])]: existing['revision'] })).toThrow()
    expect(JSON.stringify(store.data)).toBe(before)
    expect(store.internalPersist).not.toHaveBeenCalled()
  })

  it('restores the live entries when persistence fails', () => {
    const store = memoryStore()
    const previous = store.data.entries
    vi.mocked(store.internalPersist).mockImplementationOnce(() => { throw new Error('disk failure') })
    expect(() => store.importEntries([validEntry])).toThrow('disk failure')
    expect(store.data.entries).toBe(previous)
    expect(store.data.entries).toHaveLength(0)
  })

  it('commits a valid batch once with rebound parent and artist references', () => {
    const store = memoryStore()
    const imported = store.importEntries([
      validEntry,
      { id: 'branch', kind: 'branch', parent_id: 'first', name: 'Branch', data: {} },
      { id: 'artist', kind: 'artist', name: 'Artist', data: { prompt: 'artist:example' } },
      { id: 'blend', kind: 'blend', name: 'Blend', data: { artists: [{ id: 'artist', weight: 0.8 }] } },
    ])
    const map = imported['id_map'] as Record<string, string>
    expect(imported['entries_imported']).toBe(4)
    expect(store.getEntry(map['branch']!)['parent_id']).toBe(map['first'])
    expect((store.getEntry(map['blend']!)['data'] as Rec)['artists']).toEqual([{ id: map['artist'], weight: 0.8 }])
    expect(store.internalPersist).toHaveBeenCalledTimes(1)
  })
})

type Handler = ReturnType<typeof createApiHandler>
async function invoke(handler: Handler, route: string, method = 'GET', body?: Rec): Promise<{ status: number; bytes: Buffer }> {
  const req = new EventEmitter() as IncomingMessage
  req.url = '/api/nai/api/' + route
  req.method = method
  req.headers = { 'content-type': 'application/json' }
  let status = 0
  let bytes = Buffer.alloc(0)
  const res = {
    writeHead(value: number) { status = value },
    end(value: Uint8Array) { bytes = Buffer.from(value) },
  } as unknown as ServerResponse
  const pending = handler(req, res, '/api/nai')
  if (body) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  await pending
  return { status, bytes }
}

function apiFor(job: Rec): Handler {
  const wb = {
    maintenance: false,
    store: {
      queryJobs: () => ({ items: [structuredClone(job)], total: 1, offset: 0, limit: 48 }),
      getJob: () => structuredClone(job),
    },
  } as unknown as Workbench
  return createApiHandler({ workbench: wb, checkRequest: async () => true })
}

describe('review fixes: gallery sharing privacy', () => {
  it('does not expose the frozen connection context in gallery pages', async () => {
    const response = await invoke(apiFor({ id: 'job', context: { nai_secret: 'sealed-reference', proxy_url: 'private-proxy' }, result: { assets: [] } }), 'gallery')
    expect(response.status).toBe(200)
    const page = JSON.parse(response.bytes.toString())
    expect(page.items[0]).not.toHaveProperty('context')
    expect(response.bytes.toString()).not.toContain('sealed-reference')
    expect(page).toMatchObject({ total: 1, offset: 0, limit: 48 })
  })

  it('omits private fields, relocates image paths and preserves original image bytes with a disclosure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nai-review-share-'))
    roots.push(root)
    const source = join(root, 'original.png')
    const image = encodePng(1, 1, new Uint8Array([10, 20, 30, 254]), { text: [{ keyword: 'Comment', text: '{"prompt":"private prompt metadata"}' }] })
    writeFileSync(source, image)
    const ident = 'a'.repeat(64)
    const asset = { id: ident, path: source, name: 'Original', mime: 'image/png' }
    const job = {
      id: 'job', operation: 'img2img',
      context: { nai_secret: 'sealed-reference', nai_base_url: 'private-endpoint' },
      request: { prompt: 'A boy', seed: 42, image_path: 'C:/Users/private/source.png', max_anlas: 0 },
      library_refs: [{ id: 'character', context: { nai_secret: 'nested-reference' } }],
      result: {
        assets: [asset], artifact_paths: [source], image_path: source,
        record_path: join(root, 'original.json'), raw_api_image_path: join(root, 'original.raw.png'),
        anlas_spent: 0, warnings: ['Receipt: C:/Users/private/original.json', 'Receipt: /home/private/original.json'],
        source_url: 'https://docs.novelai.net/image/metadata',
        extra: { token: 'pst-sensitive-token', path: '/home/private/source.png', api_key: 'private-key', nai_secret: 'another-reference' },
      },
    }
    const before = JSON.stringify(job)
    const response = await invoke(apiFor(job), 'gallery/export', 'POST', { ids: ['job'] })
    expect(response.status).toBe(200)
    const files = unzipSync(response.bytes)
    const recordText = strFromU8(files['records.json']!)
    const records = JSON.parse(recordText)
    expect(records[0].request).toMatchObject({ prompt: 'A boy', seed: 42, max_anlas: 0 })
    expect(records[0].request).not.toHaveProperty('image_path')
    expect(records[0].result).not.toHaveProperty('record_path')
    expect(records[0].result.assets[0].path).toBe(`images/${ident}.png`)
    expect(records[0].result.artifact_paths).toEqual([`images/${ident}.png`])
    expect(records[0].result.source_url).toBe('https://docs.novelai.net/image/metadata')
    for (const privateValue of [root, 'C:/Users', '/home/private', 'sealed-reference', 'nested-reference', 'another-reference', 'private-endpoint', 'private-key', 'pst-sensitive-token']) {
      expect(recordText).not.toContain(privateValue)
    }
    expect(Buffer.from(files[`images/${ident}.png`]!)).toEqual(image)
    expect(strFromU8(files['README.txt']!)).toContain('not anonymized')
    expect(strFromU8(files['README.txt']!)).toContain('hidden alpha metadata')
    expect(JSON.stringify(job)).toBe(before)
  })

  it('exports records with absent original images without retaining local paths', async () => {
    const response = await invoke(apiFor({ id: 'job', request: { image_path: '/home/private/missing.png' }, result: { assets: [], artifact_paths: ['/home/private/missing.png'], record_path: '/home/private/missing.json' } }), 'gallery/export', 'POST', { ids: ['job'] })
    expect(response.status).toBe(200)
    const text = strFromU8(unzipSync(response.bytes)['records.json']!)
    expect(text).not.toContain('/home/private')
    expect(JSON.parse(text)[0].result.artifact_paths).toEqual([])
  })
})

function isolatedWorkbench(): Workbench {
  const root = mkdtempSync(join(tmpdir(), 'nai-review-workbench-'))
  roots.push(root)
  return new Workbench(root)
}

describe('review fixes: assistant workspace contracts', () => {
  it('returns public gallery, job, and schedule views without frozen credentials', async () => {
    const wb = isolatedWorkbench()
    const context = { nai_secret: 'sealed-private-reference', nai_base_url: 'private-endpoint', proxy_url: 'private-proxy' }
    const [job] = wb.store.createJobs([{ operation: 'generate', request: { prompt: 'boy' }, context }], 0)
    const schedule = wb.store.saveSchedule({ name: 'Private context', enabled: false, kind: 'once', at: '2030-01-01T00:00:00Z', operation: 'generate', request: { prompt: 'boy' }, snapshot: { context } })
    const reads = [
      await wb.workspace.read('gallery', {}),
      await wb.workspace.read('jobs', { id: job!['id'] }),
      await wb.workspace.read('schedules', {}),
      await wb.workspace.read('schedules', { id: schedule['id'] }),
    ]
    for (const value of reads) {
      expect(JSON.stringify(value)).not.toContain('sealed-private-reference')
      expect(JSON.stringify(value)).not.toContain('private-endpoint')
      expect(JSON.stringify(value)).not.toContain('private-proxy')
    }
    expect(wb.store.getJob(String(job!['id']))['context']).toEqual(context)
    expect((wb.store.getSchedule(String(schedule['id']))['snapshot'] as Rec)['context']).toEqual(context)
  })

  it('keeps reviewed job proposals and their application results public', async () => {
    const wb = isolatedWorkbench()
    const [job] = wb.store.createJobs([{ operation: 'generate', request: { prompt: 'boy' }, context: { nai_secret: 'private-job-reference' } }], 0)
    const favorite = await wb.workspace.propose('jobs.favorite', { job_id: job!['id'], favorite: true })
    expect(JSON.stringify(favorite)).not.toContain('private-job-reference')
    const favoriteResult = await wb.workspace.apply(String(favorite['id']))
    expect(JSON.stringify(favoriteResult)).not.toContain('private-job-reference')
    const archive = await wb.workspace.propose('jobs.archive', { job_id: job!['id'], archived: true })
    expect(JSON.stringify(archive)).not.toContain('private-job-reference')
    const cancel = await wb.workspace.propose('jobs.cancel', { job_id: job!['id'] })
    expect(JSON.stringify(cancel)).not.toContain('private-job-reference')
    const cancelResult = await wb.workspace.apply(String(cancel['id']))
    expect(JSON.stringify(cancelResult)).not.toContain('private-job-reference')
  })

  it('applies supported DSH settings after explicit proposal confirmation', async () => {
    const wb = isolatedWorkbench()
    const desired = { dsh_provider: ' provider ', dsh_model: ' model ', max_output_tokens: 8192 }
    const proposal = await wb.workspace.propose('settings.update', { settings: { ai: desired } })
    expect(wb.settings.aiConfig()['dsh_model']).toBe('')
    await wb.workspace.apply(String(proposal['id']))
    expect(wb.settings.aiConfig()).toEqual({ dsh_provider: 'provider', dsh_model: 'model', max_output_tokens: 8192 })
    const inherited = await wb.workspace.propose('settings.update', { settings: { ai: { dsh_provider: '', dsh_model: '' } } })
    await wb.workspace.apply(String(inherited['id']))
    expect(wb.settings.aiConfig()).toEqual({ dsh_provider: '', dsh_model: '', max_output_tokens: 8192 })
  })

  it('prepares local image and mask outputs only after confirmation and caches repeated application', async () => {
    const wb = isolatedWorkbench()
    wb.settings.save({ output_directory: join(wb.root, 'prepared') })
    const image = encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(128))
    const asset = await wb.assets.add(image, 'source.png')
    const prepare = vi.spyOn(wb, 'prepare')
    const credits = vi.spyOn(wb, 'credits').mockRejectedValue(new Error('unexpected network use'))
    const remote = vi.spyOn(wb.executor, 'execute').mockRejectedValue(new Error('unexpected NAI use'))
    const proposal = await wb.workspace.propose('assets.prepare', { request: { image_path: asset['path'], width: 128, height: 64, mask_boxes: [[0, 0, 16, 16]] } })
    expect(prepare).not.toHaveBeenCalled()
    const result = await wb.workspace.apply(String(proposal['id']))
    const prepared = result['result'] as Rec
    expect(prepared).toMatchObject({ operation: 'prepare_image', network_used: false, anlas_spent: 0, width: 128, height: 64 })
    expect(prepared['assets']).toHaveLength(2)
    expect((prepared['artifact_paths'] as string[]).every((path) => readFileSync(path).length > 0)).toBe(true)
    expect(readFileSync(String(asset['path']))).toEqual(image)
    expect(await wb.workspace.apply(String(proposal['id']))).toEqual(result)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(credits).not.toHaveBeenCalled()
    expect(remote).not.toHaveBeenCalled()
  })

  it('rejects an unregistered preparation source and rechecks registration at confirmation', async () => {
    const wb = isolatedWorkbench()
    const prepare = vi.spyOn(wb, 'prepare')
    await expect(wb.workspace.propose('assets.prepare', { request: { image_path: join(wb.root, 'unknown.png'), width: 64, height: 64 } })).rejects.toThrow()
    expect(wb.store.data.workspace_proposals).toHaveLength(0)
    const asset = await wb.assets.add(encodePng(1, 1, new Uint8Array([10, 20, 30, 255])), 'source.png')
    const proposal = await wb.workspace.propose('assets.prepare', { request: { image_path: asset['path'], width: 64, height: 64 } })
    wb.store.data.assets = []
    await expect(wb.workspace.apply(String(proposal['id']))).rejects.toThrow()
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each([{ model: 'legacy' }, { vision: true }, { reasoning_effort: 'high' }, { max_output_tokens: 255 }, { max_output_tokens: 200001 }])('rejects unsupported settings before storing a proposal', async (ai) => {
    const wb = isolatedWorkbench()
    await expect(wb.workspace.propose('settings.update', { settings: { ai } })).rejects.toThrow()
    expect(wb.store.data.workspace_proposals).toHaveLength(0)
  })
})

describe('review fixes: frozen asset metadata', () => {
  it('allows a frozen PNG to be re-uploaded and previewed without changing its identity', async () => {
    const wb = isolatedWorkbench()
    const image = encodePng(1, 1, new Uint8Array([10, 20, 30, 255]))
    const source = join(wb.root, 'input.png')
    writeFileSync(source, image)
    const request = wb.assets.freezePaths({ image_path: source }) as Rec
    const before = wb.store.listAssets()[0]!
    expect(before['mime']).toBe('application/octet-stream')
    const asset = await wb.assets.add(image, 'uploaded.png')
    expect(asset).toMatchObject({ id: before['id'], path: request['image_path'], sha256: before['sha256'], mime: 'image/png', width: 1, height: 1 })
    expect(wb.store.listAssets()).toHaveLength(1)
    expect((await wb.assets.thumbnail(String(asset['id']))).length).toBeGreaterThan(0)
    expect(await wb.assets.add(image, 'again.png')).toEqual(asset)
  })

  it('retains a frozen JPEG alias path when the decoder normalizes its suffix', async () => {
    const wb = isolatedWorkbench()
    const image = await sharp(encodePng(1, 1, new Uint8Array([10, 20, 30, 255]))).jpeg().toBuffer()
    const source = join(wb.root, 'input.jpeg')
    writeFileSync(source, image)
    const request = wb.assets.freezePaths({ image_path: source }) as Rec
    const asset = await wb.assets.add(image, 'uploaded.jpeg')
    expect(asset).toMatchObject({ path: request['image_path'], mime: 'image/jpeg', width: 1, height: 1 })
    expect(String(asset['path'])).toMatch(/\.jpeg$/u)
    expect(wb.store.listAssets()).toHaveLength(1)
  })

  it('does not trust metadata promotion after frozen bytes have changed', async () => {
    const wb = isolatedWorkbench()
    const image = encodePng(1, 1, new Uint8Array([10, 20, 30, 255]))
    const source = join(wb.root, 'input.png')
    writeFileSync(source, image)
    const request = wb.assets.freezePaths({ image_path: source }) as Rec
    writeFileSync(String(request['image_path']), encodePng(1, 1, new Uint8Array([50, 60, 70, 255])))
    await expect(wb.assets.add(image, 'uploaded.png')).rejects.toThrow()
    expect(wb.store.listAssets()[0]!['mime']).toBe('application/octet-stream')
  })

  it('does not allow image metadata promotion to change a hash or path', () => {
    const store = memoryStore()
    const id = 'a'.repeat(64)
    const original = { id, path: `/assets/${id}.png`, sha256: id, mime: 'application/octet-stream', width: null, height: null }
    store.addAsset(original)
    expect(() => store.addAsset({ ...original, path: '/elsewhere.png', mime: 'image/png', width: 1, height: 1 })).toThrow()
    expect(() => store.addAsset({ ...original, sha256: 'b'.repeat(64), mime: 'image/png', width: 1, height: 1 })).toThrow()
    expect(store.getAsset(id)).toMatchObject(original)
  })

  it('rolls back metadata promotion when persistence fails', () => {
    const store = memoryStore()
    const id = 'a'.repeat(64)
    const original = { id, path: `/assets/${id}.png`, sha256: id, mime: 'application/octet-stream', width: null, height: null }
    store.addAsset(original)
    const before = JSON.stringify(store.data)
    vi.mocked(store.internalPersist).mockImplementationOnce(() => { throw new Error('disk failure') })
    expect(() => store.addAsset({ ...original, mime: 'image/png', width: 1, height: 1 })).toThrow('disk failure')
    expect(JSON.stringify(store.data)).toBe(before)
  })
})
