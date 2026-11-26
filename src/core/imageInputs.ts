/** Read-only local image preparation, shared by tools and the workbench. Ported from image_inputs.py. */
import { openSync, readSync, fstatSync, closeSync, existsSync, statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { decodePng } from './png.ts'
import { Raster, sha256Hex } from './raster.ts'

export const MAX_INPUT_BYTES = 48 * 1024 * 1024
export const MAX_INPUT_PIXELS = 16 * 1024 * 1024

export interface ImageInput { image: Raster; summary: Record<string, unknown> }

export function expandPath(path: string): string {
  return resolvePath(path.replace(/^~(?=\/|\\|$)/u, process.env.HOME ?? process.env.USERPROFILE ?? '.'))
}

function readFileSyncExact(path: string): Uint8Array {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size > MAX_INPUT_BYTES) throw new Error('Input image exceeds the 48 MiB file limit')
    const buf = new Uint8Array(size)
    let read = 0
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read)
      if (n <= 0) break
      read += n
    }
    return buf.subarray(0, read)
  } finally { closeSync(fd) }
}

function summarize(target: string, data: Uint8Array, image: Raster, sourceFormat: string): ImageInput {
  return {
    image: new Raster(image.width, image.height, image.data, {
      hasAlphaChannel: image.info.hasAlphaChannel,
      transparencyMetadata: image.info.transparencyMetadata,
    }),
    summary: {
      path: target, sha256: sha256Hex(data), bytes: data.length,
      width: image.width, height: image.height, format: sourceFormat,
      has_alpha: image.info.hasAlphaChannel || image.info.transparencyMetadata,
    },
  }
}

/** Decode one static raster (PNG/JPEG/WebP) without forwarding standard metadata chunks.
 * Alpha pixels stay intact for exact inpaint compositing. Original NovelAI alpha-LSB
 * metadata can therefore remain inside those pixels; this function is not an anonymizer. */
export async function readImage(path: string): Promise<ImageInput> {
  const target = expandPath(path)
  if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`Image file does not exist: ${target}`)
  if (statSync(target).size > MAX_INPUT_BYTES) throw new Error('Input image exceeds the 48 MiB file limit')
  const data = readFileSyncExact(target)
  if (data.length > MAX_INPUT_BYTES) throw new Error('Input image exceeds the 48 MiB file limit')
  let image: Raster
  let sourceFormat: string
  if (data[0] === 0x89 && data[1] === 0x50) {
    sourceFormat = 'PNG'
    image = Raster.fromDecoded(decodePng(data))
  } else if (data[0] === 0xff && data[1] === 0xd8) {
    sourceFormat = 'JPEG'
    image = await decodeRaster(data)
  } else if (data.length > 12 && Buffer.from(data.subarray(0, 4)).toString('latin1') === 'RIFF' && Buffer.from(data.subarray(8, 12)).toString('latin1') === 'WEBP') {
    sourceFormat = 'WEBP'
    image = await decodeRaster(data)
  } else {
    throw new Error('Input must be a PNG, JPEG, or WebP image')
  }
  if (image.width * image.height > MAX_INPUT_PIXELS) throw new Error('Input image exceeds the 16 megapixel limit')
  return summarize(target, data, image, sourceFormat)
}

export async function decodeRaster(data: Uint8Array, maxPixels = MAX_INPUT_PIXELS): Promise<Raster> {
  const { default: sharp } = await import('sharp')
  const decoder = sharp(Buffer.from(data), { limitInputPixels: maxPixels, animated: false })
  const metadata = await decoder.metadata()
  if ((metadata.pages ?? 1) > 1) throw new Error('Animated images are not supported')
  const { data: pixels, info } = await decoder.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return new Raster(info.width, info.height, new Uint8Array(pixels), { hasAlphaChannel: metadata.hasAlpha ?? false, transparencyMetadata: false })
}

export interface MaskSettings { mode: string; white_means: string; grid: number; repaint_pixels: number; repaint_fraction: number }

/** NovelAI's web mask is binary and aligned to 8x8 latent-space cells. */
export function prepareMask(source: ImageInput, size: { width: number; height: number }, mode: 'luminance' | 'alpha'): { mask: Raster; settings: MaskSettings } {
  const img = source.image
  if (img.width !== size.width || img.height !== size.height) throw new Error('Mask dimensions must exactly match the source image')
  let signal: Uint8Array
  if (mode === 'alpha') {
    if (!source.summary['has_alpha']) throw new Error('mask_mode=alpha requires a mask with an alpha channel')
    signal = img.alphaChannel()
  } else {
    signal = img.luminance()
  }
  const gw = size.width / 8, gh = size.height / 8
  if (!Number.isInteger(gw) || !Number.isInteger(gh)) throw new Error('Mask and source dimensions must be multiples of 8')
  const cells = new Uint8Array(gw * gh)
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      let acc = 0
      for (let y = cy * 8; y < (cy + 1) * 8; y++) {
        for (let x = cx * 8; x < (cx + 1) * 8; x++) acc += signal[y * size.width + x]!
      }
      cells[cy * gw + cx] = acc / 64 > 127 ? 255 : 0
    }
  }
  const out = new Uint8Array(size.width * size.height * 4)
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const v = cells[Math.floor(y / 8) * gw + Math.floor(x / 8)]!
      const o = (y * size.width + x) * 4
      out[o] = out[o + 1] = out[o + 2] = v
      out[o + 3] = 255
    }
  }
  const mask = new Raster(size.width, size.height, out)
  let whiteCells = 0
  for (const c of cells) if (c === 255) whiteCells++
  const repaintPixels = whiteCells * 64
  if (repaintPixels === 0) throw new Error('Mask has no repaint region after alignment to the 8-pixel grid')
  return {
    mask,
    settings: { mode, white_means: 'repaint', grid: 8, repaint_pixels: repaintPixels, repaint_fraction: repaintPixels / (size.width * size.height) },
  }
}
