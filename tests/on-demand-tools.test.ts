import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { Workbench } from '../src/workbench/app.ts'
import { registerTools } from '../src/tools.ts'
import { ACTIVATION_KEY, BOOTSTRAP_TOOL, registerOnDemandTools } from '../src/bootstrap.ts'

const require = createRequire(import.meta.url)
const runtimeRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const { default: SystemPrompt } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture(root?: string, restoreIds: string[] = []) {
  root ??= mkdtempSync(join(tmpdir(), 'nai-demand-'))
  if (!roots.includes(root)) roots.push(root)
  const wb = new Workbench(root)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  const live = new Map<string, any>()
  const skills = new Set<object>()
  const registerSkill = vi.fn((value: object) => { skills.add(value); return () => { skills.delete(value) } })
  ctx.provide('skills', { register: registerSkill })
  ctx.provide('agents', { get: (id: string) => live.get(id), list: () => [...live.values()] })
  const actor = (id: string, parent?: object) => {
    const agent: any = { id, ctx: null }
    const scope = createScope(ctx, agent, parent ? { parent } : undefined)
    agent.ctx = scope.ctx
    live.set(id, agent)
    return { agent, scope }
  }
  const restored = restoreIds.map(id => actor(id))
  const plugin = { name: 'nai-demand-test', inject: ['tools', 'agents'], async apply(bootCtx: Context) { await registerOnDemandTools(bootCtx, wb) } }
  const boot = ctx.plugin(plugin)
  await boot
  let sequence = 0
  const run = (agent: any, enabled?: boolean) => ctx.tools.execute({ callId: `demand-${++sequence}` as never, name: BOOTSTRAP_TOOL, arguments: enabled === undefined ? {} : { enabled }, agent, signal: new AbortController().signal })
  const assemble = (agent: any) => ctx.systemPrompt.assemble({ scope: agent })
  const created = (agent: any, source: string) => ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source } as never)
  return { root, wb, ctx, live, skills, registerSkill, actor, restored, boot, run, assemble, created, async dispose() { wb.stop(); await ctx.fiber.dispose() } }
}

