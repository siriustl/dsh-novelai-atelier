import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Settings, freeModeOf } from '../src/workbench/settings.ts'
import { Store } from '../src/workbench/store.ts'
import { Workbench } from '../src/workbench/app.ts'
import { checkFreeEligibility, type NormalizedCredits } from '../src/core/client.ts'
import { quoteOperation } from '../src/core/billing.ts'
import { prepareOperation } from '../src/core/operations.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function settingsWith(token = 'pst-legacy-token'): { settings: Settings; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'nai-endpoints-'))
  roots.push(root)
  const settings = new Settings(new Store(root), root)
  if (token) settings.save({ nai_token: token, nai_base_url: 'https://relay.example/v1' })
  return { settings, root }
}

const credits: NormalizedCredits = {
  active: false, tier: 0, expires_at: 0,
  anlas: { subscription: 0, purchased: 2500, total: 2500 },
  perks: {}, v5_usage: null, v5_usage_summary: null,
}

describe('multiple NovelAI endpoints', () => {
  it('migrates the legacy single token into one enabled endpoint', () => {
    const { settings } = settingsWith()
    const list = settings.endpoints()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: '接口 1', base_url: 'https://relay.example/v1', active: true, enabled: true, official: false, free_mode: 'none', token_configured: true })
    expect(settings.target().token).toBe('pst-legacy-token')
    expect(JSON.stringify(settings.public())).not.toContain('pst-legacy-token')
  })

  it('keeps an omitted token while allowing reorder, disable and default selection', () => {
    const { settings } = settingsWith()
    const first = settings.endpoints()[0]!
    settings.save({ nai_endpoints: [
      { id: first['id'], name: '中转', base_url: 'https://relay.example/v1', enabled: true },
      { name: '官方', base_url: 'https://image.novelai.net', token: 'pst-official-token', enabled: true },
    ] })
    let list = settings.endpoints()
    expect(list.map((item) => item['name'])).toEqual(['中转', '官方'])
    expect(list[0]!['token_configured']).toBe(true)
    expect(list[0]!['free_mode']).toBe('none')
    expect(list[1]!['free_mode']).toBe('official')
    expect(settings.target().name).toBe('中转')

    settings.save({ nai_active_endpoint: String(list[1]!['id']) })
    expect(settings.target().name).toBe('官方')

    settings.save({ nai_endpoints: [
      { id: list[0]!['id'], name: '中转', base_url: 'https://relay.example/v1', enabled: false },
      { id: list[1]!['id'], name: '官方', base_url: 'https://image.novelai.net', enabled: true },
    ] })
    list = settings.endpoints()
    expect(list[1]!['active']).toBe(true)
    expect(settings.target().id).toBe(list[1]!['id'])
  })

  it('rejects unknown ids, duplicate ids and non-http addresses', () => {
    const { settings } = settingsWith()
    expect(() => settings.save({ nai_active_endpoint: 'missing' })).toThrow(/默认接口/)
    expect(() => settings.save({ nai_endpoints: [{ id: 'dup', name: 'a', base_url: 'https://a.example' }, { id: 'dup', name: 'b', base_url: 'https://b.example' }] })).toThrow(/重复/)
    expect(() => settings.save({ nai_endpoints: [{ name: 'x', base_url: 'ftp://a.example' }] })).toThrow(/HTTP/)
    expect(() => settings.target('missing')).toThrow(/不存在/)
  })

  it('treats only a declared endpoint as Opus-like for free eligibility', async () => {
    expect(freeModeOf({ base_url: 'https://image.novelai.net' })).toBe('official')
    expect(freeModeOf({ base_url: 'https://relay.example/v1' })).toBe('none')
    expect(freeModeOf({ base_url: 'https://relay.example/v1', assume_opus: true })).toBe('opus')

    const small = { width: 832, height: 1216, steps: 28, isV5: false }
    expect(checkFreeEligibility(small, credits, 'none').eligible).toBe(false)
    expect(checkFreeEligibility(small, credits, 'opus').eligible).toBe(true)
    expect(checkFreeEligibility({ ...small, width: 1536, height: 1536 }, credits, 'opus').eligible).toBe(false)
    expect(checkFreeEligibility({ ...small, steps: 29 }, credits, 'opus').eligible).toBe(false)

    const prepared = await prepareOperation({ model: 'nai-diffusion-4-5-full', prompt: '1girl', width: 832, height: 1216, steps: 28 }, 'generate')
    const declared = quoteOperation(prepared, credits, { freeMode: 'opus', v5Share: 1 })
    expect(declared.estimated_anlas).toBe(0)
    expect(declared.free_eligible).toBe(true)
    const undeclared = quoteOperation(prepared, credits, { freeMode: 'none', v5Share: 1 })
    expect(undeclared.estimated_anlas).toBeGreaterThan(0)
    expect(undeclared.free_eligible).toBe(false)
  })

  it('treats the V5 share as an allowance division, never a point multiplier', async () => {
    const v5 = await prepareOperation({ model: 'nai-diffusion-5-full', prompt: '1girl', width: 832, height: 1216 }, 'generate')
    const solo = quoteOperation(v5, credits, { freeMode: 'none', v5Share: 1 })
    expect(solo.estimated_points).toBe(solo.estimated_anlas)
    expect(solo.v5).toEqual({ share: 1, images_per_full_bar: 1730, percent_per_image: 0.06 })
    const shared = quoteOperation(v5, credits, { freeMode: 'none', v5Share: 4 })
    expect(shared.estimated_points).toBe(shared.estimated_anlas)
    expect(shared.v5).toEqual({ share: 4, images_per_full_bar: 433, percent_per_image: 0.23 })
    expect((shared.notes as string[]).some((note) => note.includes('4 人平分'))).toBe(true)
    const v45 = await prepareOperation({ model: 'nai-diffusion-4-5-full', prompt: '1girl', width: 832, height: 1216 }, 'generate')
    expect(quoteOperation(v45, credits, { freeMode: 'none', v5Share: 4 }).v5).toBe(null)
  })

  it('warns about unknown request keys instead of dropping them silently', async () => {
    const prepared = await prepareOperation({ model: 'nai-diffusion-5-full', prompt: '1girl', width: 64, height: 64, steps: 1, bogus_field: 1 } as never, 'generate')
    expect(prepared.warnings.join()).toContain('bogus_field')
  })

  it('replaces the unreadable-percentage caveat when the endpoint has a site token', async () => {
    const v5 = await prepareOperation({ model: 'nai-diffusion-5-full', prompt: '1girl', width: 832, height: 1216 }, 'generate')
    const notes = quoteOperation(v5, credits, { freeMode: 'opus', v5Share: 4, siteToken: true }).notes as string[]
    expect(notes.some((note) => note.includes('configure a site session token'))).toBe(false)
    expect(notes.some((note) => note.includes('站点令牌'))).toBe(true)
  })

  it('reports the site allowance instead of claiming it is unreadable', () => {
    const allowance = { ok: true, percent: 99.98, available_images: 432.4, capacity_images: 432.5, share_count: 4 }
    const verdict = checkFreeEligibility({ width: 832, height: 1216, steps: 28, isV5: true }, credits, 'opus', allowance)
    expect(verdict.v5_usage_condition).toContain('99.98%')
    expect(verdict.v5_usage_condition).toContain('4-way share')
    expect(checkFreeEligibility({ width: 832, height: 1216, steps: 28, isV5: true }, credits, 'opus').v5_usage_condition).toContain('site session token')
  })

  it('keeps manual subscription fields and quota presets on each endpoint', () => {
    const { settings } = settingsWith()
    const first = settings.endpoints()[0]!
    settings.save({ nai_endpoints: [
      { id: first['id'], name: '中转', base_url: 'https://relay.example/v1', v5_share: 4, assume_opus: true, quota_kind: 'huamio', quota_token: 'Bearer site-session-token', subscription_note: 'Opus 拼车 · 4 人', subscription_expires: '2026-12-01' },
    ] })
    const saved = settings.endpoints()[0]!
    expect(saved['v5_share']).toBe(4)
    expect(saved['quota_kind']).toBe('huamio')
    expect(saved['quota_url']).toBe('https://api.novelai.me/api/v1/novelai/v5-energy-policy')
    expect(saved['subscription_note']).toBe('Opus 拼车 · 4 人')
    expect(saved['subscription_expires']).toBe('2026-12-01')
    expect(settings.quotaTarget()).toEqual({ url: 'https://api.novelai.me/api/v1/novelai/v5-energy-policy', token: 'site-session-token' })
    expect(() => settings.save({ nai_endpoints: [{ id: first['id'], name: '中转', base_url: 'https://relay.example/v1', quota_kind: 'custom' }] })).toThrow(/地址/)
    expect(() => settings.save({ nai_endpoints: [{ id: first['id'], name: '中转', base_url: 'https://relay.example/v1', subscription_expires: '2026/12/01' }] })).toThrow(/YYYY-MM-DD/)
    expect(() => settings.save({ nai_endpoints: [{ id: first['id'], name: '中转', base_url: 'https://relay.example/v1', v5_share: 0 }] })).toThrow(/拼车人数/)
  })

  it('reports the active endpoint separately from "any token exists"', () => {
    const { settings } = settingsWith()
    const first = settings.endpoints()[0]!
    settings.save({ nai_endpoints: [
      { id: first['id'], name: '有令牌', base_url: 'https://relay.example/v1' },
      { name: '没令牌', base_url: 'https://image.novelai.net' },
    ], nai_active_endpoint: String(first['id']) })
    expect(settings.public()['active_token_configured']).toBe(true)
    const second = settings.endpoints()[1]!
    settings.save({ nai_active_endpoint: String(second['id']) })
    expect(settings.public()['token_configured']).toBe(true)
    expect(settings.public()['active_token_configured']).toBe(false)
    settings.save({ nai_active_endpoint: String(second['id']) })
    settings.save({ nai_endpoints: [settings.endpoints()[0]!] })
    expect(settings.raw()['nai_active_endpoint']).toBe(String(first['id']))
  })

  it('unwraps the site envelope when reading the allowance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nai-allowance-'))
    roots.push(root)
    const wb = new Workbench(root)
    wb.settings.save({ nai_endpoints: [{ name: '中转', base_url: 'https://relay.example/v1', token: 'token-aaaa-1111', quota_kind: 'huamio', quota_token: 'jwt-token-1234' }] })
    const original = globalThis.fetch
    const reply = (body: unknown, status = 200): void => {
      globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
    }
    try {
      reply({ code: 200, message: 'Success', data: { allocation: { available_images: 432.5, capacity_images: 432.5, share_count: 4 }, reset_description: '重置你的能量为100%' } })
      expect(await wb.endpointAllowance()).toMatchObject({ ok: true, available_images: 432.5, capacity_images: 432.5, percent: 100, share_count: 4 })
      reply({ code: 40100, message: '无效的认证凭证', data: null })
      expect(await wb.endpointAllowance()).toMatchObject({ ok: false, note: '无效的认证凭证' })
      reply({ code: 200, data: { allocation: { available_images: 2 } } })
      expect(await wb.endpointAllowance()).toMatchObject({ ok: true, available_images: 2, percent: null })
    } finally { globalThis.fetch = original }
  })

  it('aggregates every enabled endpoint for the header overview', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nai-overview-'))
    roots.push(root)
    const wb = new Workbench(root)
    wb.settings.save({ nai_endpoints: [
      { name: '甲', base_url: 'https://relay.example/v1', token: 'token-aaaa-1111', enabled: true, v5_share: 4 },
      { name: '乙', base_url: 'https://image.novelai.net', token: 'pst-official-2222', enabled: true },
      { name: '停用', base_url: 'https://off.example/v1', token: 'token-off-3333', enabled: false },
    ] })
    wb.credits = async (endpointId?: string) => {
      if (endpointId === 'ep_missing') throw new Error('不要用到这个分支')
      return { anlas: { total: 100 }, tier: 0, active: false, expires_at: 0, v5_usage_summary: null }
    }
    wb.endpointAllowance = async () => ({ ok: true, percent: 25, available_images: 5, capacity_images: 20 })
    const overview = await wb.creditsOverview()
    const rows = overview['endpoints'] as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row['name'])).toEqual(['甲', '乙'])
    expect(rows.every((row) => row['ok'] === true)).toBe(true)
    expect(overview['active_endpoint']).toBe(rows[0]!['id'])
    expect(((overview['anlas'] as Record<string, unknown>)['total'])).toBe(100)
  })
})
