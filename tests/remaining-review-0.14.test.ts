import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { decodePng, encodePng } from '../src/core/png.ts'
import { Raster } from '../src/core/raster.ts'
import { prepareImage, PrepareImageRequestSchema } from '../src/core/preparation.ts'

const roots: string[] = []
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'nai-remaining-review-'))
  roots.push(directory)
  return directory
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4)
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, 8 + data.length)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length)
  return chunk
}
function rgbTransparencyPng(key: [number, number, number]): Buffer {
  const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255]), { rgb: true })
  const transparency = Buffer.alloc(6)
  key.forEach((value, index) => transparency.writeUInt16BE(value, index * 2))
  return Buffer.concat([png.subarray(0, 33), pngChunk('tRNS', transparency), png.subarray(33)])
}

describe('8-bit RGB PNG transparency keys', () => {
  it('matches low-byte transparent RGB keys and agrees with Sharp', async () => {
    const input = rgbTransparencyPng([255, 0, 0])
    const decoded = decodePng(input)
    expect([...decoded.data]).toEqual([255, 0, 0, 0, 0, 0, 0, 255])
    expect(Buffer.from(decoded.data)).toEqual(await sharp(input).ensureAlpha().raw().toBuffer())
    expect(decoded).toMatchObject({ hasAlphaChannel: false, transparencyMetadata: true, mode: 'RGB' })
  })

  it('keeps a zero RGB key transparent without making red transparent', () => {
    expect([...decodePng(rgbTransparencyPng([0, 0, 0])).data]).toEqual([255, 0, 0, 255, 0, 0, 0, 0])
  })

  it('does not reinterpret a 16-bit-only key as a matching 8-bit value', () => {
    expect([...decodePng(rgbTransparencyPng([0xff00, 0, 0])).data]).toEqual([255, 0, 0, 255, 0, 0, 0, 255])
  })

  it('preserves explicit RGBA alpha pixels', () => {
    const pixels = new Uint8Array([255, 0, 0, 128, 0, 0, 0, 254])
    expect(decodePng(encodePng(2, 1, pixels)).data).toEqual(pixels)
  })
})

describe('bounded cover preparation', () => {
  it.each([[1024, 64, 64, 4096], [64, 1024, 4096, 64]])('rejects an oversized intermediate before resize (%i x %i)', async (sourceWidth, sourceHeight, width, height) => {
    const directory = root(), imagePath = join(directory, 'source.png')
    const source = encodePng(sourceWidth, sourceHeight, new Uint8Array(sourceWidth * sourceHeight * 4))
    writeFileSync(imagePath, source)
    const resize = vi.spyOn(Raster.prototype, 'resize')
    await expect(prepareImage(PrepareImageRequestSchema.parse({ image_path: imagePath, mode: 'cover', width, height }), directory))
      .rejects.toThrow(/intermediate exceeds the 16 megapixel limit/u)
    expect(resize).not.toHaveBeenCalled()
    expect(readFileSync(imagePath)).toEqual(source)
    expect(readdirSync(directory)).toEqual(['source.png'])
  })

  it('keeps normal centered cover crops unchanged', async () => {
    const directory = root(), imagePath = join(directory, 'source.png')
    const pixels = new Uint8Array(128 * 64 * 4)
    for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
      const offset = (y * 128 + x) * 4
      pixels[offset] = x
      pixels[offset + 3] = 255
    }
    const source = encodePng(128, 64, pixels)
    writeFileSync(imagePath, source)
    const result = await prepareImage(PrepareImageRequestSchema.parse({ image_path: imagePath, mode: 'cover', width: 64, height: 64 }), directory)
    const output = decodePng(readFileSync(String(result.image_path)))
    expect([output.width, output.height]).toEqual([64, 64])
    expect([...output.data.subarray(0, 4)]).toEqual([32, 0, 0, 255])
    expect([...output.data.subarray(63 * 4, 64 * 4)]).toEqual([95, 0, 0, 255])
    expect(readFileSync(imagePath)).toEqual(source)
  })
})
