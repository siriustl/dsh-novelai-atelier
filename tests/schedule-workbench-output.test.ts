import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workbench } from '../src/workbench/app.ts'
import { Assistant } from '../src/workbench/assistant.ts'
import { composeSchedule } from '../src/workbench/planSchedule.ts'
import { creativeDraft } from '../src/workbench/schedulePlanner.ts'
import { registerTools } from '../src/tools.ts'
import type { Rec } from '../src/workbench/store.ts'

const workbenches: Workbench[] = []
function fixture() {
  const wb = new Workbench(mkdtempSync(join(tmpdir(), 'nai-schedule-workbench-')))
  workbenches.push(wb)
  wb.settings.save({ output_directory: join(wb.root, 'original-output') })
  const tools = new Map<string, any>()
  registerTools({ effect: (fn: () => void) => fn(), tools: { register: (tool: any) => tools.set(tool.name, tool) } } as never, wb)
  return { wb, tools }
}
function schedule(overrides: Rec = {}): Rec {
  return {
    name: 'male portraits', enabled: false, kind: 'interval', interval_minutes: 60,
    operation: 'generate', request: { prompt: '1boy', model: 'nai-diffusion-5-full', seed: 10 },
    count: 1, max_runs: 5, output_subdir: 'men.v1', ...overrides,
  }
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Remote requests are forbidden in this test') })) })
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const wb of workbenches.splice(0)) { wb.stop(); rmSync(wb.root, { recursive: true, force: true }) }
})

