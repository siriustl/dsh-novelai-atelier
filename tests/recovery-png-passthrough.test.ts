import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareOperation } from '../src/core/operations.ts'
import { encodePng } from '../src/core/png.ts'
import { recoverRequest } from '../src/core/recovery.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function metadataImage(passthrough: Record<string, unknown>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'nai-png-reference-default-')); roots.push(root)
  const path = join(root, 'metadata.png')
  const prepared = await prepareOperation({ model: 'nai-diffusion-4-5-full', prompt: 'geometric shapes', width: 64, height: 64, seed: 123, quality_preset: 'none', negative_preset: 'none' }, 'generate')
  const comment = {
    ...prepared.payload.parameters as Record<string, unknown>,
    prompt: prepared.payload.input, uc: '', request_type: 'PromptGenerateRequest',
    skip_cfg_above_sigma: null, extra_passthrough_testing: passthrough,
  }
  writeFileSync(path, encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255), { text: [
    { keyword: 'Source', text: 'NovelAI Diffusion V4.5 4BDE2A90' },
    { keyword: 'Comment', text: JSON.stringify(comment) },
  ] }))
  return path
}

describe('observed V4.5 PNG passthrough reference default', () => {
  it('accepts the observed inactive director_reference_images null value', async () => {
    const path = await metadataImage({ director_reference_images: null })
    expect(await recoverRequest(path)).toMatchObject({
      ready_to_reuse: true, unknown_fields: [], unsupported_fields: [],
      request: { model: 'nai-diffusion-4-5-full', seed: 123, prompt: 'geometric shapes' },
    })
  })

  it.each([['encoded'], 'encoded', {}, [], false].map((value) => [value]))('keeps non-null image-reference values unsupported: %j', async (images) => {
    const path = await metadataImage({ director_reference_images: images })
    expect(await recoverRequest(path)).toMatchObject({
      ready_to_reuse: false, unsupported_fields: ['extra_passthrough_testing.director_reference_images'],
    })
  })

  it('does not treat every unknown null passthrough field as harmless', async () => {
    const path = await metadataImage({ future_reference_option: null })
    expect(await recoverRequest(path)).toMatchObject({
      ready_to_reuse: false, unsupported_fields: ['extra_passthrough_testing.future_reference_option'],
    })
  })
})
