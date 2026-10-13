import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { zipSync, gzipSync } from 'fflate'
import { boundedUnzip } from '../src/core/archive.ts'
import { readImage } from '../src/core/imageInputs.ts'
import { encodePng, decodePng, stealthMetadata } from '../src/core/png.ts'
import { OperationExecutor } from '../src/core/service.ts'
import { prepareOperation } from '../src/core/operations.ts'

const folders: string[] = []
const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'nai-images-')); folders.push(root); return root }
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

describe('image formats and resource limits', () => {
  it('decodes actual WebP and does not invent an alpha channel on JPEG', async () => {
    const root = temporary()
    const source = sharp({ create: { width: 16, height: 24, channels: 4, background: { r: 20, g: 180, b: 80, alpha: 0.5 } } })
    const webp = join(root, 'source.webp'); writeFileSync(webp, await source.clone().webp({ lossless: true }).toBuffer())
    const jpeg = join(root, 'source.jpg'); writeFileSync(jpeg, await source.clone().jpeg().toBuffer())
    expect((await readImage(webp)).summary).toMatchObject({ format: 'WEBP', width: 16, height: 24, has_alpha: true })
    expect((await readImage(jpeg)).summary).toMatchObject({ format: 'JPEG', has_alpha: false })
  })

  it('rejects oversized IHDR and truncated chunks before decompressing', () => {
    const png = Buffer.from(encodePng(1, 1, new Uint8Array([10, 20, 30, 255])))
    png.writeUInt32BE(100000, 16); png.writeUInt32BE(100000, 20)
    expect(() => decodePng(png)).toThrow(/32MP/)
    const truncated = Buffer.from(encodePng(1, 1, new Uint8Array([10, 20, 30, 255])))
    truncated.writeUInt32BE(0xffffffff, 8)
    expect(() => decodePng(truncated)).toThrow(/Truncated/)
  })

  it('reads NovelAI column-major alpha-LSB metadata and bounds decompression', () => {
    const width = 32, height = 64
    const rgba = new Uint8Array(width * height * 4).fill(254)
    const raw = gzipSync(Buffer.from('{"Comment":"verified metadata"}'))
    const length = Buffer.alloc(4); length.writeUInt32BE(raw.length * 8)
    const bytes = Buffer.concat([Buffer.from('stealth_pngcomp'), length, raw])
    for (let i = 0; i < bytes.length * 8; i++) {
      const pixel = (i % height) * width + Math.floor(i / height)
      rgba[pixel * 4 + 3] = 254 | ((bytes[Math.floor(i / 8)]! >> (7 - i % 8)) & 1)
    }
    expect(stealthMetadata(width, height, rgba)).toEqual({ Comment: 'verified metadata' })
    expect(stealthMetadata(width, height, rgba, 10)).toBeNull()
  })

  it('checks ZIP declared expansion before inflating and skips unused members', () => {
    const archive = zipSync({ 'large.png': new Uint8Array(10000), 'unused.txt': new Uint8Array(20000) })
    expect(() => boundedUnzip(archive, { bytes: 1000, fileBytes: 1000, files: 5 })).toThrow(/size limit/)
    const extracted = boundedUnzip(archive, { bytes: 15000, fileBytes: 15000, files: 5, accept: (name) => name.endsWith('.png') })
    expect(Object.keys(extracted)).toEqual(['large.png'])
    expect(extracted['large.png']!.length).toBe(10000)
  })
})

describe('direct executor cancellation', () => {
  it('retains unknown submission without billing queries or blocking later operations', async () => {
    const root = temporary()
    const controller = new AbortController()
    const client: any = {
      credits: vi.fn().mockRejectedValue(new Error('Verification must not run')),
      postOperation: vi.fn().mockImplementationOnce(async () => { controller.abort(); throw new DOMException('Cancelled after submission', 'AbortError') })
        .mockResolvedValueOnce(encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255))),
    }
    const executor = new OperationExecutor({ token: () => 'pst-test', baseUrl: () => 'https://image.novelai.net', proxy: () => null, outputDir: () => root, dataDir: () => root }, { run: async (fn) => fn() })
    const prepared = await prepareOperation({ prompt: 'tree', width: 64, height: 64, max_anlas: 0 }, 'generate')
    await expect(executor.execute(prepared, { client, signal: controller.signal })).rejects.toMatchObject({ submission_outcome_unknown: true })
    expect(client.credits).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'billing-review-required.json'))).toBe(false)
    await expect(executor.execute(prepared, { client })).resolves.toMatchObject({ status: 'generated', anlas_spent: null })
    expect(client.postOperation).toHaveBeenCalledTimes(2)
  })
})
