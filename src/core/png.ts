/** Pure-TS PNG decode/encode with full text-chunk (tEXt/zTXt/iTXt) and tRNS support.
 * NovelAI images carry request metadata in PNG text chunks and hide a copy in the
 * alpha low bit; exact channel handling here is what keeps round-trips faithful. */
import { deflateSync, inflateSync, gunzipSync } from 'node:zlib'

export interface PngText { keyword: string; text: string; lang?: string; translatedKeyword?: string }
export interface DecodedPng {
  width: number
  height: number
  /** RGBA, 8 bits per channel, length = width*height*4 */
  data: Uint8Array
  text: PngText[]
  hasAlphaChannel: boolean
  transparencyMetadata: boolean
  iccProfile?: Uint8Array
  /** pixels per metre */
  phys?: { x: number; y: number; unit: number }
  mode: string
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length)
  return out
}

function decodeText(data: Uint8Array, kind: 'tEXt' | 'zTXt' | 'iTXt'): PngText | null {
  const dec = (b: Uint8Array) => Buffer.from(b).toString('utf8')
  const nul = (from: number) => {
    const i = data.indexOf(0, from)
    return i === -1 ? -1 : i
  }
  const kEnd = nul(0)
  if (kEnd < 0) return null
  const keyword = dec(data.subarray(0, kEnd))
  if (kind === 'tEXt') return { keyword, text: Buffer.from(data.subarray(kEnd + 1)).toString('latin1') }
  if (kind === 'zTXt') {
    if (data[kEnd + 1] !== 0) return null
    try { return { keyword, text: inflateSync(data.subarray(kEnd + 2), { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8') } } catch { return null }
  }
  // iTXt: keyword\0 compFlag\0 compMethod\0 lang\0 translated\0 data
  let p = kEnd + 1
  const compFlag = data[p]; p += 2 // compMethod at p-1
  const lEnd = nul(p); if (lEnd < 0) return null
  const lang = dec(data.subarray(p, lEnd)); p = lEnd + 1
  const tEnd = nul(p); if (tEnd < 0) return null
  const translated = dec(data.subarray(p, tEnd)); p = tEnd + 1
  let payload = data.subarray(p)
  if (compFlag === 1) { try { payload = inflateSync(payload, { maxOutputLength: 4 * 1024 * 1024 }) } catch { return null } }
  return { keyword, text: Buffer.from(payload).toString('utf8'), lang: lang || undefined, translatedKeyword: translated || undefined }
}

/** Decode an 8-bit, non-interlaced PNG into RGBA plus its metadata surface. */
export function decodePng(input: Uint8Array): DecodedPng {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (buf.length < 57 || !buf.subarray(0, 8).equals(sig)) throw new Error('Not a PNG file')
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat: Buffer[] = []
  let palette: Buffer | undefined
  let trns: Buffer | undefined
  let grayTrns: number | undefined
  const text: PngText[] = []
  let iccProfile: Uint8Array | undefined
  let phys: DecodedPng['phys'] | undefined
  let pos = 8
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    if (len > buf.length - pos - 12) throw new Error('Truncated PNG chunk')
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      if (pos !== 8 || len !== 13) throw new Error('Invalid PNG IHDR')
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      if (!width || !height || width * height > 32 * 1024 * 1024) throw new Error('PNG exceeds the 32MP pixel limit')
      bitDepth = data[8]!; colorType = data[9]!
      interlace = data[12]!
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') trns = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'tEXt') { const t = decodeText(data, 'tEXt'); if (t) text.push(t) }
    else if (type === 'zTXt') { const t = decodeText(data, 'zTXt'); if (t) text.push(t) }
    else if (type === 'iTXt') { const t = decodeText(data, 'iTXt'); if (t) text.push(t) }
    else if (type === 'iCCP') {
      const nul = data.indexOf(0)
      if (nul > 0 && data[nul + 1] === 0) { try { iccProfile = inflateSync(data.subarray(nul + 2), { maxOutputLength: 4 * 1024 * 1024 }) } catch { /* ignore */ } }
    } else if (type === 'pHYs' && len >= 9) {
      phys = { x: data.readUInt32BE(0), y: data.readUInt32BE(4), unit: data[8]! }
    } else if (type === 'IEND') break
    pos += 12 + len
  }
  if (!width || !height) throw new Error('PNG is missing a valid IHDR')
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8-bit is supported)`)
  if (interlace !== 0) throw new Error('Interlaced PNG is not supported')
  if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`Unsupported PNG color type ${colorType}`)
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]!
  const rawSize = (width * channels + 1) * height
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: rawSize })
  if (raw.length !== rawSize) throw new Error('Invalid PNG pixel data length')
  const bpp = channels
  const stride = width * bpp
  const out = new Uint8Array(stride * height)
  const prev = new Uint8Array(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const row = raw.subarray(p, p + stride)
    p += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0
      const b = prev[i]!
      const c = i >= bpp ? prev[i - bpp]! : 0
      const x = row[i]!
      let v: number
      switch (filter) {
        case 0: v = x; break
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`Invalid PNG filter ${filter}`)
      }
      cur[i] = v & 0xff
    }
    prev.set(cur)
  }
  // Expand to RGBA
  const rgba = new Uint8Array(width * height * 4)
  const hasAlphaChannel = colorType === 4 || colorType === 6
  let transparencyMetadata = trns !== undefined
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    switch (colorType) {
      case 0: {
        const g = out[i]!
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g
        let a = 255
        if (trns && trns.length >= 2) {
          const key = trns.readUInt16BE(0)
          if (key === g * 0x101 || key === g) { a = 0 }
        }
        rgba[o + 3] = a
        break
      }
      case 2: {
        rgba[o] = out[i * 3]!; rgba[o + 1] = out[i * 3 + 1]!; rgba[o + 2] = out[i * 3 + 2]!
        let a = 255
        if (trns && trns.length >= 6) {
          const r = trns.readUInt16BE(0), g = trns.readUInt16BE(2), b = trns.readUInt16BE(4)
          if (rgba[o] === r && rgba[o + 1] === g && rgba[o + 2] === b) a = 0
        }
        rgba[o + 3] = a
        break
      }
      case 3: {
        const idx = out[i]!
        rgba[o] = palette?.[idx * 3] ?? 0; rgba[o + 1] = palette?.[idx * 3 + 1] ?? 0; rgba[o + 2] = palette?.[idx * 3 + 2] ?? 0
        rgba[o + 3] = trns && idx < trns.length ? trns[idx]! : 255
        break
      }
      case 4: {
        const g = out[i * 2]!
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g
        rgba[o + 3] = out[i * 2 + 1]!
        break
      }
      case 6: {
        rgba[o] = out[i * 4]!; rgba[o + 1] = out[i * 4 + 1]!; rgba[o + 2] = out[i * 4 + 2]!; rgba[o + 3] = out[i * 4 + 3]!
        break
      }
    }
  }
  if (colorType === 0 && trns) transparencyMetadata = true
  const mode = { 0: 'L', 2: 'RGB', 3: 'P', 4: 'LA', 6: 'RGBA' }[colorType]!
  return { width, height, data: rgba, text, hasAlphaChannel, transparencyMetadata, iccProfile, phys, mode }
}

export interface EncodeTextItem { keyword: string; text: string; latin?: boolean }
export interface EncodePngOptions {
  /** Use RGB (drop the alpha channel, writing 255) instead of RGBA. */
  rgb?: boolean
  text?: EncodeTextItem[]
  iccProfile?: Uint8Array
  phys?: { x: number; y: number; unit: number }
  level?: number
}

/** Encode an RGBA raster to PNG with metadata chunks (iTXt for text; tEXt for latin items). */
export function encodePng(width: number, height: number, rgba: Uint8Array, opts: EncodePngOptions = {}): Buffer {
  const colorType = opts.rgb ? 2 : 6
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1)
    raw[rowStart] = 0
    const o = y * width * 4
    for (let x = 0; x < width; x++) {
      const s = o + x * 4
      const d = rowStart + 1 + x * bpp
      raw[d] = rgba[s]!
      raw[d + 1] = rgba[s + 1]!
      raw[d + 2] = rgba[s + 2]!
      if (bpp === 4) raw[d + 3] = rgba[s + 3]!
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const parts: Buffer[] = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ]
  if (opts.phys) {
    const p = Buffer.alloc(9)
    p.writeUInt32BE(opts.phys.x, 0); p.writeUInt32BE(opts.phys.y, 4); p[8] = opts.phys.unit
    parts.push(chunk('pHYs', p))
  }
  if (opts.iccProfile) {
    const head = Buffer.concat([Buffer.from('icc\0', 'latin1'), Buffer.from([0]), deflateSync(opts.iccProfile)])
    parts.push(chunk('iCCP', head))
  }
  for (const t of opts.text ?? []) {
    if (t.latin && /^[\x20-\x7e\xa0-\xff]*$/u.test(t.keyword) && /^[\x20-\x7e\xa0-\xff]*$/u.test(t.text)) {
      parts.push(chunk('tEXt', Buffer.concat([Buffer.from(t.keyword, 'latin1'), Buffer.from([0]), Buffer.from(t.text, 'latin1')])))
    } else {
      const enc = (s: string) => Buffer.from(s, 'utf8')
      parts.push(chunk('iTXt', Buffer.concat([
        enc(t.keyword), Buffer.from([0, 0, 0, 0, 0]), enc(t.text),
      ])))
    }
  }
  parts.push(chunk('IDAT', deflateSync(raw, { level: opts.level ?? 6 })))
  parts.push(chunk('IEND', new Uint8Array(0)))
  return Buffer.concat(parts)
}

export interface StealthMetadataResult { meta: Record<string, unknown>; source: 'alpha-lsb' }

/** Read NovelAI-style stealth metadata hidden in the alpha channel low bit (x-major bit order). */
export function stealthMetadata(width: number, height: number, rgba: Uint8Array, maxMetadata = 4 * 1024 * 1024): Record<string, unknown> | null {
  const total = width * height
  if (total < 152) return null
  const bit = (i: number): number => rgba[((i % height) * width + Math.floor(i / height)) * 4 + 3]! & 1
  const read = (startBit: number, nBits: number): Uint8Array => {
    const out = new Uint8Array(nBits >> 3)
    for (let i = 0; i < nBits >> 3; i++) {
      let b = 0
      for (let k = 0; k < 8; k++) b = (b << 1) | bit(startBit + i * 8 + k)
      out[i] = b
    }
    return out
  }
  const signature = Buffer.from(read(0, 15 * 8)).toString('latin1')
  if (signature !== 'stealth_pngcomp' && signature !== 'stealth_pnginfo') return null
  const lenBuf = read(15 * 8, 4 * 8)
  const dv = new DataView(lenBuf.buffer, lenBuf.byteOffset, lenBuf.byteLength)
  const length = dv.getUint32(0)
  if (length % 8 || length > maxMetadata * 8 || length + 152 > total) return null
  let raw = read(19 * 8, length)
  try {
    if (signature === 'stealth_pngcomp') raw = gunzipSync(Buffer.from(raw), { maxOutputLength: maxMetadata })
    if (raw.length > maxMetadata) return null
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}
