/** Generation request schema + official-prompt compilation. */
import { randomInt } from 'node:crypto'
import { z } from 'zod'
import { modelSpec } from './specs.ts'

export const MODEL_IDS = ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'] as const
export const SAMPLERS = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m', 'k_dpmpp_sde'] as const
export const NOISE_SCHEDULES = ['karras', 'exponential', 'polyexponential'] as const

export const CharacterSchema = z.object({
  prompt: z.string().min(1).max(20000),
  negative_prompt: z.string().max(20000).default(''),
  x: z.number().min(0).max(1).nullable().optional(),
  y: z.number().min(0).max(1).nullable().optional(),
})

export const GenerationRequestSchema = z.object({
  model: z.enum(MODEL_IDS).default('nai-diffusion-5-full'),
  prompt: z.string().min(1).max(50000),
  negative_prompt: z.string().max(50000).default(''),
  width: z.number().int().min(64).max(4096).multipleOf(64).default(832),
  height: z.number().int().min(64).max(4096).multipleOf(64).default(1216),
  steps: z.number().int().min(1).max(50).nullable().optional(),
  scale: z.number().min(0).max(10).nullable().optional(),
  seed: z.number().int().min(0).max(4294967295).nullable().optional(),
  sampler: z.enum(SAMPLERS).default('k_euler_ancestral'),
  noise_schedule: z.enum(NOISE_SCHEDULES).default('karras'),
  cfg_rescale: z.number().min(0).max(1).default(0),
  quality_preset: z.enum(['standard', 'light', 'none']).default('standard'),
  negative_preset: z.enum(['heavy', 'light', 'humanFocus', 'furryFocus', 'none']).default('heavy'),
  characters: z.array(CharacterSchema).max(22).default([]),
  variety_boost: z.boolean().default(false),
  transparent_background: z.boolean().default(false),
  text: z.string().max(750).nullable().optional(),
  max_anlas: z.number().int().min(0).max(100000).default(0),
})
export type GenerationRequest = z.infer<typeof GenerationRequestSchema>
export type CharacterInput = z.infer<typeof CharacterSchema>

/** The official client accepts Text:/text:/teXt: at these boundaries, but not e.g. "context:" or "text::". */
const TEXT_BLOCK_RE = /(?:^|(?<=[\s,.[\]:{}、。]))text:(?!:)/i

export function splitPromptText(prompt: string): [string, string | null] {
  const match = TEXT_BLOCK_RE.exec(prompt)
  if (!match) return [prompt, null]
  return [prompt.slice(0, match.index).replace(/[ ,\n]+$/u, ''), prompt.slice(match.index + match[0].length).trim()]
}

export function isV5(model: string): boolean { return model.startsWith('nai-diffusion-5-') }
export function effectiveSteps(r: GenerationRequest): number { return r.steps ?? 23 }
export function effectiveScale(r: GenerationRequest): number { return r.scale ?? (isV5(r.model) ? 7 : 5) }

/** Model-specific validation beyond the base schema. Throws Error with a user-facing message. */
export function validateRequest(r: GenerationRequest): void {
  if (!r.prompt.trim()) throw new Error('Prompt must contain visible text')
  if (!isV5(r.model) && r.characters.length > 6) throw new Error('V4.5 supports up to 6 character prompts')
  if (isV5(r.model) && r.variety_boost) throw new Error('Variety Boost is a V4.5 option, not a V5 option')
  if (!isV5(r.model) && r.transparent_background) throw new Error('The transparent background control is V5-only')
  if (isV5(r.model) && r.noise_schedule !== 'karras') throw new Error('V5 uses the fixed karras noise schedule')
  if (!isV5(r.model) && r.quality_preset === 'light') throw new Error('V4.5 has standard/none quality presets; light is V5-only')
  if (r.model === 'nai-diffusion-4-5-curated' && r.negative_preset === 'furryFocus')
    throw new Error('V4.5 Curated does not offer the official furryFocus negative preset')
  const [, explicitText] = splitPromptText(r.prompt)
  if (r.text != null && explicitText != null) throw new Error('Use either the text field or an explicit Text: block, not both')
  const content = r.text ?? explicitText ?? ''
  const limit = isV5(r.model) ? (r.model.endsWith('curated') ? 374 : 750) : 118
  if (content.length > limit) throw new Error(`Rendered text exceeds this model's documented ${limit}-character budget`)
}

function plainTerms(value: string): Set<string> {
  if (value.includes('::')) return new Set()
  const out = new Set<string>()
  for (const part of value.split(',')) {
    const t = part.trim()
    if (t && /^[\w -]+$/u.test(t)) out.add(t.toLowerCase())
  }
  return out
}

