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
  return { draft, drafts: [draft], assets, jobs, library: [{ id: 'character-1', kind: 'character', name: 'Garden Keeper', revision: 0, data: { prompt: 'girl, green hair, gardening apron', examples: [assets[0].id] } }], schedules: [{ id: 'schedule-1', name: 'Daily garden study', kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai', enabled: false, execution_mode: 'fixed', operation: 'generate', request: clone(request), count: 1, max_runs: 10, runs: 2, spent: 0, reserved: 0, remaining_anlas: 0, max_total_anlas: 0, revision: 0 }], settings: { token_configured: true, token_source: 'verification fixture', nai_base_url: 'https://image.novelai.net', proxy_url: '', output_directory: 'C:/verification/outputs', creative_preferences: '', onboarding_complete: true, ai: { dsh_provider: '', dsh_model: '', max_output_tokens: 4096 }, ai_profiles: [] }, nextSaveStatus: 0, expectedHttpFailures: [], requests: [], curations: [], uploads: [] }
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
    if (path.startsWith('/files/') || /^\/assets\/[^/]+\/(file|thumb)$/.test(path)) return route.fulfill({ contentType: 'image/png', body: bitmap })
    if (path === '/bootstrap') return json({ version: pkg.version, draft: fixture.draft, settings: fixture.settings, jobs: fixture.jobs, library: fixture.library, schedules: fixture.schedules, paused: false, summary: { active_jobs: 0, library_count: fixture.library.length, schedule_count: fixture.schedules.length } })
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
    if (path === '/library') return json(fixture.library)
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
        fixture.settings.token_configured = true; fixture.settings.token_source = '工作台加密保存'
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
    const ctx = { effect(fn) { disposers.push(fn()) }, sidebarRightTabs: { register(definition) { registration = definition; return () => {} } }, slots: { inject(_name, register) { return register() }, register(_spec, value) { component = value; return () => {} } } }
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
    const id = `${theme}-${size}`, { page, context, fixture, errors, warnings } = await fixturePage({ width: size, height: 940 }, theme)
    try {
      report.viewports.push({ id, width: size, height: 940, theme })
      await check(page, `${id}/real-react-mount`, async () => { assert.equal(await page.locator('.nai-nav button').count(), 6); assert.equal(await page.locator('.nai-root').count(), 1); report.react_version = await page.evaluate(() => window.__verificationReact.React.version) })
      if (!smoke) await check(page, `${id}/first-token-save-retry-replace-remount`, async () => {
        fixture.settings.token_configured = false; fixture.settings.token_source = '未配置'
        await mount(page); await navigate(page, '设置')
        const input = page.getByLabel('NovelAI 令牌（pst-…，保存后仅显示状态）', { exact: true })
        const saveToken = page.getByRole('button', { name: '保存令牌', exact: true })
        await saveToken.click()
        await page.getByRole('alert').filter({ hasText: '请先输入 NovelAI 令牌' }).waitFor()
        assert.equal((fixture.savedTokens ?? []).length, 0)
        await input.fill('  pst-browser-first-install  ')
        fixture.nextSettingsStatus = 503
        await saveToken.click()
        await page.getByRole('alert').filter({ hasText: 'Credential persistence temporarily unavailable' }).waitFor()
        assert.equal(await input.inputValue(), '  pst-browser-first-install  ')
        assert.equal(fixture.settings.token_configured, false)
        await saveToken.click()
        await page.getByRole('status').filter({ hasText: '令牌已加密保存' }).waitFor()
        assert.equal(await input.inputValue(), '')
        assert.equal(fixture.savedTokens.at(-1), 'pst-browser-first-install')
        assert.equal(fixture.settings.token_configured, true)
        await input.fill('pst-browser-replacement')
        await saveToken.click()
        await page.waitForFunction(() => document.querySelector('input[type=password]')?.value === '')
        assert.deepEqual(fixture.savedTokens, ['pst-browser-first-install', 'pst-browser-replacement'])
        await navigate(page, '创作'); await navigate(page, '设置')
        assert.equal(await input.inputValue(), '')
        await mount(page); await navigate(page, '设置')
        assert.equal(await input.inputValue(), '')
        assert.equal(await input.getAttribute('placeholder'), '已配置，输入可替换')
        assert.equal(await page.locator('body').textContent().then((text) => text.includes('pst-browser-')), false)
        await screenshot(page, `settings-credentials-${id}`)
      })
      for (const label of (credentialsOnly ? ['设置'] : smoke ? ['创作'] : ['创作', '画廊', '资料库', '草稿', '定时任务', '设置'])) await check(page, `${id}/page/${label}`, async () => {
        if (!smoke) await navigate(page, label)
        if (label === '画廊') { await page.locator('.nai-gallery .cell').first().waitFor(); await page.waitForFunction(() => document.querySelector('.nai-gallery img')?.naturalWidth > 0) }
        const geometry = await page.evaluate(() => { const main = document.querySelector('main'), root = document.querySelector('.nai-root'); return { bodyOverflow: document.documentElement.scrollWidth - innerWidth, mainOverflow: main.scrollWidth - main.clientWidth, rootWidth: root.getBoundingClientRect().width } })
        assert.ok(geometry.bodyOverflow <= 1 && geometry.mainOverflow <= 1, `Horizontal content overflow: ${JSON.stringify(geometry)}`)
        if (label === '创作') await screenshot(page, `workspace-${id}`)
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
        if (label === '画廊' && theme === 'dark' && size === 1200) await screenshot(page, 'gallery-dark-1200')
        return geometry
      })
      if (!smoke && !credentialsOnly && theme === 'light' && size === 1200) {
        await check(page, `${id}/retry-settings-serialize-token-click`, async () => {
          await navigate(page, '设置')
          const delay = page.getByLabel('重试间隔（秒）', { exact: true })
          const attempts = page.getByLabel('最多尝试次数（含首次）', { exact: true })
          const token = page.getByLabel('NovelAI 令牌（pst-…，保存后仅显示状态）', { exact: true })
          let release
          const before = (fixture.settingsWrites ?? []).length
          fixture.settingsGate = new Promise((resolve) => { release = resolve })
          try {
            await delay.fill('5')
            assert.equal((fixture.settingsWrites ?? []).length, before, 'Typing must not save numeric retry controls')
            await token.fill('pst-retry-serialization')
            await page.getByRole('button', { name: '保存令牌', exact: true }).click()
            assert.equal((fixture.settingsWrites ?? []).length, before + 1, 'Token save must wait for the earlier blur save')
            release(); fixture.settingsGate = null
            await page.waitForFunction(() => document.querySelector('input[type=password]')?.value === '')
            assert.equal(fixture.settings.retry_delay_seconds, 5)
            assert.equal(fixture.savedTokens.at(-1), 'pst-retry-serialization')
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
