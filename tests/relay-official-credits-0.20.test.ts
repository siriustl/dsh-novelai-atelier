import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkFreeEligibility, normalizeSubscription, summarizeV5Usage } from '../src/core/client.ts'
import { quoteOperation } from '../src/core/billing.ts'
import { Workbench } from '../src/workbench/app.ts'

const roots: string[] = []
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'nai-relay-credits-')); roots.push(d); return d }
afterEach(() => { vi.restoreAllMocks(); for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }) })

const OFFICIAL_SHAPED_RELAY_PAYLOAD = {
  tier: 3,
  active: true,
  expiresAt: 1798212020,
  perks: { imageGeneration: true, unlimitedImageGeneration: false },
  trainingStepsLeft: { fixedTrainingStepsLeft: 0, purchasedTrainingSteps: 2456 },
  usage: { percent: 87.5, purchasedPercent: 12, isNegative: false, timeUntilNextPercent: 0 },
  remainingPoints: 2456,
  source: 'site_points',
}

describe('official-shaped relay /user/subscription compatibility (0.20.0)', () => {
  it('normalizes relay subscription, purchasedPercent, remainingPoints, and source', () => {
    const credits = normalizeSubscription(OFFICIAL_SHAPED_RELAY_PAYLOAD)
    expect(credits).toMatchObject({
      active: true,
      tier: 3,
      expires_at: 1798212020,
      anlas: { subscription: 0, purchased: 2456, total: 2456 },
      remaining_points: 2456,
      source: 'site_points',
      v5_usage_summary: {
        pool_available: true,
        remaining_percent: 87.5,
        purchased_percent: 12,
        refill_one_percentage_point_seconds: 0,
        refill_paused_above_cap: true,
      },
    })
    expect(summarizeV5Usage({ percent: 50, isNegative: false, timeUntilNextPercent: 3600 })).not.toHaveProperty('purchased_percent')
  })

  it('uses live API V5 usage percentage and isNegative flag on opus-declared relays', () => {
    const credits = normalizeSubscription(OFFICIAL_SHAPED_RELAY_PAYLOAD)
    const ok = checkFreeEligibility({ width: 832, height: 1216, steps: 23, isV5: true }, credits, 'opus')
    expect(ok.eligible).toBe(true)
    expect(ok.v5_usage_condition).toContain('87.5%')
    expect(ok.v5_usage_condition).toContain('+12% purchased')

    const depleted = normalizeSubscription({
      ...OFFICIAL_SHAPED_RELAY_PAYLOAD,
      usage: { percent: 0, purchasedPercent: 0, isNegative: true, timeUntilNextPercent: 600 },
    })
    const blocked = checkFreeEligibility({ width: 832, height: 1216, steps: 23, isV5: true }, depleted, 'opus')
    expect(blocked.eligible).toBe(false)
    expect(blocked.reasons.some((r) => r.includes('negative'))).toBe(true)
  })

  it('surfaces live relay V5 percentage in quoteOperation and wb.quote (fixes /api/quote missing endpoint rules)', async () => {
    const wb = new Workbench(tempDir())
    wb.settings.save({
      nai_endpoints: [
        { name: '拼车中转', base_url: 'https://relay.example/v1', token: 'relay-token-123456', assume_opus: true, v5_share: 4 },
      ],
    })
    const credits = normalizeSubscription(OFFICIAL_SHAPED_RELAY_PAYLOAD)
    vi.spyOn(wb.executor, 'credits').mockResolvedValue(credits)

    const quoted = await wb.quote('generate', { prompt: '1girl, forest', model: 'nai-diffusion-5-full', width: 832, height: 1216, steps: 23 })
    expect(quoted['estimated_anlas']).toBe(0)
    expect(quoted['v5']).toMatchObject({ share: 4, remaining_percent: 87.5 })
    expect((quoted['notes'] as string[]).some((n) => n.includes('87.5%'))).toBe(true)
    expect(quoted['endpoint']).toMatchObject({ free_mode: 'opus', v5_share: 4 })

    // Direct quoteOperation check
    const direct = quoteOperation({
      operation: 'generate', endpoint: '/ai/generate-image',
      payload: { model: 'nai-diffusion-5-full', parameters: { width: 832, height: 1216, steps: 23, n_samples: 1 } },
      expected_outputs: 1, expected_dimensions: null, summary: {}, warnings: [], generation_request: null, output_kind: 'image', max_anlas: 0, inpaint_context: null,
    }, credits, { freeMode: 'opus', v5Share: 4 })
    expect(direct['estimated_anlas']).toBe(0)
    expect((direct['v5'] as Record<string, unknown>)['remaining_percent']).toBe(87.5)
  })

  it('keeps real third-party relay site names out of UI settings copy', () => {
    const settingsSource = readFileSync(join(process.cwd(), 'client', 'panels', 'settings.tsx'), 'utf8')
    expect(settingsSource).not.toContain('画喵')
  })
})
