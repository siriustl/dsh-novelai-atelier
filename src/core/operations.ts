/** Validated NovelAI image operations, independent of transport and harness. Ported from operations.py. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { z } from 'zod'
import { expandPath } from './imageInputs.ts'
import { prepareMask, readImage, type ImageInput, type MaskSettings } from './imageInputs.ts'
import { compileRequest, GenerationRequestSchema, splitPromptText, validateRequest, isV5, type GenerationRequest, type CharacterInput } from './models.ts'
import { decodePng, encodePng } from './png.ts'
import { Raster, imageBase64, sha256Hex } from './raster.ts'

export const OPERATION_ENDPOINTS = ['/ai/generate-image', '/ai/upscale', '/ai/augment-image', '/ai/encode-vibe'] as const

export interface PreparedOperation {
  operation: string
  endpoint: string
  payload: Record<string, unknown>
  expected_outputs: number
  expected_dimensions: Array<{ width: number; height: number }> | null
  summary: Record<string, unknown>
  warnings: string[]
  generation_request: GenerationRequest | null
  output_kind: string
  max_anlas: number
  inpaint_context: {
    source: Raster
    mask: Raster
    focus_box?: [number, number, number, number]
  } | null
}

function prepared(partial: Partial<PreparedOperation> & Pick<PreparedOperation, 'operation' | 'endpoint' | 'payload'>): PreparedOperation {
  return {
    expected_outputs: 1, expected_dimensions: null, summary: {}, warnings: [],
    generation_request: null, output_kind: 'image', max_anlas: 0, inpaint_context: null,
    ...partial,
  }
}

// ---------- request schemas ----------

const Base = GenerationRequestSchema.partial({ width: true, height: true }).extend({
  max_anlas: z.number().int().min(0).default(0),
})

export const Img2ImgRequestSchema = Base.extend({
  image_path: z.string().min(1).describe('Local PNG/JPEG/WebP source; never modified'),
  strength: z.number().min(0.01).max(0.99).default(0.7),
  noise: z.number().min(0).max(0.99).default(0),
  extra_noise_seed: z.number().int().min(0).max(4294967295).nullable().optional(),
  color_correct: z.boolean().default(false),
})
export type Img2ImgRequest = z.infer<typeof Img2ImgRequestSchema>

export const EnhanceRequestSchema = Img2ImgRequestSchema.extend({
  strength: z.number().min(0.01).max(0.99).default(0.2),
  mode: z.enum(['regular', 'max']).default('regular'),
  append_enhance_tags: z.boolean().default(true),
})
export type EnhanceRequest = z.infer<typeof EnhanceRequestSchema>

export const InpaintRequestSchema = Base.omit({ model: true }).extend({
  model: z.enum(['nai-diffusion-5-full', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated']).default('nai-diffusion-5-full'),
  image_path: z.string().min(1),
  mask_path: z.string().min(1).describe('Same-size mask: white repaints and black preserves'),
  mask_mode: z.enum(['luminance', 'alpha']).default('luminance'),
  strength: z.number().min(0).max(1).default(1),
  extra_noise_seed: z.number().int().min(0).max(4294967295).nullable().optional(),
  color_correct: z.boolean().default(true),
  focus_box: z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)]).nullable().optional(),
  focus_size: z.tuple([z.number().int().min(64).max(4096).multipleOf(64), z.number().int().min(64).max(4096).multipleOf(64)]).nullable().optional(),
})
export type InpaintRequest = z.infer<typeof InpaintRequestSchema>

export const UpscaleRequestSchema = z.object({
  image_path: z.string().min(1),
  model: z.literal('nai-diffusion-5-curated').default('nai-diffusion-5-curated'),
  max_anlas: z.number().int().min(0).default(0),
})
export type UpscaleRequest = z.infer<typeof UpscaleRequestSchema>

export const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'scared', 'surprised', 'tired', 'excited',
  'nervous', 'thinking', 'confused', 'shy', 'disgusted', 'smug', 'bored', 'laughing',
  'irritated', 'aroused', 'embarrassed', 'worried', 'love', 'determined', 'hurt', 'playful'] as const

export const AugmentRequestSchema = z.object({
  image_path: z.string().min(1),
  tool: z.enum(['bg-removal', 'lineart', 'sketch', 'colorize', 'emotion', 'declutter', 'declutter-keep-bubbles']),
  prompt: z.string().max(10000).default(''),
  defry: z.number().int().min(0).max(5).default(0),
  emotion: z.enum(EMOTIONS).nullable().optional(),
  max_anlas: z.number().int().min(0).default(0),
})
export type AugmentRequest = z.infer<typeof AugmentRequestSchema>

export const V45_MODELS = ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'] as const

export const EncodeVibeRequestSchema = z.object({
  image_path: z.string().min(1),
  model: z.enum(V45_MODELS).default('nai-diffusion-4-5-full'),
  information_extracted: z.number().min(0.01).max(1).default(0.7),
  max_anlas: z.number().int().min(0).default(0),
})
export type EncodeVibeRequest = z.infer<typeof EncodeVibeRequestSchema>

export const VibeReferenceSchema = z.object({
  encoding_path: z.string().min(1).describe('Raw .vibe file saved by encode_vibe, or a .naiv4vibe JSON export'),
  strength: z.number().min(0).max(1).default(0.6),
  information_extracted: z.number().min(0.01).max(1).nullable().optional()
    .describe('Select an already-encoded variant from a .naiv4vibe file; never re-encodes or changes a raw vibe'),
})
export type VibeReference = z.infer<typeof VibeReferenceSchema>

export const PreciseReferenceSchema = z.object({
  image_path: z.string().min(1),
  type: z.enum(['character', 'style', 'character&style']).default('character'),
  strength: z.number().min(-1).max(1).default(1),
  fidelity: z.number().min(-1).max(1).default(1),
})
export type PreciseReference = z.infer<typeof PreciseReferenceSchema>

export const ReferenceGenerationRequestSchema = Base.omit({ model: true }).extend({
  model: z.enum(V45_MODELS).default('nai-diffusion-4-5-full'),
  vibes: z.array(VibeReferenceSchema).max(16).default([]),
  precise_references: z.array(PreciseReferenceSchema).max(16).default([]),
  normalize_vibe_strengths: z.boolean().default(true),
})
export type ReferenceGenerationRequest = z.infer<typeof ReferenceGenerationRequestSchema>

/** Format a zod error into a single readable message. */
export function zodMessage(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

// ---------- vibe reading ----------

function readVibe(reference: VibeReference, model: string): { encoded: string; summary: Record<string, unknown> } {
  const path = expandPath(reference.encoding_path)
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Vibe encoding file does not exist: ${path}`)
  const data = readFileSync(path)
  if (!data.length || data.length > 8 * 1024 * 1024) throw new Error('Vibe encoding must be nonempty and no larger than 8 MiB')
  const summary: Record<string, unknown> = { path, sha256: sha256Hex(data), bytes: data.length }
  const suffix = path.toLowerCase().endsWith('.naiv4vibe') ? '.naiv4vibe' : path.toLowerCase().endsWith('.vibe') ? '.vibe' : path.slice(path.lastIndexOf('.'))
  if (suffix === '.naiv4vibe') {
    let document: Record<string, unknown>
    try { document = JSON.parse(data.toString('utf8')) } catch { throw new Error('Invalid .naiv4vibe export') }
    try {
      const importInfo = document['importInfo'] as Record<string, unknown> | undefined
      const metadataModel = importInfo && typeof importInfo === 'object' ? importInfo['model'] : undefined
      if (metadataModel && metadataModel !== model) throw new Error('Vibe model differs from the selected generation model')
      const candidates: Array<[string, unknown]> = []
      const encodings = document['encodings'] as Record<string, Record<string, Record<string, unknown>>>
      for (const group of Object.values(encodings ?? {})) {
        for (const slot of Object.values(group ?? {})) {
          const information = (slot['params'] as Record<string, unknown> | undefined)?.['information_extracted']
          if (reference.information_extracted == null || (typeof information === 'number' && Math.abs(information - reference.information_extracted) < 0.000001)) {
            if (slot['encoding']) candidates.push([slot['encoding'] as string, information])
          }
        }
      }
      if (candidates.length !== 1) throw new Error('Select one information_extracted value present in the .naiv4vibe export')
      const [encoded, information] = candidates[0]!
      const raw = Buffer.from(encoded, 'base64')
      if (!raw.length) throw new Error('The selected vibe encoding is empty')
      summary['information_extracted'] = information
      return { encoded, summary }
    } catch (error) {
      if (error instanceof Error && !/Invalid \.naiv4vibe/.test(error.message)) {
        if (/Vibe model|Select one information/.test(error.message)) throw error
      }
      throw new Error('Invalid .naiv4vibe export')
    }
  }
  if (suffix !== '.vibe') throw new Error('Use an encoded .vibe or .naiv4vibe file, not an ordinary image; first call encode_vibe')
  // A raw encoding may have the JSON receipt written by our service next to it.
  const receiptPath = path.slice(0, -'.vibe'.length) + '.json'
  let recordedInformation: unknown = undefined
  if (existsSync(receiptPath)) {
    if (statSync(receiptPath).size > 1024 * 1024) throw new Error('Vibe receipt exceeds the size limit')
    let receipt: Record<string, unknown>
    try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) } catch { throw new Error('Invalid vibe JSON receipt') }
    const stored = (receipt['request'] ?? ((receipt['summary'] as Record<string, unknown> | undefined)?.['request'] as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>
    if (stored['model'] && stored['model'] !== model) throw new Error('Vibe model differs from the selected generation model')
    recordedInformation = stored['information_extracted']
  }
  if (reference.information_extracted != null && recordedInformation !== reference.information_extracted)
    throw new Error("A raw vibe's information_extracted cannot be changed; select its recorded value or encode again")
  summary['information_extracted'] = recordedInformation
  return { encoded: data.toString('base64'), summary }
}

// ---------- inpaint postprocessing ----------

export interface InpaintPostContext {
  sourcePng: Uint8Array
  maskPng: Uint8Array
  generated: Uint8Array
  prepared: PreparedOperation
}

/** Composite API pixels only inside the prepared mask, without touching files.
 * The raw API result should also be retained by the caller: compositing changes
 * the alpha-channel bits that may carry NovelAI's hidden metadata. */
export function postprocessInpaint(sourcePng: Uint8Array, maskPng: Uint8Array, generatedPng: Uint8Array, prepared: PreparedOperation): Buffer {
  if (prepared.operation !== 'inpaint') throw new Error('Inpaint postprocessing requires a prepared inpaint operation')
  const source = Raster.fromDecoded(decodePng(sourcePng))
  const mask = Raster.fromDecoded(decodePng(maskPng))
  const generatedRaw = decodePng(generatedPng)
  const generated = Raster.fromDecoded(generatedRaw)
  if (mask.width !== source.width || mask.height !== source.height)
    throw new Error('Inpaint source and mask dimensions must match before compositing')
  const parameters = prepared.payload['parameters'] as Record<string, unknown>
  if (generated.width !== parameters['width'] || generated.height !== parameters['height'])
    throw new Error('Inpaint response dimensions must match the prepared API tile')
  let result: Raster
  const context = prepared.inpaint_context
  if (context?.focus_box) {
    const [left, top, right, bottom] = context.focus_box
    const patch = generated.resize(right - left, bottom - top)
    const canvas = context.source.clone()
    compositeAt(canvas, patch, left, top)
    result = compositeByMask(canvas, context.source, context.mask)
  } else {
    if (generated.width !== source.width || generated.height !== source.height)
      throw new Error('Unfocused inpaint response dimensions must match the source canvas')
    const finalMask = context ? context.mask : mask
    result = compositeByMask(generated, source, finalMask)
  }
  // Preserve generated text chunks; annotate the composite.
  const text: Array<{ keyword: string; text: string; latin?: boolean }> = generatedRaw.text.map((t) => ({ keyword: t.keyword, text: t.text }))
  text.push({ keyword: 'NovelAI-MCP-Inpaint', text: 'Generated pixels composited inside the binary mask; unmasked pixels preserved', latin: true })
  const actual: Record<string, unknown> = Object.fromEntries(Object.entries(parameters).filter(([k]) => k !== 'image' && k !== 'mask'))
  actual['prompt'] = prepared.payload['input']
  actual['model'] = prepared.payload['model']
  actual['action'] = 'infill'
  if (!generatedRaw.text.some((t) => t.keyword === 'Comment')) {
    text.push({ keyword: 'Comment', text: JSON.stringify(actual) })
    text.push({ keyword: 'NovelAI-MCP-Metadata-Source', text: 'Compiled request; original API output retained separately', latin: true })
  }
  return encodePng(result.width, result.height, result.data, { text, iccProfile: generatedRaw.iccProfile, phys: generatedRaw.phys })
}

function compositeAt(canvas: Raster, patch: Raster, left: number, top: number): void {
  for (let y = 0; y < patch.height; y++) {
    for (let x = 0; x < patch.width; x++) {
      const s = (y * patch.width + x) * 4
      const d = ((y + top) * canvas.width + (x + left)) * 4
      canvas.data[d] = patch.data[s]!
      canvas.data[d + 1] = patch.data[s + 1]!
      canvas.data[d + 2] = patch.data[s + 2]!
      canvas.data[d + 3] = patch.data[s + 3]!
    }
  }
}

/** result = a where mask>127 else b (Pillow Image.composite semantics on mask L). */
function compositeByMask(a: Raster, b: Raster, mask: Raster): Raster {
  const out = new Uint8Array(a.width * a.height * 4)
  const lum = mask.luminance()
  for (let i = 0; i < a.width * a.height; i++) {
    const useA = lum[i]! > 127
    const s = useA ? a.data : b.data
    out[i * 4] = s[i * 4]!
    out[i * 4 + 1] = s[i * 4 + 1]!
    out[i * 4 + 2] = s[i * 4 + 2]!
    out[i * 4 + 3] = s[i * 4 + 3]!
  }
  return new Raster(a.width, a.height, out)
}

// ---------- preparation ----------

function fullRequest(r: Omit<GenerationRequest, 'width' | 'height'> & { width: number; height: number }): GenerationRequest {
  const request = GenerationRequestSchema.parse(r)
  validateRequest(request)
  return request
}

export function prepareGeneration(request: GenerationRequest): PreparedOperation {
  const { payload, warnings } = compileRequest(request)
  return prepared({
    operation: 'generate', endpoint: '/ai/generate-image', payload,
    expected_dimensions: [{ width: request.width, height: request.height }],
    summary: { request }, warnings, generation_request: request, max_anlas: request.max_anlas,
  })
}

function dims(raw: Record<string, unknown>): { explicit: boolean; width?: number; height?: number } {
  const hasW = 'width' in raw, hasH = 'height' in raw
  if (hasW !== hasH) throw new Error('Set both width and height, or omit both to use the source size')
  return { explicit: hasW, width: raw['width'] as number | undefined, height: raw['height'] as number | undefined }
}

/** Prepare a request locally; performs no network calls and writes nothing. */
export async function prepareOperation(rawRequest: unknown, kind: string): Promise<PreparedOperation> {
  if (kind === 'upscale') {
    const request = UpscaleRequestSchema.parse(rawRequest)
    const source = await readImage(request.image_path)
    if (source.image.width * source.image.height > 3145728) throw new Error('Dedicated upscaling accepts source images up to 3,145,728 pixels')
    const payload = { image: imageBase64(source.image), model: request.model, declared_blur_sigma: 0 }
    return prepared({
      operation: 'upscale', endpoint: '/ai/upscale', payload,
      expected_dimensions: [{ width: source.image.width * 2, height: source.image.height * 2 }],
      summary: { request, source: source.summary, scale_per_axis: 2 }, max_anlas: request.max_anlas,
    })
  }
  if (kind === 'augment') {
    const request = AugmentRequestSchema.parse(rawRequest)
    if (request.tool === 'emotion' && !request.emotion) throw new Error('The emotion tool requires an emotion')
    if (request.tool !== 'emotion' && request.emotion) throw new Error('emotion is only valid for the emotion tool')
    if (!['emotion', 'colorize'].includes(request.tool) && (request.prompt || request.defry))
      throw new Error('prompt and defry apply only to colorize and emotion')
    if (request.prompt.includes(';;') && request.tool === 'emotion') throw new Error("Provide the emotion separately; the prompt must not contain ';;'")
    const source = await readImage(request.image_path)
    if (source.image.width * source.image.height > 3145728) throw new Error('Director Tools accept images up to 3,145,728 pixels')
    const payload: Record<string, unknown> = {
      req_type: request.tool, image: imageBase64(source.image),
      width: source.image.width, height: source.image.height, use_new_shared_trial: true,
    }
    if (request.tool === 'emotion' || request.tool === 'colorize') {
      payload['prompt'] = request.tool === 'emotion' ? `${request.emotion};;${request.prompt}` : request.prompt
      payload['defry'] = request.defry
    }
    const count = request.tool === 'bg-removal' ? 3 : 1
    return prepared({
      operation: 'augment', endpoint: '/ai/augment-image', payload, expected_outputs: count,
      expected_dimensions: Array.from({ length: count }, () => ({ width: source.image.width, height: source.image.height })),
      summary: { request, source: source.summary }, max_anlas: request.max_anlas,
    })
  }
  if (kind === 'encode_vibe') {
    const request = EncodeVibeRequestSchema.parse(rawRequest)
    const informationExtracted = 'information_extracted' in (rawRequest as object) ? request.information_extracted : (request.model.endsWith('curated') ? 1 : request.information_extracted)
    const source = await readImage(request.image_path)
    return prepared({
      operation: 'encode_vibe', endpoint: '/ai/encode-vibe',
      payload: { image: imageBase64(source.image), model: request.model, information_extracted: informationExtracted },
      summary: { request: { ...request, information_extracted: informationExtracted }, source: source.summary },
      output_kind: 'vibe', max_anlas: request.max_anlas,
    })
  }
  if (kind === 'reference_generate') {
    const request = ReferenceGenerationRequestSchema.parse(rawRequest)
    if (request.precise_references.length) return prepareReferencesAsync(request)
    return prepareReferences(request)
  }
  if (kind === 'generate') {
    const request = GenerationRequestSchema.parse(rawRequest)
    validateRequest(request)
    return prepareGeneration(request)
  }
  if (kind === 'img2img' || kind === 'enhance') {
    const request: EnhanceRequest = kind === 'img2img'
      ? { ...Img2ImgRequestSchema.parse(rawRequest), mode: 'regular', append_enhance_tags: false }
      : EnhanceRequestSchema.parse(rawRequest)
    if (request.mode === 'max' && !isV5(request.model)) throw new Error('Max Enhance is only supported on V5')
    return prepareImageToImage(request, kind === 'img2img' ? 'img2img' : 'enhance', rawRequest as Record<string, unknown>)
  }
  if (kind === 'inpaint') {
    const raw = rawRequest as Record<string, unknown>
    if (raw['model'] === 'nai-diffusion-5-curated')
      throw new Error('V5 Curated inpainting is not deployed: the live API reports that its model does not exist. Choose nai-diffusion-5-full or nai-diffusion-4-5-curated explicitly; no model is silently substituted.')
    const request = InpaintRequestSchema.parse(raw)
    if (request.focus_size && !request.focus_box) throw new Error('focus_size requires focus_box')
    if (request.focus_box && (request.focus_box[2] <= request.focus_box[0] || request.focus_box[3] <= request.focus_box[1]))
      throw new Error('focus_box needs right > left and bottom > top')
    return prepareInpaint(request, raw)
  }
  throw new Error(`Unsupported operation kind: ${kind}`)
}

function prepareReferences(request: ReferenceGenerationRequest): PreparedOperation {
  if (!request.vibes.length && !request.precise_references.length) throw new Error('Provide at least one vibe or precise reference')
  if (request.vibes.length && request.precise_references.length) throw new Error('Vibe Transfer and Precise Reference cannot be combined')
  const base = fullRequest({ ...request, width: request.width ?? 832, height: request.height ?? 1216 })
  const preparedOp = prepareGeneration(base)
  // summary.request 必须携带引用字段：quote/validate 用 resolved_request 复检（Python 版经 pydantic 继承天然保留）。
  preparedOp.summary['request'] = {
    ...base,
    vibes: request.vibes, precise_references: request.precise_references,
    normalize_vibe_strengths: request.normalize_vibe_strengths,
  }
  const params = preparedOp.payload['parameters'] as Record<string, unknown>
  const summaries: Record<string, unknown>[] = []
  if (request.vibes.length) {
    const encodings = request.vibes.map((r) => readVibe(r, request.model))
    let strengths = request.vibes.map((r) => r.strength)
    const total = strengths.reduce((a, b) => a + b, 0)
    if (request.normalize_vibe_strengths && total > 1) strengths = strengths.map((s) => s / total)
    params['reference_image_multiple'] = encodings.map((e) => e.encoded)
    params['reference_strength_multiple'] = strengths
    params['controlnet_strength'] = 1
    params['normalize_reference_strength_multiple'] = request.normalize_vibe_strengths
    encodings.forEach((e, i) => summaries.push({ ...e.summary, effective_strength: strengths[i] }))
  } else {
    // Precise references are prepared synchronously from cached reads below.
    preparedOp.summary['precise_reference_paths'] = request.precise_references.map((r) => r.image_path)
  }
  preparedOp.operation = 'reference_generate'
  preparedOp.summary['references'] = summaries
  if (request.precise_references.filter((r) => r.type !== 'style').length > 1)
    preparedOp.warnings.push('Multiple character references blend identities; they are not assigned to separate character prompts')
  return preparedOp
}

export async function prepareReferencesAsync(request: ReferenceGenerationRequest): Promise<PreparedOperation> {
  const preparedOp = prepareReferences(request)
  if (request.precise_references.length) {
    const params = preparedOp.payload['parameters'] as Record<string, unknown>
    const images: string[] = []
    const summaries: Record<string, unknown>[] = []
    for (const ref of request.precise_references) {
      const source = await readImage(ref.image_path)
      const ratio = source.image.width / source.image.height
      const options: Array<[number, number]> = [[1024, 1536], [1472, 1472], [1536, 1024]]
      const dimensions = options.reduce((best, s) => Math.abs(ratio - s[0] / s[1]) < Math.abs(ratio - best[0] / best[1]) ? s : best)
      const factor = Math.min(dimensions[0] / source.image.width, dimensions[1] / source.image.height)
      const w = Math.max(1, Math.round(source.image.width * factor))
      const h = Math.max(1, Math.round(source.image.height * factor))
      const resized = source.image.resize(w, h)
      const canvas = new Raster(dimensions[0], dimensions[1], new Uint8Array(dimensions[0] * dimensions[1] * 4).fill(255))
      // Fill black background then paste with alpha (Pillow semantics: black canvas).
      for (let i = 0; i < canvas.data.length; i += 4) { canvas.data[i] = 0; canvas.data[i + 1] = 0; canvas.data[i + 2] = 0; canvas.data[i + 3] = 255 }
      const offsetX = Math.floor((dimensions[0] - w) / 2), offsetY = Math.floor((dimensions[1] - h) / 2)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = (y * w + x) * 4
          const alpha = resized.data[s + 3]! / 255
          const d = ((y + offsetY) * dimensions[0] + (x + offsetX)) * 4
          for (let c = 0; c < 3; c++) canvas.data[d + c] = Math.round(resized.data[s + c]! * alpha + canvas.data[d + c]! * (1 - alpha))
          canvas.data[d + 3] = 255
        }
      }
      images.push(imageBase64(canvas))
      summaries.push({ ...source.summary, prepared_width: dimensions[0], prepared_height: dimensions[1] })
    }
    params['director_reference_images'] = images
    params['director_reference_descriptions'] = request.precise_references.map((ref) => ({ caption: { base_caption: ref.type, char_captions: [] }, legacy_uc: false }))
    params['director_reference_strength_values'] = request.precise_references.map((r) => r.strength)
    params['director_reference_secondary_strength_values'] = request.precise_references.map((r) => 1 - r.fidelity)
    params['director_reference_information_extracted'] = request.precise_references.map(() => 1)
    preparedOp.summary['references'] = summaries
  }
  return preparedOp
}

async function prepareImageToImage(request: EnhanceRequest, operation: 'img2img' | 'enhance', raw: Record<string, unknown>): Promise<PreparedOperation> {
  const source = await readImage(request.image_path)
  const { explicit, width, height } = dims(raw)
  let resolvedW: number, resolvedH: number
  if (explicit) {
    resolvedW = width!; resolvedH = height!
  } else {
    resolvedW = source.image.width; resolvedH = source.image.height
  }
  let resolved = fullRequest({ ...request, width: resolvedW, height: resolvedH })
  if (request.mode === 'max' && (resolved.width !== source.image.width || resolved.height !== source.image.height))
    throw new Error('Max Enhance chooses its own output size; omit width and height or use the source dimensions')
  if (operation === 'enhance' && request.mode === 'regular' && request.append_enhance_tags && !resolved.prompt.includes('upscaled, blurry')) {
    const [prompt, text] = splitPromptText(resolved.prompt)
    let p = prompt.replace(/[ ,\n]+$/u, '') + ', -2::upscaled, blurry::'
    if (text !== null) p += '\nText: ' + text
    resolved = { ...resolved, prompt: p }
    validateRequest(resolved)
  }
  const preparedOp = prepareGeneration(resolved)
  const effectiveRequest: Record<string, unknown> = { ...request, width: resolved.width, height: resolved.height }
  if (operation === 'img2img') {
    delete effectiveRequest['mode']
    delete effectiveRequest['append_enhance_tags']
  }
  const seed = (preparedOp.payload['parameters'] as Record<string, unknown>)['seed']
  effectiveRequest['seed'] = seed
  preparedOp.summary = {
    request: effectiveRequest, user_request: stripDefaults(raw), source: source.summary,
    resolved_width: resolved.width, resolved_height: resolved.height,
  }
  const params = preparedOp.payload['parameters'] as Record<string, unknown>
  params['extra_noise_seed'] = request.extra_noise_seed ?? (Number(seed) - 1 + 4294967296) % 4294967296
  params['add_original_image'] = false
  const outputSize = { width: resolved.width, height: resolved.height }
  let image = source.image
  if (image.width !== outputSize.width || image.height !== outputSize.height) {
    image = image.resize(outputSize.width, outputSize.height)
    preparedOp.warnings.push('Source pixels are resized in memory to the requested output dimensions; the source file is unchanged')
  }
  preparedOp.payload['action'] = 'img2img'
  params['image'] = imageBase64(image)
  params['strength'] = request.strength
  params['noise'] = request.noise
  params['color_correct'] = request.color_correct
  preparedOp.operation = operation
  if (operation === 'enhance' && request.mode === 'max') {
    params['upscaled_enhance'] = true
    const w16 = Math.floor(image.width / 16) * 32, h16 = Math.floor(image.height / 16) * 32
    const factor = Math.min(1, Math.sqrt(3145728 / (w16 * h16)))
    let size: [number, number] = [Math.floor((w16 * factor) / 32 + 0.5) * 32, Math.floor((h16 * factor) / 32 + 0.5) * 32]
    if (size[0] * size[1] > 3145728) size = [Math.floor((w16 * factor) / 32) * 32, Math.floor((h16 * factor) / 32) * 32]
    preparedOp.summary['output_dimensions_estimate'] = size
    preparedOp.expected_dimensions = null
    preparedOp.warnings.push('Max Enhance selects the final output dimensions server-side, up to approximately 3 megapixels')
  }
  return preparedOp
}

async function prepareInpaint(request: InpaintRequest, raw: Record<string, unknown>): Promise<PreparedOperation> {
  const source = await readImage(request.image_path)
  const isFocused = request.focus_box != null
  const { explicit } = dims(raw)
  let resolved: GenerationRequest
  let workingSize: [number, number] = [source.image.width, source.image.height]
  if (isFocused) {
    if (explicit && (raw['width'] !== source.image.width || raw['height'] !== source.image.height))
      throw new Error('Focused inpainting preserves the source canvas; omit width/height, or set both to its exact size')
    const [left, top, right, bottom] = request.focus_box!
    if (right > source.image.width || bottom > source.image.height) throw new Error('focus_box exceeds the source dimensions')
    workingSize = request.focus_size ?? [Math.max(64, Math.ceil((right - left) / 64) * 64), Math.max(64, Math.ceil((bottom - top) / 64) * 64)]
    resolved = fullRequest({ ...request, width: workingSize[0], height: workingSize[1] })
  } else {
    const { width, height } = dims(raw)
    if (explicit) {
      if (width !== source.image.width || height !== source.image.height)
        throw new Error('Inpainting output dimensions must match the source image; resize the image and mask together first')
    }
    resolved = fullRequest({ ...request, width: source.image.width, height: source.image.height })
  }
  const preparedOp = prepareGeneration(resolved)
  const seed = (preparedOp.payload['parameters'] as Record<string, unknown>)['seed'] as number
  const effectiveRequest: Record<string, unknown> = { ...request, seed }
  if (isFocused) {
    // width/height are canvas constraints, not the API tile dimensions.
    delete effectiveRequest['width']; delete effectiveRequest['height']
  }
  preparedOp.summary = {
    request: effectiveRequest, user_request: stripDefaults(raw), source: source.summary,
    resolved_width: resolved.width, resolved_height: resolved.height,
  }
  const params = preparedOp.payload['parameters'] as Record<string, unknown>
  params['extra_noise_seed'] = request.extra_noise_seed ?? (seed - 1 + 4294967296) % 4294967296
  params['add_original_image'] = false

  const maskSource = await readImage(request.mask_path)
  if (maskSource.image.width !== source.image.width || maskSource.image.height !== source.image.height)
    throw new Error('Mask dimensions must exactly match the source image')
  if (request.mask_mode === 'alpha' && !maskSource.summary['has_alpha']) throw new Error('mask_mode=alpha requires a mask with an alpha channel')
  const signal = request.mask_mode === 'alpha' ? maskSource.image.alphaChannel() : maskSource.image.luminance()
  const originalMask = thresholdMask(source.image.width, source.image.height, signal)
  if (!originalMask.maskBounds(originalMask.luminance())) throw new Error('Mask has no repaint region')

  preparedOp.inpaint_context = { source: source.image, mask: originalMask }
  let workingImage = source.image
  let workingMask: Raster
  let maskSettings: MaskSettings = { mode: request.mask_mode, white_means: 'repaint', grid: 1, repaint_pixels: -1, repaint_fraction: -1 }

  if (request.focus_box) {
    const [left, top, right, bottom] = request.focus_box
    if (right > source.image.width || bottom > source.image.height) throw new Error('focus_box exceeds the source dimensions')
    const bounds = originalMask.maskBounds(originalMask.luminance())
    if (!bounds || bounds[0] < left || bounds[1] < top || bounds[2] > right || bounds[3] > bottom)
      throw new Error('focus_box must contain every repaint pixel after mask alignment')
    workingSize = request.focus_size ?? [Math.max(64, Math.ceil((right - left) / 64) * 64), Math.max(64, Math.ceil((bottom - top) / 64) * 64)]
    const workingRequest = fullRequest({ ...resolved, width: workingSize[0], height: workingSize[1] })
    const characters: CharacterInput[] = []
    for (const character of workingRequest.characters) {
      let c = { ...character }
      if (c.x != null && c.y != null) {
        const x = (c.x * source.image.width - left) / (right - left)
        const y = (c.y * source.image.height - top) / (bottom - top)
        if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1))
          throw new Error('A character position falls outside focus_box; omit positions or adapt the character prompts for the focused region')
        c = { ...c, x, y }
      }
      characters.push(c)
    }
    const focusedReq: GenerationRequest = { ...workingRequest, characters, seed }
    const focused = prepareGeneration(focusedReq)
    focused.summary = preparedOp.summary
    const fparams = focused.payload['parameters'] as Record<string, unknown>
    fparams['extra_noise_seed'] = params['extra_noise_seed']
    fparams['add_original_image'] = false
    focused.inpaint_context = { source: source.image, mask: originalMask, focus_box: [...request.focus_box] }
    focused.summary['focus_box'] = request.focus_box
    focused.summary['focus_size'] = workingSize
    focused.summary['output_dimensions'] = [source.image.width, source.image.height]
    workingImage = source.image.cropDestructive(left, top, right, bottom).resize(workingSize[0], workingSize[1])
    const maskCrop = originalMask.cropDestructive(left, top, right, bottom).resize(workingSize[0], workingSize[1], 'nearest')
    const aligned = prepareMask({ image: maskCrop, summary: { has_alpha: false } }, { width: workingSize[0], height: workingSize[1] }, 'luminance')
    workingMask = aligned.mask
    maskSettings = aligned.settings
    preparedOp.summary['mask_settings'] = maskSettings
    preparedOp.payload = focused.payload
    preparedOp.operation = 'inpaint'
    preparedOp.inpaint_context = focused.inpaint_context
    preparedOp.summary = focused.summary
    preparedOp.generation_request = focused.generation_request
    preparedOp.max_anlas = focused.max_anlas
    preparedOp.expected_dimensions = focused.expected_dimensions
    preparedOp.warnings = focused.warnings
    preparedOp.endpoint = focused.endpoint
  } else {
    const aligned = prepareMask(maskSource, { width: source.image.width, height: source.image.height }, request.mask_mode)
    workingMask = aligned.mask
    maskSettings = aligned.settings
    preparedOp.summary['mask_settings'] = maskSettings
  }
  const finalParams = preparedOp.payload['parameters'] as Record<string, unknown>
  preparedOp.payload['model'] = String(preparedOp.payload['model']) + '-inpainting'
  preparedOp.payload['action'] = 'infill'
  finalParams['image'] = imageBase64(workingImage)
  finalParams['mask'] = imageBase64(workingMask)
  finalParams['inpaintImg2ImgStrength'] = request.strength
  if (request.strength < 1)
    finalParams['img2img'] = { strength: request.strength, color_correct: request.color_correct }
  preparedOp.summary['mask'] = maskSource.summary
  preparedOp.operation = 'inpaint'
  return preparedOp
}

function thresholdMask(width: number, height: number, signal: Uint8Array): Raster {
  const out = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const v = signal[i]! > 127 ? 255 : 0
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v
    out[i * 4 + 3] = 255
  }
  return new Raster(width, height, out)
}

/** Best-effort capture of the user's explicit input (Python exclude_unset equivalent). */
function stripDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(raw)
}

export type { ImageInput }
