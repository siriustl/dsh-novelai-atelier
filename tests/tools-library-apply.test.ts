import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools } from '../src/tools.ts'
import { Workbench } from '../src/workbench/app.ts'
import { timestamp } from '../src/workbench/util.ts'

let root: string, wb: Workbench, tools: Map<string, any>
const run = (name: string, args: Record<string, unknown> = {}) => tools.get(name).execute(args, { signal: new AbortController().signal })
const apply = (args: Record<string, unknown>) => run('nai_draft', { action: 'apply_library', ...args })
const save = (kind: string, data: Record<string, unknown>, extra = {}) => wb.store.saveEntry({ kind, name: kind, data, ...extra })
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nai-library-tools-'))
  wb = new Workbench(root)
  tools = new Map()
  registerTools({ effect: (fn: () => void) => fn(), tools: { register: (tool: any) => tools.set(tool.name, tool) } } as never, wb)
})
afterEach(() => { wb.stop(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

describe('nai_draft apply_library', () => {
  it('keeps the application mutation out of concurrency-safe reads', () => {
    const tool = tools.get('nai_draft')
    expect(tool.isConcurrencySafe({ action: 'apply_library' })).toBe(false)
    expect(tool.isConcurrencySafe({ action: 'update' })).toBe(false)
    expect(tool.isConcurrencySafe({ action: 'read' })).toBe(true)
    expect(tool.isConcurrencySafe({ action: 'list' })).toBe(true)
  })

  it('applies weighted artists to a non-active draft with provenance and no remote execution', async () => {
    const active = wb.store.getDraft()
    const artist = save('artist', { prompt: 'artist:fixture' })
    const blend = save('blend', { artists: [{ id: artist.id, weight: 0.6 }] })
    const target = wb.store.createDraft({ name: 'target', request: { model: 'nai-diffusion-5-full', prompt: 'sign\nText: OPEN', seed: 42, width: 832, height: 1216 } }, false)
    const execute = vi.spyOn(wb.executor, 'execute'), credits = vi.spyOn(wb.executor, 'credits')
    const result = await apply({ draft_id: target.id, base_revision: target.revision, entry_id: blend.id, expected_entry_revision: blend.revision })
    expect(result.draft.request).toMatchObject({ prompt: 'sign, 0.6::artist:fixture::\nText: OPEN', seed: 42, width: 832, height: 1216 })
    expect(result.draft.library_refs).toEqual([expect.objectContaining({ id: blend.id, revision: blend.revision, prompt_set: -1 })])
    expect(result.draft.revision).toBe(Number(target.revision) + 1)
    expect(result.validation.ok).toBe(true)
    expect(wb.store.getDraft()).toEqual(active)
    expect(wb.store.getDraft(String(target.id))).toEqual(result.draft)
    expect(execute).not.toHaveBeenCalled()
    expect(credits).not.toHaveBeenCalled()
    expect(wb.store.data.jobs).toHaveLength(0)
  })

  it('resolves branch prompt groups and replaces only the selected slot, retaining position', async () => {
    const parent = save('character', { prompt: 'green eyes', negative_prompt: 'red eyes' })
    const branch = save('branch', { prompt: 'coat', prompt_sets: [{ name: 'winter', prompt: 'scarf', negative_prompt: 'hat' }] }, { parent_id: parent.id })
    const target = wb.store.createDraft({ request: { model: 'nai-diffusion-5-full', prompt: 'snow', characters: [{ prompt: 'old', x: 0.2, y: 0.7 }, { prompt: 'other' }] }, library_refs: [{ id: 'old', slot: 0 }, { id: 'other', slot: 1 }] }, false)
    const result = await apply({ draft_id: target.id, base_revision: target.revision, entry_id: branch.id, prompt_set: 0, target_slot: 0 })
    expect(result.draft.request.characters).toEqual([{ prompt: 'green eyes, scarf', negative_prompt: 'red eyes, hat', x: 0.2, y: 0.7 }, { prompt: 'other' }])
    expect(result.draft.library_refs).toEqual([{ id: 'other', slot: 1 }, expect.objectContaining({ id: branch.id, parent_id: parent.id, slot: 0, prompt_set: 0, prompt_set_name: 'winter' })])
    expect(wb.store.getEntry(String(branch.id))).toMatchObject({
      id: branch.id, data: { ...branch.data, use_count: 1, last_used_at: expect.any(String) },
    })
  })

  it('applies several library entries in one revision and one save', async () => {
    const character = save('character', { prompt: 'girl, red coat' })
    const artist = save('artist', { prompt: 'artist:fixture' })
    const target = wb.store.createDraft({ name: 'batch target', request: { model: 'nai-diffusion-5-full', prompt: 'forest' } }, false)
    const result = await apply({ draft_id: target.id, base_revision: target.revision, entry_ids: [character.id, artist.id] })
    expect(result.draft.request.characters).toEqual([{ prompt: 'girl, red coat', negative_prompt: '' }])
    expect(result.draft.request.prompt).toBe('forest, artist:fixture')
    expect(result.draft.library_refs.map((ref: Record<string, unknown>) => ref['id'])).toEqual([character.id, artist.id])
    expect(result.applied_entry_ids).toEqual([character.id, artist.id])
    expect(result.draft.revision).toBe(Number(target.revision) + 1)
    expect(wb.store.data.drafts.filter((draft) => draft.id === target.id)).toHaveLength(1)
    const before = structuredClone(result.draft)
    await expect(apply({ draft_id: target.id, base_revision: result.draft.revision, entry_id: character.id, entry_ids: [artist.id] })).rejects.toThrow('not both')
    await expect(apply({ draft_id: target.id, base_revision: result.draft.revision, entry_ids: [character.id, character.id] })).rejects.toThrow('unique')
    await expect(apply({ draft_id: target.id, base_revision: result.draft.revision, entry_ids: [character.id], target_slot: 0 })).rejects.toThrow('target_slot')
    await expect(apply({ draft_id: target.id, base_revision: result.draft.revision, entry_ids: [character.id], expected_entry_revision: 0 })).rejects.toThrow('expected_entry_revision')
    expect(wb.store.getDraft(String(target.id))).toEqual(before)
  })

  it('supports the active draft, identity replacement, and preset characters', async () => {
    const parent = save('character', { prompt: 'old identity' })
    const branch = save('branch', { prompt: 'new identity', replace_identity: true }, { parent_id: parent.id })
    const current = wb.store.getDraft()
    const result = await apply({ base_revision: current.revision, entry_id: branch.id })
    expect(result.draft.request.characters).toEqual([{ prompt: 'new identity', negative_prompt: '' }])
    const preset = save('preset', { prompt: 'forest', negative_prompt: 'blur', characters: [{ prompt: 'traveler' }] })
    const next = await apply({ base_revision: result.draft.revision, entry_id: preset.id })
    expect(next.draft.request).toMatchObject({ prompt: 'forest', negative_prompt: 'blur', characters: [{ prompt: 'new identity', negative_prompt: '' }, { prompt: 'traveler' }] })
  })

  it('requires read revisions and rejects stale source or draft versions before saving', async () => {
    const entry = save('preset', { prompt: 'forest' })
    const current = wb.store.getDraft()
    const persist = vi.spyOn(wb.store, 'saveDraft')
    await expect(apply({ entry_id: entry.id })).rejects.toThrow('base_revision')
    await expect(apply({ base_revision: current.revision })).rejects.toThrow('entry_id')
    await expect(apply({ entry_id: entry.id, base_revision: Number(current.revision) + 1 })).rejects.toThrow('revision changed')
    await expect(apply({ entry_id: entry.id, base_revision: current.revision, expected_entry_revision: Number(entry.revision) + 1 })).rejects.toThrow('revision changed')
    expect(persist).not.toHaveBeenCalled()
    expect(wb.store.getDraft()).toEqual(current)
  })

  it.each(['request.prompt', 'prompt', '/request/prompt', 'library_refs'])('respects %s locks without partial saves', async (lock) => {
    const entry = save('preset', { prompt: 'forest' })
    const target = wb.store.createDraft({ request: { prompt: 'keep' }, locked_fields: [lock] }, false)
    await expect(apply({ entry_id: entry.id, draft_id: target.id, base_revision: target.revision })).rejects.toThrow('locked field')
    expect(wb.store.getDraft(String(target.id))).toEqual(target)
  })

  it('protects bracket-addressed slot locks and leaves unrelated locked parameters alone', async () => {
    const entry = save('character', { prompt: 'new' })
    const locked = wb.store.createDraft({ request: { prompt: 'scene', seed: 42, characters: [{ prompt: 'keep', x: 0.2 }] }, locked_fields: ['characters[0].prompt'] }, false)
    await expect(apply({ entry_id: entry.id, draft_id: locked.id, base_revision: locked.revision, target_slot: 0 })).rejects.toThrow('locked field')
    const allowed = wb.store.createDraft({ request: { prompt: 'scene', seed: 42 }, locked_fields: ['seed'] }, false)
    expect((await apply({ entry_id: entry.id, draft_id: allowed.id, base_revision: allowed.revision })).draft.request.seed).toBe(42)
  })

  it.each([{ request: {} }, { patch: {} }, { prompt: '' }, { operation: 'generate' }, { seed: 42 }, { query: 'forest' }, { limit: 5 }])('rejects mixed application fields %j', async (fields) => {
    const entry = save('preset', { prompt: 'forest' }), current = wb.store.getDraft()
    await expect(apply({ entry_id: entry.id, base_revision: current.revision, ...fields })).rejects.toThrow('cannot be combined')
    expect(wb.store.getDraft()).toEqual(current)
  })

  it('rejects apply-only arguments on other actions and invalid composition options without writes', async () => {
    const entry = save('preset', { prompt: 'forest' }), current = wb.store.getDraft()
    await expect(run('nai_draft', { action: 'update', entry_id: entry.id })).rejects.toThrow('require action:apply_library')
    await expect(apply({ entry_id: entry.id, base_revision: current.revision, target_slot: 0 })).rejects.toThrow('only supported')
    await expect(apply({ entry_id: entry.id, base_revision: current.revision, prompt_set: 0 })).rejects.toThrow()
    expect(wb.store.getDraft()).toEqual(current)
  })

  it('rejects model slot limits and conflicting rendered text without saving', async () => {
    const entry = save('character', { prompt: 'new' })
    const target = wb.store.createDraft({ request: { model: 'nai-diffusion-4-5-full', prompt: 'scene', characters: Array.from({ length: 6 }, () => ({ prompt: 'person' })) } }, false)
    await expect(apply({ entry_id: entry.id, draft_id: target.id, base_revision: target.revision })).rejects.toThrow()
    expect(wb.store.getDraft(String(target.id))).toEqual(target)
    const lettering = save('preset', { prompt: 'sign\nText: CLOSED' })
    const sign = wb.store.createDraft({ request: { prompt: 'sign\nText: OPEN' } }, false)
    await expect(apply({ entry_id: lettering.id, draft_id: sign.id, base_revision: sign.revision })).rejects.toThrow('Text:')
    expect(wb.store.getDraft(String(sign.id))).toEqual(sign)
  })

  it('returns failed offline validation alongside the saved draft without generating', async () => {
    const entry = save('preset', { prompt: 'forest' }), current = wb.store.getDraft()
    vi.spyOn(wb, 'validate').mockRejectedValue(new Error('isolated validation failure'))
    const execute = vi.spyOn(wb.executor, 'execute')
    const result = await apply({ entry_id: entry.id, base_revision: current.revision })
    expect(result.validation).toEqual({ ok: false, message: 'isolated validation failure' })
    expect(wb.store.getDraft()).toEqual(result.draft)
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('nai_gallery_read persisted date boundaries', () => {
  it('handles GUI ISO dates directly in the shared store without excluding equal timestamps', () => {
    const at = '2025-01-02T00:30:00.000Z'
    const [job] = wb.store.createJobs([{ operation: 'generate', request: { prompt: 'forest' } }], 0, null, { now: timestamp(new Date(at)) })
    expect(wb.store.queryJobs({ after: at, before: at })).toMatchObject({ total: 1, items: [{ id: job!.id }] })
    expect(wb.store.queryJobs({ after: '2025-01-02T01:30:00+01:00', before: '2025-01-01T19:30:00-05:00' })).toMatchObject({ total: 1 })
    expect(() => wb.store.queryJobs({ after: 'invalid' })).toThrow('ISO 8601')
    expect(() => wb.store.queryJobs({ after: '2025-01-03', before: '2025-01-02' })).toThrow('after must not be later')
  })

  it('normalizes offsets and includes jobs exactly on after/before boundaries', async () => {
    const at = timestamp(new Date('2025-01-02T00:30:00Z'))
    const [job] = wb.store.createJobs([{ operation: 'generate', request: { prompt: 'forest' } }], 0, null, { now: at })
    const result = await run('nai_gallery_read', { after: '2025-01-02T01:30:00+01:00', before: '2025-01-01T19:30:00-05:00' })
    expect(result.total).toBe(1)
    expect(result.items[0].id).toBe(job!.id)
    expect((await run('nai_gallery_read', { after: '2025-01-02T00:30:00.001Z' })).total).toBe(0)
    expect((await run('nai_gallery_read', { before: '2025-01-02T00:29:59.999Z' })).total).toBe(0)
  })

  it('accepts blank bounds and date-only midnight and rejects invalid or reversed ranges', async () => {
    wb.store.createJobs([{ operation: 'generate', request: { prompt: 'forest' } }], 0, null, { now: timestamp(new Date('2025-01-02T00:00:00Z')) })
    expect((await run('nai_gallery_read', { after: ' ', before: '' })).total).toBe(1)
    expect((await run('nai_gallery_read', { before: '2025-01-02' })).total).toBe(1)
    for (const after of ['not a date', '1', 'October 1', '2025-02-30T00:00:00Z', '2025-01-02T00:00:00']) {
      await expect(run('nai_gallery_read', { after })).rejects.toThrow('ISO 8601')
      expect(() => wb.store.queryJobs({ after })).toThrow('ISO 8601')
    }
    await expect(run('nai_gallery_read', { after: '2025-01-03', before: '2025-01-02' })).rejects.toThrow('after must not be later')
  })
})