describe('on-demand NAI capabilities', () => {
  it('keeps only one small entry, refreshes the next native assembly, and does not touch drafts or submit images', async () => {
    const f = await fixture()
    try {
      const first = f.actor('first'), second = f.actor('second')
      const draftBefore = JSON.stringify(f.wb.store.data.drafts)
      const generate = vi.spyOn(f.wb.executor, 'execute')
      const changes = vi.fn(); f.ctx.on('tools/change', changes)
      const initial = await f.assemble(first.agent)
      expect(initial.tools.map((tool: any) => tool.name)).toEqual([BOOTSTRAP_TOOL])
      const schema = JSON.stringify(initial.tools)
      expect(Math.ceil(schema.length / 4) + 4).toBeLessThan(300)
      const enabled = await f.run(first.agent)
      expect(enabled).toMatchObject({ isError: false, value: { enabled: true, changed: true, tool_count: 15, source: 'session' } })
      expect((await f.assemble(first.agent)).tools).toHaveLength(16)
      expect((await f.assemble(second.agent)).tools.map((tool: any) => tool.name)).toEqual([BOOTSTRAP_TOOL])
      expect(f.ctx.tools.schemas()).toHaveLength(1)
      expect(changes).toHaveBeenCalled()
      expect(f.skills.size).toBe(1)
      expect(await f.run(first.agent)).toMatchObject({ isError: false, value: { changed: false, tool_count: 15 } })
      expect(f.skills.size).toBe(1)
      expect(JSON.parse(f.wb.store.data.kv[ACTIVATION_KEY]!)).toEqual({ version: 1, sessions: ['first'] })
      expect(await f.run(first.agent, false)).toMatchObject({ isError: false, value: { enabled: false, changed: true } })
      expect((await f.assemble(first.agent)).tools).toHaveLength(1)
      expect(f.skills.size).toBe(0)
      expect(JSON.parse(f.wb.store.data.kv[ACTIVATION_KEY]!)).toEqual({ version: 1, sessions: [] })
      expect(JSON.stringify(f.wb.store.data.drafts)).toBe(draftBefore)
      expect(generate).not.toHaveBeenCalled()
      expect(f.wb.store.data.jobs).toHaveLength(0)
    } finally { await f.dispose() }
  })

  it('rejects missing, forged, disposed, or wrong-scope callers before persistence', async () => {
    const f = await fixture()
    try {
      const first = f.actor('first')
      for (const agent of [undefined, { ...first.agent }, { id: 'first', ctx: f.ctx }]) expect(await f.run(agent)).toMatchObject({ isError: true })
      f.live.delete('first')
      expect(await f.run(first.agent)).toMatchObject({ isError: true })
      expect(f.wb.store.data.kv[ACTIVATION_KEY]).toBeUndefined()
      expect(f.ctx.tools.schemas(first.agent)).toHaveLength(1)
    } finally { await f.dispose() }
  })

  it('rolls back activation effects and metadata if writing the marker fails', async () => {
    const f = await fixture()
    try {
      const first = f.actor('first')
      vi.spyOn(f.wb.store, 'internalPersist').mockImplementationOnce(() => { throw new Error('disk full') })
      expect(await f.run(first.agent)).toMatchObject({ isError: true })
      expect(f.ctx.tools.schemas(first.agent)).toHaveLength(1)
      expect(f.skills.size).toBe(0)
      expect(f.wb.store.data.kv[ACTIVATION_KEY]).toBeUndefined()
      expect(await f.run(first.agent)).toMatchObject({ isError: false, value: { enabled: true } })
    } finally { await f.dispose() }
  })

  it('retains active tools and the old marker if disabling cannot be persisted', async () => {
    const f = await fixture()
    try {
      const first = f.actor('first')
      await f.run(first.agent)
      const marker = f.wb.store.data.kv[ACTIVATION_KEY]
      vi.spyOn(f.wb.store, 'internalPersist').mockImplementationOnce(() => { throw new Error('disk full') })
      expect(await f.run(first.agent, false)).toMatchObject({ isError: true })
      expect(f.ctx.tools.schemas(first.agent)).toHaveLength(16)
      expect(f.skills.size).toBe(1)
      expect(f.wb.store.data.kv[ACTIVATION_KEY]).toBe(marker)
    } finally { await f.dispose() }
  })

  it('restores the same session from disk, keeps a new fork off, and clears same-ID activation on clear', async () => {
    const first = await fixture()
    const root = first.root
    await first.run(first.actor('persistent').agent)
    await first.dispose()
    const second = await fixture(root, ['persistent'])
    try {
      const restored = second.restored[0]!.agent
      expect(second.ctx.tools.schemas(restored)).toHaveLength(16)
      const fork = second.actor('new-fork')
      await second.created(fork.agent, 'resume')
      expect(second.ctx.tools.schemas(fork.agent)).toHaveLength(1)
      const late = second.actor('later')
      second.wb.store.data.kv[ACTIVATION_KEY] = JSON.stringify({ version: 1, sessions: ['persistent', 'later'] })
      second.wb.store.internalPersist()
      await second.created(late.agent, 'resume')
      expect(second.ctx.tools.schemas(late.agent)).toHaveLength(16)
      await second.created(late.agent, 'clear')
      expect(second.ctx.tools.schemas(late.agent)).toHaveLength(1)
      expect(JSON.parse(second.wb.store.data.kv[ACTIVATION_KEY]!)).toEqual({ version: 1, sessions: ['persistent'] })
    } finally { await second.dispose() }
  })

  it('does not duplicate or remove dedicated preset capabilities', async () => {
    const f = await fixture()
    try {
      const key = {}, preset = createScope(f.ctx, key)
      await preset.ctx.plugin({ name: 'dedicated-nai-test', inject: ['tools'], apply(presetCtx: Context) { registerTools(presetCtx, f.wb) } })
      const dedicated = f.actor('dedicated', key)
      expect(await f.run(dedicated.agent)).toMatchObject({ isError: false, value: { source: 'preset', changed: false, tool_count: 15 } })
      expect(await f.run(dedicated.agent, false)).toMatchObject({ isError: false, value: { source: 'preset', enabled: true, changed: false } })
      expect(f.ctx.tools.schemas(dedicated.agent)).toHaveLength(16)
      expect(f.wb.store.data.kv[ACTIVATION_KEY]).toBeUndefined()
    } finally { await f.dispose() }
  })

  it('refreshes the PTC SDK without changing its presentation mode', async () => {
    const f = await fixture()
    try {
      const first = f.actor('ptc')
      f.ctx.provide('ptcRuntime', { language: 'typescript' })
      const presentation = first.scope.ctx.get('tools')
      if (!presentation) throw new Error('Missing tools service')
      presentation.presentAs('ptc')
      const before = await f.assemble(first.agent)
      expect(before.tools.map((tool: any) => tool.name)).toEqual(['run_code'])
      expect(before.sections.find((section: any) => section.name === 'tools:sdk')!.text).not.toContain('nai_generate_image')
      // The PTC transport supplies this same explicit actor to its nested binding.
      const definition = f.ctx.tools.get(BOOTSTRAP_TOOL, first.agent)!
      await definition.execute({}, { agent: first.agent, signal: new AbortController().signal } as never)
      const after = await f.assemble(first.agent)
      expect(after.tools.map((tool: any) => tool.name)).toEqual(['run_code'])
      expect(after.sections.find((section: any) => section.name === 'tools:sdk')!.text).toContain('nai_generate_image')
      await definition.execute({ enabled: false }, { agent: first.agent, signal: new AbortController().signal } as never)
      expect((await f.assemble(first.agent)).sections.find((section: any) => section.name === 'tools:sdk')!.text).not.toContain('nai_generate_image')
    } finally { await f.dispose() }
  })

  it('repeatedly toggles capabilities without accumulating skills or effect closures', async () => {
    const f = await fixture()
    try {
      const first = f.actor('first')
      const before = first.scope.ctx.fiber.getEffects().length
      for (let i = 0; i < 20; i++) {
        expect(await f.run(first.agent)).toMatchObject({ isError: false, value: { enabled: true } })
        expect(f.skills.size).toBe(1)
        expect(await f.run(first.agent, false)).toMatchObject({ isError: false, value: { enabled: false } })
        expect(f.skills.size).toBe(0)
        expect(f.ctx.tools.schemas(first.agent)).toHaveLength(1)
      }
      expect(first.scope.ctx.fiber.getEffects().length).toBe(before)
    } finally { await f.dispose() }
  })

  it('fails closed on malformed markers without blocking ordinary resume or clear', async () => {
    const f = await fixture()
    try {
      const first = f.actor('first')
      await f.run(first.agent)
      f.wb.store.data.kv[ACTIVATION_KEY] = 'invalid-json'
      await expect(f.created(first.agent, 'clear')).resolves.toBeUndefined()
      expect(f.ctx.tools.schemas(first.agent)).toHaveLength(1)
      await expect(f.created(first.agent, 'resume')).resolves.toBeUndefined()
      expect(f.ctx.tools.schemas(first.agent)).toHaveLength(1)
      expect(await f.run(first.agent)).toMatchObject({ isError: true })
      expect(f.wb.store.data.kv[ACTIVATION_KEY]).toBe('invalid-json')
    } finally { await f.dispose() }
  })

  it('unwinds only owned session tools on host plugin unload while retaining restart markers', async () => {
    const f = await fixture()
    try {
      const first = f.actor('first'), other = f.actor('other')
      await f.run(first.agent)
      await f.boot.dispose()
      expect(f.ctx.tools.schemas(first.agent)).toHaveLength(0)
      expect(f.ctx.tools.schemas(other.agent)).toHaveLength(0)
      expect(f.skills.size).toBe(0)
      expect(JSON.parse(f.wb.store.data.kv[ACTIVATION_KEY]!)).toEqual({ version: 1, sessions: ['first'] })
    } finally { await f.dispose() }
  })
})
