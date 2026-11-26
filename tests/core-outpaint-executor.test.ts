import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { NovelAIClient } from '../src/core/client.ts'
import { prepareOperation } from '../src/core/operations.ts'
import { decodePng, encodePng } from '../src/core/png.ts'
import { recoverRequest } from '../src/core/recovery.ts'
import { OperationExecutor } from '../src/core/service.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('offline outpaint executor integration', () => {
  it.each(['high', 'medium'] as const)('preserves source RGBA and recovers %s seed and source coordinates after execution', async (tier) => {
    const root = mkdtempSync(join(tmpdir(), 'nai-core-outpaint-executor-'))
    roots.push(root)
    const sourcePath = join(root, 'source.png')
    const pixels = new Uint8Array(64 * 64 * 4)
    const alphas = [0, 1, 127, 128, 254, 255]
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const offset = (y * 64 + x) * 4
        pixels.set([x * 3, y * 3, (x + y) * 2, alphas[(x + y) % alphas.length]!], offset)
      }
    }
    const original = encodePng(64, 64, pixels, { text: [{ keyword: 'Description', text: 'Original must remain untouched' }] })
    writeFileSync(sourcePath, original)
    const prepared = await prepareOperation({ image_path: sourcePath, prompt: 'scenery',
      model: 'nai-diffusion-5-full', v5_tier: tier, output_subdir: 'executor-regression',
      left: 17, right: 9, top: 11, bottom: 7, seam_overlap: 8,
      steps: 40, sampler: 'k_euler', cfg_rescale: 0.7,
      characters: [{ prompt: 'blue hair', negative_prompt: 'draft negative', x: 0.25, y: 0.75 }],
    }, 'outpaint')
    const parameters = prepared.payload.parameters as Record<string, any>
    const expectedModel = tier === 'medium' ? 'nai-diffusion-5-full-medium-inpainting' : 'nai-diffusion-5-full-inpainting'
    expect(prepared).toMatchObject({ operation: 'outpaint', payload: { model: expectedModel, action: 'infill' } })
    const seed = parameters.seed
    expect(Number.isInteger(seed)).toBe(true)
    const generatedPixels = new Uint8Array(parameters.width * parameters.height * 4)
    for (let offset = 0; offset < generatedPixels.length; offset += 4) generatedPixels.set([211, 22, 33, 255], offset)
    const apiPng = encodePng(parameters.width, parameters.height, generatedPixels)
    const postOperation = vi.fn().mockResolvedValue(apiPng)
    const credits = vi.fn().mockRejectedValue(new Error('Billing must never be queried'))
    const client = { postOperation, credits } as unknown as NovelAIClient
    const token = vi.fn((): string => { throw new Error('Credentials must not be read with a mock client') })
    const executor = new OperationExecutor({ token, baseUrl: () => 'https://invalid.example', proxy: () => null,
      outputDir: () => root, dataDir: () => root }, { run: async (fn) => fn() })

    const result = await executor.execute(prepared, { client })
    expect(result).toMatchObject({ operation: 'outpaint', status: 'generated', model: expectedModel, seed,
      dimensions: [{ width: 128, height: 128 }] })
    expect(postOperation).toHaveBeenCalledOnce()
    expect(postOperation.mock.calls[0]![0]).toBe('/ai/generate-image')
    expect(postOperation.mock.calls[0]![1]).toBe(prepared.payload)
    expect(credits).not.toHaveBeenCalled()
    expect(token).not.toHaveBeenCalled()
    expect(executor.activeExecutions).toBe(0)
    if (tier === 'medium') expect(parameters).toMatchObject({ steps: 14, sampler: 'k_euler_ancestral', cfg_rescale: 0 })

    const recordPath = result.record_path as string
    expect(dirname(recordPath)).toBe(join(root, 'executor-regression'))
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    expect(record).toMatchObject({ operation: 'outpaint', status: 'generated', composited_inpaint: true,
      api_payload: { model: expectedModel, parameters: { seed } },
      request: { characters: [{ x: 0.25, y: 0.75 }] } })
    expect(readFileSync(record.raw_api_image_path).equals(apiPng)).toBe(true)
    expect(readFileSync(sourcePath).equals(original)).toBe(true)

    const saved = decodePng(readFileSync(result.image_path as string))
    const upload = decodePng(Buffer.from(parameters.image, 'base64'))
    const outpaint = prepared.summary.outpaint as Record<string, number>
    const preserved: number[] = [], uploaded: number[] = [], expected: number[] = []
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const destination = ((y + outpaint.top!) * saved.width + x + outpaint.left!) * 4
        if (prepared.inpaint_context!.mask.data[destination] !== 0) continue
        preserved.push(...saved.data.subarray(destination, destination + 4))
        uploaded.push(...upload.data.subarray(destination, destination + 4))
        const offset = (y * 64 + x) * 4
        expected.push(...pixels.subarray(offset, offset + 4))
      }
    }
    expect(expected.length).toBeGreaterThan(0)
    expect(preserved).toEqual(expected)
    expect(uploaded).toEqual(expected)
    expect(Array.from(saved.data.subarray(0, 4))).toEqual([211, 22, 33, 255])
    const seam = (outpaint.top! * saved.width + outpaint.left!) * 4
    expect(Array.from(saved.data.subarray(seam, seam + 4))).toEqual([211, 22, 33, 255])

    const recovered = await recoverRequest(recordPath)
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ operation: 'outpaint', ready_to_reuse: true,
      exact_payload_match: true, input_files_match: true,
      request: { model: 'nai-diffusion-5-full', v5_tier: tier, seed,
        characters: [{ x: 0.25, y: 0.75 }], output_subdir: 'executor-regression' } })
    const rebuilt = await prepareOperation(recovered.request, 'outpaint')
    const rebuiltParameters = rebuilt.payload.parameters as Record<string, any>
    expect(rebuilt.payload.model).toBe(expectedModel)
    expect(rebuiltParameters.seed).toBe(seed)
    expect(rebuiltParameters.extra_noise_seed).toBe(parameters.extra_noise_seed)
    expect(rebuiltParameters.v4_prompt.caption.char_captions).toEqual(parameters.v4_prompt.caption.char_captions)
  })
})
