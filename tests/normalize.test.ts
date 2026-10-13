import { describe, it, expect } from 'vitest'
import { normalizeRequest, SAMPLER_ALIASES, MODEL_ALIASES } from '../src/core/normalize.ts'

describe('normalizeRequest', () => {
  it('parses flat top-level parameters', () => {
    const res = normalizeRequest({
      prompt: '1girl, white hair',
      model: 'nai-diffusion-5-full',
      width: 832,
      height: 1216,
    })
    expect(res.prompt).toBe('1girl, white hair')
    expect(res.model).toBe('nai-diffusion-5-full')
    expect(res.width).toBe(832)
    expect(res.height).toBe(1216)
  })

  it('parses nested request object', () => {
    const res = normalizeRequest({
      request: {
        prompt: '1boy, blue eyes',
        width: 1024,
      },
    })
    expect(res.prompt).toBe('1boy, blue eyes')
    expect(res.width).toBe(1024)
    expect(res.request).toBeUndefined()
  })

  it('merges outer fields and inner request fields', () => {
    const res = normalizeRequest({
      model: 'v5',
      request: {
        prompt: 'scenery, sunset',
      },
    })
    expect(res.prompt).toBe('scenery, sunset')
    expect(res.model).toBe('nai-diffusion-5-full')
  })

  it('strips reserved keys if provided', () => {
    const res = normalizeRequest({
      operation: 'generate',
      base_revision: 5,
      prompt: 'test prompt',
    }, ['operation', 'base_revision'])
    expect(res.prompt).toBe('test prompt')
    expect(res.operation).toBeUndefined()
    expect(res.base_revision).toBeUndefined()
  })

  it('normalizes sampler aliases correctly', () => {
    expect(normalizeRequest({ sampler: 'Euler' }).sampler).toBe('k_euler')
    expect(normalizeRequest({ sampler: 'euler ancestral' }).sampler).toBe('k_euler_ancestral')
    expect(normalizeRequest({ sampler: 'Euler Ancestral' }).sampler).toBe('k_euler_ancestral')
    expect(normalizeRequest({ sampler: 'DPM++ 2M' }).sampler).toBe('k_dpmpp_2m')
    expect(normalizeRequest({ sampler: 'dpm++ 2s ancestral' }).sampler).toBe('k_dpmpp_2s_ancestral')
    expect(normalizeRequest({ sampler: 'DPM++ SDE' }).sampler).toBe('k_dpmpp_sde')
  })

  it('normalizes model aliases correctly', () => {
    expect(normalizeRequest({ model: 'v5' }).model).toBe('nai-diffusion-5-full')
    expect(normalizeRequest({ model: 'v5-curated' }).model).toBe('nai-diffusion-5-curated')
    expect(normalizeRequest({ model: 'v4.5' }).model).toBe('nai-diffusion-4-5-full')
    expect(normalizeRequest({ model: 'v4.5-curated' }).model).toBe('nai-diffusion-4-5-curated')
  })

  it('aligns width and height to nearest multiple of 64', () => {
    const res = normalizeRequest({ width: 800, height: 1200 })
    expect(res.width).toBe(832) // 800 / 64 = 12.5 -> 13 * 64 = 832
    expect(res.height).toBe(1216) // 1200 / 64 = 18.75 -> 19 * 64 = 1216
  })

  it('preserves explicit incompatible model options for validation to reject', () => {
    const res = normalizeRequest({ model: 'v5', noise_schedule: 'exponential', variety_boost: true })
    expect(res.model).toBe('nai-diffusion-5-full')
    expect(res.noise_schedule).toBe('exponential')
    expect(res.variety_boost).toBe(true)
    expect(normalizeRequest({ model: 'v4.5', transparent_background: true }).transparent_background).toBe(true)
  })

  it('does not clamp invalid dimensions into valid potentially costly requests', () => {
    expect(normalizeRequest({ width: -10, height: 99999 })).toMatchObject({ width: -10, height: 99999 })
    expect(normalizeRequest({ width: 63, height: 4097 })).toMatchObject({ width: 63, height: 4097 })
  })

  it('rejects malformed nested request objects instead of silently ignoring them', () => {
    for (const request of [null, [], 'scenery']) expect(() => normalizeRequest({ prompt: 'outer', request })).toThrow('request must be an object')
  })

  it('merges nested fields safely, replaces arrays, and does not resolve inherited aliases', () => {
    const raw = JSON.parse('{"model":"constructor","sampler":"__proto__","editor":{"keep":1,"changed":2},"characters":[{"prompt":"boy"}],"request":{"editor":{"changed":3},"characters":[],"__proto__":{"safe":true}}}')
    const result = normalizeRequest(raw)
    expect(result.editor).toEqual({ keep: 1, changed: 3 })
    expect(result.characters).toEqual([])
    expect(result.model).toBe('constructor')
    expect(result.sampler).toBe('__proto__')
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.hasOwn(result, '__proto__')).toBe(true)
    expect(result.safe).toBeUndefined()
  })

  it('removes reserved fields from both levels without mutating arguments', () => {
    const raw = { operation: 'generate', request: { operation: 'inpaint', prompt: 'inner', nested: { keep: 1 } } }
    expect(normalizeRequest(raw, ['operation'])).toEqual({ prompt: 'inner', nested: { keep: 1 } })
    expect(raw.request.operation).toBe('inpaint')
  })
})
