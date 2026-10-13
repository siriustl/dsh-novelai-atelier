import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'
import { Workbench } from '../src/workbench/app.ts'
import { Backup } from '../src/workbench/backup.ts'
import { Raster } from '../src/core/raster.ts'
import { decodeRaster } from '../src/core/imageInputs.ts'
import { prepareImage } from '../src/core/preparation.ts'
import { encodePng } from '../src/core/png.ts'

vi.mock('../src/core/imageInputs.ts', async (original) => {
  const actual = await original<typeof import('../src/core/imageInputs.ts')>()
  return { ...actual, decodeRaster: vi.fn(actual.decodeRaster) }
})
vi.mock('../src/core/preparation.ts', async (original) => {
  const actual = await original<typeof import('../src/core/preparation.ts')>()
  return { ...actual, prepareImage: vi.fn(actual.prepareImage) }
})

const roots: string[] = []
function workbench(): Workbench {
  const root = mkdtempSync(join(tmpdir(), 'nai-asset-restore-'))
  roots.push(root)
  return new Workbench(root)
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('asset restore commit boundaries', () => {
  it('rejects an upload decoded across restore before committing an asset', async () => {
    const source = workbench(), target = workbench()
    const backup = new Backup(source).export()
    const decoded = deferred<Raster>()
    const entered = deferred<void>()
    vi.mocked(decodeRaster).mockImplementationOnce(async () => { entered.resolve(); return decoded.promise })
    const upload = target.assets.add(new Uint8Array([0xff, 0xd8, 1, 2]), 'deferred.jpg')
    await entered.promise
    new Backup(target).restore(backup.path)
    const restored = structuredClone(target.store.data)
    decoded.resolve(new Raster(1, 1, new Uint8Array([1, 2, 3, 255])))
    await expect(upload).rejects.toThrow(/恢复|刷新/)
    expect(target.store.data).toEqual(restored)
  })

  it('does not import library entries after an awaited asset add spans restore', async () => {
    const source = workbench(), target = workbench()
    const png = encodePng(1, 1, new Uint8Array([1, 2, 3, 255]))
    await source.assets.add(png, 'pixel.png')
    const backup = new Backup(source).export()
    const digest = createHash('sha256').update(png).digest('hex')
    const packed = zipSync({
      'library.json': strToU8(JSON.stringify({ format: 'novelai-workbench-library', version: 1,
        assets: [{ id: digest, name: 'pixel.png' }],
        entries: [{ id: 'imported', kind: 'character', name: 'stale entry', data: { examples: [digest] } }],
      })),
      [`assets/${digest}.png`]: png,
    })
    const add = target.assets.add.bind(target.assets)
    vi.spyOn(target.assets, 'add').mockImplementationOnce(async (data, name) => {
      const asset = await add(data, name)
      new Backup(target).restore(backup.path)
      return asset
    })
    await expect(target.assets.importLibrary(packed)).rejects.toThrow(/恢复|刷新/)
    expect(target.store.listEntries()).toEqual([])
    expect(target.store.listAssets()).toHaveLength(1)
  })

  it('skips a direct generation registration resumed after restore without retrying', async () => {
    const source = workbench(), target = workbench()
    const backup = new Backup(source).export()
    const asset = deferred<Record<string, unknown>>()
    vi.spyOn(target.assets, 'fromPath').mockImplementationOnce(async () => asset.promise)
    const record = vi.spyOn(target.store, 'recordDirectJob')
    const registration = target.registerDirectGeneration({ operation: 'generate', artifact_paths: ['offline.png'], anlas_spent: 0 }, {})
    new Backup(target).restore(backup.path)
    const restored = structuredClone(target.store.data)
    asset.resolve({ id: 'offline-asset', path: 'offline.png' })
    await registration
    expect(record).not.toHaveBeenCalled()
    expect(target.assets.fromPath).toHaveBeenCalledOnce()
    expect(target.store.data).toEqual(restored)
  })

  it('does not register prepared outputs when local processing spans restore', async () => {
    const source = workbench(), target = workbench()
    const backup = new Backup(source).export()
    const prepared = deferred<Record<string, unknown>>()
    vi.mocked(prepareImage).mockImplementationOnce(async () => prepared.promise)
    const fromPath = vi.spyOn(target.assets, 'fromPath')
    const preparation = target.prepare({ image_path: join(target.root, 'offline-source.png') })
    new Backup(target).restore(backup.path)
    const restored = structuredClone(target.store.data)
    writeFileSync(join(target.root, 'offline-output.png'), encodePng(1, 1, new Uint8Array([4, 5, 6, 255])))
    prepared.resolve({ artifact_paths: [join(target.root, 'offline-output.png')] })
    await expect(preparation).rejects.toThrow(/恢复|刷新/)
    expect(fromPath).not.toHaveBeenCalled()
    expect(target.store.data).toEqual(restored)
  })
})
