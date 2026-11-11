import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workbench } from '../src/workbench/app.ts'
import type { Rec } from '../src/workbench/store.ts'

const workbenches: Workbench[] = []
function fixture() {
  const wb = new Workbench(mkdtempSync(join(tmpdir(), 'nai-output-proposal-')))
  workbenches.push(wb)
  vi.spyOn(wb.settings, 'freeze').mockReturnValue({ output_directory: join(wb.root, 'outputs') })
  return wb
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Remote requests are forbidden in this test') })) })
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const wb of workbenches.splice(0)) { wb.stop(); rmSync(wb.root, { recursive: true, force: true }) }
})
const directory = (value: Rec) => (value.request as Rec).output_subdir ?? null

describe.each(['fixed', 'ai'])('reviewable %s schedule directory updates', (execution_mode) => {
  const save = (wb: Workbench) => wb.saveSchedule({
    name: 'male portraits', enabled: false, kind: 'interval', interval_minutes: 60,
    operation: 'generate', request: { prompt: '1boy', seed: 42 }, output_subdir: 'old',
    execution_mode, ai_recipe: { instruction: 'A male portrait', locked_fields: ['request.seed'] },
  })

  it.each(['new', '', null])('previews the actual request-only update to %s', async (output_subdir) => {
    const wb = fixture(), saved = await save(wb)
    const patch = { request: { ...(saved.request as Rec), output_subdir } }
    const original = structuredClone(patch)
    const proposal = await wb.workspace.propose('schedules.update', { schedule_id: saved.id, schedule: patch })
    const after = proposal.after as Rec
    expect(after.output_subdir).toBe(output_subdir || null)
    expect(directory(after)).toBe(output_subdir || null)
    expect(wb.store.getSchedule(String(saved.id)).output_subdir).toBe('old')
    expect(patch).toEqual(original)
    const applied = (await wb.workspace.apply(String(proposal.id))).result as Rec
    expect(applied.output_subdir).toBe(after.output_subdir)
    expect(directory(applied)).toBe(directory(after))
    expect((wb.store.getSchedule(String(saved.id)).snapshot as Rec).request).toEqual(applied.request)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['explicit', null])('keeps the explicit task directory %s authoritative', async (output_subdir) => {
    const wb = fixture(), saved = await save(wb)
    const proposal = await wb.workspace.propose('schedules.update', {
      schedule_id: saved.id, schedule: { output_subdir, request: { ...(saved.request as Rec), output_subdir: 'ignored' } },
    })
    expect(directory(proposal.after as Rec)).toBe(output_subdir)
    const applied = (await wb.workspace.apply(String(proposal.id))).result as Rec
    expect(directory(applied)).toBe(directory(proposal.after as Rec))
    expect(applied.output_subdir).toBe(output_subdir)
  })

  it('retains the directory when a request-only patch does not mention it', async () => {
    const wb = fixture(), saved = await save(wb)
    const proposal = await wb.workspace.propose('schedules.update', { schedule_id: saved.id, schedule: { request: { prompt: '1boy, smiling', seed: 42 } } })
    expect(directory(proposal.after as Rec)).toBe('old')
    const applied = (await wb.workspace.apply(String(proposal.id))).result as Rec
    expect(directory(applied)).toBe('old')
    expect(applied.request).toMatchObject({ prompt: '1boy, smiling', seed: 42 })
  })

  it('rejects an invalid request-only directory before recording a proposal', async () => {
    const wb = fixture(), saved = await save(wb)
    await expect(wb.workspace.propose('schedules.update', { schedule_id: saved.id, schedule: { request: { ...(saved.request as Rec), output_subdir: '../escape' } } })).rejects.toThrow()
    expect(wb.store.data.workspace_proposals).toHaveLength(0)
    expect(wb.store.getSchedule(String(saved.id)).output_subdir).toBe('old')
  })
})
