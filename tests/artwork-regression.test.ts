import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { Workbench } from '../src/workbench/app.ts'
import { revealArtwork } from '../src/workbench/reveal.ts'

const roots: string[] = []
function workbench() { const root = mkdtempSync(join(tmpdir(), 'nai-artwork-')); roots.push(root); return new Workbench(root) }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('artwork previews and file locations', () => {
  it('opens the original output folder and falls back to its registered copy', async () => {
    const wb = workbench(), original = join(wb.root, 'artwork.png')
    const data = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#abcdef' } }).png().toBuffer()
    writeFileSync(original, data)
    const asset = await wb.assets.add(data, 'artwork.png')
    const job = wb.store.recordDirectJob({ operation: 'generate', request: {} }, { assets: [asset], artifact_paths: [original] }, 0)
    const open = vi.fn(async () => {})
    expect(await revealArtwork(wb, job.id, asset.id, open)).toMatchObject({ opened: true, path: original })
    expect(open).toHaveBeenLastCalledWith(dirname(original))
    rmSync(original)
    expect(await revealArtwork(wb, job.id, asset.id, open)).toMatchObject({ path: asset.path })
    await expect(revealArtwork(wb, job.id, 'not-from-this-job', open)).rejects.toThrow('不属于')
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('matches the selected asset after an earlier artifact failed to import', async () => {
    const wb = workbench(), first = join(wb.root, 'first.png'), second = join(wb.root, 'second.png')
    const red = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff0000' } }).png().toBuffer()
    const blue = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#0000ff' } }).png().toBuffer()
    writeFileSync(first, red); writeFileSync(second, blue)
    const asset = await wb.assets.add(blue, 'second.png')
    const job = wb.store.recordDirectJob({ operation: 'augment', request: {} }, { assets: [asset], artifact_paths: [first, second] }, 0)
    const open = vi.fn(async () => {})
    expect(await revealArtwork(wb, job.id, asset.id, open)).toMatchObject({ path: second })
    writeFileSync(second, red)
    expect(await revealArtwork(wb, job.id, asset.id, open)).toMatchObject({ path: asset.path })
  })

  it('deduplicates thumbnail work, bounds dimensions and refuses external paths', async () => {
    const wb = workbench()
    const data = await sharp({ create: { width: 832, height: 1216, channels: 4, background: '#abcdef' } }).png().toBuffer()
    const asset = await wb.assets.add(data, 'large.png')
    const [a, b] = await Promise.all([wb.assets.thumbnail(String(asset.id)), wb.assets.thumbnail(String(asset.id))])
    expect(a).toBe(b)
    expect(await wb.assets.thumbnail(String(asset.id))).toBe(a)
    const meta = await sharp(a).metadata()
    expect(meta.height).toBe(640)
    expect(meta.width).toBeLessThanOrEqual(640)
    const external = join(wb.root, 'private.png'); writeFileSync(external, data)
    const invalid = wb.store.addAsset({ path: external, mime: 'image/png' })
    await expect(wb.assets.thumbnail(String(invalid.id))).rejects.toThrow('超出')
  })
})
