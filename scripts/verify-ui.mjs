/** Isolated browser verification of the actual DSH client bundle. No server or real API access. */
import { chromium } from 'playwright'
import { build } from 'esbuild'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const smoke = process.argv.includes('--smoke')
const credentialsOnly = process.argv.includes('--credentials-only')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const reactVersion = process.env.NAI_VERIFY_REACT === '19' ? '19' : '18'
const output = process.env.NAI_VERIFY_OUTPUT || join(root, '.nai-verification', pkg.version, `ui-react${reactVersion}`)
const bundlePath = process.env.NAI_VERIFY_BUNDLE || join(root, 'lib/client.js')
const bundle = await readFile(bundlePath, 'utf8')
const bundleStat = await stat(bundlePath)
await mkdir(output, { recursive: true })

// A genuine PNG bitmap with deterministic color and luminance variation.
const width = 256, height = 320, pixels = Buffer.alloc(width * height * 4)
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const offset = (y * width + x) * 4
  pixels[offset] = 35 + Math.floor(x * 180 / width)
  pixels[offset + 1] = 50 + Math.floor(y * 160 / height)
  pixels[offset + 2] = (Math.floor(x / 24) + Math.floor(y / 24)) % 2 ? 175 : 75
  pixels[offset + 3] = 255
}
const bitmap = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer()
const originalWidth = 1536, originalHeight = 1920
const inspectorBitmap = await sharp(bitmap).resize(originalWidth, originalHeight).png().toBuffer()
const bootstrap = await build({
  stdin: { contents: `import * as React from 'react'; import {createRoot} from 'react-dom/client'; import * as jsx from 'react/jsx-runtime'; window.__verificationReact={React,createRoot,jsx};`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' },
  ...(reactVersion === '18' ? { alias: { react: 'react18', 'react-dom': 'react-dom18' } } : {}),
})
const bootstrapCode = bootstrap.outputFiles[0].text
const report = { mode: smoke ? 'smoke-old-or-current-bundle' : 'full', package_version: pkg.version, bundle_path: 'lib/client.js', bundle_mtime: bundleStat.mtime.toISOString(), bundle_sha256: createHash('sha256').update(bundle).digest('hex'), isolated_origin: 'https://nai-verification.invalid', network_access: false, started_at: new Date().toISOString(), checks: [], viewports: [], screenshots: [] }
const executable = process.env.NAI_VERIFY_BROWSER || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'D:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((path) => existsSync(path))
if (!executable || !existsSync(executable)) throw new Error('No local browser found. Set NAI_VERIFY_BROWSER to an existing Chrome/Edge executable; this script never downloads browsers.')
const browser = await chromium.launch({ headless: true, executablePath: executable })
report.browser = { executable, version: browser.version() }
const clone = (value) => structuredClone(value)
// Extracted from the installed DSH 0.2.0-rc.2 theme bundle; selectors and token
// semantics are preserved, including body[data-ds-dark-theme].
const hostTheme = await readFile(process.env.NAI_VERIFY_THEME || join(root, 'scripts/fixtures/dsh-theme.css'), 'utf8')
report.theme_source = 'DSH 0.2.0-rc.2 dsh-client-ui-theme'
report.theme_sha256 = createHash('sha256').update(hostTheme).digest('hex')
function state() {
  const request = { model: 'nai-diffusion-5-full', prompt: 'A vivid illustration of a mountain garden, detailed flowers, clear daylight', negative_prompt: '', width: 832, height: 1216, seed: 123, steps: 23, scale: 7, sampler: 'k_euler_ancestral', quality_preset: 'standard', negative_preset: 'heavy', max_anlas: 0, characters: [], vibes: [], precise_references: [] }
  const assets = [1, 2, 3].map((i) => ({ id: `asset-${i}`, path: `C:/verification/bitmap-${i}.png`, name: `bitmap-${i}.png`, mime: 'image/png', width, height }))
  const draft = { id: 'main', name: 'Mountain Garden', revision: 3, operation: 'generate', request: clone(request), locked_fields: [], library_refs: [] }
  const jobs = assets.map((asset, i) => ({ id: `job-${i + 1}`, operation: 'generate', status: 'completed', request: { ...clone(request), prompt: ['Mountain garden in daylight', 'Coastal greenhouse illustration', 'Vivid botanical composition'][i] }, assets: [asset], favorite: false, archived: false, actual_anlas: 0, created_at: '2026-09-20T12:00:00Z' }))
  return { draft, drafts: [draft], assets, jobs, library: [{ id: 'character-1', kind: 'character', name: 'Garden Keeper', revision: 0, data: { prompt: 'girl, green hair, gardening apron', examples: [assets[0].id] } }], schedules: [{ id: 'schedule-1', name: 'Daily garden study', kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai', enabled: false, execution_mode: 'fixed', operation: 'generate', request: clone(request), count: 1, max_runs: 10, runs: 2, spent: 0, reserved: 0, remaining_anlas: 0, max_total_anlas: 0, revision: 0 }], settings: { token_configured: true, token_source: 'verification fixture', nai_base_url: 'https://image.novelai.net', nai_active_endpoint: 'ep_fixture', nai_endpoints: [{ id: 'ep_fixture', name: '官方 NovelAI', base_url: 'https://image.novelai.net', enabled: true, priority: 0, active: true, official: true, v5_rate: 1, assume_opus: false, free_mode: 'official', token_configured: true, token_hint: '…ture', quota_url: '', quota_configured: false }], proxy_url: '', output_directory: 'C:/verification/outputs', creative_preferences: '', onboarding_complete: true, ai: { dsh_provider: '', dsh_model: '', max_output_tokens: 4096 }, ai_profiles: [] }, nextSaveStatus: 0, expectedHttpFailures: [], requests: [], curations: [], uploads: [] }
}
async function check(page, name, fn) {
  try { const details = await fn(); report.checks.push({ name, passed: true, ...(details === undefined ? {} : { details }) }) }
  catch (error) {
    const path = join(output, `failure-${report.checks.length}.png`)
    await page.screenshot({ path }).catch(() => {})
    report.checks.push({ name, passed: false, error: error.message, screenshot: path })
  }
}
async function mount(page) { await page.evaluate(() => window.__verification.remount()); await page.locator('.nai-nav button').first().waitFor(); await page.locator('main').waitFor() }
async function saved(page) { await page.waitForFunction(() => document.querySelector('.nai-save-state')?.getAttribute('data-save-status') === 'saved') }
async function navigate(page, label) { await page.locator('.nai-nav').getByRole('button', { name: label, exact: true }).click(); await page.waitForFunction((label) => document.querySelector('.nai-nav button.active')?.textContent.trim() === label, label) }
async function screenshot(page, name) { const path = join(output, name + '.png'); await page.screenshot({ path }); const stats = await sharp(path).stats(); assert.ok(stats.channels.slice(0, 3).some((channel) => channel.stdev > 10), 'Screenshot must contain nonblank UI'); report.screenshots.push(path) }
async function fixturePage(viewport, theme) {
  const fixture = state()
  const context = await browser.newContext({ viewport, colorScheme: theme, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.setDefaultTimeout(7000)
  const errors = [], warnings = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    const expected = fixture.expectedHttpFailures.find((failure) => !failure.observed && text.includes(`status of ${failure.status}`) && (!message.location().url || message.location().url === failure.url))
    if (expected && /^Failed to load resource:/.test(text)) { expected.observed = true; return }
    if (/Each child in a list should have a unique|non-boolean attribute/.test(text)) warnings.push(text)
    else errors.push(text)
  })
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}))
  await page.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname.replace(/^\/api\/nai\/api/, ''), method = req.method()
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
    if (url.origin !== report.isolated_origin) { errors.push(`Blocked unexpected external request: ${url.origin}`); return route.abort('blockedbyclient') }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' })
    fixture.requests.push({ path: url.pathname + url.search, method })
    const body = method === 'GET' || method === 'HEAD' ? {} : (() => { try { return req.postDataJSON() } catch { return {} } })()
    if (/^\/assets\/inspector-asset-\d+-\d+\/file$/.test(path)) {
      if (fixture.failOriginalOnce) {
        fixture.failOriginalOnce = false
        fixture.expectedHttpFailures.push({ status: 503, url: req.url(), observed: false })
        return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Temporary original-image failure' })
      }
      return route.fulfill({ contentType: 'image/png', body: inspectorBitmap })
    }
    if (path.startsWith('/files/') || /^\/assets\/[^/]+\/(file|thumb)$/.test(path)) return route.fulfill({ contentType: 'image/png', body: bitmap })
    if (path === '/bootstrap') return json({ version: pkg.version, draft: fixture.draft, settings: fixture.settings, jobs: fixture.jobs, library: fixture.library, schedules: fixture.schedules, paused: false, summary: { active_jobs: 0, library_count: fixture.library.length, schedule_count: fixture.schedules.length } })
    if (path === '/inspiration/search') {
      const source = url.searchParams.get('source') || 'all', page = Number(url.searchParams.get('page') || 1)
      const sources = source === 'all' ? ['pixiv', 'aitag'] : [source]
      return json({ items: sources.map((source) => ({ id: `${source}_${page}`, source, title: `${source} artwork page ${page}`, prompt: source === 'danbooru' ? 'forest, sunlight' : '', tags: source === 'pixiv' ? ['風景', '森'] : undefined, aiMark: source === 'pixiv' ? 'not-ai' : undefined, promptKind: source === 'aitag' ? 'original' : source === 'pixiv' ? 'reference' : 'tags', needsDetail: source === 'aitag', previewUrl: 'https://i.pximg.net/verification.jpg' })), page, hasMore: page < 2, errors: source === 'all' ? [{ source: 'danbooru', code: 'HTTP_403', message: '素材接口 HTTP 403' }] : [] })
    }
    if (path === '/inspiration/detail') return json({ id: url.searchParams.get('id'), source: url.searchParams.get('source'), title: 'AITag detail', prompt: 'original recipe, forest', negativePrompt: 'blur', promptKind: 'original', needsDetail: false, previewUrl: 'https://i.pximg.net/verification.jpg', characters: [{ prompt: 'traveler, cape' }] })
    if (path === '/inspiration/image') return route.fulfill({ contentType: 'image/png', body: bitmap })
    if (path === '/credits') return json({ active: true, tier: 3, anlas: { total: 1200 }, v5_usage_summary: { remaining_percent: 85 } })
    if (path === '/draft' && method === 'PATCH') {
      if (fixture.nextSaveStatus) { const status = fixture.nextSaveStatus; fixture.nextSaveStatus = 0; fixture.expectedHttpFailures.push({ status, url: req.url(), observed: false }); return json({ error: status === 409 ? '草稿版本冲突，请核对后重试' : '测试保存暂时失败' }, status) }
      if (body.base_revision !== fixture.draft.revision) return json({ error: '草稿版本冲突，请核对后重试' }, 409)
      Object.assign(fixture.draft, clone(body), { revision: fixture.draft.revision + 1 }); delete fixture.draft.base_revision
      return json(fixture.draft)
    }
    if (path === '/drafts' && method === 'POST') { const draft = { ...clone(fixture.draft), ...clone(body.draft), id: `copy-${fixture.drafts.length}`, revision: 0 }; fixture.drafts.push(draft); if (body.activate !== false) fixture.draft = draft; return json(draft) }
    if (path === '/drafts') return json(fixture.drafts)
    if (/^\/drafts\/[^/]+\/versions$/.test(path)) {
      const id = path.split('/')[2]
      fixture.versions ??= {}
      const list = fixture.versions[id] ??= []
      if (method === 'POST') { const draft = fixture.drafts.find((draft) => draft.id === id); const version = { id: `version-${list.length}`, draft_id: id, revision: draft.revision, name: body.name, data: clone(draft), created_at: new Date().toISOString() }; list.push(version); return json(version) }
      return json(list)
    }
    if (/^\/drafts\/[^/]+\/activate$/.test(path) && method === 'POST') { fixture.draft = fixture.drafts.find((draft) => draft.id === path.split('/')[2]); return json(fixture.draft) }
    if (/^\/drafts\/[^/]+$/.test(path)) {
      const id = path.split('/')[2]
      if (method === 'DELETE') {
        fixture.drafts = fixture.drafts.filter((draft) => draft.id !== id)
        if (!fixture.drafts.length) fixture.drafts.push({ ...clone(fixture.draft), id: 'fresh-after-delete', name: '未命名作品', revision: 0, request: { ...clone(fixture.draft.request), prompt: '' } })
        if (fixture.draft.id === id) fixture.draft = fixture.drafts.at(-1)
        return json(fixture.draft)
      }
      return json(fixture.drafts.find((draft) => draft.id === id) ?? fixture.draft)
    }
    if (path === '/gallery/reveal') { (fixture.reveals ??= []).push(clone(body)); return json({ opened: true, directory: 'C:/verification' }) }
    if (path === '/gallery') {
      const jobs = fixture.jobs.filter((job) => job.archived === (url.searchParams.get('archived') === 'true') && (url.searchParams.get('favorite') !== 'true' || job.favorite))
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 48)
      return json({ items: jobs.slice(offset, offset + limit), total: jobs.length, offset, limit })
    }
    if (path === '/gallery/curate') { fixture.curations.push(clone(body)); for (const job of fixture.jobs) if (body.ids.includes(job.id)) Object.assign(job, body.favorite === undefined ? {} : { favorite: body.favorite }, body.archived === undefined ? {} : { archived: body.archived }); return json({ updated: body.ids.length }) }
    if (path === '/gallery/export') return route.fulfill({ contentType: 'application/zip', body: Buffer.from('verification ZIP fixture') })
    if (path === '/assets' && method === 'POST') {
      if (fixture.uploadGate) await fixture.uploadGate
      const isVibe = /filename="[^"\r\n]*\.(vibe|naiv4vibe)"/i.test(req.postDataBuffer()?.toString('latin1') ?? '')
      const asset = { id: `upload-${fixture.uploads.length}`, path: `C:/verification/upload-${fixture.uploads.length}.${isVibe ? 'vibe' : 'png'}`, name: isVibe ? 'reference.vibe' : 'reference.png', mime: isVibe ? 'application/octet-stream' : 'image/png', width, height }
      fixture.uploads.push(asset); return json(asset)
    }
    if (path === '/assets') return json(fixture.assets)
    if (path === '/library' && method === 'POST') {
      const entry = { ...clone(body), id: `browser-entry-${fixture.library.length}`, revision: 0 }
      fixture.library.push(entry); return json(entry)
    }
    const summary = (entry) => {
      const data = entry.data ?? {}
      const parent = fixture.library.find((row) => row.id === entry.parent_id)
      const examples = Array.isArray(data.examples) ? data.examples : []
      const sets = Array.isArray(data.prompt_sets) ? data.prompt_sets : []
      return {
        id: entry.id, kind: entry.kind, parent_id: entry.parent_id ?? null, parent_name: parent?.name ?? null,
        name: entry.name, revision: entry.revision, created_at: entry.created_at ?? '2026-09-20T12:00:00Z', updated_at: entry.updated_at ?? '2026-09-20T12:00:00Z',
        tags: Array.isArray(data.tags) ? data.tags : [], favorite: data.favorite === true, use_count: data.use_count ?? 0, last_used_at: data.last_used_at ?? null,
        prompt_preview: data.prompt ?? '', negative_preview: data.negative_prompt ?? '',
        prompt_set_count: sets.length, prompt_set_names: sets.map((set) => set.name).filter(Boolean),
        example_count: examples.length, cover_asset_id: examples[0] ?? null,
        branches: entry.kind === 'character' ? fixture.library.filter((row) => row.parent_id === entry.id).map((row) => ({ id: row.id, name: row.name })) : undefined,
      }
    }
    if (path === '/library/query') {
      const query = (url.searchParams.get('query') ?? '').trim().toLowerCase()
      const kind = url.searchParams.get('kind') ?? 'all'
      const tag = url.searchParams.get('tag') ?? ''
      const favorite = url.searchParams.get('favorite') === 'true'
      const sort = url.searchParams.get('sort') ?? 'updated'
      const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 48)
      const rows = fixture.library.map(summary).filter((row) => {
        if (kind !== 'all' && row.kind !== kind) return false
        if (favorite && !row.favorite) return false
        if (tag && !row.tags.some((value) => String(value).toLowerCase() === tag.toLowerCase())) return false
        if (query && !`${row.name} ${row.parent_name ?? ''} ${row.prompt_preview} ${row.tags.join(' ')}`.toLowerCase().includes(query)) return false
        return true
      })
      rows.sort((left, right) => sort === 'name' ? left.name.localeCompare(right.name, 'zh-CN') : sort === 'used' ? right.use_count - left.use_count : right.updated_at.localeCompare(left.updated_at))
      const kinds = Object.fromEntries(['character', 'branch', 'artist', 'blend', 'preset'].map((value) => [value, fixture.library.filter((entry) => entry.kind === value).length]))
      return json({
        items: rows.slice(offset, offset + limit), total: rows.length, offset, limit,
        next_offset: offset + limit < rows.length ? offset + limit : null, sort,
        facets: { all: rows.length, kinds, favorites: fixture.library.filter((entry) => entry.data?.favorite === true).length, tags: [] },
      })
    }
    if (/^\/library\/[^/]+\/(use|favorite)$/.test(path) && method === 'POST') {
      const entry = fixture.library.find((row) => row.id === path.split('/')[2])
      if (!entry) return json({ error: 'missing' }, 404)
      if (path.endsWith('/favorite')) { entry.data = { ...(entry.data ?? {}), favorite: body.favorite === true }; entry.revision = (entry.revision ?? 0) + 1 }
      else entry.data = { ...(entry.data ?? {}), use_count: Number(entry.data?.use_count ?? 0) + 1, last_used_at: new Date().toISOString() }
      return json(entry)
    }
    if (path === '/library') return json(fixture.library)
    if (/^\/library\/[^/]+$/.test(path) && method === 'GET') {
      return json(fixture.library.find((entry) => entry.id === path.split('/')[2]) ?? fixture.library[0])
    }
    if (/^\/library\/[^/]+$/.test(path) && method === 'PUT') {
      const entry = fixture.library.find((entry) => entry.id === path.split('/')[2])
      Object.assign(entry, clone(body), { revision: entry.revision + 1 }); return json(entry)
    }
    if (path === '/library/preview') {
      const entry = fixture.library.find((entry) => entry.id === body.entry_id)
      const parent = fixture.library.find((parent) => parent.id === entry?.parent_id)
      return json({ prompt: entry?.kind === 'branch' ? [parent?.data.prompt, entry.data.prompt].filter(Boolean).join(', ') : entry?.data.prompt ?? '', negative_prompt: '' })
    }
    if (path === '/schedules' && method === 'POST') {
      const plan = { ...clone(body), id: `browser-plan-${fixture.schedules.length}`, revision: 0 }
      fixture.schedules.push(plan); return json(plan)
    }
    if (path === '/schedules') return json(fixture.schedules)
    if (path.startsWith('/schedules/') && path.endsWith('/runs')) return json([])
    if (path === '/settings' && method === 'PUT') {
      (fixture.settingsWrites ??= []).push(clone(body))
      if (fixture.settingsGate) await fixture.settingsGate
      if (fixture.nextSettingsStatus) {
        const status = fixture.nextSettingsStatus; fixture.nextSettingsStatus = 0
        fixture.expectedHttpFailures.push({ status, url: req.url(), observed: false })
        return json({ error: 'Credential persistence temporarily unavailable' }, status)
      }
      if (body.nai_token) {
        assert.match(body.nai_token, /^pst-\S+$/)
        fixture.savedTokens ??= []; fixture.savedTokens.push(body.nai_token)
        fixture.settings.token_configured = true; fixture.settings.token_source = '工作台明文保存'
      }
      if (Array.isArray(body.nai_endpoints)) {
        for (const entry of body.nai_endpoints) {
          if (entry.token) {
            assert.match(entry.token, /^\S{8,}$/u)
            fixture.savedTokens ??= []; fixture.savedTokens.push(entry.token)
          }
        }
        const previous = fixture.settings.nai_endpoints ?? []
        fixture.settings.nai_endpoints = body.nai_endpoints.map((entry, index) => {
          // The real server assigns an id on save; without one the editor cannot reopen the row.
          const id = entry.id ?? `ep_fixture_${index}`
          const before = previous.find((item) => item.id === id)
          return {
            ...entry, id, priority: index,
            token_configured: Boolean(entry.token) || before?.token_configured === true,
            token_hint: entry.token ? `…${String(entry.token).slice(-6)}` : before?.token_hint ?? '',
            official: /novelai\.net$/u.test(new URL(entry.base_url).hostname),
            active: id === (body.nai_active_endpoint || fixture.settings.nai_active_endpoint),
          }
        })
        fixture.settings.token_configured = fixture.settings.nai_endpoints.some((entry) => entry.token_configured)
        if (body.nai_active_endpoint) fixture.settings.nai_active_endpoint = body.nai_active_endpoint
      }
      for (const key of ['nai_base_url', 'proxy_url', 'output_directory', 'retry_delay_seconds', 'retry_max_attempts']) if (key in body) fixture.settings[key] = body[key]
      if (body.ai) Object.assign(fixture.settings.ai, body.ai)
      return json(fixture.settings)
    }
    if (path === '/settings') return json(fixture.settings)
    if (path === '/settings/ai-channel') return json({ providers: [], default_selection: {}, available: true })
    if (path === '/validate') return json({ valid: true, warnings: [], resolved_request: body.request })
    if (path === '/quote') return json({ valid: true, estimated_anlas: 0, balance: 1200, within_budget: true, notes: [] })
    if (path === '/jobs' && method === 'GET') return json(fixture.jobs)
    if (path === '/jobs' && method === 'POST') return json({ jobs: [{ id: 'mock-only-generation', status: 'queued' }] })
    if (path.startsWith('/jobs/')) return json(fixture.jobs.find((job) => job.id === path.split('/')[2]) ?? fixture.jobs[0])
    errors.push(`Unmocked API route: ${method} ${path}`)
    return json({ error: 'Verification fixture does not implement this route' }, 501)
  })
  await page.goto(report.isolated_origin + '/')
  await page.setContent(`<!doctype html><html style="color-scheme:${theme}"><head><meta charset="utf-8"></head><body ${theme === 'dark' ? 'data-ds-dark-theme' : ''} style="margin:0;height:100vh;overflow:hidden"><div id="app" style="height:100vh;width:100%"></div></body></html>`)
  await page.addStyleTag({ content: hostTheme })
  await page.addScriptTag({ content: bootstrapCode })
  await page.evaluate(() => { window.__NAI_ATELIER_API_PREFIX__ = '/api/nai'; window.__ModuleLoader__ = { load(definition) { window.__verificationModule = definition } } })
  await page.addScriptTag({ content: bundle })
  await page.evaluate(() => {
    const { React, createRoot, jsx } = window.__verificationReact
    const exported = window.__verificationModule.factory((id) => { if (id === 'react') return React; if (id === 'react/jsx-runtime') return jsx; if (id === 'react-dom/client') return { createRoot }; throw new Error(`Unexpected factory require: ${id}`) })
    let component, registration, root
    const disposers = []
    const ctx = { effect(fn) { disposers.push(fn()) }, sidebarRightTabs: { register(definition) { registration = definition; return () => {} } }, slots: { inject(_name, register) { return register() }, register(spec, value) { if (spec.name === 'sidebar.right.pane.tab' && spec.key === 'dsh-novelai-atelier') component = value; return () => {} } } }
    ;(exported.default ?? exported).apply(ctx)
    if (!component || !registration) throw new Error('Real WorkbenchTab was not registered')
    window.__verification = { remount() { root?.unmount(); root = createRoot(document.getElementById('app')); root.render(React.createElement(component)) }, dispose() { root?.unmount(); for (const fn of disposers.reverse()) if (typeof fn === 'function') fn() } }
    window.__verification.remount()
  })
  await page.locator('.nai-nav button').first().waitFor()
  return { page, context, fixture, errors, warnings }
}
try {
  for (const theme of ['light', 'dark']) for (const size of [1200, 540, 360]) {
    if (process.env.NAI_VERIFY_CASE && process.env.NAI_VERIFY_CASE !== `${theme}-${size}`) continue
    const id = `${theme}-${size}`, { page, context, fixture, errors, warnings } = await fixturePage({ width: size, height: 940 }, theme)
    try {
      report.viewports.push({ id, width: size, height: 940, theme })
      await check(page, `${id}/real-react-mount`, async () => { assert.equal(await page.locator('.nai-nav button').count(), 7); assert.equal(await page.locator('.nai-root').count(), 1); report.react_version = await page.evaluate(() => window.__verificationReact.React.version) })
      if (!smoke) await check(page, `${id}/endpoint-save-retry`, async () => {
        fixture.settings.nai_endpoints = []; fixture.settings.token_configured = false
        await mount(page); await navigate(page, '设置')
        await page.getByRole('button', { name: '添加接口', exact: true }).click()
        const name = page.getByLabel('名称', { exact: true })
        const base = page.getByLabel('API 地址', { exact: true })
        const token = page.getByLabel('令牌（留空表示不修改）', { exact: true })
        await name.fill('测试中转')
        await base.fill('https://relay.verification.invalid/v1')
        assert.equal(await page.getByLabel('拼车人数 N（V5 额度按 1/N 估算）', { exact: true }).count(), 1)
        assert.equal(await page.getByLabel('订阅说明（可选，仅展示）', { exact: true }).count(), 1)
        await page.getByLabel('拼车人数 N（V5 额度按 1/N 估算）', { exact: true }).fill('4')
        await page.getByLabel('站点额度查询', { exact: true }).selectOption('huamio')
        assert.equal(await page.getByLabel('站点登录令牌（会过期）', { exact: true }).count(), 1)
        await screenshot(page, `settings-endpoint-editor-${id}`)
        await token.fill('uai-browser-fixture-token')
        fixture.nextSettingsStatus = 503
        await page.getByRole('button', { name: '保存接口', exact: true }).click()
        await page.getByRole('alert').filter({ hasText: 'Credential persistence temporarily unavailable' }).waitFor()
        assert.equal(await token.inputValue(), 'uai-browser-fixture-token')
        assert.equal(fixture.settings.token_configured, false)
        await page.getByRole('button', { name: '保存接口', exact: true }).click()
        await page.getByRole('status').filter({ hasText: '已保存接口配置' }).waitFor()
        assert.equal(fixture.savedTokens.at(-1), 'uai-browser-fixture-token')
        assert.equal(fixture.settings.token_configured, true)
        assert.equal(fixture.settingsWrites.at(-1).nai_endpoints[0].v5_share, 4)
        assert.equal(fixture.settingsWrites.at(-1).nai_endpoints[0].quota_kind, 'huamio')
        await page.getByText('测试中转', { exact: true }).waitFor()
        assert.equal(await page.locator('body').textContent().then((text) => text.includes('uai-browser-fixture-token')), false)
        await screenshot(page, `settings-endpoints-${id}`)
      })
      for (const label of (credentialsOnly ? ['设置'] : smoke ? ['创作'] : ['创作', '画廊', '灵感', '资料库', '草稿', '定时任务', '设置'])) await check(page, `${id}/page/${label}`, async () => {
        if (!smoke) await navigate(page, label)
        if (label === '画廊') { await page.locator('.nai-gallery .cell').first().waitFor(); await page.waitForFunction(() => document.querySelector('.nai-gallery img')?.naturalWidth > 0) }
        const geometry = await page.evaluate(() => { const main = document.querySelector('main'), root = document.querySelector('.nai-root'); return { bodyOverflow: document.documentElement.scrollWidth - innerWidth, mainOverflow: main.scrollWidth - main.clientWidth, rootWidth: root.getBoundingClientRect().width } })
        assert.ok(geometry.bodyOverflow <= 1 && geometry.mainOverflow <= 1, `Horizontal content overflow: ${JSON.stringify(geometry)}`)
        if (label === '创作') await screenshot(page, `workspace-${id}`)
        if (label === '资料库' && size === 1200) await screenshot(page, `library-${id}`)
        if (label === '画廊' && size === 1200) {
          await page.locator('.nai-gallery .cell').first().click()
          const dialog = page.getByRole('dialog')
          await dialog.waitFor()
          const palette = await dialog.evaluate((node) => {
            const root = document.querySelector('.nai-root'), style = getComputedStyle(root)
            const probe = document.createElement('div'); probe.style.backgroundColor = 'var(--dsw-alias-bg-layer-1)'; root.append(probe)
            const expected = getComputedStyle(probe).backgroundColor; probe.remove()
            return { actual: getComputedStyle(node).backgroundColor, expected, font: style.fontFamily, faint: style.getPropertyValue('--nai-faint').trim() }
          })
          assert.equal(palette.actual, palette.expected, 'Dialog must use the host surface, not its gray overlay')
          assert.ok(palette.font.includes('Microsoft YaHei'), 'Use the host CJK font stack')
          await dialog.getByRole('button', { name: '打开所在文件夹', exact: true }).click()
          await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="dialog"] button')).some((button) => button.textContent.includes('打开所在文件夹') && !button.disabled))
          assert.equal(fixture.reveals.at(-1).job_id, 'job-1')
          assert.equal(await dialog.getByRole('button', { name: '下载图片', exact: true }).count(), 0)
          if (theme === 'dark') await screenshot(page, 'artwork-dialog-dark-1200')
          await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
        }
        if (label === '画廊' && theme === 'dark' && size === 1200) {
          await check(page, `${id}/gallery-masonry-filters-inspector`, async () => {
            // Adaptive masonry: mixed artwork ratios must produce mixed card heights,
            // and every badge/action layer must stay inside its own card.
            const originalJobs = fixture.jobs
            const ratios = [[832, 1216], [1216, 832], [1024, 1024], [832, 1216], [1216, 832], [1024, 1024], [832, 1216], [1216, 832], [1024, 1024], [832, 1216], [1216, 832], [1024, 1024]]
            fixture.jobs = ratios.map((size, index) => {
              const source = originalJobs[index % originalJobs.length]
              return {
                ...clone(source), id: `masonry-${index + 1}`,
                request: {
                  ...clone(source.request), width: size[0], height: size[1],
                  prompt: `Masonry artwork ${index + 1} — ${size[0]}×${size[1]}`,
                },
              }
            })
            let layout
            try {
              await mount(page); await navigate(page, '画廊')
              await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
              await page.waitForFunction(() => {
                const images = Array.from(document.querySelectorAll('.nai-gallery .cell img'))
                return images.length === 12 && images.every((image) => image.naturalWidth > 0)
              })
              await page.evaluate(() => window.scrollTo(0, 0))
              layout = await page.evaluate(() => {
                const gallery = document.querySelector('.nai-gallery[data-layout="columns"]')
                const cards = Array.from(document.querySelectorAll('.nai-gallery .cell'))
                const inside = (card) => Array.from(card.querySelectorAll('.flags, .nai-card-actions, .nai-gallery-selection')).every((node) => {
                  const box = card.getBoundingClientRect(), layer = node.getBoundingClientRect()
                  return layer.left >= box.left - 1 && layer.right <= box.right + 1 && layer.top >= box.top - 1 && layer.bottom <= box.bottom + 1
                })
                const tops = cards.map((card) => Math.round(card.getBoundingClientRect().top))
                return {
                  found: Boolean(gallery),
                  columns: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left))).size,
                  cards: cards.length,
                  contained: cards.every(inside),
                  heights: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().height))).size,
                  fit: Array.from(document.querySelectorAll('.nai-gallery .cell img')).every((image) => getComputedStyle(image).objectFit === 'contain'),
                  firstRow: tops.filter((top) => top === Math.min(...tops)).length,
                }
              })
              await screenshot(page, 'gallery-dark-1200')
            } finally {
              fixture.jobs = originalJobs
              await mount(page); await navigate(page, '画廊')
            }
            assert.ok(layout.found, 'The gallery must render one masonry container')
            assert.ok(layout.cards >= 2, `Masonry must keep every card: ${JSON.stringify(layout)}`)
            assert.ok(layout.columns >= 2, `Masonry must use the panel width: ${JSON.stringify(layout)}`)
            assert.ok(layout.contained, `Card overlays must stay inside their card: ${JSON.stringify(layout)}`)
            assert.ok(layout.heights > 1, `Adaptive masonry must vary card heights: ${JSON.stringify(layout)}`)
            assert.ok(layout.firstRow >= 2, `Newest works must start the first row left to right: ${JSON.stringify(layout)}`)
            assert.ok(layout.fit, `Masonry thumbnails must keep the whole artwork visible: ${JSON.stringify(layout)}`)

            // Polling must reuse the cards instead of remounting them.
            const beforePoll = await page.evaluate(() => {
              const image = document.querySelector('.nai-gallery .cell img')
              image.dataset.masonryProbe = 'kept'
              return image.dataset.masonryProbe
            })
            await page.waitForTimeout(6800)
            const afterPoll = await page.evaluate(() => document.querySelector('.nai-gallery .cell img')?.dataset.masonryProbe ?? '')
            assert.equal(afterPoll, beforePoll, 'A gallery refresh must not remount the masonry cards')
            assert.equal(await page.evaluate(() => localStorage.getItem('nai-atelier.gallery-density')), null)

            // Every card must open its own artwork: the old bug reopened one image
            // because card overlays escaped their card and covered the panel.
            const titles = []
            for (const index of [0, 1]) {
              await page.locator('.nai-gallery .cell').nth(index).click()
              const dialog = page.getByRole('dialog').last()
              await dialog.waitFor()
              titles.push((await dialog.getByRole('heading').first().textContent()).trim())
              await dialog.getByRole('button', { name: '关闭窗口', exact: true }).click()
              await dialog.waitFor({ state: 'hidden' })
            }
            assert.notEqual(titles[0], titles[1], `Each card must open its own artwork: ${titles.join(' / ')}`)

            await page.getByLabel('模型', { exact: true }).selectOption('nai-diffusion-5-full')
            await page.getByLabel('从', { exact: true }).fill('2025-03-09')
            await page.waitForTimeout(100)
            const expectedAfter = await page.evaluate(() => new Date('2025-03-09T00:00:00').toISOString())
            const request = [...fixture.requests].reverse().find((item) => {
              if (!item.path.includes('/gallery?')) return false
              const params = new URLSearchParams(item.path.split('?')[1])
              return params.get('model') === 'nai-diffusion-5-full' && params.get('after') === expectedAfter
            })
            assert.ok(request, 'Model and date filters must reach the existing gallery endpoint')
            const filters = new URLSearchParams(request.path.split('?')[1])
            assert.equal(filters.get('model'), 'nai-diffusion-5-full')
            assert.equal(filters.get('after'), expectedAfter)

            await page.locator('.nai-gallery .cell').first().click()
            const detail = page.getByRole('dialog').last()
            await detail.getByRole('button', { name: '检查大图', exact: true }).first().click()
            const viewer = page.getByRole('dialog').last()
            await viewer.getByRole('button', { name: '适应窗口', exact: true }).click()
            await viewer.getByRole('button', { name: '100%', exact: true }).click()
            assert.equal(await viewer.getByRole('button', { name: '100%', exact: true }).getAttribute('aria-pressed'), 'true')
            await viewer.locator('img').waitFor()
            assert.equal(await viewer.locator('img').evaluate((image) => image.naturalWidth), width)
            await screenshot(page, 'image-inspector-dark-1200')
            await viewer.getByRole('button', { name: '下一张', exact: true }).click()
            await viewer.getByRole('heading').filter({ hasText: '2 / 3' }).waitFor()
            await viewer.getByRole('button', { name: '关闭窗口', exact: true }).click()
            await detail.getByRole('button', { name: '关闭窗口', exact: true }).click()
            // Navigation must stay clickable after browsing the masonry.
            await navigate(page, '灵感'); await navigate(page, '画廊')
            await page.locator('.nai-gallery[data-layout="columns"] .cell').first().waitFor()
          })
        }
        return geometry
      })
      if (!smoke && !credentialsOnly) await check(page, `${id}/inspector-original-pixels-wheel-retry-resize`, async () => {
        const originalJobs = fixture.jobs, imageResponses = []
        const observeOriginal = (response) => { if (response.url().includes('/assets/inspector-')) imageResponses.push({ url: response.url(), status: response.status() }) }
        page.on('response', observeOriginal)
        fixture.jobs = originalJobs.map((job, index) => ({ ...clone(job), id: `inspector-job-${index}`, assets: job.assets.map((asset, assetIndex) => ({ ...clone(asset), id: `inspector-asset-${index}-${assetIndex}`, path: `C:/verification/inspector-${index}-${assetIndex}.png`, width: originalWidth, height: originalHeight })) }))
        try {
          const originalResponse = page.waitForResponse((response) => response.url().endsWith('/assets/inspector-asset-0-0/file') && response.status() === 200)
          await mount(page); await navigate(page, '画廊')
          await page.locator('.nai-gallery .cell').first().click()
          const original = await originalResponse
          assert.equal(original.headers()['content-type'], 'image/png')
          assert.equal((await original.body()).length, inspectorBitmap.length)
          const detail = page.getByRole('dialog').last()
          await detail.getByRole('button', { name: '检查大图', exact: true }).first().click()
          const viewer = page.getByRole('dialog').last(), stage = viewer.locator('.nai-image-inspector-stage')
          await viewer.getByRole('button', { name: '100%', exact: true }).click()
          const pixels = await viewer.locator('img').evaluate((image) => ({ naturalWidth: image.naturalWidth, width: image.getBoundingClientRect().width }))
          assert.equal(pixels.naturalWidth, originalWidth)
          assert.equal(pixels.width, originalWidth)
          assert.ok(originalWidth > size)
          await stage.focus(); await page.keyboard.press('ArrowRight')
          assert.match(await viewer.locator('img').evaluate((image) => image.style.transform), /translate\(-40px, 0px\)/)
          await stage.evaluate((node) => node.addEventListener('wheel', (event) => { node.dataset.wheelCancelled = String(event.defaultPrevented) }, { once: true }))
          await stage.hover(); await page.mouse.wheel(0, -100)
          await page.waitForFunction(() => document.querySelector('.nai-image-inspector-stage')?.dataset.wheelCancelled === 'true')
          await viewer.getByRole('button', { name: '100%', exact: true }).click()
          await page.setViewportSize({ width: size, height: 360 })
          await page.waitForFunction(() => Array.from(document.querySelectorAll('.nai-image-inspector-controls button')).some((button) => button.textContent === '100%' && button.getAttribute('aria-pressed') === 'true'))
          await viewer.getByRole('button', { name: '适应窗口', exact: true }).click()
          const fitted = await stage.evaluate((node) => {
            const box = node.getBoundingClientRect(), image = node.querySelector('img').getBoundingClientRect(), body = node.parentElement.getBoundingClientRect()
            return { width: box.width, height: box.height, top: box.top, bottom: box.bottom, bodyTop: body.top, bodyBottom: body.bottom, imageWidth: image.width, imageHeight: image.height }
          })
          assert.ok(fitted.height > 40 && fitted.top >= fitted.bodyTop && fitted.bottom <= fitted.bodyBottom + 1, `Inspector stage must remain visible: ${JSON.stringify(fitted)}`)
          assert.ok(fitted.imageWidth <= fitted.width + 1 && fitted.imageHeight <= fitted.height + 1, `Fit must use the visible stage: ${JSON.stringify(fitted)}`)
          await screenshot(page, `inspector-compact-height-${id}`)
          fixture.failOriginalOnce = true
          await viewer.getByRole('button', { name: '下一张', exact: true }).click()
          await viewer.getByText('原图不可用', { exact: true }).waitFor()
          await viewer.getByRole('button', { name: '重试原图', exact: true }).click()
          await viewer.getByRole('button', { name: '100%', exact: true }).click()
          assert.equal(await viewer.locator('img').evaluate((image) => image.naturalWidth), originalWidth)
          await viewer.getByRole('button', { name: '关闭窗口', exact: true }).click()
          await detail.getByRole('button', { name: '关闭窗口', exact: true }).click()
        } catch (error) {
          throw new Error(`${error.message}; image responses=${JSON.stringify(imageResponses)}; image requests=${JSON.stringify(fixture.requests.filter((request) => /assets\//.test(request.path)).slice(-12))}; sources=${JSON.stringify(await page.locator('.nai-gallery img, [role="dialog"] img').evaluateAll((images) => images.map((image) => image.src)))}`)
        } finally {
          page.off('response', observeOriginal)
          fixture.jobs = originalJobs; fixture.failOriginalOnce = false
          await page.setViewportSize({ width: size, height: 940 }); await mount(page)
        }
      })
      if (!smoke && !credentialsOnly) await check(page, `${id}/library-branch-inheritance-negative-preview`, async () => {
        const original = fixture.library, parent = original.find((entry) => entry.kind === 'character')
        fixture.library = [...original, { id: 'preview-browser-branch', kind: 'branch', parent_id: parent.id, name: 'Preview branch', revision: 0, data: { prompt: 'yellow raincoat', negative_prompt: 'raincoat defects', prompt_sets: [] } }]
        try {
          await mount(page); await navigate(page, '资料库')
          await page.getByRole('group', { name: `${parent.name} - Preview branch`, exact: true }).click()
          const editor = page.getByRole('dialog').last(), prompt = editor.getByLabel('合成提示词', { exact: true }), negative = editor.getByLabel('合成负面词', { exact: true })
          assert.ok((await prompt.inputValue()).includes(parent.data.prompt))
          assert.ok(await prompt.getAttribute('readonly') !== null)
          await editor.getByLabel('继承角色本体提示词', { exact: true }).uncheck()
          assert.equal(await prompt.inputValue(), 'yellow raincoat')
          await editor.getByRole('button', { name: '添加词组', exact: true }).click()
          await editor.getByLabel('词组 1 提示词', { exact: true }).fill('blue raincoat')
          await editor.getByLabel('词组 1 负面提示词', { exact: true }).fill('group negative')
          await editor.getByLabel('应用词组', { exact: true }).selectOption('0')
          assert.ok((await prompt.inputValue()).includes('blue raincoat'))
          assert.ok((await negative.inputValue()).includes('group negative'))
          await screenshot(page, `library-composition-preview-${id}`)
          await editor.getByRole('button', { name: '取消', exact: true }).click()
          await editor.waitFor({ state: 'hidden' })
          assert.equal(fixture.library.at(-1).data.replace_identity, undefined)
          assert.deepEqual(fixture.library.at(-1).data.prompt_sets, [])
        } finally { fixture.library = original; await mount(page) }
      })
      if (!smoke && !credentialsOnly && theme === 'light' && size === 1200) {
        await check(page, `${id}/retry-settings-serialize-endpoint-save`, async () => {
          await navigate(page, '设置')
          const delay = page.getByLabel('重试间隔（秒）', { exact: true })
          const attempts = page.getByLabel('最多尝试次数（含首次）', { exact: true })
          let release
          const before = (fixture.settingsWrites ?? []).length
          fixture.settingsGate = new Promise((resolve) => { release = resolve })
          try {
            await delay.fill('5')
            assert.equal((fixture.settingsWrites ?? []).length, before, 'Typing must not save numeric retry controls')
            await page.getByRole('button', { name: '编辑', exact: true }).first().click()
            const retryToken = page.getByLabel('令牌（留空表示不修改）', { exact: true }); await retryToken.fill('uai-retry-serialization'); assert.equal(await retryToken.inputValue(), 'uai-retry-serialization', 'Token field must keep the typed value')
            await page.getByRole('button', { name: '保存接口', exact: true }).click()
            assert.equal((fixture.settingsWrites ?? []).length, before + 1, 'Endpoint save must wait for the earlier blur save')
            release(); fixture.settingsGate = null
            await page.getByRole('status').filter({ hasText: '已保存接口配置' }).waitFor()
            assert.equal(fixture.settings.retry_delay_seconds, 5)
            assert.equal(fixture.savedTokens.at(-1), 'uai-retry-serialization')
            await attempts.fill('4'); await delay.focus()
            await page.getByRole('status').filter({ hasText: '已保存尝试次数' }).waitFor()
            assert.equal(fixture.settings.retry_max_attempts, 4)
          } finally { release(); fixture.settingsGate = null }
        })
        await check(page, `${id}/dialog-tab-escape`, async () => {
          await navigate(page, '草稿'); await page.getByRole('button', { name: '保存命名版本', exact: true }).click()
          const dialog = page.getByRole('dialog', { name: '保存命名版本' }); await dialog.waitFor()
          const buttons = dialog.getByRole('button'); await buttons.last().focus(); await page.keyboard.press('Tab')
          assert.ok(await dialog.evaluate((node) => node.contains(document.activeElement)))
          await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
        })
        await check(page, `${id}/named-version-restore`, async () => {
          await navigate(page, '草稿')
          const original = fixture.draft.request.prompt
          await page.getByRole('button', { name: '保存命名版本', exact: true }).click()
          const dialog = page.getByRole('dialog', { name: '保存命名版本' })
          await dialog.locator('input').fill('Browser regression version')
          await dialog.getByRole('button', { name: '保存', exact: true }).click()
          await dialog.waitFor({ state: 'hidden' })
          await navigate(page, '创作'); await page.locator('#nai-prompt').fill('A later draft edit'); await saved(page)
          await navigate(page, '草稿'); await page.getByRole('button', { name: '恢复此版本', exact: true }).click()
          await page.getByText('已恢复命名版本「Browser regression version」', { exact: true }).waitFor()
          assert.equal(fixture.draft.request.prompt, original)
          await navigate(page, '创作'); assert.equal(await page.locator('#nai-prompt').inputValue(), original)
        })
        await check(page, `${id}/save-failure-retry`, async () => {
          await navigate(page, '创作'); fixture.nextSaveStatus = 503
          await page.locator('#nai-prompt').fill('Locally preserved edit after transient failure')
          await page.locator('.nai-save-state[data-save-status="failed"]').waitFor()
          await page.getByRole('button', { name: '重试保存', exact: true }).click(); await saved(page)
          assert.equal(fixture.draft.request.prompt, 'Locally preserved edit after transient failure')
        })
        await check(page, `${id}/save-conflict-copy`, async () => {
          fixture.nextSaveStatus = 409
          await page.locator('#nai-prompt').fill('Preserve this conflicted edit in a new draft')
          await page.locator('.nai-save-state[data-save-status="failed"]').waitFor()
          await page.getByRole('button', { name: '另存副本', exact: true }).click()
          await page.waitForFunction(() => document.querySelector('h1')?.textContent.includes('未保存副本'))
          assert.equal(fixture.draft.request.prompt, 'Preserve this conflicted edit in a new draft')
        })
        await check(page, `${id}/gallery-bulk-favorite-archive`, async () => {
          await navigate(page, '画廊'); await page.locator('.nai-gallery .cell').first().waitFor()
          await page.getByRole('button', { name: '选择本页', exact: true }).click(); await page.getByRole('button', { name: '收藏所选', exact: true }).click()
          await page.waitForFunction(() => !document.querySelector('.nai-selection-bar'))
          assert.equal(fixture.curations.at(-1).ids.length, 3); assert.equal(fixture.curations.at(-1).favorite, true)
          await page.getByRole('button', { name: '选择本页', exact: true }).click(); await page.getByRole('button', { name: '归档所选', exact: true }).click()
          await page.waitForFunction(() => !document.querySelector('.nai-gallery .cell'))
          assert.equal(fixture.curations.at(-1).archived, true)
        })
        await check(page, `${id}/library-upload-preserves-latest-form`, async () => {
          await navigate(page, '资料库')
          await page.getByRole('group', { name: 'Garden Keeper', exact: true }).click()
          const dialog = page.getByRole('dialog')
          let release
          fixture.uploadGate = new Promise((resolve) => { release = resolve })
          try {
            await dialog.locator('input[type=file]').first().setInputFiles({ name: 'example.png', mimeType: 'image/png', buffer: bitmap })
            await page.waitForFunction(() => Array.from(document.querySelectorAll('[role=dialog] button')).some((button) => button.textContent.trim() === '保存' && button.disabled))
            await dialog.getByLabel('名称', { exact: true }).fill('Edited during example upload')
            release(); fixture.uploadGate = null
            await page.waitForFunction(() => Array.from(document.querySelectorAll('[role=dialog] button')).some((button) => button.textContent.trim() === '保存' && !button.disabled))
            assert.equal(await dialog.getByLabel('名称', { exact: true }).inputValue(), 'Edited during example upload')
            await dialog.getByRole('button', { name: '保存', exact: true }).click()
            await dialog.waitFor({ state: 'hidden' })
            assert.equal(fixture.library[0].name, 'Edited during example upload')
            assert.equal(fixture.library[0].data.examples.length, 2)
          } finally { release(); fixture.uploadGate = null }
        })
        await check(page, `${id}/fixed-plan-inherits-parent-identity`, async () => {
          fixture.library.push({ id: 'branch-browser', parent_id: 'character-1', kind: 'branch', name: 'Garden Branch', revision: 0, data: { prompt: 'yellow raincoat', examples: [] } })
          await navigate(page, '定时任务')
          await page.getByRole('button', { name: '新建计划', exact: true }).click()
          const dialog = page.getByRole('dialog', { name: '新建计划', exact: true })
          await dialog.getByLabel('名称', { exact: true }).fill('Inherited fixed browser plan')
          await dialog.getByLabel('执行模式', { exact: true }).selectOption('fixed')
          await dialog.getByLabel('固定提示词', { exact: true }).fill('clear garden')
          await dialog.getByLabel('分类子目录', { exact: true }).fill('browser-fixed.v1')
          await dialog.getByRole('button', { name: '添加角色', exact: true }).click()
          const picker = page.getByRole('dialog', { name: '从资料库选择角色 / 画风', exact: true })
          await picker.getByRole('combobox').selectOption('')
          await picker.getByRole('button', { name: /Garden Branch/ }).click()
          await picker.waitFor({ state: 'hidden' })
          await dialog.getByRole('button', { name: '保存', exact: true }).click()
          await dialog.waitFor({ state: 'hidden' })
          const plan = fixture.schedules.at(-1)
          assert.equal(plan.enabled, false)
          assert.equal(plan.request.prompt, 'clear garden')
          assert.equal(plan.output_subdir, 'browser-fixed.v1')
          assert.equal(plan.request.characters[0].prompt, 'girl, green hair, gardening apron, yellow raincoat')
          assert.deepEqual(plan.ai_recipe.library_refs, ['branch-browser'])
        })
        await check(page, `${id}/library-save-edited-content-before-apply`, async () => {
          await navigate(page, '资料库')
          await page.locator('.nai-lib-card').first().click()
          const dialog = page.getByRole('dialog')
          await dialog.getByLabel('主提示词', { exact: true }).fill('Edited identity for browser apply')
          await dialog.getByRole('button', { name: '保存并填入草稿', exact: true }).click()
          await dialog.waitFor({ state: 'hidden' })
          await page.locator('#nai-prompt').waitFor()
          assert.equal(fixture.library[0].data.prompt, 'Edited identity for browser apply')
          assert.equal(fixture.draft.request.characters.at(-1).prompt, 'Edited identity for browser apply')
          assert.equal(fixture.draft.library_refs.at(-1).id, fixture.library[0].id)
        })
        await check(page, `${id}/creation-save-to-library-discoverable`, async () => {
          await navigate(page, '创作')
          await page.locator('#nai-prompt').fill('Reusable garden composition')
          await saved(page)
          await page.locator('.nai-workspace-prompt').getByRole('button', { name: '存入资料库', exact: true }).click()
          const dialog = page.getByRole('dialog', { name: '新建资料', exact: true })
          await dialog.waitFor()
          assert.equal(await dialog.getByLabel('主提示词', { exact: true }).inputValue(), 'Reusable garden composition')
          await dialog.getByLabel('名称', { exact: true }).fill('Reusable browser preset')
          await dialog.getByRole('button', { name: '保存', exact: true }).click()
          await dialog.waitFor({ state: 'hidden' })
          assert.equal(fixture.library.at(-1).kind, 'preset')
          assert.equal(fixture.library.at(-1).data.prompt, 'Reusable garden composition')
        })
        await check(page, `${id}/gallery-last-page-shrinks-to-valid-page`, async () => {
          const original = fixture.jobs
          fixture.jobs = Array.from({ length: 49 }, (_, index) => ({ ...clone(original[0]), id: `pagination-${index}`, archived: false }))
          let stage = 'first page'
          try {
            await mount(page); await navigate(page, '画廊')
            await page.waitForFunction(() => document.querySelectorAll('.nai-gallery .cell').length === 48)
            stage = 'second page'
            await page.getByRole('button', { name: '下一页', exact: true }).click()
            await page.waitForFunction(() => document.querySelectorAll('.nai-gallery .cell').length === 1)
            stage = 'archive last item'
            await page.getByRole('button', { name: '选择本页', exact: true }).click()
            await page.getByRole('button', { name: '归档所选', exact: true }).click()
            await page.waitForFunction(() => document.querySelectorAll('.nai-gallery .cell').length === 48)
            assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).count(), 0)
            assert.equal(fixture.jobs.filter((job) => job.archived).length, 1)
          } catch (error) {
            await screenshot(page, `pagination-failure-${id}`)
            throw new Error(`${stage}: ${error.message}; cells=${await page.locator('.nai-gallery .cell').count()}; archived=${fixture.jobs.filter((job) => job.archived).length}; requests=${JSON.stringify(fixture.requests.filter((request) => request.path.includes('/gallery')).slice(-8))}`)
          } finally { fixture.jobs = original; await mount(page) }
        })
        await check(page, `${id}/precise-vibe-reference-switch`, async () => {
          await navigate(page, '创作'); await page.getByRole('button', { name: /上传参考图 \/ Vibe/ }).click()
          await page.getByRole('dialog', { name: '上传参考', exact: true }).locator('input[type=file][accept*="image/png"]').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: bitmap })
          await page.getByRole('dialog').waitFor({ state: 'hidden' }); await saved(page)
          assert.equal(fixture.draft.operation, 'reference_generate'); assert.equal(fixture.draft.request.precise_references.length, 1)
          await page.getByRole('button', { name: /上传参考图 \/ Vibe/ }).click()
          await page.getByRole('dialog', { name: '上传参考', exact: true }).locator('input[type=file][accept*=".vibe"]').setInputFiles({ name: 'reference.vibe', mimeType: 'application/octet-stream', buffer: Buffer.from('offline-vibe-fixture') })
          await page.getByRole('dialog').waitFor({ state: 'hidden' }); await saved(page)
          assert.equal(fixture.draft.request.vibes.length, 1); assert.deepEqual(fixture.draft.request.precise_references, [])
        })
        await check(page, `${id}/mask-canvas-pixels-undo-save`, async () => {
          fixture.draft.operation = 'inpaint'; fixture.draft.request = { ...fixture.draft.request, model: 'nai-diffusion-5-full', image_path: fixture.assets[0].path, vibes: [], precise_references: [] }; fixture.draft.revision++
          await mount(page); await page.getByRole('button', { name: /绘制遮罩/ }).click()
          const canvas = page.getByRole('img', { name: '重绘遮罩', exact: true }); await canvas.waitFor()
          const pixel = () => canvas.evaluate((node) => Array.from(node.getContext('2d').getImageData(node.width / 2, node.height / 2, 1, 1).data))
          assert.deepEqual(await pixel(), [0, 0, 0, 255])
          await canvas.click({ position: { x: width / 2, y: height / 2 } }); assert.deepEqual(await pixel(), [255, 255, 255, 255])
          await page.getByRole('button', { name: '撤销', exact: true }).click(); assert.deepEqual(await pixel(), [0, 0, 0, 255])
          await canvas.click({ position: { x: width / 2, y: height / 2 } }); await screenshot(page, 'mask-light-1200')
          await page.getByRole('button', { name: '保存遮罩', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' }); await saved(page)
          assert.ok(fixture.draft.request.mask_path?.endsWith('.png'))
        })
      }
      if (!smoke && !credentialsOnly && theme === 'dark' && size === 1200) await check(page, `${id}/delete-last-default-draft`, async () => {
        await navigate(page, '草稿')
        await page.getByRole('button', { name: '删除草稿', exact: true }).click()
        await page.waitForFunction(() => document.querySelector('.nai-list .item.selected strong')?.textContent === '未命名作品')
        assert.equal(fixture.drafts.length, 1)
        assert.equal(fixture.draft.id, 'fresh-after-delete')
        await navigate(page, '创作')
        assert.equal(await page.locator('#nai-prompt').inputValue(), '')
      })
      if (!smoke && !credentialsOnly) await check(page, `${id}/schedule-directory-ai-mode-and-clear`, async () => {
        await navigate(page, '定时任务')
        await page.getByRole('button', { name: '新建计划', exact: true }).click()
        const editor = page.getByRole('dialog', { name: '新建计划', exact: true })
        const directory = editor.getByLabel('分类子目录', { exact: true })
        await directory.fill('browser-ai.v1')
        await editor.getByLabel('执行模式', { exact: true }).selectOption('fixed')
        assert.equal(await directory.inputValue(), 'browser-ai.v1')
        await editor.getByLabel('执行模式', { exact: true }).selectOption('ai')
        assert.equal(await directory.inputValue(), 'browser-ai.v1')
        await directory.fill('')
        await editor.getByLabel('创作要求（每次唤醒 AI 重新编写）', { exact: true }).fill('A male character portrait')
        await editor.getByRole('button', { name: '保存', exact: true }).click()
        await editor.waitFor({ state: 'hidden' })
        const plan = fixture.schedules.at(-1)
        assert.equal(plan.output_subdir, null)
        assert.equal(plan.execution_mode, 'ai')
        assert.equal(plan.enabled, false)
      })
      if (!smoke && !credentialsOnly) await check(page, `${id}/medium-model-transition-and-directory`, async () => {
        await navigate(page, '创作')
        for (const operation of ['图生图', '扩图 (Outpaint)', 'Enhance 增强', '专用放大', '导演工具', '局部重绘', '参考图生成', 'Vibe 编码', '文生图']) {
          await page.getByRole('button', { name: operation, exact: true }).click()
          await page.getByLabel('本任务分类目录（可选）', { exact: true }).waitFor()
        }
        await page.getByLabel('模型', { exact: true }).selectOption('nai-diffusion-5-full')
        await page.getByLabel('V5 档位', { exact: true }).selectOption('medium')
        assert.equal(await page.getByLabel('步数', { exact: true }).inputValue(), '14')
        assert.equal(await page.getByLabel('步数', { exact: true }).isDisabled(), true)
        assert.equal(await page.locator('#nai-negative-prompt').isDisabled(), true)
        await page.getByLabel('模型', { exact: true }).selectOption('nai-diffusion-4-5-full')
        assert.equal(await page.getByLabel('V5 档位', { exact: true }).count(), 0)
        await saved(page)
        assert.equal(fixture.draft.request.v5_tier, 'high')
        await page.getByLabel('模型', { exact: true }).selectOption('nai-diffusion-5-full')
        await saved(page)
        await navigate(page, '设置')
        assert.equal(await page.getByLabel('默认分类子目录（可选）', { exact: true }).count(), 0)
      })
      if (!smoke && !credentialsOnly) await check(page, `${id}/inspiration-pages-details-and-import`, async () => {
        await navigate(page, '灵感')
        const panel = page.locator('.nai-inspiration')
        await panel.getByText('pixiv artwork page 1', { exact: true }).waitFor()
        await panel.getByRole('alert').filter({ hasText: 'DANBOORU' }).waitFor()
        await page.waitForFunction(() => document.querySelector('.nai-inspiration img')?.naturalWidth > 0)
        await panel.getByTitle('下一页', { exact: true }).click()
        await panel.getByText('pixiv artwork page 2', { exact: true }).waitFor()
        await panel.getByTitle('上一页', { exact: true }).click()
        await panel.getByText('aitag artwork page 1', { exact: true }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByText('original recipe, forest', { exact: true }).waitFor()
        await dialog.getByRole('button', { name: '导入生图工作台', exact: true }).click()
        await page.locator('#nai-prompt').waitFor()
        assert.equal(await page.locator('#nai-prompt').inputValue(), 'original recipe, forest')
        assert.equal(fixture.draft.request.characters[0].prompt, 'traveler, cape')
        assert.equal(Object.hasOwn(fixture.draft.request.characters[0], 'x'), false)
        await navigate(page, '灵感')
        await panel.getByText('pixiv artwork page 1', { exact: true }).click()
        const reference = page.getByRole('dialog')
        await reference.getByText('Pixiv 原生标签（非 Danbooru）', { exact: true }).waitFor()
        assert.equal(await reference.getByRole('button', { name: '导入生图工作台', exact: true }).count(), 0)
        assert.equal(await reference.getByRole('button', { name: '保存到资料库预设', exact: true }).count(), 0)
        assert.equal(await reference.getByRole('button', { name: '复制原生标签', exact: true }).isEnabled(), true)
        await page.keyboard.press('Escape')
        await reference.waitFor({ state: 'hidden' })
        await panel.getByLabel('搜索素材与灵感', { exact: true }).fill('forest')
        await Promise.all([
          page.waitForResponse((response) => response.url().includes('/inspiration/search?') && response.url().includes('q=forest')),
          panel.getByRole('button', { name: '搜索', exact: true }).click(),
        ])
        await panel.getByText('pixiv artwork page 1', { exact: true }).waitFor()
        try {
          await Promise.all([
            page.waitForResponse((response) => response.url().includes('/inspiration/search?') && response.url().includes('pixivAi=exclude')),
            panel.getByRole('combobox', { name: 'Pixiv', exact: true }).selectOption('exclude'),
          ])
        } catch (error) {
          throw new Error(`${error.message}; selected=${await panel.getByRole('combobox', { name: 'Pixiv', exact: true }).inputValue()}; requests=${JSON.stringify(fixture.requests.filter((request) => request.path.includes('/inspiration/search')).slice(-5))}`)
        }
        assert.ok(fixture.requests.some((request) => request.path.includes('pixivAi=exclude')))
        await panel.getByText('pixiv artwork page 1', { exact: true }).waitFor()
        const cards = await panel.locator('.nai-lib-card').evaluateAll((nodes) => nodes.map((node) => {
          const rect = node.getBoundingClientRect(), media = node.querySelector('.nai-image').getBoundingClientRect(), img = node.querySelector('img').getBoundingClientRect()
          return { width: rect.width, mediaWidth: media.width, mediaHeight: media.height, imageWidth: img.width, imageHeight: img.height }
        }))
        assert.ok(cards.length > 0 && cards.every((card) => card.width <= 321 && card.mediaHeight > 80 && card.imageWidth <= card.mediaWidth + 1 && card.imageHeight <= card.mediaHeight + 1), `Unstable artwork layout: ${JSON.stringify(cards)}`)
        await page.locator('main').evaluate((node) => { node.scrollTop = 0 })
        await screenshot(page, `inspiration-${id}`)
        await navigate(page, '创作')
      })
      await check(page, `${id}/no-runtime-or-network-errors`, async () => { assert.deepEqual(errors, []); assert.ok(fixture.requests.length > 0); return { requests: fixture.requests.length, errors, warnings, expected_http_failures: fixture.expectedHttpFailures } })
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  report.finished_at = new Date().toISOString()
  report.passed = report.checks.filter((check) => check.passed).length
  report.failed = report.checks.filter((check) => !check.passed).length
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, report: join(output, 'report.json'), screenshots: report.screenshots }, null, 2))
}
if (report.failed) process.exitCode = 1
