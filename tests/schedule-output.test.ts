import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type Rec } from '../src/workbench/store.ts'
import { creativeDraft } from '../src/workbench/schedulePlanner.ts'
import { checkScheduledRequest } from '../src/workbench/scheduledAssistant.ts'

const roots: string[] = []
const now = '2026-10-01T00:00:00Z'
const due = '2026-10-01T00:01:00Z'
function store(): Store {
  const root = mkdtempSync(join(tmpdir(), 'nai-schedule-output-'))
  roots.push(root)
  return new Store(root)
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function schedule(overrides: Rec = {}): Rec {
  return {
    name: 'scheduled portraits', enabled: true, kind: 'once', timezone: 'UTC', at: due,
    operation: 'generate', count: 2, max_runs: 5, max_total_anlas: 0, missed_policy: 'once',
    request: { prompt: '1boy', model: 'nai-diffusion-5-full', max_anlas: 0 },
    snapshot: { context: { output_directory: '/frozen-output' }, request: { output_subdir: 'stale' } },
    ...overrides,
  }
}
function aiSchedule(overrides: Rec = {}): Rec {
  return schedule({ execution_mode: 'ai', ai_recipe: { instruction: 'A male portrait', locked_fields: [] }, ...overrides })
}

describe('explicit scheduled output directories', () => {
  it.each(['fixed', 'ai'])('freezes the %s directory into request and snapshot without mutating input', (execution_mode) => {
    const s = store(), input = aiSchedule({ execution_mode, output_subdir: ' portraits.v1 ' })
    const before = structuredClone(input)
    const preview = s.previewSchedule(input, null, now)
    const saved = s.saveSchedule(input, null, now)
    for (const value of [preview, saved]) {
      expect(value.output_subdir).toBe('portraits.v1')
      expect(value.request).toMatchObject({ output_subdir: 'portraits.v1', prompt: '1boy' })
      expect(value.snapshot).toMatchObject({ context: { output_directory: '/frozen-output' }, request: value.request })
    }
    expect(input).toEqual(before)
  })

  it.each(['../escape', 'a/b', 'a\\b', 'C:\\images', 'CON', 'nul.png', 'trailing.', 'bad\u0000name', 42])('rejects invalid output %s atomically', (output_subdir) => {
    const s = store(), before = structuredClone(s.data)
    expect(() => s.previewSchedule(schedule({ output_subdir }), null, now)).toThrow()
    expect(() => s.saveSchedule(schedule({ output_subdir }), null, now)).toThrow()
    expect(s.data).toEqual(before)
  })

  it('preserves a legacy request directory on edit and explicit clearing overrides it', () => {
    const s = store()
    const saved = s.saveSchedule(schedule({ request: { prompt: '1boy', max_anlas: 0, output_subdir: 'legacy.v1' } }), null, now)
    // Emulate an existing persisted task that predates the schedule-level field.
    const row = s.data.schedules[0]!, legacy = JSON.parse(row.data)
    delete legacy.output_subdir
    row.data = JSON.stringify(legacy)
    const edited = s.saveSchedule({ name: 'renamed', expected_revision: saved.revision }, String(saved.id), now)
    expect(edited).toMatchObject({ output_subdir: 'legacy.v1', request: { output_subdir: 'legacy.v1' }, runs: 0 })
    const cleared = s.saveSchedule({ output_subdir: '', expected_revision: edited.revision }, String(saved.id), now)
    expect(cleared.output_subdir).toBeNull()
    expect(cleared.request).not.toHaveProperty('output_subdir')
    expect((cleared.snapshot as Rec).request).not.toHaveProperty('output_subdir')
    expect(s.data.jobs).toEqual([])
  })

  it.each(['fixed', 'ai'])('loads persisted legacy %s tasks without rewriting their data or settings', (execution_mode) => {
    const s = store(), root = roots.at(-1)!
    s.saveSettings({ default_output_subdir: 'retired', custom_setting: 'keep' })
    const saved = s.saveSchedule(aiSchedule({ execution_mode, request: { prompt: '1boy', max_anlas: 0, output_subdir: 'legacy' } }), null, now)
    const row = s.data.schedules[0]!, legacy = JSON.parse(row.data)
    delete legacy.output_subdir
    row.data = JSON.stringify(legacy)
    s.internalPersist()
    const before = structuredClone(s.data), reopened = new Store(root)
    expect(reopened.data).toEqual(before)
    expect(reopened.getSettings()).toMatchObject({ default_output_subdir: 'retired', custom_setting: 'keep' })
    reopened.tickSchedules(due)
    if (execution_mode === 'ai') {
      const run = reopened.claimScheduleRun(due)!
      const request = { prompt: '1boy, smiling', max_anlas: 0, output_subdir: 'legacy' }
      reopened.finishScheduleRun(run, { plan: { snapshots: [{ operation: 'generate', request }, { operation: 'generate', request }] }, now: due })
    }
    expect(reopened.listJobs().map((job) => (job.request as Rec).output_subdir)).toEqual(['legacy', 'legacy'])
    expect(reopened.getSchedule(String(saved.id)).runs).toBe(1)
  })

  it('keeps request-only updates compatible and gives an explicit schedule field precedence', () => {
    const s = store(), saved = s.saveSchedule(schedule({ output_subdir: 'old' }), null, now)
    const edited = s.saveSchedule({ request: { prompt: '1boy', max_anlas: 0, output_subdir: 'legacy-update' } }, String(saved.id), now)
    expect(edited).toMatchObject({ output_subdir: 'legacy-update', request: { output_subdir: 'legacy-update' } })
    const explicit = s.saveSchedule({ output_subdir: 'explicit', request: { prompt: '1boy', max_anlas: 0, output_subdir: 'ignored' } }, String(saved.id), now)
    expect(explicit).toMatchObject({ output_subdir: 'explicit', request: { output_subdir: 'explicit' } })
  })

  it.each(['tick', 'once'])('freezes fixed %s jobs and never inherits a global directory', (trigger) => {
    const s = store()
    s.saveSettings({ default_output_subdir: 'retired-global' })
    const saved = s.saveSchedule(schedule({ output_subdir: 'men.v1', seed_mode: 'increment', request: { prompt: '1boy', seed: 10, max_anlas: 0 } }), null, now)
    if (trigger === 'tick') s.tickSchedules(due)
    else s.scheduleOnce(String(saved.id), Number(saved.revision), 'manual')
    expect(s.listJobs()).toHaveLength(2)
    expect(s.listJobs().map((job) => (job.request as Rec).output_subdir)).toEqual(['men.v1', 'men.v1'])
    s.saveSchedule({ output_subdir: 'changed', expected_revision: saved.revision }, String(saved.id), due)
    expect(s.listJobs().map((job) => (job.request as Rec).output_subdir)).toEqual(['men.v1', 'men.v1'])
    const root = s.saveSchedule(schedule({ snapshot: {} }), null, now)
    expect(root.output_subdir).toBeNull()
    expect(root.request).not.toHaveProperty('output_subdir')
    expect(s.getSettings().default_output_subdir).toBe('retired-global')
  })

  it('adds an implicit AI directory lock while preserving user locks', () => {
    const draft = creativeDraft(aiSchedule({ output_subdir: 'men', ai_recipe: { instruction: 'Portrait', locked_fields: ['request.seed'] } })).draft
    expect(draft.locked_fields).toEqual(expect.arrayContaining(['request.model', 'request.output_subdir', 'request.seed']))
    expect(draft.request).toMatchObject({ output_subdir: 'men' })
  })

  it.each([undefined, null, 'elsewhere', '../escape'])('rejects AI directory removal/change %s without optional user locks', (output_subdir) => {
    const saved = aiSchedule({ output_subdir: 'men', request: { prompt: '1boy', output_subdir: 'men', max_anlas: 0 } })
    const proposed: Rec = { prompt: '1boy, smiling', max_anlas: 0 }
    if (output_subdir !== undefined) proposed.output_subdir = output_subdir
    expect(() => checkScheduledRequest(saved, proposed)).toThrow()
  })

  it('prevents AI from introducing a directory into a root-output task', () => {
    expect(() => checkScheduledRequest(aiSchedule(), { prompt: '1boy', output_subdir: 'new-folder' })).toThrow()
    expect(checkScheduledRequest(aiSchedule(), { prompt: '1boy', output_subdir: null })).not.toHaveProperty('output_subdir')
  })

  it.each(['tick', 'once'])('freezes AI %s run directories and rejects changed final snapshots before creating jobs', (trigger) => {
    const s = store(), saved = s.saveSchedule(aiSchedule({ output_subdir: 'men' }), null, now)
    if (trigger === 'tick') s.tickSchedules(due)
    else s.scheduleOnce(String(saved.id), Number(saved.revision), 'manual')
    const run = s.claimScheduleRun(due)!
    const bad = { operation: 'generate', request: { prompt: '1boy', output_subdir: 'other', max_anlas: 0 } }
    expect(() => s.finishScheduleRun(run, { plan: { snapshots: [bad, bad] }, now: due })).toThrow()
    expect(s.data.jobs).toHaveLength(0)
    const good = { operation: 'generate', request: { prompt: '1boy, smiling', output_subdir: 'men', max_anlas: 0 } }
    const result = s.finishScheduleRun(run, { plan: { snapshots: [good, good] }, now: due })
    expect(result.outcome).toBe('queued')
    expect(s.listJobs().map((job) => (job.request as Rec).output_subdir)).toEqual(['men', 'men'])
    expect(s.data.jobs.every((job) => JSON.parse(job.snapshot).context.output_directory === '/frozen-output')).toBe(true)
  })
})
