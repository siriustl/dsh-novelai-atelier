import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { decodePng, encodePng, cleanPngMetadata, stealthMetadata } from '../src/core/png.ts'

function hiddenPng(signature: 'stealth_pngcomp' | 'stealth_pnginfo', alpha: number): Buffer {
  const width = 128, height = 128
  const pixels = new Uint8Array(width * height * 4).fill(255)
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = alpha
  const json = Buffer.from(JSON.stringify({ Comment: JSON.stringify({ prompt: 'secret hidden prompt', steps: 14, seed: 789 }) }))
  const payload = signature === 'stealth_pngcomp' ? gzipSync(json) : json
  const size = Buffer.alloc(4); size.writeUInt32BE(payload.length * 8)
  const bytes = Buffer.concat([Buffer.from(signature), size, payload])
  for (let i = 0; i < bytes.length * 8; i++) {
    const offset = ((i % height) * width + Math.floor(i / height)) * 4 + 3
    pixels[offset] = (pixels[offset]! & 254) | ((bytes[i >> 3]! >> (7 - i % 8)) & 1)
  }
  return encodePng(width, height, pixels)
}


describe('privacy regressions', () => {
  it.each(['all', 'prompts'] as const)('removes half-transparent stealth payloads in %s mode', (mode) => {
    const png = hiddenPng('stealth_pngcomp', 128)
    const before = decodePng(png)
    expect(stealthMetadata(before.width, before.height, before.data)).not.toBeNull()
    const after = decodePng(cleanPngMetadata(png, { mode }))
    expect(stealthMetadata(after.width, after.height, after.data)).toBeNull()
    for (let i = 0; i < after.data.length; i++) {
      expect(Math.abs(after.data[i]! - before.data[i]!)).toBeLessThanOrEqual(i % 4 === 3 ? 1 : 0)
    }
  })

  it.each(['stealth_pngcomp', 'stealth_pnginfo'] as const)('preserves safe hidden-only parameters in prompts mode for %s', (signature) => {
    const result = decodePng(cleanPngMetadata(hiddenPng(signature, 255), { mode: 'prompts' }))
    const comment = result.text.find((t) => t.keyword === 'Comment')
    expect(comment).toBeDefined()
    expect(JSON.parse(comment!.text)).toMatchObject({ steps: 14, seed: 789 })
    expect(JSON.stringify(result.text)).not.toContain('secret')
  })

  it('bounds total decoded text metadata rather than only each compressed chunk', () => {
    const png = encodePng(1, 1, new Uint8Array([1, 2, 3, 255]), { text: [
      { keyword: 'one', text: 'x'.repeat(3 * 1024 * 1024) },
      { keyword: 'two', text: 'y'.repeat(3 * 1024 * 1024) },
    ] })
    expect(() => decodePng(png)).toThrow(/metadata.*limit/i)
  })

  it('drops ICC ancillary data that can carry private strings', () => {
    const png = encodePng(1, 1, new Uint8Array([1, 2, 3, 255]), { iccProfile: Buffer.from('private creator and prompt') })
    const cleaned = decodePng(cleanPngMetadata(png, { mode: 'all' }))
    expect(cleaned.iccProfile).toBeUndefined()
  })

  it('fails closed on malformed comments, nested prompts, aliases, and arbitrary text chunks', () => {
    const pixels = new Uint8Array(64 * 64 * 4).fill(255)
    const source = encodePng(64, 64, pixels, { text: [
      { keyword: 'Comment', text: '{secret malformed prompt' },
      { keyword: 'comment', text: JSON.stringify({ steps: 14, text: 'secret text', parameters: { prompt: 'secret nested prompt' }, characters: [{ prompt: 'secret character' }], v4_prompt: { caption: { base_caption: 'secret base', char_captions: [null, { char_caption: 'secret char' }] } } }) },
      { keyword: 'UC', text: 'secret negative' }, { keyword: 'Title', text: 'secret title' },
      { keyword: 'arbitrary', text: 'secret unknown field' }, { keyword: 'Software', text: 'NovelAI' },
    ] })
    const result = decodePng(cleanPngMetadata(source, { mode: 'prompts' }))
    expect(JSON.stringify(result.text)).not.toContain('secret')
    expect(result.text.find((t) => t.keyword === 'Software')?.text).toBe('NovelAI')
    expect(result.text.some((t) => t.keyword.toLowerCase() === 'comment')).toBe(true)
  })
})

describe('cleanPngMetadata', () => {
  const w = 64
  const h = 64
  const data = new Uint8Array(w * h * 4).fill(255)

  const commentObj = {
    prompt: '1girl, masterpiece, secret prompt',
    uc: 'lowres, bad quality',
    steps: 28,
    scale: 5,
    seed: 123456,
    sampler: 'k_euler_ancestral',
    v4_prompt: {
      caption: {
        base_caption: '1girl, masterpiece, secret prompt',
        char_captions: [{ char_caption: 'solo girl, blue hair', centers: [{ x: 0.5, y: 0.5 }] }],
      },
    },
    v4_negative_prompt: {
      caption: {
        base_caption: 'lowres, bad quality',
        char_captions: [{ char_caption: 'extra limbs', centers: [{ x: 0.5, y: 0.5 }] }],
      },
    },
  }

  const origPng = encodePng(w, h, data, {
    text: [
      { keyword: 'Title', text: 'AI Art' },
      { keyword: 'Description', text: '1girl, secret prompt' },
      { keyword: 'Comment', text: JSON.stringify(commentObj) },
      { keyword: 'Software', text: 'NovelAI' },
    ],
  })

  it('removes all text chunks in "all" mode', () => {
    const cleaned = cleanPngMetadata(origPng, { mode: 'all' })
    const decoded = decodePng(cleaned)
    expect(decoded.text).toEqual([])
  })

  it('strips prompts and character prompts while keeping parameters in "prompts" mode', () => {
    const cleaned = cleanPngMetadata(origPng, { mode: 'prompts' })
    const decoded = decodePng(cleaned)

    // Title and Description removed
    expect(decoded.text.some((t) => t.keyword === 'Title')).toBe(false)
    expect(decoded.text.some((t) => t.keyword === 'Description')).toBe(false)
    expect(decoded.text.some((t) => t.keyword === 'Software')).toBe(true)

    const commentChunk = decoded.text.find((t) => t.keyword === 'Comment')
    expect(commentChunk).toBeDefined()
    const parsed = JSON.parse(commentChunk!.text)

    // Sensitive prompts stripped
    expect(parsed.prompt).toBeUndefined()
    expect(parsed.uc).toBeUndefined()
    expect(parsed.v4_prompt.caption.base_caption).toBe('')
    expect(parsed.v4_prompt.caption.char_captions[0].char_caption).toBe('')
    expect(parsed.v4_negative_prompt.caption.base_caption).toBe('')
    expect(parsed.v4_negative_prompt.caption.char_captions[0].char_caption).toBe('')

    // Safe generation parameters preserved
    expect(parsed.steps).toBe(28)
    expect(parsed.scale).toBe(5)
    expect(parsed.seed).toBe(123456)
    expect(parsed.sampler).toBe('k_euler_ancestral')
  })

  it('injects customText into Description when provided', () => {
    const cleaned = cleanPngMetadata(origPng, {
      mode: 'all',
      customText: 'Created with DSH Atelier by @Sorato 🎨',
    })
    const decoded = decodePng(cleaned)
    expect(decoded.text).toHaveLength(1)
    expect(decoded.text[0]).toEqual({
      keyword: 'Description',
      text: 'Created with DSH Atelier by @Sorato 🎨',
    })
  })
})
