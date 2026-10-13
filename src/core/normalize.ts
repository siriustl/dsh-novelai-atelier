/** Request normalizer for friendly LLM/user arguments. */
import type { Rec } from '../workbench/store.ts'

export const SAMPLER_ALIASES: Record<string, string> = {
  euler: 'k_euler',
  k_euler: 'k_euler',
  'euler ancestral': 'k_euler_ancestral',
  'euler_ancestral': 'k_euler_ancestral',
  'euler-ancestral': 'k_euler_ancestral',
  'euler a': 'k_euler_ancestral',
  'eulera': 'k_euler_ancestral',
  k_euler_ancestral: 'k_euler_ancestral',
  'dpm++ 2s ancestral': 'k_dpmpp_2s_ancestral',
  'dpm++_2s_ancestral': 'k_dpmpp_2s_ancestral',
  'dpmpp_2s_ancestral': 'k_dpmpp_2s_ancestral',
  k_dpmpp_2s_ancestral: 'k_dpmpp_2s_ancestral',
  'dpm++ 2m': 'k_dpmpp_2m',
  'dpm++_2m': 'k_dpmpp_2m',
  'dpmpp_2m': 'k_dpmpp_2m',
  k_dpmpp_2m: 'k_dpmpp_2m',
  'dpm++ sde': 'k_dpmpp_sde',
  'dpm++_sde': 'k_dpmpp_sde',
  'dpmpp_sde': 'k_dpmpp_sde',
  k_dpmpp_sde: 'k_dpmpp_sde',
}

export const MODEL_ALIASES: Record<string, string> = {
  v5: 'nai-diffusion-5-full',
  'v5-full': 'nai-diffusion-5-full',
  'v5_full': 'nai-diffusion-5-full',
  'v5-curated': 'nai-diffusion-5-curated',
  'v5_curated': 'nai-diffusion-5-curated',
  'nai-diffusion-5-full': 'nai-diffusion-5-full',
  'nai-diffusion-5-curated': 'nai-diffusion-5-curated',
  'v4.5': 'nai-diffusion-4-5-full',
  'v45': 'nai-diffusion-4-5-full',
  'v4.5-full': 'nai-diffusion-4-5-full',
  'v45-full': 'nai-diffusion-4-5-full',
  'v4.5-curated': 'nai-diffusion-4-5-curated',
  'v45-curated': 'nai-diffusion-4-5-curated',
  'nai-diffusion-4-5-full': 'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated': 'nai-diffusion-4-5-curated',
}

/** Recursively merge object fields; arrays, null, and scalar values replace the prior value. */
export function mergeRequest(base: Rec, patch: Rec): Rec {
  const fields = new Map(Object.entries(base))
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const previous = fields.get(key)
    const nested = value !== null && typeof value === 'object' && !Array.isArray(value)
    fields.set(key, nested && previous !== null && typeof previous === 'object' && !Array.isArray(previous)
      ? mergeRequest(previous as Rec, value as Rec)
      : structuredClone(value))
  }
  return Object.fromEntries(fields)
}

/** Flatten raw tool arguments; explicit nested request fields retain legacy precedence. */
export function normalizeRequest(raw: Rec | null | undefined, reservedKeys: string[] = []): Rec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  if (raw['request'] !== undefined && (raw['request'] === null || typeof raw['request'] !== 'object' || Array.isArray(raw['request']))) {
    throw new TypeError('request must be an object')
  }
  const inner = (raw['request'] ?? {}) as Rec
  const merged = mergeRequest(raw, inner)
  delete merged['request']
  for (const k of reservedKeys) delete merged[k]

  // Normalize model
  if (typeof merged['model'] === 'string') {
    const key = merged['model'].trim().toLowerCase()
    if (Object.hasOwn(MODEL_ALIASES, key)) merged['model'] = MODEL_ALIASES[key]
  }

  // Normalize sampler
  if (typeof merged['sampler'] === 'string') {
    const key = merged['sampler'].trim().toLowerCase()
    if (Object.hasOwn(SAMPLER_ALIASES, key)) merged['sampler'] = SAMPLER_ALIASES[key]
  }

  // Keep friendly in-range alignment, but let validation reject invalid limits.
  for (const key of ['width', 'height']) {
    const value = merged[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 64 && value <= 4096) {
      merged[key] = Math.round(value / 64) * 64
    }
  }

  return merged
}
