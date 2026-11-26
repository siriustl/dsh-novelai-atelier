import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/workbench/store.ts'
import { normalizeRequest } from '../src/core/normalize.ts'
import { GenerationRequestSchema } from '../src/core/models.ts'

describe('tools ergonomics integration', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nai-tools-test-'))
    store = new Store(dir)
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('allows flat properties to merge cleanly into store draft', () => {
    const current = store.getDraft()
    const baseRev = current.revision as number
    const args = {
      prompt: 'masterpiece, 1girl, silver hair',
      model: 'v5',
      sampler: 'Euler',
      width: 800,
      height: 1200,
    }

    // Simulate nai_draft_patch logic
    const curReq = (current['request'] && typeof current['request'] === 'object') ? (current['request'] as Record<string, unknown>) : {}
    const topLevelReq = normalizeRequest(args, ['name', 'operation', 'locked_fields', 'library_refs', 'patch', 'base_revision'])
    const mergedRequest = { ...curReq, ...topLevelReq }

    const updated = store.saveDraft({ request: mergedRequest }, baseRev)
    const req = updated.request as Record<string, unknown>

    expect(req.prompt).toBe('masterpiece, 1girl, silver hair')
    expect(req.model).toBe('nai-diffusion-5-full')
    expect(req.sampler).toBe('k_euler')
    expect(req.width).toBe(832)
    expect(req.height).toBe(1216)
    expect(req.noise_schedule).toBeUndefined()
    expect(GenerationRequestSchema.parse(req).noise_schedule).toBe('karras')
  })

  it('allows flat library saving without manual data wrapper', () => {
    const args = {
      name: 'Elysia',
      kind: 'character',
      prompt: '1girl, pink hair, elf ears',
      negative_prompt: 'bad eyes',
      notes: 'Test character note',
    }

    // Simulate nai_library_save logic
    const rawEntry = { ...args } as Record<string, unknown>
    if (!rawEntry.data || typeof rawEntry.data !== 'object') {
      rawEntry.data = {
        prompt: rawEntry.prompt ?? '',
        negative_prompt: rawEntry.negative_prompt ?? '',
        prompt_sets: rawEntry.prompt_sets ?? [],
        examples: rawEntry.examples ?? [],
        notes: rawEntry.notes ?? '',
      }
      delete rawEntry.prompt
      delete rawEntry.negative_prompt
      delete rawEntry.prompt_sets
      delete rawEntry.examples
      delete rawEntry.notes
    }

    const saved = store.saveEntry(rawEntry, null, null)
    expect(saved.id).toBeDefined()
    expect(saved.name).toBe('Elysia')
    expect(saved.kind).toBe('character')
    const data = saved.data as Record<string, unknown>
    expect(data.prompt).toBe('1girl, pink hair, elf ears')
    expect(data.negative_prompt).toBe('bad eyes')
    expect(data.notes).toBe('Test character note')
  })
})
