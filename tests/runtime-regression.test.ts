import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, validateApiPrefix } from '../src/index.ts'
import { Workbench } from '../src/workbench/app.ts'

const folders: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

describe('DSH runtime integration', () => {
  it('registers tools, authenticated routes and disposable skills on the current SDK', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nai-runtime-')); folders.push(root)
    vi.stubEnv('NOVELAI_WORKBENCH_DIR', root)
    const tools: any[] = []
    const disposers: Array<() => void> = []
    const skillsDispose = vi.fn()
    let route: any
    let tap: any
    const services: Record<string, any> = {
      tools: { register: (tool: any) => { tools.push(tool); return vi.fn() } },
      skills: { register: () => skillsDispose },
      connection: { requestRejection: vi.fn(() => 403) },
      webServer: { register: (value: any) => { route = value; return vi.fn() }, tapIndex: (value: any) => { tap = value; return vi.fn() } },
    }
    const ctx: any = { provide: (key: string, value: unknown) => { services[key] = value; return vi.fn() }, tools: services.tools, get: (key: string) => services[key], logger: () => ({ warn: vi.fn(), info: vi.fn() }), effect: (fn: () => () => void) => { disposers.push(fn()); return vi.fn() } }
    ctx.inject = (deps: string[], callback: (context: any) => unknown) => { if (deps.every((key) => services[key])) callback(ctx) }
    apply(ctx, { token: '', outputDirectory: '', proxyUrl: 'http://127.0.0.1:8888', apiPrefix: '/custom/nai/', startWorker: false })
    expect(tools.length).toBe(16)
    expect(route.path).toBe('/custom/nai')
    expect(tap('<head></head>')).toContain('window.__NAI_ATELIER_API_PREFIX__="/custom/nai"')
    expect(new Workbench(root).settings.raw()['proxy_url']).toBe('http://127.0.0.1:8888')
    const tool = tools.find((t) => t.name === 'nai_generate_image')
    expect(tool.output.presentationMeta({}, { artifact_paths: ['output.png'] })).toEqual({ image_paths: ['output.png'], locations: [{ path: 'output.png' }] })
    expect(tool.output.render({}, { artifact_paths: ['output.png'] })[0].text).not.toContain('dsh_im_return_file')
    const res: any = { writeHead: vi.fn(), end: vi.fn() }
    await route.handler({ url: '/custom/nai/api/bootstrap', headers: {}, method: 'GET' }, res)
    expect(res.writeHead.mock.calls[0][0]).toBe(403)
    disposers.reverse().forEach((dispose) => dispose())
    expect(skillsDispose).toHaveBeenCalledOnce()
  })

  it('mounts late web services and remounts them after replacement without toggling the plugin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nai-cold-start-')); folders.push(root)
    vi.stubEnv('NOVELAI_WORKBENCH_DIR', root)
    const ctx = new Context()
    ctx.provide('tools', { register: () => () => {} })
    const routeDispose = vi.fn(), tapDispose = vi.fn()
    const web = { register: vi.fn(() => routeDispose), tapIndex: vi.fn(() => tapDispose) }
    try {
      await ctx.plugin({ apply, inject: ['tools'] }, { token: '', outputDirectory: '', proxyUrl: '', apiPrefix: '/api/nai', startWorker: false })
      expect(web.register).not.toHaveBeenCalled()
      const dropWeb = ctx.provide('webServer', web)
      expect(web.register).not.toHaveBeenCalled()
      ctx.provide('connection', { requestRejection: () => undefined })
      await vi.waitFor(() => expect(web.register).toHaveBeenCalledTimes(1))
      await dropWeb()
      await vi.waitFor(() => expect(routeDispose).toHaveBeenCalledTimes(1))
      expect(tapDispose).toHaveBeenCalledTimes(1)
      ctx.provide('webServer', web)
      await vi.waitFor(() => expect(web.register).toHaveBeenCalledTimes(2))
    } finally { await ctx.fiber.dispose() }
    expect(routeDispose).toHaveBeenCalledTimes(2)
  })

  it('attaches and detaches DSH native schedule service dynamically', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nai-late-schedule-')); folders.push(root)
    vi.stubEnv('NOVELAI_WORKBENCH_DIR', root)
    const ctx = new Context()
    ctx.provide('tools', { register: () => () => {} })
    const attached = vi.spyOn(Workbench.prototype, 'setDshSchedule')
    try {
      await ctx.plugin({ apply, inject: ['tools'] }, { token: '', outputDirectory: '', proxyUrl: '', apiPrefix: '/api/nai', startWorker: false })
      const fakeSchedule = { create: vi.fn(), list: vi.fn(), edit: vi.fn(), view: vi.fn(), history: vi.fn(), run: vi.fn() }
      const dropSchedule = ctx.provide('schedule', fakeSchedule)
      await vi.waitFor(() => expect(attached).toHaveBeenLastCalledWith(fakeSchedule))
      await dropSchedule()
      await vi.waitFor(() => expect(attached).toHaveBeenLastCalledWith(null))
    } finally { await ctx.fiber.dispose(); attached.mockRestore() }
  })

  it('rejects unsafe or conflicting API prefixes', () => {
    for (const prefix of ['/', '/api', 'https://remote/api', '/api/../x', '/api/<script>', '/api/x?y']) expect(() => validateApiPrefix(prefix)).toThrow()
    expect(validateApiPrefix('/api/nai///')).toBe('/api/nai')
  })
})
