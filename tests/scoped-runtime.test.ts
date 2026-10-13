import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as host from '../src/index.ts'
import * as agentEntry from '../src/agent.ts'
import { Workbench } from '../src/workbench/app.ts'

const folders: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const config = { token: '', outputDirectory: '', proxyUrl: '', apiPrefix: '/api/nai', startWorker: false }

function prepareDirectory(): void {
  const folder = mkdtempSync(join(tmpdir(), 'nai-scoped-'))
  folders.push(folder)
  vi.stubEnv('NOVELAI_WORKBENCH_DIR', folder)
}

function mockSkills(ctx: Context) {
  const active = new Set<object>()
  const register = vi.fn((value: object) => {
    active.add(value)
    return () => { active.delete(value) }
  })
  ctx.provide('skills', { register })
  return { active, register }
}

describe('NAI preset capability isolation', () => {
  it('keeps one host runtime while sibling presets are hidden and descendants inherit tools', async () => {
    prepareDirectory()
    const ctx = new Context()
    ctx.provide('systemPrompt', { tools: () => () => {} })
    const skills = mockSkills(ctx)
    const routeDispose = vi.fn(), tapDispose = vi.fn()
    const web = { register: vi.fn(() => routeDispose), tapIndex: vi.fn(() => tapDispose) }
    ctx.provide('webServer', web)
    ctx.provide('connection', { requestRejection: () => undefined })
    const start = vi.spyOn(Workbench.prototype, 'start').mockImplementation(() => {})
    const stop = vi.spyOn(Workbench.prototype, 'stop').mockImplementation(() => {})
    try {
      await ctx.plugin(ToolRuntime, {})
      await ctx.plugin(host, { ...config, startWorker: true, toolExposure: 'scoped' })
      await vi.waitFor(() => expect(ctx.get('naiAtelier')).toBeDefined())
      const wb = ctx.naiAtelier.workbench
      expect(ctx.tools.schemas()).toHaveLength(0)
      expect(skills.register).not.toHaveBeenCalled()
      const naiKey = {}, normalKey = { id: 'normal' }, childKey = {}
      const nai = createScope(ctx, naiKey)
      const normal = createScope(ctx, normalKey)
      const child = createScope(ctx, childKey, { parent: naiKey })
      await nai.ctx.plugin(agentEntry)
      await vi.waitFor(() => expect(ctx.tools.schemas(naiKey)).toHaveLength(15))
      expect(ctx.tools.schemas(normalKey)).toHaveLength(0)
      expect(ctx.tools.schemas(childKey)).toHaveLength(15)
      expect(new Set(ctx.tools.schemas(naiKey).map((tool) => tool.name)).size).toBe(15)
      expect(skills.register).toHaveBeenCalledOnce()
      expect(skills.active.size).toBe(1)
      expect(nai.ctx.get('naiAtelier')?.workbench).toBe(wb)
      expect(start).toHaveBeenCalledOnce()
      expect(web.register).toHaveBeenCalledOnce()
      const hidden = await ctx.tools.execute({ callId: 'hidden-call' as never, name: 'nai_draft', arguments: {}, agent: normalKey as never, signal: new AbortController().signal })
      expect(hidden.isError).toBe(true)
      expect(hidden.error?.info?.code).toBe('UNKNOWN_TOOL')
      const tool = ctx.tools.get('nai_draft', naiKey)!
      const value = await tool.execute({ action: 'read' }, { signal: new AbortController().signal } as never) as Record<string, unknown>
      expect(value['id']).toBe(wb.store.getDraft()['id'])
      await child.dispose()
      await nai.dispose()
      expect(ctx.tools.schemas(naiKey)).toHaveLength(0)
      expect(skills.active.size).toBe(0)
      expect(stop).not.toHaveBeenCalled()
      expect(routeDispose).not.toHaveBeenCalled()
      expect(ctx.naiAtelier.workbench).toBe(wb)
      await normal.dispose()
    } finally { await ctx.fiber.dispose() }
    expect(stop).toHaveBeenCalledOnce()
    expect(routeDispose).toHaveBeenCalledOnce()
    expect(tapDispose).toHaveBeenCalledOnce()
  })

  it('keeps omitted toolExposure globally compatible and the agent entry does not duplicate it', async () => {
    prepareDirectory()
    const ctx = new Context()
    ctx.provide('systemPrompt', { tools: () => () => {} })
    const skills = mockSkills(ctx)
    try {
      await ctx.plugin(ToolRuntime, {})
      await ctx.plugin(host, config)
      await vi.waitFor(() => expect(ctx.tools.schemas()).toHaveLength(15))
      const key = {}
      const scope = createScope(ctx, key)
      await scope.ctx.plugin(agentEntry)
      expect(ctx.tools.schemas(key)).toHaveLength(15)
      expect(skills.register).toHaveBeenCalledOnce()
      await scope.dispose()
      expect(ctx.tools.schemas()).toHaveLength(15)
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects both entries in the wrong plane before registering capabilities or creating state', () => {
    const ctx = new Context()
    expect(() => agentEntry.apply(ctx)).toThrow('inside an agent preset')
    const scope = createScope(ctx, {})
    expect(() => host.apply(scope.ctx, config)).toThrow('mounted on the host')
    expect(ctx.get('naiAtelier')).toBeUndefined()
  })
})
