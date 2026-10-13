/** Informational price estimates; execution does not enforce or verify a spending cap. */
import { checkFreeEligibility, type NormalizedCredits } from './client.ts'
import type { PreparedOperation } from './operations.ts'

export function baseGenerationPrice(width: number, height: number, steps: number, v5: boolean, strength = 1): number {
  const area = width * height
  const base = Math.ceil(2.951823174884865e-6 * area + 5.753298233447344e-7 * area * steps)
  return Math.max(2, Math.ceil(base * (v5 ? 1.5 : 1) * strength))
}

function generationEstimate(operation: PreparedOperation, credits: NormalizedCredits, forcePaid = false): { amount: number | null; notes: string[] } {
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
  const free = checkFreeEligibility(request, credits)
  const img2img = parameters['img2img'] as Record<string, unknown> | undefined
  const strength = parameters['mask']
    ? (img2img?.['strength'] as number | undefined ?? parameters['inpaintImg2ImgStrength'] as number | undefined ?? 1)
    : parameters['image'] ? (parameters['strength'] as number | undefined ?? 1) : 1
  const unit = baseGenerationPrice(width, height, steps, request.isV5, strength)
  if (unit > 140)
    return { amount: null, notes: ['Per-image price exceeds the official client\'s 140-Anlas supported limit; reduce dimensions or steps'] }
  const count = (parameters['n_samples'] as number | undefined) ?? 1
  const discounted = free.eligible && !forcePaid ? 1 : 0
  const amount = unit * Math.max(0, count - discounted) + 5 * references.length * count + 2 * Math.max(0, vibes.length - 4)
  const notes = free.eligible ? [] : [...free.reasons]
  if (references.length)
    notes.push('Precise Reference adds 5 Anlas per reference; a verified eligible Opus base sample remains discounted (live API verified)')
  return { amount, notes }
}

export function quoteOperation(operation: PreparedOperation, credits: NormalizedCredits): Record<string, unknown> {
  const notes: string[] = []
  let amount: number | null
  if (operation.endpoint === '/ai/generate-image') {
    const r = generationEstimate(operation, credits)
    amount = r.amount
    notes.push(...r.notes)
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
    const free = checkFreeEligibility({ width: p['width'] as number, height: p['height'] as number, steps: 28, isV5: false }, credits)
    amount = p['req_type'] === 'bg-removal' ? base * 3 + 5 : free.eligible ? 0 : base
    if (p['req_type'] === 'bg-removal')
      notes.push('Background removal costs 3× base +5 using submitted dimensions: direct 512×512 was verified at 20 Anlas; website preprocessing to 1MP would cost about 65')
  } else {
    amount = null
    notes.push('No verified price formula is available for this operation')
  }
  const balance = credits.anlas.total
  return {
    operation: operation.operation, estimated_anlas: amount,
    balance, free_eligible: amount === 0,
    notes, basis: 'Official client formulas with direct API billing checks, 2026-09-20',
    limitation: 'Informational estimate only; max_anlas is a legacy advisory value, not a server spending cap. Generation does not automatically query or verify billing.',
  }
}