/** Compile the visible API request; no undocumented arbitrary parameter escape hatch. */
export function compileRequest(r: GenerationRequest): { payload: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = []
  const spec = modelSpec(r.model)
  const [strippedPrompt, explicitText] = splitPromptText(r.prompt.trim())
  const textBlock = r.text ?? explicitText
  let prompt = strippedPrompt
  let quality = ''
  if (r.quality_preset !== 'none') {
    quality = spec.quality_presets.find((p) => p.id === r.quality_preset)?.suffix ?? ''
    if (textBlock) quality = quality.split(', ').filter((t) => t !== 'no text').join(', ')
    if (quality.includes('-0.8::feet::'))
      warnings.push('V4.5 Curated standard quality includes -0.8::feet::; if unwanted foot suppression appears, compare quality_preset=none with a custom suffix omitting this term. Full-body prompts do not automatically require disabling quality.')
  }
  if (r.transparent_background) quality = [ 'transparent background', quality ].filter(Boolean).join(', ')
  if (quality) prompt = [prompt, quality].filter(Boolean).join(', ')
  if (textBlock) prompt += `\nText: ${textBlock}`
  const ucUser = r.negative_prompt.trim()
  let prefix = spec.uc_presets.find((p) => p.id === r.negative_preset)?.prefix ?? ''
  if (prefix && r.model.endsWith('full') && !prompt.toLowerCase().includes('nsfw')) prefix = 'nsfw, ' + prefix
  const uc = [prefix, ucUser].filter(Boolean).join(', ')
  // Conservative lexical diagnostics: never rewrite user text or official presets.
  const positiveStrings: string[] = [splitPromptText(r.prompt)[0], ...r.characters.map((c) => c.prompt)]
  if (r.transparent_background) positiveStrings.push('transparent background')
  const positiveTerms = new Set<string>()
  for (const s of positiveStrings) for (const t of plainTerms(s)) positiveTerms.add(t)
  const negativeTerms = plainTerms(prefix)
  for (const t of plainTerms(r.negative_prompt)) negativeTerms.add(t)
  const conflicts = [...positiveTerms].filter((t) => negativeTerms.has(t)).sort()
  if (conflicts.length)
    warnings.push('Positive tags also occur in global undesired content: ' + conflicts.join(', ') +
      '. This is a possible conflict, not a predicted failure; inspect the compiled presets and compare outputs before changing them.')
  if (textBlock && positiveTerms.has('no text'))
    warnings.push('Rendered text was supplied, but the user prompt still includes no text. Only the automatic no text suffix is removed; edit the conflicting user tag if unintended.')

  const useCoords = r.characters.some((c) => c.x != null)
  if (useCoords && r.characters.some((c) => c.x == null))
    throw new Error('When positioning characters explicitly, provide coordinates for every character')
  const positives: unknown[] = []
  const negatives: unknown[] = []
  for (const c of r.characters) {
    let x = c.x ?? 0.5
    let y = c.y ?? 0.5
    if (useCoords && !isV5(r.model)) {
      const grid = [0.1, 0.3, 0.5, 0.7, 0.9]
      const nx = grid[Math.min(4, Math.floor(x * 5))!]!
      const ny = grid[Math.min(4, Math.floor(y * 5))!]!
      if (nx !== x || ny !== y) warnings.push(`V4.5 position (${x}, ${y}) snapped to (${nx}, ${ny})`)
      x = nx; y = ny
    }
    const centers = [{ x, y }]
    positives.push({ char_caption: c.prompt, centers })
    negatives.push({ char_caption: c.negative_prompt, centers })
  }
  const seed = r.seed ?? randomInt(2 ** 32)
  const params: Record<string, unknown> = {
    params_version: 4,
    width: r.width, height: r.height, scale: effectiveScale(r), steps: effectiveSteps(r),
    sampler: r.sampler, noise_schedule: r.noise_schedule, n_samples: 1,
    seed, negative_prompt: uc,
    ucPresetId: r.negative_preset, qualityPresetId: r.quality_preset,
    tag_hint_qt: { none: 0, standard: 1, light: 3 }[r.quality_preset],
    tag_hint_uc_preset: { none: 0, heavy: 2, light: 3, humanFocus: 4, furryFocus: 5 }[r.negative_preset],
    cfg_rescale: r.cfg_rescale,
    legacy: false, legacy_v3_extend: false, dynamic_thresholding: false,
    deliberate_euler_ancestral_bug: false, prefer_brownian: true,
    image_format: 'png',
    v4_prompt: { caption: { base_caption: prompt, char_captions: positives }, use_coords: useCoords, use_order: true },
    v4_negative_prompt: { caption: { base_caption: uc, char_captions: negatives }, legacy_uc: false },
  }
  if (isV5(r.model)) {
    params.straight_alpha = true
    if (r.transparent_background) params.tag_hint_transparent_background = true
  }
  if (r.variety_boost) params.skip_cfg_above_sigma = 58 * (r.width * r.height / (832 * 1216)) ** 0.5
  return { payload: { input: prompt, model: r.model, action: 'generate', parameters: params }, warnings }
}
