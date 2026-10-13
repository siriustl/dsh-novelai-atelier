/** RGBA raster + the pixel operations the NovelAI workflows need (crop, resize, masks, composite). */
import { createHash } from 'node:crypto'
import { decodePng, encodePng, type PngText } from './png.ts'

export interface RasterInfo {
  hasAlphaChannel: boolean
  transparencyMetadata: boolean
  iccProfile?: Uint8Array
  phys?: { x: number; y: number; unit: number }
}

export class Raster {
  constructor(readonly width: number, readonly height: number, readonly data: Uint8Array, readonly info: RasterInfo = { hasAlphaChannel: true, transparencyMetadata: false }) {
    if (data.length !== width * height * 4) throw new Error('Raster buffer size mismatch')
  }

  clone(): Raster { return new Raster(this.width, this.height, this.data.slice(), { ...this.info }) }

  static fromDecoded(d: ReturnType<typeof decodePng>): Raster {
    return new Raster(d.width, d.height, d.data, { hasAlphaChannel: d.hasAlphaChannel, transparencyMetadata: d.transparencyMetadata, iccProfile: d.iccProfile, phys: d.phys })
  }

  hasVisibleAlpha(): boolean {
    if (!this.info.hasAlphaChannel && !this.info.transparencyMetadata) return false
    const d = this.data
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true
    return false
  }

  cropDestructive(left: number, top: number, right: number, bottom: number): Raster {
    const w = right - left, h = bottom - top
    const out = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      const srcStart = ((y + top) * this.width + left) * 4
      out.set(this.data.subarray(srcStart, srcStart + w * 4), y * w * 4)
    }
    return new Raster(w, h, out, { ...this.info })
  }

  /** Catmull-Rom bicubic resize (matches Pillow's LANCZOS output closely enough for compositing previews). */
  resize(width: number, height: number, mode: 'bicubic' | 'nearest' = 'bicubic'): Raster {
    if (width === this.width && height === this.height) return this.clone()
    const out = new Uint8Array(width * height * 4)
    const src = this.data
    if (mode === 'nearest') {
      for (let y = 0; y < height; y++) {
        const sy = Math.min(this.height - 1, Math.floor((y * this.height) / height))
        for (let x = 0; x < width; x++) {
          const sx = Math.min(this.width - 1, Math.floor((x * this.width) / width))
          const s = (sy * this.width + sx) * 4, d = (y * width + x) * 4
          out[d] = src[s]!; out[d + 1] = src[s + 1]!; out[d + 2] = src[s + 2]!; out[d + 3] = src[s + 3]!
        }
      }
      return new Raster(width, height, out, { ...this.info })
    }
    const cubic = (t: number): Array<readonly [number, number]> => {
      // Catmull-Rom weights on fract position
      const a = Math.floor(t) - 1
      const f = t - Math.floor(t)
      const w0 = (-0.5 * f + f * f - 0.5 * f ** 3)
      const w1 = (1 - 2.5 * f * f + 1.5 * f ** 3)
      const w2 = (0.5 * f + 2 * f * f - 1.5 * f ** 3)
      const w3 = (-0.5 * f * f + 0.5 * f ** 3)
      const weights = [w0, w1, w2, w3]
      return [a, a + 1, a + 2, a + 3].map((xx, i) => [xx, weights[i]!] as const)
    }
    const sample = (xw: number, yw: number, ch: number): number => {
      const xw2 = cubic(xw), yw2 = cubic(yw)
      let acc = 0
      for (let j = 0; j < 4; j++) {
        const [sy, wy] = yw2[j]!
        for (let i = 0; i < 4; i++) {
          const [sx, wx] = xw2[i]!
          acc += src[(Math.min(this.height - 1, Math.max(0, sy)) * this.width + Math.min(this.width - 1, Math.max(0, sx))) * 4 + ch]! * wx * wy
        }
      }
      return Math.max(0, Math.min(255, Math.round(acc)))
    }
    const xr = this.width / width, yr = this.height / height
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const d = (y * width + x) * 4
        const sxp = (x + 0.5) * xr - 0.5, syp = (y + 0.5) * yr - 0.5
        out[d] = sample(sxp, syp, 0)
        out[d + 1] = sample(sxp, syp, 1)
        out[d + 2] = sample(sxp, syp, 2)
        out[d + 3] = sample(sxp, syp, 3)
      }
    }
    return new Raster(width, height, out, { ...this.info })
  }

  /** Area-average (Pillow BOX) downscale approximation via two-pass box filter. */
  resizeBox(width: number, height: number): Raster {
    if (width === this.width && height === this.height) return this.clone()
    const out = new Uint8Array(width * height * 4)
    const xr = this.width / width, yr = this.height / height
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * yr), y1 = Math.min(this.height, Math.max(y0 + 1, Math.ceil((y + 1) * yr)))
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * xr), x1 = Math.min(this.width, Math.max(x0 + 1, Math.ceil((x + 1) * xr)))
        let r = 0, g = 0, b = 0, a = 0, n = 0
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) {
            const s = (sy * this.width + sx) * 4
            r += this.data[s]!; g += this.data[s + 1]!; b += this.data[s + 2]!; a += this.data[s + 3]!; n++
          }
        }
        const d = (y * width + x) * 4
        out[d] = Math.round(r / n); out[d + 1] = Math.round(g / n); out[d + 2] = Math.round(b / n); out[d + 3] = Math.round(a / n)
      }
    }
    return new Raster(width, height, out, { ...this.info })
  }

  /** Luminance channel (Pillow convert("L") weights). */
  luminance(): Uint8Array {
    const out = new Uint8Array(this.width * this.height)
    const d = this.data
    for (let i = 0; i < out.length; i++) {
      const o = i * 4
      out[i] = Math.round(0.299 * d[o]! + 0.587 * d[o + 1]! + 0.114 * d[o + 2]!)
    }
    return out
  }

  alphaChannel(): Uint8Array {
    const out = new Uint8Array(this.width * this.height)
    const d = this.data
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3]!
    return out
  }

  /** Bounding box of pixels where channel > 127 — Pillow getbbox semantics on a thresholded mask. */
  maskBounds(channel: Uint8Array): [number, number, number, number] | null {
    let left = this.width, top = this.height, right = -1, bottom = -1
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (channel[y * this.width + x]! > 127) {
          if (x < left) left = x
          if (x > right) right = x
          if (y < top) top = y
          if (y > bottom) bottom = y
        }
      }
    }
    return right < 0 ? null : [left, top, right + 1, bottom + 1]
  }

  channelHistogram(channel: 'luminance' | 'alpha'): number[] {
    const values = channel === 'alpha' ? this.alphaChannel() : this.luminance()
    const hist = new Array<number>(256).fill(0)
    for (const v of values) hist[v] = (hist[v] ?? 0) + 1
    return hist
  }

  toPng(text: PngText[] = [], opts: { rgb?: boolean; level?: number } = {}): Buffer {
    return encodePng(this.width, this.height, this.data, {
      rgb: opts.rgb ?? (!this.info.hasAlphaChannel && !this.info.transparencyMetadata),
      text, iccProfile: this.info.iccProfile, phys: this.info.phys, level: opts.level,
    })
  }
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function imageBase64(r: Raster, text: PngText[] = []): string {
  return r.toPng(text).toString('base64')
}
