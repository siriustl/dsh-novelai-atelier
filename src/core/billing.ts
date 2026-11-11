/** Informational price estimates; execution does not enforce or verify a spending cap. */
import { checkFreeEligibility, type FreeMode, type NormalizedCredits } from './client.ts'
import type { PreparedOperation } from './operations.ts'

export function baseGenerationPrice(width: number, height: number, steps: number, v5: boolean, strength = 1): number {
  const area = width * height
  const base = Math.ceil(2.951823174884865e-6 * area + 5.753298233447344e-7 * area * steps)
  return Math.max(2, Math.ceil(base * (v5 ? 1.5 : 1) * strength))
}

function generationEstimate(operation: PreparedOperation, credits: NormalizedCredits, mode: FreeMode = 'official'): { amount: number | null; notes: string[] } {
  const payload = operation.payload
  const parameters = payload['parameters'] as Record<string, unknown>
  const model = String(payload['model']).replace(/-inpainting$/u, '')
  let width = parameters['width'] as number, height = parameters['height'] as number
  if (parameters['upscaled_enhance']) {
    width = Math.floor(width / 16) * 32
    height = Math.floor(height / 16) * 32
    const factor = Math.min(1, Math.sqrt(3145728 / (width * height)))
    let size: [number, number] = [Math.floor((width * factor) / 32 + 0.5) * 32, Math.floor((height * factor) / 32 + 0.5) * 32]
    if (size[0] * size[1] > 3145728) size = [Math.floor((width * factor) / 32) * 32, Math.floor((height * factor) / 32) * 32]
    width = size[0]; height = size[1]
  }
  const steps = parameters['steps'] as number
  const request = {
    width, height, steps,
    isV5: model.startsWith('nai-diffusion-5-'),
  }
  const references = (parameters['director_reference_images'] as unknown[] | undefined) ?? []
  const vibes = (parameters['reference_image_multiple'] ?? parameters['reference_vibe_multiple'] ?? []) as unknown[]
  const free = checkFreeEligibility(request, credits, mode)
  const img2img = parameters['img2img'] as Record<string, unknown> | undefined
  const strength = parameters['mask']
    ? (img2img?.['strength'] as number | undefined ?? parameters['inpaintImg2ImgStrength'] as number | undefined ?? 1)
    : parameters['image'] ? (parameters['strength'] as number | undefined ?? 1) : 1
  const unit = baseGenerationPrice(width, height, steps, request.isV5, strength)
  if (unit > 140)
    return { amount: null, notes: ['Per-image price exceeds the official client\'s 140-Anlas supported limit; reduce dimensions or steps'] }
  const count = (parameters['n_samples'] as number | undefined) ?? 1
  const discounted = free.eligible ? 1 : 0
  const amount = unit * Math.max(0, count - discounted) + 5 * references.length * count + 2 * Math.max(0, vibes.length - 4)
  const notes = free.eligible ? [] : [...free.reasons]
  if (free.v5_usage_condition) notes.push(free.v5_usage_condition)
  if (references.length)
    notes.push('Precise Reference adds 5 Anlas per reference; a verified eligible Opus base sample remains discounted (live API verified)')
  return { amount, notes }
}

export interface QuoteOptions {
  /** How free eligibility is judged for the selected endpoint. */
  freeMode?: FreeMode
  /** Carpool size N: this endpoint's V5 allowance is 1/N of the official pool. */
  v5Share?: number
  endpoint?: { id: string; name: string; free_mode: FreeMode; v5_share: number }
  /** The endpoint has a site session token, so its allowance is readable. */
  siteToken?: boolean
}

/** Full V5 bar at 832×1216, 23 steps, V5 Full high; see assets/guides/parameters.md. */
export const OFFICIAL_V5_IMAGES_PER_BAR = 1730

export function quoteOperation(operation: PreparedOperation, credits: NormalizedCredits, options: QuoteOptions = {}): Record<string, unknown> {
  const notes: string[] = []
  const mode = options.freeMode ?? 'official'
  let amount: number | null
  if (operation.endpoint === '/ai/generate-image') {
    const r = generationEstimate(operation, credits, mode)
    amount = r.amount
    notes.push(...r.notes)
    if (mode !== 'official') notes.push('非官方接口：不读取服务端订阅状态，按该接口声明的免费规则估算；实际扣费由该接口结算')
  } else if (operation.endpoint === '/ai/encode-vibe') {
    amount = 2
  } else if (operation.endpoint === '/ai/upscale') {
    const source = operation.summary['source'] as Record<string, number>
    const pixels = source['width']! * source['height']!
    amount = pixels <= 1048576 ? 1 : pixels <= 1747627 ? 2 : pixels <= 2446678 ? 3 : pixels <= 3145728 ? 4 : null
  } else if (operation.endpoint === '/ai/augment-image') {
    // The website enlarges tiny inputs before submission. This client sends
    // the original pixels: a live 512-square bg-removal call cost 3*5+5=20.
    const p = operation.payload as Record<string, number | string>
    const pixels = (p['width'] as number) * (p['height'] as number)
    const base = Math.max(2, Math.ceil(2.951823174884865e-6 * pixels + 5.753298233447344e-7 * pixels * 28))
    const free = checkFreeEligibility({ width: p['width'] as number, height: p['height'] as number, steps: 28, isV5: false }, credits, mode)
    amount = p['req_type'] === 'bg-removal' ? base * 3 + 5 : free.eligible ? 0 : base
    if (p['req_type'] === 'bg-removal')
      notes.push('Background removal costs 3× base +5 using submitted dimensions: direct 512×512 was verified at 20 Anlas; website preprocessing to 1MP would cost about 65')
  } else {
    amount = null
    notes.push('No verified price formula is available for this operation')
  }
  const balance = credits.anlas.total
  const model = operation.endpoint === '/ai/generate-image' ? String(operation.payload['model']) : ''
  const isV5 = model.startsWith('nai-diffusion-5-')
  const share = isV5 ? Math.max(1, Math.round(Number(options.v5Share ?? 1))) : 1
  // V5 allowance is a share of the official pool, not a points multiplier.
  const v5 = isV5
    ? {
      share,
      images_per_full_bar: Math.round(OFFICIAL_V5_IMAGES_PER_BAR / share),
      percent_per_image: Math.round((100 * share / OFFICIAL_V5_IMAGES_PER_BAR) * 100) / 100,
    }
    : null
  if (v5 && (mode !== 'official' || share > 1)) {
    notes.push(`V5 由该接口额度池结算，不再按积分计价；按 ${share} 人平分，满池约 ${v5.images_per_full_bar} 张 832×1216，每张约占用你份额的 ${v5.percent_per_image}%`)
    // The share note replaces the client's generic "cannot read the percentage" caveat.
    const stale = notes.findIndex((note) => note.includes("this endpoint's own allowance"))
    if (stale >= 0) notes.splice(stale, 1)
    if (options.siteToken)
      notes.push('该接口已配置站点令牌：nai_check_credits 可读取其 V5 剩余百分比')
  }
  return {
    operation: operation.operation, estimated_anlas: amount,
    estimated_points: amount,
    balance, free_eligible: amount === 0,
    v5, endpoint: options.endpoint ?? null,
    notes,
    limitation: amount == null
      ? 'No verified price formula; treat the cost as unknown, not zero.'
      : 'Estimate only; generation does not query or verify billing.',
  }
}

