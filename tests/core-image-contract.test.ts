import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileRequest, GenerationRequestSchema } from '../src/core/models.ts'
import { normalizeRequest } from '../src/core/normalize.ts'
import { prepareOperation } from '../src/core/operations.ts'
import { encodePng } from '../src/core/png.ts'
import { recoverRequest } from '../src/core/recovery.ts'
import { redactBinaryPayload } from '../src/core/service.ts'
import { modelSpec } from '../src/core/specs.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'nai-core-contract-'))
  roots.push(root)
  return root
}

it('flattens character tags before the rendered Text block', () => {
  const request = GenerationRequestSchema.parse({ prompt: 'scenery, Text: Hello', flat_prompt: true,
    negative_prompt: 'lowres', quality_preset: 'none', negative_preset: 'none',
    characters: [{ prompt: 'blue hair', negative_prompt: 'bad hands' }] })
  const snapshot = structuredClone(request)
  const { payload } = compileRequest(request)
  expect(payload.input).toBe('scenery, blue hair\nText: Hello')
  const params = payload.parameters as Record<string, any>
  expect(params.v4_prompt.caption.char_captions).toEqual([])
  expect(params.negative_prompt).toBe('lowres, bad hands')
  expect(request).toEqual(snapshot)
})

it('uses the official Medium model and fixed settings without forwarding negative drafts', async () => {
  const request = { model: 'nai-diffusion-5-full', v5_tier: 'medium', prompt: 'scenery', steps: 40,
    sampler: 'k_euler', cfg_rescale: 0.7, negative_preset: 'none', negative_prompt: 'private global draft',
    characters: [{ prompt: 'blue hair', negative_prompt: 'private character draft' }] }
  const prepared = await prepareOperation(request, 'generate')
  expect(prepared.payload.model).toBe('nai-diffusion-5-full-medium')
  const params = prepared.payload.parameters as Record<string, any>
  expect(params).toMatchObject({ steps: 14, sampler: 'k_euler_ancestral', cfg_rescale: 0, ucPresetId: 'heavy', tag_hint_uc_preset: 2 })
  const heavy = modelSpec('nai-diffusion-5-full').uc_presets.find((p) => p.id === 'heavy')!.prefix!
  expect(params.negative_prompt).toBe('nsfw, ' + heavy)
  expect(params.v4_negative_prompt.caption.base_caption).toBe(params.negative_prompt)
  expect(params.v4_negative_prompt.caption.char_captions[0].char_caption).toBe('')
  expect(request.negative_prompt).toBe('private global draft')
  // The preview must show the effective Medium fields, not the ones it discards.
  expect(prepared.summary['request']).toMatchObject({ steps: 14, sampler: 'k_euler_ancestral', cfg_rescale: 0, negative_preset: 'heavy', negative_prompt: '' })
})

it.each(['nai-diffusion-5-curated', 'nai-diffusion-4-5-full'])('rejects unsupported Medium tier for %s', async (model) => {
  await expect(prepareOperation({ model, v5_tier: 'medium', prompt: 'scenery' }, 'generate')).rejects.toThrow(/Medium/)
})

it('normalizes a Medium model alias without changing the canonical base-model contract', () => {
  expect(normalizeRequest({ model: 'nai-diffusion-5-full-medium', prompt: 'scenery' })).toMatchObject({ model: 'nai-diffusion-5-full', v5_tier: 'medium' })
})

