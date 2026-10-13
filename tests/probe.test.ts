import { describe, it, expect } from 'vitest'
import { ReferenceGenerationRequestSchema } from '../src/core/operations.ts'

describe('reference_generate schema probe', () => {
  it('keeps vibes through parse', () => {
    const input = {
      model: 'nai-diffusion-4-5-full', prompt: '1girl', width: 512, height: 768, steps: 23, scale: 5, seed: 42,
      vibes: [{ encoding_path: 'C:/x/y.vibe', strength: 0.6 }], characters: [], max_anlas: 20,
    }
    const parsed = ReferenceGenerationRequestSchema.parse(input)
    expect(parsed.vibes.length).toBe(1)
  })
})
