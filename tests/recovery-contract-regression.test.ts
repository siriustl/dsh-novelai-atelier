import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareOperation, type PreparedOperation } from '../src/core/operations.ts'
import { encodePng } from '../src/core/png.ts'
import { recoverRequest } from '../src/core/recovery.ts'
import { redactBinaryPayload } from '../src/core/service.ts'

const roots: string[] = []
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'nai-recovery-contract-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function image(path: string, note = 'original', size = 64): void {
  const pixels = new Uint8Array(size * size * 4).fill(255)
  writeFileSync(path, encodePng(size, size, pixels, { text: [{ keyword: 'Description', text: note }] }))
}
function receipt(root: string, prepared: PreparedOperation, changes: Record<string, unknown> = {}): string {
  const path = join(root, 'receipt.json')
  writeFileSync(path, JSON.stringify({
    id: '20261003T120000Z-abcdef1234', operation: prepared.operation, status: 'generated',
    ...prepared.summary, endpoint: prepared.endpoint, api_payload: redactBinaryPayload(prepared.payload), ...changes,
  }))
  return path
}
async function preciseReference() {
  const root = temporary(), source = join(root, 'reference.png')
  image(source, 'original', 1472)
  const prepared = await prepareOperation({ prompt: 'geometric shapes', model: 'nai-diffusion-4-5-full', seed: 123, width: 64, height: 64, precise_references: [{ image_path: source }] }, 'reference_generate')
  return { root, source, prepared }
}

describe('receipt input identity recovery', () => {
  it('checks precise-reference hashes even when the recorded vibes array is empty', async () => {
    const { root, prepared } = await preciseReference()
    const recovered = await recoverRequest(receipt(root, prepared))
    expect(recovered.ready_to_reuse).toBe(true)
    expect(recovered.input_file_checks).toEqual([{ field: 'references[0].sha256', status: 'matched' }])
  })

  it('rejects a changed precise-reference file even when its compiled pixels match', async () => {
    const { root, source, prepared } = await preciseReference()
    const record = receipt(root, prepared)
    image(source, 'changed metadata, identical pixels', 1472)
    const recovered = await recoverRequest(record)
    expect(recovered.exact_payload_match).toBe(true)
    expect(recovered.ready_to_reuse).toBe(false)
    expect(recovered.input_files_match).toBe(false)
    expect(recovered.source_differences).toEqual(['references[0].sha256'])
  })

  it('does not claim identity when an older receipt lacks precise-reference hashes', async () => {
    const { root, prepared } = await preciseReference()
    const recovered = await recoverRequest(receipt(root, prepared, { references: [{}] }))
    expect(recovered.exact_payload_match).toBe(true)
    expect(recovered.ready_to_reuse).toBe(false)
    expect(recovered.unknown_fields).toContain('references[0].sha256')
  })

  it.each(['img2img', 'enhance', 'inpaint', 'upscale', 'augment', 'encode_vibe'])('roundtrips %s receipts without a network client', async (operation) => {
    const root = temporary(), source = join(root, 'source.png')
    image(source)
    const prepared = await prepareOperation({ prompt: operation === 'augment' ? '' : 'geometric shapes', image_path: source, mask_path: source, seed: 123, tool: 'lineart' }, operation)
    const recovered = await recoverRequest(receipt(root, prepared))
    expect(recovered.ready_to_reuse).toBe(true)
    expect(recovered.exact_payload_match).toBe(true)
    expect(recovered.input_file_checks).toContainEqual({ field: 'source.sha256', status: 'matched' })
  })
})

async function metadataImage(extra: Record<string, unknown>): Promise<string> {
  const root = temporary(), path = join(root, 'metadata.png')
  const prepared = await prepareOperation({ prompt: 'geometric shapes', width: 64, height: 64, seed: 123, quality_preset: 'none', negative_preset: 'none' }, 'generate')
  const comment = { ...prepared.payload.parameters as Record<string, unknown>, model: prepared.payload.model, prompt: prepared.payload.input, uc: '', request_type: 'PromptGenerateRequest', skip_cfg_above_sigma: null, ...extra }
  writeFileSync(path, encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255), { text: [{ keyword: 'Comment', text: JSON.stringify(comment) }] }))
  return path
}

describe('PNG metadata reference defaults', () => {
  it('accepts empty reference arrays as inactive options', async () => {
    const path = await metadataImage({ reference_image_multiple: [], reference_strength_multiple: [], reference_information_extracted_multiple: [], director_reference_strengths: [], director_reference_descriptions: [], director_reference_information_extracted: [], director_reference_secondary_strengths: [] })
    const recovered = await recoverRequest(path)
    expect(recovered.unsupported_fields).toEqual([])
    expect(recovered.unknown_fields).toEqual([])
    expect(recovered.ready_to_reuse).toBe(true)
  })

  it('still reports populated reference arrays as unsupported reconstruction', async () => {
    const path = await metadataImage({ reference_strength_multiple: [0.6] })
    const recovered = await recoverRequest(path)
    expect(recovered.unsupported_fields).toContain('reference_strength_multiple')
    expect(recovered.ready_to_reuse).toBe(false)
  })
})
