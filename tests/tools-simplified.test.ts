import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools, ToolFailure } from '../src/tools.ts'
import { Workbench } from '../src/workbench/app.ts'
import { NovelAIError, NovelAINotSubmitted } from '../src/core/client.ts'
import * as operations from '../src/core/operations.ts'
import * as recovery from '../src/core/recovery.ts'
import { Raster } from '../src/core/raster.ts'
import { NOVELAI_PROMPTING } from '../src/workbench/skill.ts'

let root: string, wb: Workbench, tools: Map<string, any>
const run = (name: string, args: Record<string, unknown> = {}) => tools.get(name).execute(args, { signal: new AbortController().signal })
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nai-simple-tools-'))
  wb = new Workbench(root)
  tools = new Map()
  registerTools({ effect: (fn: () => void) => fn(), tools: { register: (tool: any) => tools.set(tool.name, tool) } } as never, wb)
})
afterEach(() => { wb.stop(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

const mockRemote = () => {
  const prepare = vi.spyOn(operations, 'prepareOperation').mockImplementation(async (request, operation) => ({ operation, summary: { request }, payload: {} }) as never)
  const execute = vi.spyOn(wb.executor, 'execute').mockImplementation(async (prepared) => ({ id: 'direct', operation: prepared.operation, artifact_paths: [join(root, 'final.png')], record_path: join(root, 'receipt.json'), anlas_spent: null, warnings: [] }))
  vi.spyOn(wb, 'registerDirectGeneration').mockResolvedValue()
  return { prepare, execute }
}

describe('simplified default tools', () => {
  it.each(['img2img', 'inpaint', 'enhance', 'upscale', 'augment', 'encode_vibe'])('dispatches edit %s with request precedence and final image rendering', async (operation) => {
    const { prepare, execute } = mockRemote()
    const output = await run('nai_edit_image', { operation, image_path: 'outer.png', prompt: 'outer', model: 'v5', request: { image_path: 'inner.png', prompt: 'inner', strength: 0.3, seed: 42 } })
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ image_path: 'inner.png', prompt: 'inner', model: 'nai-diffusion-5-full', seed: 42, strength: 0.3 }), operation)
    expect(prepare.mock.calls[0][0]).not.toHaveProperty('operation')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(output.image_path).toBe(join(root, 'final.png'))
    expect(output.anlas_spent).toBeNull()
    expect(tools.get('nai_edit_image').output.render({}, output)[0].text).toContain('![NovelAI output]')
  })

  it('keeps operation-specific model and strength defaults when editing without a request wrapper', async () => {
    const source = join(root, 'source.png')
    writeFileSync(source, new Raster(64, 64, new Uint8Array(64 * 64 * 4).fill(255)).toPng())
    const execute = vi.spyOn(wb.executor, 'execute').mockResolvedValue({ id: 'local', artifact_paths: [], warnings: [] })
    vi.spyOn(wb, 'registerDirectGeneration').mockResolvedValue()
    await run('nai_edit_image', { operation: 'encode_vibe', image_path: source })
    expect(execute.mock.lastCall?.[0].payload.model).toBe('nai-diffusion-4-5-full')
    await run('nai_edit_image', { operation: 'img2img', image_path: source, prompt: 'scenery' })
    expect(execute.mock.lastCall?.[0].payload.model).toBe('nai-diffusion-5-full')
    expect((execute.mock.lastCall?.[0].payload.parameters as Record<string, unknown>).strength).toBe(0.7)
    await run('nai_edit_image', { operation: 'enhance', image_path: source, prompt: 'scenery' })
    expect((execute.mock.lastCall?.[0].payload.parameters as Record<string, unknown>).strength).toBe(0.2)
    expect((await run('nai_get_presets', { operation: 'encode_vibe' })).request_parameters).not.toHaveProperty('max_anlas')
  })

  it('requires the edit operation and rejects undeclared operations before execution', async () => {
    const { execute } = mockRemote()
    await expect(run('nai_edit_image', { image_path: 'source.png' })).rejects.toThrow()
    await expect(run('nai_edit_image', { operation: 'generate', image_path: 'source.png' })).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('generates once with V5 defaults and no prerequisite credits or quote call', async () => {
    const { prepare, execute } = mockRemote()
    const credits = vi.spyOn(wb.executor, 'credits')
    const result = await run('nai_generate_image', { prompt: 'scenery, forest', seed: 42 })
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ model: 'nai-diffusion-5-full', prompt: 'scenery, forest', seed: 42 }), 'generate')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(credits).not.toHaveBeenCalled()
    expect(result).toMatchObject({ image_path: join(root, 'final.png'), record_path: join(root, 'receipt.json'), anlas_spent: null })
    expect(result).not.toHaveProperty('credits_after')
  })

  it.each([
    { vibes: [{ encoding_path: 'saved.vibe', strength: 0.6 }] },
    { precise_references: [{ image_path: 'character.png', type: 'character', strength: 0.8, fidelity: 0.7 }] },
  ])('automatically dispatches references with V4.5 defaults and preserves explicit models', async (references) => {
    const { prepare } = mockRemote()
    await run('nai_generate_image', { prompt: 'scenery', ...references })
    expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ ...references, model: 'nai-diffusion-4-5-full' }), 'reference_generate')
    await run('nai_generate_image', { prompt: 'scenery', request: { ...references, model: 'v4.5-curated' } })
    expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ ...references, model: 'nai-diffusion-4-5-curated' }), 'reference_generate')
    await run('nai_generate_image', { prompt: 'scenery', ...references, model: 'v5' })
    expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'nai-diffusion-5-full' }), 'reference_generate')
  })

  it('uses ordinary generation for empty reference lists', async () => {
    const { prepare } = mockRemote()
    await run('nai_generate_image', { prompt: 'scenery', vibes: [], precise_references: [] })
    expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'nai-diffusion-5-full' }), 'generate')
  })

  it('validates locally through quote.offline without a network prerequisite', async () => {
    const credits = vi.spyOn(wb.executor, 'credits'), execute = vi.spyOn(wb.executor, 'execute')
    const result = await run('nai_quote', { offline: true, request: { prompt: 'scenery', seed: 42 } })
    expect(result).toMatchObject({ valid: true, resolved_request: { seed: 42 }, warnings: [] })
    expect(result.resolved_request).not.toHaveProperty('offline')
    expect(credits).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect((await run('nai_quote', { offline: true, operation: 'prepare_image', request: { image_path: 'source.png', width: 64, height: 64 } })).valid).toBe(true)
  })

  it('lists, reads and updates drafts through one action selector', async () => {
    const target = wb.store.createDraft({ name: 'forest', request: { prompt: 'forest', characters: [{ prompt: 'girl' }], nested: { keep: 1, change: 2 } } }, false)
    expect((await run('nai_draft', { action: 'list', query: 'forest' })).drafts[0].id).toBe(target.id)
    const read = await run('nai_draft', { action: 'read', draft_id: target.id })
    const updated = await run('nai_draft', { action: 'update', draft_id: read.id, base_revision: read.revision, prompt: 'autumn forest', request: { characters: [], nested: { change: 3 } } })
    expect(updated.draft.request).toMatchObject({ prompt: 'autumn forest', characters: [], nested: { keep: 1, change: 3 } })
    expect(updated.draft.request).not.toHaveProperty('action')
    await expect(run('nai_draft', { action: 'update', draft_id: read.id, base_revision: read.revision, prompt: 'stale' })).rejects.toThrow()
    expect(wb.store.getDraft().id).not.toBe(target.id)
  })

  it('saves reusable memory, reads before updating, and deletes via save action with revision checks', async () => {
    const saved = await run('nai_library_save', { name: 'Forest watercolor', kind: 'preset', prompt: 'watercolor, muted greens' })
    expect(saved).not.toHaveProperty('action')
    const read = await run('nai_library_read', { id: saved.id })
    const updated = await run('nai_library_save', { id: saved.id, expected_revision: read.entry.revision, notes: 'Reusable forest style' })
    await expect(run('nai_library_save', { action: 'delete', id: saved.id, expected_revision: read.entry.revision })).rejects.toThrow()
    expect(wb.store.getEntry(saved.id)).toEqual(updated)
    expect(await run('nai_library_save', { action: 'delete', id: saved.id, expected_revision: updated.revision })).toMatchObject({ deleted: true, id: saved.id })
    await expect(run('nai_library_save', { action: 'delete' })).rejects.toThrow('requires id')
    expect(wb.store.listEntries()).toEqual([])
  })

  it('requires schedule only for save and deletes without schedule', async () => {
    await expect(run('nai_schedule_save', {})).rejects.toThrow('save requires schedule')
    const plan = await run('nai_schedule_save', { schedule: { name: 'forest', kind: 'interval', interval_minutes: 60, enabled: false, request: { prompt: 'scenery, forest' } } })
    expect(await run('nai_schedule_save', { action: 'delete', id: plan.id })).toMatchObject({ deleted: true, id: plan.id })
    await expect(run('nai_schedule_save', { action: 'delete' })).rejects.toThrow('requires id')
    expect(wb.store.listSchedules()).toEqual([])
  })

  it('dispatches local inspect, receipt operation and request recovery with explicit arguments', async () => {
    const path = join(root, 'source.png')
    writeFileSync(path, new Raster(64, 64, new Uint8Array(64 * 64 * 4).fill(255)).toPng())
    expect(await run('nai_image_info', { action: 'inspect', path })).toBeDefined()
    const inspect = vi.spyOn(recovery, 'getOperationStatus').mockReturnValue({ status: 'submitted' })
    const recover = vi.spyOn(recovery, 'recoverRequest').mockResolvedValue({ request: { max_anlas: 0 } })
    await run('nai_image_info', { action: 'operation', record_path: ' receipt.json ', operation_id: ' ', output_dir: '' })
    expect(inspect).toHaveBeenCalledWith({ record_path: ' receipt.json ', operation_id: undefined, output_dir: undefined })
    await run('nai_image_info', { action: 'recover', source_path: ' receipt.json ', model_override: ' ' })
    expect(recover).toHaveBeenCalledWith(' receipt.json ', null)
    await expect(run('nai_image_info', { action: 'recover' })).rejects.toThrow('requires source_path')
    await expect(run('nai_image_info', { action: 'inspect', path, record_path: 'receipt.json' })).rejects.toThrow('only accepts path')
  })

  it('surfaces gallery persistence warnings without losing saved image results', async () => {
    mockRemote()
    vi.spyOn(wb, 'registerDirectGeneration').mockRejectedValue(new Error('disk full'))
    const result = await run('nai_generate_image', { prompt: 'scenery' })
    expect(result.image_path).toBe(join(root, 'final.png'))
    expect(result.warnings.join(' ')).toContain('gallery registration failed')
  })

  it('adds receipt advice only for explicitly ambiguous submissions, never preflight 401 or not-submitted errors', async () => {
    const unauthorized = Object.assign(new NovelAIError('HTTP 401'), { status_code: 401 })
    expect(new ToolFailure(unauthorized).message).not.toContain('nai_image_info')
    expect(new ToolFailure(new NovelAINotSubmitted(new Error('cancelled before POST'))).message).not.toContain('nai_image_info')
    expect(new ToolFailure(new NovelAIError('preflight failed')).message).not.toContain('nai_image_info')
    const unknown = Object.assign(new NovelAIError('Response lost. Receipt: receipt.json.'), { submission_outcome_unknown: true })
    expect(new ToolFailure(unknown).message).toContain('nai_image_info')
    expect(new ToolFailure(unknown).message).toContain('do not manually retry')
  })

  it('makes remembering reusable character, artist, style and preset actionable in descriptions and skill', () => {
    const description = tools.get('nai_library_save').description
    for (const phrase of ['记住', '保存', '角色', '画师', '风格', '预设', 'nai_library_read', 'expected_revision']) expect(description).toContain(phrase)
    expect(NOVELAI_PROMPTING.whenToUse).toContain('remember/save')
    for (const phrase of ['nai_library_save({', 'nai_library_read({id:', 'expected_revision:2', 'kind:"character"', 'kind:"preset"', 'No separate quote or validation is required']) expect(NOVELAI_PROMPTING.content).toContain(phrase)
    for (const [name] of NOVELAI_PROMPTING.content.matchAll(/\bnai_[a-z][a-z0-9_]+/g)) expect(tools.has(name), name).toBe(true)
  })
})