describe('schedule output end-to-end preparation', () => {
  it.each(['fixed', 'ai'])('preserves output through public %s save, preview, edit and copy', async (execution_mode) => {
    const { wb } = fixture()
    const input = schedule({ execution_mode, ai_recipe: { instruction: 'A male portrait', locked_fields: ['request.seed'] } })
    const saved = await wb.saveSchedule(input)
    expect(saved).toMatchObject({ output_subdir: 'men.v1', request: { output_subdir: 'men.v1' } })
    const internal = wb.store.getSchedule(String(saved.id))
    expect(internal.snapshot).toMatchObject({ request: { output_subdir: 'men.v1' }, context: { output_directory: join(wb.root, 'original-output') } })
    const edited = await wb.saveSchedule({ name: 'renamed', expected_revision: saved.revision }, String(saved.id))
    expect(edited).toMatchObject({ output_subdir: 'men.v1', request: { output_subdir: 'men.v1' } })
    const copy = await wb.saveSchedule({ ...edited, id: undefined, revision: undefined, enabled: false })
    expect(copy).toMatchObject({ output_subdir: 'men.v1', request: { output_subdir: 'men.v1' } })
    expect(copy.id).not.toBe(saved.id)
    if (execution_mode === 'fixed') expect(await wb.previewSchedule(input)).toMatchObject({ request: { output_subdir: 'men.v1' } })
    const cleared = await wb.saveSchedule({ output_subdir: null, expected_revision: edited.revision }, String(edited.id))
    expect(cleared.output_subdir).toBeNull()
    expect(cleared.request).not.toHaveProperty('output_subdir')
  })

  it('preserves legacy request-only updates through Workbench preparation', async () => {
    const { wb } = fixture(), saved = await wb.saveSchedule(schedule())
    const edited = await wb.saveSchedule({ request: { ...(saved.request as Rec), output_subdir: 'updated' }, expected_revision: saved.revision }, String(saved.id))
    expect(edited).toMatchObject({ output_subdir: 'updated', request: { output_subdir: 'updated' } })
  })

  it.each(['fixed', 'ai'])('clears request-only null and empty directory updates for %s plans', async (execution_mode) => {
    const { wb } = fixture()
    for (const output_subdir of [null, '']) {
      const saved = await wb.saveSchedule(schedule({ execution_mode, ai_recipe: { instruction: 'A male portrait' } }))
      const edited = await wb.saveSchedule({ request: { ...(saved.request as Rec), output_subdir }, expected_revision: saved.revision }, String(saved.id))
      expect(edited.output_subdir).toBeNull()
      expect(edited.request).not.toHaveProperty('output_subdir')
      expect((wb.store.getSchedule(String(saved.id)).snapshot as Rec).request).not.toHaveProperty('output_subdir')
    }
  })

  it.each(['fixed', 'ai'])('keeps the explicit root field authoritative during %s request updates', async (execution_mode) => {
    const { wb } = fixture(), saved = await wb.saveSchedule(schedule({ execution_mode, ai_recipe: { instruction: 'A male portrait' } }))
    const edited = await wb.saveSchedule({ output_subdir: 'explicit', request: { ...(saved.request as Rec), output_subdir: 'ignored' }, expected_revision: saved.revision }, String(saved.id))
    expect(edited).toMatchObject({ output_subdir: 'explicit', request: { output_subdir: 'explicit' } })
  })

  it('exposes and executes schedule.output_subdir in the registered tool schema', async () => {
    const { wb, tools } = fixture(), tool = tools.get('nai_schedule_save')
    expect(tool.parameters.properties.schedule.properties.output_subdir).toBeDefined()
    const saved = await tool.execute({ schedule: schedule() }, { signal: new AbortController().signal })
    expect(saved).toMatchObject({ output_subdir: 'men.v1', request: { output_subdir: 'men.v1' } })
    const before = structuredClone(wb.store.data.schedules)
    await expect(tool.execute({ schedule: schedule({ output_subdir: '../escape' }) }, { signal: new AbortController().signal })).rejects.toThrow()
    expect(wb.store.data.schedules).toEqual(before)
  })

  it('keeps the authorized output root and directory in fixed queued work after settings change', async () => {
    const { wb } = fixture(), saved = await wb.saveSchedule(schedule())
    wb.settings.save({ output_directory: join(wb.root, 'later-output') })
    wb.store.scheduleOnce(String(saved.id), Number(saved.revision), 'once')
    expect(wb.store.listJobs()[0]).toMatchObject({ request: { output_subdir: 'men.v1' }, context: { output_directory: join(wb.root, 'original-output') } })
  })

  it('restores a character slot dropped by the proposal instead of failing the occurrence', async () => {
    const { wb } = fixture()
    const person = wb.store.saveEntry({ kind: 'character', name: 'Akito', data: { prompt: 'shinonome akito, orange hair' } })
    const saved = await wb.saveSchedule(schedule({ execution_mode: 'ai', ai_recipe: { instruction: 'A portrait', library_refs: [person.id] } }))
    const internal = wb.store.getSchedule(String(saved.id)), draft = creativeDraft(internal).draft
    const candidate = structuredClone(draft)
    ;(candidate.request as Rec).characters = []
    vi.spyOn(Assistant.prototype, 'planDraft').mockResolvedValue({ draft: candidate, reply: 'A portrait' })
    const result = await composeSchedule(wb, { schedule: internal, scheduled_for: '2026-10-01T00:00:00Z' })
    const characters = ((result.snapshots as Rec[])[0]!['request'] as Rec)['characters'] as Rec[]
    expect(characters).toHaveLength(1)
    expect(String(characters[0]!['prompt'])).toContain('shinonome akito')
  })

  it.each(['men.v1', null, 'other', '../escape'])('checks AI composition output %s before preparing a snapshot', async (output_subdir) => {
    const { wb } = fixture()
    const saved = await wb.saveSchedule(schedule({ execution_mode: 'ai', ai_recipe: { instruction: 'A male portrait', locked_fields: ['request.seed'] } }))
    const internal = wb.store.getSchedule(String(saved.id)), draft = creativeDraft(internal).draft
    const candidate = structuredClone(draft)
    ;(candidate.request as Rec).output_subdir = output_subdir
    vi.spyOn(Assistant.prototype, 'planDraft').mockResolvedValue({ draft: candidate, reply: 'A portrait' })
    const result = composeSchedule(wb, { schedule: internal, scheduled_for: '2026-10-01T00:00:00Z' })
    if (output_subdir === 'men.v1') expect(await result).toMatchObject({ request: { output_subdir: 'men.v1' }, snapshots: [{ request: { output_subdir: 'men.v1' } }] })
    else await expect(result).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    expect(wb.store.listJobs()).toEqual([])
  })
})
