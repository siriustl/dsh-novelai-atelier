/** Local image and mask preparation; no API calls or credentials. Ported from preparation.py. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readImage, MAX_INPUT_PIXELS } from './imageInputs.ts'
import { defaultOutputDir } from './service.ts'
import { Raster } from './raster.ts'

type Rec = Record<string, unknown>

const Pixel = z.number().int().min(0)
const Box = z.tuple([Pixel, Pixel, Pixel, Pixel])
const Point = z.tuple([Pixel, Pixel])

export const PrepareImageRequestSchema = z.object({
  image_path: z.string().min(1).describe('Local source image; the original is never overwritten'),
  width: z.number().int().min(64).max(4096).multipleOf(64).nullable().optional(),
  height: z.number().int().min(64).max(4096).multipleOf(64).nullable().optional(),
  mode: z.enum(['contain', 'cover', 'stretch', 'pad']).default('contain'),
  background: z.string().max(40).default('#ffffff').describe('Padding color, e.g. #ffffff or transparent'),
  crop_box: Box.nullable().optional().describe('[left, top, right, bottom] on the source; right/bottom excluded'),
  mask_boxes: z.array(Box).max(64).default([]).describe('White repaint rectangles on the final canvas'),
  mask_polygons: z.array(z.array(Point).min(3).max(256)).max(64).default([]).describe('White repaint polygons in final-canvas pixels'),
})
export type PrepareImageRequest = z.infer<typeof PrepareImageRequestSchema>

function parseColor(background: string): [number, number, number, number] {
  if (background === 'transparent') return [0, 0, 0, 0]
  const hex = /^#([0-9a-f]{3,8})$/iu.exec(background)
  if (hex) {
    const value = hex[1]!
    const expand = (s: string) => parseInt(s.length === 1 ? s + s : s, 16)
    if (value.length === 3 || value.length === 4) {
      return [expand(value[0]!), expand(value[1]!), expand(value[2]!), value.length === 4 ? expand(value[3]!) : 255]
    }
    if (value.length === 6 || value.length === 8) {
      return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16), value.length === 8 ? parseInt(value.slice(6, 8), 16) : 255]
    }
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/iu.exec(background)
  if (rgb) {
    const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    const alpha = rgb[4] !== undefined ? Number(rgb[4]) : 1
    if (channels.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
      && Number.isFinite(alpha) && alpha >= 0 && alpha <= 1)
      return [channels[0]!, channels[1]!, channels[2]!, Math.round(alpha * 255)]
  }
  const named: Record<string, [number, number, number, number]> = {
    white: [255, 255, 255, 255], black: [0, 0, 0, 255], gray: [128, 128, 128, 255],
    red: [255, 0, 0, 255], green: [0, 128, 0, 255], blue: [0, 0, 255, 255], yellow: [255, 255, 0, 255],
  }
  if (named[background.toLowerCase()]) return named[background.toLowerCase()]!
  throw new Error('background must be a color string or transparent')
}

export async function prepareImage(request: PrepareImageRequest, outputDir?: string): Promise<Rec> {
  if ((request.width == null) !== (request.height == null)) throw new Error('Provide both width and height, or omit both to keep the cropped source size')
  const boxes = [...(request.crop_box ? [request.crop_box] : []), ...request.mask_boxes]
  for (const box of boxes) {
    if (box[2] <= box[0] || box[3] <= box[1]) throw new Error('Rectangles need right > left and bottom > top')
  }
  if (request.background !== 'transparent') parseColor(request.background) // validation
  const source = await readImage(request.image_path)
  let image = source.image
  if (request.crop_box) {
    const [left, top, right, bottom] = request.crop_box
    if (right > image.width || bottom > image.height) throw new Error('crop_box exceeds the source dimensions')
    image = image.cropDestructive(left, top, right, bottom)
  }
  const size = { width: (request.width ?? image.width) as number, height: (request.height ?? image.height) as number }
  if (size.width < 64 || size.width > 4096 || size.width % 64 || size.height < 64 || size.height > 4096 || size.height % 64)
    throw new Error('Prepared dimensions must be 64..4096 and multiples of 64; provide width and height')
  for (const [, , right, bottom] of request.mask_boxes) {
    if (right > size.width || bottom > size.height) throw new Error('mask_boxes must fit the final canvas')
  }
  for (const polygon of request.mask_polygons) {
    for (const [x, y] of polygon) {
      if (x >= size.width || y >= size.height) throw new Error('mask polygon points must be inside the final canvas')
    }
  }
  const cropSize = { width: image.width, height: image.height }
  let offset = [0, 0]
  let result: Raster
  if (request.mode === 'contain' || request.mode === 'pad') {
    if (request.mode === 'pad' && (image.width > size.width || image.height > size.height))
      throw new Error('pad requires a canvas at least as large as the cropped source')
    const resized = request.mode === 'pad' ? image : containResize(image, size.width, size.height)
    const fill = parseColor(request.background)
    const canvasData = new Uint8Array(size.width * size.height * 4)
    for (let i = 0; i < canvasData.length; i += 4) {
      canvasData[i] = fill[0]; canvasData[i + 1] = fill[1]; canvasData[i + 2] = fill[2]; canvasData[i + 3] = fill[3]
    }
    result = new Raster(size.width, size.height, canvasData)
    offset = [Math.floor((size.width - resized.width) / 2), Math.floor((size.height - resized.height) / 2)]
    // Copy RGBA pixels directly: alpha-as-mask would darken translucent pixels.
    for (let y = 0; y < resized.height; y++) {
      for (let x = 0; x < resized.width; x++) {
        const s = (y * resized.width + x) * 4
        const d = ((y + offset[1]!) * size.width + (x + offset[0]!)) * 4
        result.data[d] = resized.data[s]!
        result.data[d + 1] = resized.data[s + 1]!
        result.data[d + 2] = resized.data[s + 2]!
        result.data[d + 3] = resized.data[s + 3]!
      }
    }
  } else if (request.mode === 'cover') {
    result = coverResize(image, size.width, size.height)
  } else {
    result = image.resize(size.width, size.height)
  }
  let mask: Raster | null = null
  if (request.mask_boxes.length || request.mask_polygons.length) {
    const maskData = new Uint8Array(size.width * size.height * 4)
    mask = new Raster(size.width, size.height, maskData)
    for (const [left, top, right, bottom] of request.mask_boxes) {
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const d = (y * size.width + x) * 4
          maskData[d] = maskData[d + 1] = maskData[d + 2] = 255
          maskData[d + 3] = 255
        }
      }
    }
    for (const polygon of request.mask_polygons) fillPolygon(mask, polygon)
    if (!mask.luminance().some((v) => v > 0)) throw new Error('Mask geometry has no repaint pixels')
  }
  const directory = outputDir ?? defaultOutputDir()
  mkdirSync(directory, { recursive: true })
  const stamp = new Date().toISOString().replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).*$/u, '$1$2$3T$4$5$6Z')
  const identifier = `${stamp}-prepare-${randomHex10()}`
  const imagePath = join(directory, `${identifier}.png`)
  writeFileSync(imagePath, result.toPng())
  const response: Rec = {
    operation: 'prepare_image', image_path: imagePath, width: size.width, height: size.height,
    source: source.summary, cropped_source_dimensions: [cropSize.width, cropSize.height], mode: request.mode,
    content_offset: offset, anlas_spent: 0, network_used: false, artifact_paths: [imagePath],
  }
  if (mask !== null) {
    const maskPath = join(directory, `${identifier}-mask.png`)
    writeFileSync(maskPath, mask.toPng())
    response['mask_path'] = maskPath
    response['mask_white_means'] = 'repaint'
    response['mask_mode'] = 'luminance'
    response['repaint_fraction'] = mask.luminance().filter((v) => v === 255).length / (size.width * size.height)
    ;(response['artifact_paths'] as string[]).push(maskPath)
  }
  response['image_paths'] = [...(response['artifact_paths'] as string[])]
  const receipt = join(directory, `${identifier}.json`)
  writeFileSync(receipt, JSON.stringify({ request, result: response }, null, 2) + '\n', 'utf8')
  response['record_path'] = receipt
  return response
}

function containResize(image: Raster, width: number, height: number): Raster {
  const factor = Math.min(width / image.width, height / image.height)
  return image.resize(Math.max(1, Math.floor(image.width * factor)), Math.max(1, Math.floor(image.height * factor)))
}

function coverResize(image: Raster, width: number, height: number): Raster {
  const factor = Math.max(width / image.width, height / image.height)
  const scaledWidth = Math.max(width, Math.floor(image.width * factor + 0.5))
  const scaledHeight = Math.max(height, Math.floor(image.height * factor + 0.5))
  if (scaledWidth * scaledHeight > MAX_INPUT_PIXELS)
    throw new Error('Cover resize intermediate exceeds the 16 megapixel limit; crop the source closer to the target aspect ratio first')
  const scaled = image.resize(scaledWidth, scaledHeight)
  const left = Math.floor((scaled.width - width) / 2)
  const top = Math.floor((scaled.height - height) / 2)
  return scaled.cropDestructive(left, top, left + width, top + height)
}

/** Even-odd scanline polygon fill. */
function fillPolygon(mask: Raster, polygon: Array<[number, number]>): void {
  const ys = polygon.map((p) => p[1])
  const y0 = Math.max(0, Math.floor(Math.min(...ys)))
  const y1 = Math.min(mask.height - 1, Math.ceil(Math.max(...ys)))
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = []
    for (let i = 0; i < polygon.length; i++) {
      const [x1, yy1] = polygon[i]!
      const [x2, yy2] = polygon[(i + 1) % polygon.length]!
      if (yy1 <= y && yy2 > y) xs.push(x1 + ((y - yy1) / (yy2 - yy1)) * (x2 - x1))
      else if (yy2 <= y && yy1 > y) xs.push(x2 + ((y - yy2) / (yy1 - yy2)) * (x1 - x2))
    }
    xs.sort((a, b) => a - b)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.max(0, Math.ceil(xs[i]!)); x <= Math.min(mask.width - 1, Math.floor(xs[i + 1]!)); x++) {
        const d = (y * mask.width + x) * 4
        mask.data[d] = mask.data[d + 1] = mask.data[d + 2] = 255
        mask.data[d + 3] = 255
      }
    }
  }
}

function randomHex10(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(5))).map((b) => b.toString(16).padStart(2, '0')).join('')
}