describe('offline receipt and metadata recovery', () => {
  it.each(['Source', 'model_hash'])('recovers the live-observed Medium hash from %s without guessing High', async (field) => {
    const root = temporary(), path = join(root, 'observed-medium.png')
    const prepared = await prepareOperation({ prompt: '1boy, solo', v5_tier: 'medium', width: 64, height: 64, seed: 123 }, 'generate')
    const comment = { ...prepared.payload.parameters as object, prompt: prepared.payload.input,
      uc: (prepared.payload.parameters as any).negative_prompt, request_type: 'PromptGenerateRequest', skip_cfg_above_sigma: null,
      ...(field === 'model_hash' ? { model_hash: '70ab5786' } : {}) }
    writeFileSync(path, encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255), { text: [
      { keyword: 'Comment', text: JSON.stringify(comment) },
      ...(field === 'Source' ? [{ keyword: 'Source', text: 'NovelAI Diffusion V5 70AB5786' }] : []),
    ] }))
    expect(await recoverRequest(path)).toMatchObject({ ready_to_reuse: true, unknown_fields: [], unsupported_fields: [],
      model_resolution: 'observed_model_hash', request: { model: 'nai-diffusion-5-full', v5_tier: 'medium', steps: 14 } })
  })

  it.each(['generate', 'img2img', 'inpaint', 'outpaint'])('roundtrips Medium %s receipts including random seeds and coordinates', async (operation) => {
    const root = temporary(), source = join(root, 'source.png')
    writeFileSync(source, encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255)))
    const prepared = await prepareOperation({ model: 'nai-diffusion-5-full', v5_tier: 'medium', prompt: 'scenery',
      width: operation === 'outpaint' ? 128 : 64, height: operation === 'outpaint' ? 128 : 64, image_path: source, mask_path: source, left: 11, top: 13,
      characters: [{ prompt: 'blue hair', x: 0.25, y: 0.75 }] }, operation)
    const path = join(root, 'receipt.json')
    writeFileSync(path, JSON.stringify({ id: '20261003T120000Z-abcdef1234', operation: prepared.operation, status: 'generated',
      ...prepared.summary, endpoint: prepared.endpoint, api_payload: redactBinaryPayload(prepared.payload) }))
    const recovered = await recoverRequest(path)
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ ready_to_reuse: true, exact_payload_match: true, operation,
      request: { model: 'nai-diffusion-5-full', v5_tier: 'medium' } })
    if (operation === 'outpaint') expect((recovered.request as any).characters[0]).toMatchObject({ x: 0.25, y: 0.75 })
  })

  it.each(['upscale', 'augment', 'encode_vibe'])('preserves %s output subdirectories through preparation and receipt recovery', async (operation) => {
    const root = temporary(), source = join(root, 'source.png')
    writeFileSync(source, encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255)))
    const request = { image_path: source, tool: 'lineart', output_subdir: 'test-output' }
    const prepared = await prepareOperation(request, operation)
    expect(prepared.output_subdir).toBe('test-output')
    const path = join(root, 'receipt.json')
    writeFileSync(path, JSON.stringify({ id: '20261003T120000Z-abcdef1234', operation: prepared.operation, status: 'generated',
      ...prepared.summary, endpoint: prepared.endpoint, api_payload: redactBinaryPayload(prepared.payload) }))
    expect(await recoverRequest(path)).toMatchObject({ ready_to_reuse: true, request: { output_subdir: 'test-output' } })
    await expect(prepareOperation({ ...request, output_subdir: '../escape' }, operation)).rejects.toThrow()
  })

  it('does not mark conflicting Medium PNG settings reusable', async () => {
    const root = temporary(), path = join(root, 'medium-conflict.png')
    const prepared = await prepareOperation({ prompt: 'scenery', v5_tier: 'medium', width: 64, height: 64, seed: 123 }, 'generate')
    writeFileSync(path, encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255), { text: [{ keyword: 'Comment', text: JSON.stringify({
      ...prepared.payload.parameters as object, model: 'nai-diffusion-5-full-medium', steps: 30,
      prompt: prepared.payload.input, uc: (prepared.payload.parameters as any).negative_prompt,
      request_type: 'PromptGenerateRequest', skip_cfg_above_sigma: null,
    }) }] }))
    const recovered = await recoverRequest(path)
    expect(recovered.ready_to_reuse).toBe(false)
    expect(recovered.unsupported_fields).toContain('medium_fixed.steps')
  })

  it('recovers Medium PNG metadata as Medium rather than silently defaulting to High', async () => {
    const root = temporary(), path = join(root, 'medium.png')
    const prepared = await prepareOperation({ model: 'nai-diffusion-5-full', v5_tier: 'medium', prompt: 'scenery', width: 64, height: 64, seed: 123 }, 'generate')
    writeFileSync(path, encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255), { text: [{ keyword: 'Comment', text: JSON.stringify({
      ...prepared.payload.parameters as object, model: 'nai-diffusion-5-full-medium', prompt: prepared.payload.input,
      uc: (prepared.payload.parameters as any).negative_prompt, request_type: 'PromptGenerateRequest', skip_cfg_above_sigma: null,
    }) }] }))
    expect(await recoverRequest(path)).toMatchObject({ ready_to_reuse: true, request: { model: 'nai-diffusion-5-full', v5_tier: 'medium' } })
  })
})
