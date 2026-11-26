import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePng, encodePng } from '../src/core/png.ts'
import { prepareOperation } from '../src/core/operations.ts'
import { pickV5ReferenceBucket, pickV45ReferenceCanvas, V5_REFERENCE_BUCKETS } from '../src/core/referenceImage.ts'
import { quoteOperation } from '../src/core/billing.ts'
import { OperationExecutor } from '../src/core/service.ts'
import { recoverRequest } from '../src/core/recovery.ts'
import { Workbench } from '../src/workbench/app.ts'
import { registerTools } from '../src/tools.ts'
import { specCatalog } from '../src/core/specs.ts'

const roots: string[] = []
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'nai-v5-ref-')); roots.push(d); return d }
afterEach(() => { vi.restoreAllMocks(); for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }) })

function writeSolidPng(dir: string, name: string, width: number, height: number, rgba = [180, 90, 40, 255]): string {
  const buf = new Uint8Array(width * height * 4)
  for (let i = 0; i < buf.length; i += 4) buf.set(rgba, i)
  const path = join(dir, name)
  writeFileSync(path, encodePng(width, height, buf))
  return path
}

describe('V5 Precise Reference & Outfit Reference (0.20.0)', () => {
  it('exposes official V5 precise-reference capabilities in model-specs.json', () => {
    const specs = specCatalog().models
    for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated']) {
      expect(specs[model]!['capabilities']).toMatchObject({
        precise_reference: true,
        precise_reference_inpainting: false,
        outfit_reference: true,
        precise_reference_fidelity: false,
        precise_reference_strength_max: 5,
        precise_reference_bucketing: true,
        vibe_transfer: false,
      })
    }
    for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated']) {
      expect(specs[model]!['capabilities']).toMatchObject({
        precise_reference: true,
        outfit_reference: false,
        precise_reference_fidelity: true,
        precise_reference_strength_max: 1,
        precise_reference_bucketing: false,
      })
    }
  })

  it('uses official 97-bucket cover+crop math for V5 and 3-canvas black pad for V4.5', () => {
    expect(V5_REFERENCE_BUCKETS).toHaveLength(97)
    expect(pickV5ReferenceBucket(832, 1216)).toMatchObject({ width: 832, height: 1216, unchanged: true })
    expect(pickV5ReferenceBucket(600, 600)).toMatchObject({ width: 1024, height: 1024, unchanged: false })
    expect(pickV5ReferenceBucket(1920, 1080)).toMatchObject({ width: 1344, height: 768, unchanged: false })
    expect(pickV45ReferenceCanvas(600, 600)).toMatchObject({ width: 1472, height: 1472 })
    expect(pickV45ReferenceCanvas(400, 900)).toMatchObject({ width: 1024, height: 1536 })
  })

  it('compiles V5 character, outfit (costume), style, and prefer_same_outfit wire captions accurately', async () => {
    const dir = tempDir()
    const charImg = writeSolidPng(dir, 'char.png', 200, 300, [200, 100, 50, 255])
    const outfitImg = writeSolidPng(dir, 'outfit.png', 300, 300, [50, 150, 220, 255])
    const styleImg = writeSolidPng(dir, 'style.png', 300, 200, [90, 200, 90, 255])

    const prepared = await prepareOperation({
      model: 'nai-diffusion-5-full',
      prompt: '1girl, outdoors',
      precise_references: [
        { image_path: charImg, type: 'character', prefer_same_outfit: true, strength: 1.5 },
        { image_path: outfitImg, type: 'outfit', strength: 2.5 },
        { image_path: styleImg, type: 'character&style', prefer_same_outfit: false, strength: -0.5, fidelity: 0.4 },
      ],
    }, 'reference_generate')

    const params = prepared.payload['parameters'] as Record<string, any>
    expect(prepared.payload['model']).toBe('nai-diffusion-5-full')
    expect(params['director_reference_descriptions']).toEqual([
      { caption: { base_caption: 'character_mainoutfit', char_captions: [] }, legacy_uc: false },
      { caption: { base_caption: 'costume', char_captions: [] }, legacy_uc: false },
      { caption: { base_caption: 'character&style_anyoutfit', char_captions: [] }, legacy_uc: false },
    ])
    expect(params['director_reference_strength_values']).toEqual([1.5, 2.5, -0.5])
    // V5 always fixes secondary_strength to 0 (fidelity=1) and warns when caller passes non-1 fidelity.
    expect(params['director_reference_secondary_strength_values']).toEqual([0, 0, 0])
    expect(prepared.warnings.some((w) => w.includes('Fidelity'))).toBe(true)
    expect(prepared.warnings.some((w) => w.includes('Multiple character references'))).toBe(true)

    // Verify V5 bucket output has NO black padding on the solid orange image
    const decoded0 = decodePng(Buffer.from(params['director_reference_images'][0], 'base64'))
    expect([decoded0.width, decoded0.height]).toEqual([832, 1216])
    expect(decoded0.data[0]).toBeGreaterThan(150) // top-left pixel is image content, not black bar
  })

  it('supports V5 Medium tier and V5 Curated with precise_references without overwriting Medium fixed fields', async () => {
    const dir = tempDir()
    const ref = writeSolidPng(dir, 'ref.png', 128, 128)
    const medium = await prepareOperation({
      model: 'nai-diffusion-5-full',
      v5_tier: 'medium',
      prompt: '1girl, smile',
      precise_references: [{ image_path: ref, type: 'outfit', strength: 1 }],
    }, 'reference_generate')
    expect(medium.payload['model']).toBe('nai-diffusion-5-full-medium')
    expect((medium.payload['parameters'] as Record<string, any>)['steps']).toBe(14)
    expect((medium.summary['request'] as Record<string, any>)['steps']).toBe(14)
    expect(medium.warnings.some((w) => w.includes('Multiple character references'))).toBe(false)

    const curated = await prepareOperation({
      model: 'nai-diffusion-5-curated',
      prompt: '1girl, smile',
      precise_references: [{ image_path: ref, type: 'costume', strength: 1 }],
    }, 'reference_generate')
    expect(curated.payload['model']).toBe('nai-diffusion-5-curated')
    expect((curated.payload['parameters'] as Record<string, any>)['director_reference_descriptions'][0].caption.base_caption).toBe('costume')
  })

  it('enforces V4.5 boundaries (rejects outfit, prefer_same_outfit, strength > 1; retains fidelity & black pad)', async () => {
    const dir = tempDir()
    const ref = writeSolidPng(dir, 'ref.png', 200, 100, [220, 40, 40, 255])
    await expect(prepareOperation({
      model: 'nai-diffusion-4-5-full',
      prompt: '1girl',
      precise_references: [{ image_path: ref, type: 'outfit' }],
    }, 'reference_generate')).rejects.toThrow(/V5/)
    await expect(prepareOperation({
      model: 'nai-diffusion-4-5-full',
      prompt: '1girl',
      precise_references: [{ image_path: ref, type: 'character', prefer_same_outfit: true }],
    }, 'reference_generate')).rejects.toThrow(/V5/)
    await expect(prepareOperation({
      model: 'nai-diffusion-4-5-full',
      prompt: '1girl',
      precise_references: [{ image_path: ref, type: 'character', strength: 2 }],
    }, 'reference_generate')).rejects.toThrow(/-1 and 1/)
    await expect(prepareOperation({
      model: 'nai-diffusion-5-full',
      prompt: '1girl',
      vibes: [{ encoding_path: join(dir, 'x.vibe'), strength: 0.6 }],
    }, 'reference_generate')).rejects.toThrow(/V4\.5/)

    const v45 = await prepareOperation({
      model: 'nai-diffusion-4-5-full',
      prompt: '1girl',
      precise_references: [{ image_path: ref, type: 'character', strength: 0.8, fidelity: 0.6 }],
    }, 'reference_generate')
    const params = v45.payload['parameters'] as Record<string, any>
    expect(params['director_reference_secondary_strength_values'][0]).toBeCloseTo(0.4, 5)
    const decoded = decodePng(Buffer.from(params['director_reference_images'][0], 'base64'))
    expect([decoded.width, decoded.height]).toEqual([1536, 1024])
    // Top-left corner is black padding because 2:1 image on 3:2 canvas pads top/bottom
    expect([decoded.data[0], decoded.data[1], decoded.data[2]]).toEqual([0, 0, 0])
  })

  it('supports precise_references in img2img with full receipt recovery, and rejects them in enhance', async () => {
    const dir = tempDir()
    const source = writeSolidPng(dir, 'src.png', 128, 128, [60, 80, 120, 255])
    const outfit = writeSolidPng(dir, 'outfit.png', 128, 128, [200, 180, 40, 255])

    await expect(prepareOperation({
      model: 'nai-diffusion-5-full',
      prompt: '1girl',
      image_path: source,
      precise_references: [{ image_path: outfit, type: 'outfit' }],
    }, 'enhance')).rejects.toThrow(/not enhance/)

    const prepared = await prepareOperation({
      model: 'nai-diffusion-5-full',
      prompt: '1girl, new dress',
      image_path: source,
      seed: 99,
      precise_references: [{ image_path: outfit, type: 'outfit', strength: 1.2 }],
    }, 'img2img')
    expect(prepared.operation).toBe('img2img')
    expect(prepared.payload['action']).toBe('img2img')
    expect((prepared.payload['parameters'] as Record<string, any>)['director_reference_descriptions']).toEqual([
      { caption: { base_caption: 'costume', char_captions: [] }, legacy_uc: false },
    ])

    const fakeOutput = encodePng(128, 128, new Uint8Array(128 * 128 * 4).fill(255))
    const executor = new OperationExecutor(
      { token: () => '', baseUrl: () => 'https://image.novelai.net', proxy: () => null, outputDir: () => dir, dataDir: () => dir },
      { run: async (fn) => fn() },
    )
    const result = await executor.execute(prepared, {
      client: { postOperation: vi.fn().mockResolvedValue(fakeOutput) } as any,
    })
    const recovered = await recoverRequest(String(result['record_path']))
    expect(recovered['ready_to_reuse']).toBe(true)
    expect(recovered['exact_payload_match']).toBe(true)
    expect(recovered['unsupported_fields']).toEqual([])
  })

  it('applies updated Nov 2026 per-image Vibe surcharge and avoids double prepareOperation in nai_quote', async () => {
    const dir = tempDir()
    const ref = writeSolidPng(dir, 'ref.png', 128, 128)
    const credits = {
      active: true, tier: 3, expires_at: Math.floor(Date.now() / 1000) + 86400,
      anlas: { subscription: 500, purchased: 0, total: 500 }, perks: {},
      v5_usage: { isNegative: false, percent: 100, timeUntilNextPercent: 0 },
      v5_usage_summary: { pool_available: true, remaining_percent: 100, refill_one_percentage_point_seconds: 0, refill_percentage_points_per_day: null, refill_paused_above_cap: true },
    }
    const fakeMultiVibeOp = {
      operation: 'reference_generate', endpoint: '/ai/generate-image',
      payload: { model: 'nai-diffusion-4-5-full', parameters: { width: 832, height: 1216, steps: 23, n_samples: 3, reference_image_multiple: [1, 2, 3, 4, 5, 6] } },
      expected_outputs: 3, expected_dimensions: null, summary: {}, warnings: [], generation_request: null, output_kind: 'image', max_anlas: 0, inpaint_context: null,
    }
    const quoted = quoteOperation(fakeMultiVibeOp, credits)
    // 2 extra vibes * 2 Anlas * 3 images = 12 + 2 paid base samples
    const baseUnit = quoteOperation({ ...fakeMultiVibeOp, payload: { model: 'nai-diffusion-4-5-full', parameters: { width: 832, height: 1216, steps: 23, n_samples: 2 } } }, credits).estimated_anlas as number
    expect(quoted.estimated_anlas).toBe(baseUnit * 2 + 12)

    // Verify nai_quote runs prepareOperation only ONCE via WeakMap handoff, and preserves img2img with precise_references
    const wb = new Workbench(dir)
    const tools = new Map<string, any>()
    registerTools({ effect: (fn: () => void) => fn(), tools: { register: (t: any) => tools.set(t.name, t) } } as never, wb)
    vi.spyOn(wb.executor, 'credits').mockResolvedValue(credits as never)
    const ops = await import('../src/core/operations.ts')
    const spy = vi.spyOn(ops, 'prepareOperation')
    const res = await tools.get('nai_quote').execute({
      operation: 'img2img',
      request: { prompt: '1girl', image_path: ref, precise_references: [{ image_path: ref, type: 'outfit' }] },
    }, { signal: new AbortController().signal })
    expect(res.operation).toBe('img2img')
    expect(res.estimated_anlas).toBe(5)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
