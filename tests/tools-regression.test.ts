import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools, ToolFailure } from '../src/tools.ts'
import { Workbench } from '../src/workbench/app.ts'
import { NovelAIError } from '../src/core/client.ts'
import { Raster } from '../src/core/raster.ts'

describe('registered Agent tool regression contracts', () => {
  let root: string
  let wb: Workbench
  let tools: Map<string, any>
  const run = (name: string, args: Record<string, unknown> = {}, signal = new AbortController().signal) => tools.get(name).execute(args, { signal })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nai-agent-tools-'))
    wb = new Workbench(root)
    tools = new Map()
    registerTools({ effect: (fn: () => void) => fn(), tools: { register: (tool: any) => tools.set(tool.name, tool) } } as never, wb, { legacyTools: true })
  })
  afterEach(() => {
    wb.stop()
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('uses one request object on cross-operation tools without repeating editing schemas', () => {
    for (const name of ['nai_quote', 'nai_validate_request', 'nai_validate_operation', 'nai_workbench_submit', 'nai_draft_patch']) {
      const properties = tools.get(name).parameters.properties
      expect(properties.request.type).toBe('object')
      expect(properties.request.additionalProperties).toBe(true)
      expect(properties.image_path).toBeUndefined()
      expect(properties.focus_box).toBeUndefined()
    }
    expect(tools.get('nai_generate_with_references').parameters.properties.model.default).toBe('nai-diffusion-4-5-full')
    expect(tools.get('nai_img2img').parameters.properties.width.default).toBeUndefined()
    for (const key of ['crop_box', 'mask_boxes', 'mask_polygons']) expect(tools.get('nai_prepare_image').parameters.properties[key]).toBeDefined()
    expect(tools.get('nai_enhance_image').parameters.properties.prompt).toBeDefined()
  })

  it('omits duplicate payload by default and retains it on demand without request pollution', async () => {
    const args = { operation: 'generate', request: { model: 'v5', prompt: 'scenery', seed: 42 } }
    const compact = await run('nai_validate_request', args)
    expect(compact).toMatchObject({ valid: true, resolved_request: { seed: 42 }, warnings: [] })
    expect(compact.api_payload).toBeUndefined()
    expect(compact.preparation).toBeUndefined()
    const full = await run('nai_validate_request', { ...args, include_payload: true })
    expect(full.api_payload.parameters.seed).toBe(42)
    expect(full.resolved_request.include_payload).toBeUndefined()
  })

  it('returns compact queue acknowledgements with budgets and preserves explicit detailed snapshots', async () => {
    const args = { request: { model: 'v5', prompt: 'scenery', seed: 42 }, idempotency_key: 'compact-batch' }
    const compact = await run('nai_workbench_submit', args)
    expect(compact.jobs[0]).toMatchObject({ status: 'queued', attempts: 0, draft_id: 'main' })
    expect(compact.jobs[0].request).toBeUndefined()
    const full = await run('nai_workbench_submit', { ...args, include_details: true })
    expect(full.jobs[0].id).toBe(compact.jobs[0].id)
    expect(full.jobs[0].request.prompt).toBe('scenery')
    expect(full.jobs[0].request.include_details).toBeUndefined()
    expect(full.jobs[0].context).toBeUndefined()
  })

  it('validates flat editing arguments offline with source dimensions and noise controls', async () => {
    const source = join(root, 'source.png')
    writeFileSync(source, new Raster(64, 128, new Uint8Array(64 * 128 * 4).fill(255)).toPng())
    const credits = vi.spyOn(wb.executor, 'credits')
    const execute = vi.spyOn(wb.executor, 'execute')
    const result = await run('nai_validate_operation', { operation: 'img2img', include_payload: true, image_path: source, prompt: 'scenery', model: 'v5', noise: 0.2, extra_noise_seed: 42, strength: 0.4 })
    expect(result.resolved_request).toMatchObject({ width: 64, height: 128, noise: 0.2, extra_noise_seed: 42, strength: 0.4 })
    expect(result.api_payload.parameters.extra_noise_seed).toBe(42)
    expect(result.requires_live_quote).toBe(true)
    expect(credits).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('preserves nested request precedence and resolves a quote seed for reuse', async () => {
    const controller = new AbortController()
    const credits = vi.spyOn(wb.executor, 'credits').mockResolvedValue({ active: true, tier: 3, expires_at: null, anlas: { total: 100, subscription: 100, purchased: 0 }, perks: {}, v5_usage: null, v5_usage_summary: null })
    const result = await run('nai_quote', { include_payload: true, prompt: 'outer', seed: 9, max_anlas: 0, request: { prompt: 'inner', model: 'v4.5', max_anlas: 100 } }, controller.signal)
    expect(result.resolved_request).toMatchObject({ prompt: 'inner', model: 'nai-diffusion-4-5-full', seed: 9, max_anlas: 100 })
    expect(result.api_payload.parameters.seed).toBe(9)
    expect(result.estimated_anlas).toBeDefined()
    expect(credits).toHaveBeenCalledWith(controller.signal)
  })

  it('deep merges targeted drafts and replaces arrays without mixing active draft values', async () => {
    const active = wb.store.getDraft()
    wb.store.saveDraft({ request: { prompt: 'active', width: 1024 } }, active.revision as number)
    const target = wb.store.createDraft({ name: 'target', request: { prompt: 'target', model: 'v4.5', width: 832, height: 1216, editor: { keep: 1, replace: 2 }, characters: [{ prompt: 'boy' }] } }, false)
    const result = await run('nai_draft_patch', { draft_id: target.id, base_revision: 0, request: { editor: { outer: 3 } }, patch: { request: { model: 'v5', editor: { replace: 4 }, characters: [] } } })
    expect(result.draft.id).toBe(target.id)
    expect(result.draft.request).toMatchObject({ prompt: 'target', model: 'nai-diffusion-5-full', width: 832, editor: { keep: 1, outer: 3, replace: 4 }, characters: [] })
    expect(result.draft.request.draft_id).toBeUndefined()
    expect(wb.store.getDraft().request).toEqual({ prompt: 'active', width: 1024 })
    expect((await run('nai_draft_read', { draft_id: target.id })).id).toBe(target.id)
  })

  it('honors legacy patch.id selection and the selected draft revision', async () => {
    const target = wb.store.createDraft({ name: 'legacy target', request: { prompt: 'original', model: 'v5' } }, false)
    const active = wb.store.getDraft()
    wb.store.saveDraft({ name: 'active changed' }, active.revision as number)
    const result = await run('nai_draft_patch', { patch: { id: target.id, request: { prompt: 'changed' } }, base_revision: 0 })
    expect(result.draft.id).toBe(target.id)
    expect(result.draft.revision).toBe(1)
    expect(result.draft.request.prompt).toBe('changed')
    expect(wb.store.getDraft().name).toBe('active changed')
  })

  it('rejects a stale revision or conflicting target without saving', async () => {
    const before = wb.store.getDraft()
    wb.store.saveDraft({ name: 'newer' }, before.revision as number)
    await expect(run('nai_draft_patch', { draft_id: before.id, base_revision: before.revision, prompt: 'stale' })).rejects.toThrow()
    await expect(run('nai_draft_patch', { draft_id: 'main', patch: { id: 'other' }, prompt: 'wrong' })).rejects.toThrow('same draft')
    expect(wb.store.getDraft().revision).toBe(1)
    expect(wb.store.getDraft().name).toBe('newer')
  })

  it('rejects malformed patch requests before any mutation', async () => {
    await expect(run('nai_draft_patch', { patch: { request: [] } })).rejects.toThrow('patch.request must be an object')
    expect(wb.store.getDraft().revision).toBe(0)
  })

  it('persists an invalid draft with an explicit validation failure and no generation', async () => {
    const execute = vi.spyOn(wb.executor, 'execute')
    const result = await run('nai_draft_patch', { prompt: 'scenery', model: 'v5', variety_boost: true })
    expect(result.validation.ok).toBe(false)
    expect(result.validation.message).toContain('V4.5')
    expect(result.draft.request.variety_boost).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  it('exposes queue idempotency and stable draft provenance with no duplicate jobs', async () => {
    const args = { include_details: true, prompt: 'scenery', seed: 123, idempotency_key: 'intended-batch', draft_id: 'main', draft_revision: 0, count: 2, max_anlas: 0, max_total_anlas: 0 }
    const first = await run('nai_workbench_submit', args)
    const second = await run('nai_workbench_submit', args)
    expect(second.jobs.map((job: any) => job.id)).toEqual(first.jobs.map((job: any) => job.id))
    expect(wb.store.listJobs()).toHaveLength(2)
    expect(first.jobs[0]).toMatchObject({ draft_id: 'main', draft_revision: 0 })
    expect(first.jobs[0].context).toBeUndefined()
    expect(first.jobs[0].request.idempotency_key).toBeUndefined()
    expect(first.jobs[0].request.draft_id).toBeUndefined()
    await expect(run('nai_workbench_submit', { ...args, prompt: 'different' })).rejects.toThrow()
    expect(wb.store.listJobs()).toHaveLength(2)
  })

  it('normalizes model and sampler aliases in comparison variants before freezing jobs', async () => {
    const args = { request: { prompt: 'scenery', model: 'v5', seed: 42 }, variants: [{ model: 'v5-curated', sampler: 'Euler' }, { model: 'v4.5', sampler: 'DPM++ 2M' }], seed_mode: 'fixed', idempotency_key: 'aliases', include_details: true }
    const batch = await run('nai_workbench_submit', args)
    expect(batch.jobs.map((job: any) => [job.request.model, job.request.sampler])).toEqual([['nai-diffusion-5-curated', 'k_euler'], ['nai-diffusion-4-5-full', 'k_dpmpp_2m']])
    expect((await run('nai_workbench_submit', args)).jobs.map((job: any) => job.id)).toEqual(batch.jobs.map((job: any) => job.id))
    const before = wb.store.listJobs().length
    await expect(run('nai_workbench_submit', { ...args, variants: [{ model: 'not-a-model' }], idempotency_key: 'invalid-alias' })).rejects.toThrow('model')
    expect(wb.store.listJobs()).toHaveLength(before)
  })

  it('can inspect a queued job outside the recent list without exposing runtime context', async () => {
    const submission = await run('nai_workbench_submit', { prompt: 'scenery', count: 10 })
    const id = submission.jobs[0].id
    expect(wb.store.claimJob()?.id).toBe(id)
    wb.store.finishJob(id, { result: { artifact_paths: ['saved.png'], record_path: 'saved.json' }, actualAnlas: 0 })
    const result = await run('nai_workbench_status', { job_id: id })
    expect(result.job.result).toMatchObject({ artifact_paths: ['saved.png'], record_path: 'saved.json' })
    expect(result.job.context).toBeUndefined()
  })

  it('reads and recovers actual receipts when unused optional fields are blank', async () => {
    const id = '20260824T120000Z-abcdef1234'
    const receiptPath = join(root, `${id}.json`)
    const validation = await run('nai_validate_request', { include_payload: true, prompt: 'scenery', model: 'v5', seed: 42, max_anlas: 10 })
    writeFileSync(receiptPath, JSON.stringify({ id, operation: 'generate', status: 'submitted', request: validation.resolved_request, api_payload: validation.api_payload }))
    const execute = vi.spyOn(wb.executor, 'execute')
    for (const blank of ['', ' \t ']) {
      const byPath = await run('nai_get_operation', { record_path: receiptPath, operation_id: blank, output_dir: blank })
      const byId = await run('nai_get_operation', { record_path: blank, operation_id: id, output_dir: root })
      expect(byPath).toMatchObject({ id, status: 'submitted', record_path: receiptPath })
      expect(byId).toEqual(byPath)
      const recovered = await run('nai_recover_request', { source_path: receiptPath, model_override: blank })
      expect(recovered).toMatchObject({ operation_id: id, source_kind: 'operation_receipt', request: { max_anlas: 0 } })
      await expect(run('nai_get_operation', { record_path: blank, operation_id: blank, output_dir: blank })).rejects.toThrow('exactly one')
    }
    await expect(run('nai_get_operation', { record_path: receiptPath, operation_id: id, output_dir: '' })).rejects.toThrow('exactly one')
    await expect(run('nai_get_operation', { record_path: receiptPath, operation_id: '', output_dir: root })).rejects.toThrow('only used with operation_id')
    expect(execute).not.toHaveBeenCalled()
  })

  it('preserves nonblank paths and exact identifiers while normalizing only blank options', async () => {
    const recovery = await import('../src/core/recovery.ts')
    const inspect = vi.spyOn(recovery, 'getOperationStatus').mockReturnValue({ inspected: true })
    const recover = vi.spyOn(recovery, 'recoverRequest').mockResolvedValue({ recovered: true })
    const path = '  path with spaces/receipt.json  '
    await run('nai_get_operation', { record_path: path, operation_id: ' \t ', output_dir: '' })
    expect(inspect).toHaveBeenLastCalledWith({ record_path: path, operation_id: undefined, output_dir: undefined })
    await run('nai_get_operation', { record_path: '', operation_id: ' exact-id ', output_dir: ' output directory ' })
    expect(inspect).toHaveBeenLastCalledWith({ record_path: undefined, operation_id: ' exact-id ', output_dir: ' output directory ' })
    await run('nai_recover_request', { source_path: path, model_override: ' \t ' })
    expect(recover).toHaveBeenLastCalledWith(path, null)
  })

  it('uses discovery defaults for blank optional strings without relaxing required target IDs', async () => {
    const entry = await run('nai_library_save', { name: 'discover', kind: 'artist', prompt: 'artist:one' })
    for (const blank of ['', ' \t ']) {
      expect((await run('nai_library_read', { id: blank, query: blank, kind: blank, offset: 0, limit: 20, prompt_set: -1 })).entries[0].id).toBe(entry.id)
      expect((await run('nai_library_read', { id: entry.id, query: blank, kind: blank, offset: 0, limit: 20, prompt_set: -1 })).entry).toEqual(entry)
      expect(await run('nai_draft_read', { draft_id: blank })).toEqual(wb.store.getDraft())
      expect((await run('nai_draft_list', { query: blank })).total).toBe(1)
      expect((await run('nai_workbench_status', { job_id: blank })).draft).toEqual(wb.store.getDraft())
      await expect(run('nai_library_save', { id: blank, expected_revision: 0, name: 'invalid', kind: 'artist' })).rejects.toThrow()
      await expect(run('nai_library_delete', { id: blank })).rejects.toThrow()
      await expect(run('nai_job_cancel', { id: blank })).rejects.toThrow()
    }
    expect(wb.store.getEntry(entry.id)).toEqual(entry)
    await expect(run('nai_library_read', { id: entry.id, offset: 1, limit: 20 })).rejects.toThrow('non-default pagination')
    await expect(run('nai_library_read', { kind: 'invalid' })).rejects.toThrow()
  })

  it('preserves library content on flat rename and merges nested data while replacing explicit arrays', async () => {
    const asset = wb.store.addAsset({ path: join(root, 'example.png') })
    const original = await run('nai_library_save', {
      name: 'original', kind: 'character', prompt: 'girl, original', negative_prompt: 'bad anatomy', notes: 'keep notes',
      examples: [asset.id], prompt_sets: [{ name: 'alternate', prompt: 'girl, alternate' }],
      data: { custom: { keep: 1, change: 2 }, replace_identity: true },
    })
    const renamed = await run('nai_library_save', { id: original.id, expected_revision: 0, name: 'renamed' })
    expect(renamed.data).toEqual(original.data)
    expect(renamed).toMatchObject({ name: 'renamed', revision: 1 })
    const patched = await run('nai_library_save', {
      id: original.id, expected_revision: 1, notes: 'flat note', prompt: 'flat prompt',
      entry: { data: { notes: 'nested note', custom: { change: 3 }, prompt_sets: [] } },
    })
    expect(patched.data).toEqual({
      prompt: 'flat prompt', negative_prompt: 'bad anatomy', notes: 'nested note', examples: [asset.id],
      prompt_sets: [], custom: { keep: 1, change: 3 }, replace_identity: true,
    })
    const cleared = await run('nai_library_save', { entry: { id: original.id, revision: 2, data: { prompt: '', examples: [] } } })
    expect(cleared.data).toMatchObject({ prompt: '', examples: [], notes: 'nested note', custom: { keep: 1, change: 3 } })
    expect(cleared.revision).toBe(3)
  })

  it('requires an observed library revision and rejects stale, invalid or conflicting updates without changes', async () => {
    const original = await run('nai_library_save', { name: 'stable', kind: 'artist', prompt: 'artist:stable' })
    await expect(run('nai_library_save', { id: original.id, notes: 'missing revision' })).rejects.toThrow('expected_revision')
    await expect(run('nai_library_save', { id: original.id, expected_revision: 1, prompt: 'stale' })).rejects.toThrow()
    await expect(run('nai_library_save', { id: original.id, expected_revision: 0.5 })).rejects.toThrow('expected_revision')
    await expect(run('nai_library_save', { id: original.id, expected_revision: 0, entry: { id: 'another' } })).rejects.toThrow('same entry')
    for (const entry of [[], null, { data: [] }, { data: null }, { data: 'invalid' }]) {
      await expect(run('nai_library_save', { id: original.id, expected_revision: 0, entry })).rejects.toThrow()
    }
    expect(wb.store.getEntry(original.id)).toEqual(original)
    expect(wb.store.listEntries()).toHaveLength(1)
  })

  it('preserves branch identity settings and blend references during partial library updates', async () => {
    const character = await run('nai_library_save', { name: 'character', kind: 'character', prompt: 'girl, identity' })
    const branch = await run('nai_library_save', { name: 'branch', kind: 'branch', parent_id: character.id, prompt: 'coat', data: { replace_identity: true } })
    const changedBranch = await run('nai_library_save', { id: branch.id, expected_revision: 0, notes: 'branch notes' })
    expect(changedBranch).toMatchObject({ parent_id: character.id, data: { prompt: 'coat', replace_identity: true } })
    const artist = await run('nai_library_save', { name: 'artist', kind: 'artist', prompt: 'artist:one' })
    const blend = await run('nai_library_save', { name: 'blend', kind: 'blend', data: { artists: [{ id: artist.id, weight: 0.75 }] } })
    const changedBlend = await run('nai_library_save', { entry: { id: blend.id, revision: 0, data: { notes: 'blend notes' } } })
    expect(changedBlend.data.artists).toEqual([{ id: artist.id, weight: 0.75 }])
  })

  it('searches and paginates compact library summaries then reads complete entries by id', async () => {
    const longPrompt = 'detailed '.repeat(100)
    const character = await run('nai_library_save', { name: 'Discover parent', kind: 'character', prompt: longPrompt, notes: 'large note '.repeat(100) })
    const branch = await run('nai_library_save', { name: 'winter outfit', kind: 'branch', parent_id: character.id, prompt: 'coat', prompt_sets: [{ name: 'summer', prompt: 'dress' }] })
    await run('nai_library_save', { name: 'unrelated artist', kind: 'artist', prompt: 'artist:other' })
    const first = await run('nai_library_read', { query: 'DISCOVER', limit: 1 })
    const second = await run('nai_library_read', { query: 'DISCOVER', offset: first.next_offset, limit: 1 })
    expect(first).toMatchObject({ total: 2, offset: 0, limit: 1, next_offset: 1 })
    expect(second).toMatchObject({ total: 2, offset: 1, next_offset: null })
    expect(new Set([...first.entries, ...second.entries].map((entry: any) => entry.id))).toEqual(new Set([character.id, branch.id]))
    for (const entry of [...first.entries, ...second.entries]) {
      expect(entry.data).toBeUndefined()
      expect(entry.notes).toBeUndefined()
      expect(entry.prompt_preview.length).toBeLessThanOrEqual(161)
    }
    const filtered = await run('nai_library_read', { query: 'discover', kind: 'branch' })
    expect(filtered.entries).toEqual([expect.objectContaining({ id: branch.id, parent_name: 'Discover parent', prompt_set_count: 1 })])
    const exact = await run('nai_library_read', { id: character.id })
    expect(exact.entry).toEqual(character)
    expect(exact.entry.data.prompt).toBe(longPrompt)
    expect(exact.parent).toBeNull()
    expect((await run('nai_library_read', { query: 'not present' })).entries).toEqual([])
    expect((await run('nai_library_read', { offset: 99 })).entries).toEqual([])
  })

  it('composes inherited branch prompts, selected prompt sets and weighted artist blends through exact reads', async () => {
    const parent = await run('nai_library_save', { name: 'parent', kind: 'character', prompt: 'girl, identity', negative_prompt: 'parent negative' })
    const branch = await run('nai_library_save', {
      name: 'outfit', kind: 'branch', parent_id: parent.id, prompt: 'coat', negative_prompt: 'branch negative',
      prompt_sets: [{ name: 'summer', prompt: 'dress', negative_prompt: 'set negative' }],
    })
    const exact = await run('nai_library_read', { id: branch.id })
    expect(exact.parent).toEqual(parent)
    expect(exact.composed_prompt).toEqual({ prompt: 'girl, identity, coat', negative_prompt: 'parent negative, branch negative' })
    expect((await run('nai_library_read', { id: branch.id, prompt_set: 0 })).composed_prompt).toEqual({ prompt: 'girl, identity, dress', negative_prompt: 'parent negative, set negative' })
    await run('nai_library_save', { id: branch.id, expected_revision: 0, data: { replace_identity: true } })
    expect((await run('nai_library_read', { id: branch.id })).composed_prompt.prompt).toBe('coat')
    const artist = await run('nai_library_save', { name: 'artist', kind: 'artist', prompt: 'artist:one' })
    const blend = await run('nai_library_save', { name: 'blend', kind: 'blend', negative_prompt: 'blend negative', data: { artists: [{ id: artist.id, weight: 0.6 }] } })
    expect((await run('nai_library_read', { id: blend.id })).composed_prompt).toEqual({ prompt: '0.6::artist:one::', negative_prompt: 'blend negative' })
    await expect(run('nai_library_read', { id: branch.id, prompt_set: 1 })).rejects.toThrow()
    await expect(run('nai_library_read', { id: 'missing' })).rejects.toThrow()
  })

  it('discovers inactive drafts with compact pagination without changing the active draft', async () => {
    const active = wb.store.getDraft()
    const target = wb.store.createDraft({ name: 'Discover target', request: { model: 'v5', prompt: 'long '.repeat(100), characters: [{ prompt: 'private character details' }] } }, false)
    wb.store.createDraft({ name: 'Discover another' }, false)
    const first = await run('nai_draft_list', { query: 'DISCOVER', limit: 1 })
    const second = await run('nai_draft_list', { query: 'DISCOVER', offset: 1, limit: 1 })
    expect(first).toMatchObject({ total: 2, next_offset: 1, active_draft_id: active.id })
    expect(second.next_offset).toBeNull()
    const summary = [...first.drafts, ...second.drafts].find((draft: any) => draft.id === target.id)
    expect(summary).toMatchObject({ name: 'Discover target', revision: 0, active: false, model: 'v5' })
    expect(summary.request).toBeUndefined()
    expect(summary.prompt_preview).toHaveLength(161)
    expect((await run('nai_draft_read', { draft_id: summary.id })).request).toEqual(target.request)
    expect((await run('nai_draft_list')).drafts.find((draft: any) => draft.id === active.id).active).toBe(true)
    expect(wb.store.activeDraftId()).toBe(active.id)
  })

  it('rejects invalid discovery pagination and ambiguous library reads', async () => {
    for (const name of ['nai_library_read', 'nai_draft_list']) {
      for (const args of [{ offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }]) {
        await expect(run(name, args)).rejects.toThrow()
      }
    }
    await expect(run('nai_library_read', { id: 'entry', query: 'search' })).rejects.toThrow('cannot be combined')
    await expect(run('nai_library_read', { prompt_set: 0 })).rejects.toThrow('requires id')
    await expect(run('nai_library_read', { kind: 'invalid' })).rejects.toThrow()
  })

  it('classifies read-only operations as parallel and all state writes as exclusive', () => {
    for (const [name, tool] of tools) {
      expect(typeof tool.isConcurrencySafe).toBe('function')
      if (['nai_generate_image', 'nai_draft_patch', 'nai_workbench_submit', 'nai_prepare_image', 'nai_queue_pause', 'nai_schedule_save', 'nai_library_save', 'nai_library_delete'].includes(name)) expect(tool.isConcurrencySafe({})).toBe(false)
    }
    expect(tools.get('nai_quote').isConcurrencySafe({ prompt: 'scenery' })).toBe(true)
    expect(tools.get('nai_validate_operation').isConcurrencySafe({ operation: 'img2img' })).toBe(true)
    expect(tools.get('nai_draft_read').isConcurrencySafe({})).toBe(true)
    expect(tools.get('nai_draft_list').isConcurrencySafe({})).toBe(true)
    expect(tools.get('nai_library_read').isConcurrencySafe({})).toBe(true)
  })

  it('does not start an already-aborted mutation', async () => {
    const signal = AbortSignal.abort()
    await expect(run('nai_queue_pause', { paused: true }, signal)).rejects.toBe(signal.reason)
    expect(wb.store.getPaused()).toBe(false)
  })

  it('does not read credits if quoting was cancelled during offline preparation', async () => {
    const controller = new AbortController()
    const original = wb.validate.bind(wb)
    vi.spyOn(wb, 'validate').mockImplementation(async (op, request) => { const result = await original(op, request); controller.abort(); return result })
    const credits = vi.spyOn(wb.executor, 'credits')
    const failure = await run('nai_quote', { prompt: 'scenery' }, controller.signal).catch((error: unknown) => error)
    expect(failure).toBe(controller.signal.reason)
    expect(credits).not.toHaveBeenCalled()
  })

  it('preserves executor abort identity without labelling it as invalid input', async () => {
    const error = new DOMException('cancelled', 'AbortError')
    vi.spyOn(wb.executor, 'execute').mockRejectedValue(error)
    await expect(run('nai_generate_image', { prompt: 'scenery' })).rejects.toBe(error)
  })

  it('renders artifacts, warnings and receipt while omitting retired budget fields', async () => {
    const result = { id: 'operation', operation: 'generate', artifact_paths: ['first.png', 'second.png'], record_path: 'receipt.json', warnings: ['Optional metadata inspection failed'], max_anlas: 0, estimated_anlas: 0, anlas_spent: null, image_metadata: { retained: true } }
    vi.spyOn(wb.executor, 'execute').mockResolvedValue(result)
    vi.spyOn(wb, 'registerDirectGeneration').mockResolvedValue()
    const output = await run('nai_generate_image', { prompt: 'scenery' })
    const text = tools.get('nai_generate_image').output.render({}, output)[0].text
    for (const value of ['second.png', 'receipt.json', 'Optional metadata inspection failed', 'image_path', 'operation']) expect(text).toContain(value)
    expect(output.max_anlas).toBeUndefined()
    expect(output.estimated_anlas).toBeUndefined()
    expect(output.image_metadata).toBeUndefined()
    expect(result.image_metadata).toEqual({ retained: true })
  })

  it('preserves provider failure evidence and adds receipt recovery guidance', async () => {
    const error = new NovelAIError('Response lost. Receipt: receipt.json.')
    error.status_code = 500
    Object.assign(error, { submission_outcome_unknown: true })
    vi.spyOn(wb.executor, 'execute').mockRejectedValue(error)
    const failure = await run('nai_generate_image', { prompt: 'scenery' }).catch((value: unknown) => value)
    expect(failure).toBeInstanceOf(ToolFailure)
    expect(failure.cause).toBe(error)
    expect(failure.message).toContain('receipt.json')
    expect(failure.message).toContain('nai_image_info')
    expect(failure.message).not.toContain('请求无效')
    expect(new ToolFailure(new NovelAIError('No generation was submitted')).message).not.toContain('nai_image_info')
  })

  it('keeps the legacy local image preparation validation path available', async () => {
    const result = await run('nai_validate_operation', { operation: 'prepare_image', image_path: 'source.png', width: 64, height: 64, mode: 'pad', mask_boxes: [[1, 1, 10, 10]] })
    expect(result.valid).toBe(true)
    expect(result.resolved_request.mask_boxes).toEqual([[1, 1, 10, 10]])
  })

  it('normalizes tag lookup aliases and rejects invalid lookup arguments without networking', async () => {
    const lookup = vi.spyOn(wb.executor, 'suggestTags').mockResolvedValue([{ tag: 'blue sky' }, { tag: 'sky' }])
    const controller = new AbortController()
    const result = await run('nai_suggest_tags', { query: 'sky', model: 'v5', language: 'jp', limit: 1 }, controller.signal)
    expect(result.tags).toEqual([{ tag: 'blue sky' }])
    expect(lookup).toHaveBeenCalledWith('sky', 'nai-diffusion-5-full', 'jp', controller.signal)
    lookup.mockClear()
    for (const args of [{ query: 'x' }, { query: 'sky', limit: 1.5 }, { query: 'sky', language: 'invalid' }, { query: 'sky', model: 'unknown' }]) await expect(run('nai_suggest_tags', args)).rejects.toThrow()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('accepts null gallery flags as unchanged, matching the documented legacy contract', async () => {
    const batch = await run('nai_workbench_submit', { prompt: 'scenery' })
    const id = batch.jobs[0].id
    await run('nai_gallery_curate', { ids: [id], favorite: true })
    await run('nai_gallery_curate', { ids: [id], favorite: null, archived: null })
    expect(wb.store.getJob(id).favorite).toBe(true)
  })

  it('loads the full operation field contract only on request', async () => {
    const defaults = await run('nai_get_presets', { model: 'v5' })
    expect(defaults.request_parameters).toBeUndefined()
    const details = await run('nai_get_presets', { model: 'v5', operation: 'inpaint' })
    for (const key of ['prompt', 'characters', 'steps', 'cfg_rescale', 'mask_path', 'focus_box', 'focus_size', 'extra_noise_seed']) expect(details.request_parameters[key]).toBeDefined()
    expect(details.request_parameters.width.default).toBeUndefined()
    await expect(run('nai_get_presets', { operation: 'unknown' })).rejects.toThrow('未知操作')
  })

  it('accepts preset aliases and returns a canonical default model', async () => {
    expect((await run('nai_get_presets', { model: 'v4.5' })).model).toBe('nai-diffusion-4-5-full')
    expect((await run('nai_get_presets')).model).toBe('nai-diffusion-5-full')
  })
})
