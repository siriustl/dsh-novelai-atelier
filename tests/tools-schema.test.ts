import { describe, it, expect } from 'vitest'
import { registerTools } from '../src/tools.ts'
import { Workbench } from '../src/workbench/app.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const DEFAULT_TOOL_NAMES = [
  'nai_generate_image', 'nai_edit_image', 'nai_check_credits', 'nai_quote', 'nai_get_presets',
  'nai_suggest_tags', 'nai_image_info', 'nai_prepare_image', 'nai_get_prompt_guide',
  'nai_workbench_status', 'nai_draft', 'nai_library_read', 'nai_library_save',
  'nai_schedule_save', 'nai_gallery_read', 'nai_gallery_curate',
]

describe('tool schema compilation via defineTool', () => {
  it('exposes exactly sixteen useful tools by default and reports the actual catalog', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nai-schema-test-'))
    const wb = new Workbench(dir)
    try {
      const registered: any[] = []
      const ctx: any = { effect(fn: () => void) { fn() }, tools: { register(tool: any) { registered.push(tool) } } }
      expect(() => registerTools(ctx, wb)).not.toThrow()
      const names = registered.map((tool) => tool.name)
      expect(names).toEqual(DEFAULT_TOOL_NAMES)
      expect(new Set(names).size).toBe(16)
      const schemaJSON = JSON.stringify(registered.map(({ name, description, parameters }) => ({ name, description, parameters })))
      expect(schemaJSON.length).toBeLessThan(24000)
      console.log(JSON.stringify({ nai_schema_count: names.length, characters: schemaJSON.length, utf8_bytes: Buffer.byteLength(schemaJSON), dsh_estimated_tokens: Math.ceil(schemaJSON.length / 4) + 4 }))
      const find = (name: string) => registered.find((tool) => tool.name === name)
      const info = await find('nai_workbench_status').execute({ info: true }, { signal: new AbortController().signal })
      expect(info.tools).toEqual(names)
      expect(info.runtime_version).toBeDefined()
      expect(info.draft).toBeUndefined()
      for (const name of names) {
        expect(find(name).description.length).toBeGreaterThan(10)
        for (const [mentioned] of find(name).description.matchAll(/\bnai_[a-z][a-z0-9_]+/g)) expect(names).toContain(mentioned)
      }
      const save = find('nai_library_save').parameters.properties
      for (const field of ['prompt', 'negative_prompt', 'notes', 'prompt_sets', 'examples', 'data']) {
        expect(save[field]).toBeDefined()
        expect(save[field].default).toBeUndefined()
      }
      expect(save.expected_revision.description).toContain('必需')
      expect(save.action.enum).toEqual(['save', 'delete'])
      expect(find('nai_schedule_save').parameters.required ?? []).not.toContain('schedule')
      for (const name of ['nai_generate_image', 'nai_edit_image']) expect(find(name).parameters.properties.max_anlas).toBeUndefined()
      expect(find('nai_edit_image').parameters.required).toContain('operation')
      expect(find('nai_image_info').parameters.required).toContain('action')
      const draft = find('nai_draft')
      expect(draft.parameters.required).toContain('action')
      for (const field of ['query', 'offset', 'limit']) expect(draft.parameters.properties[field]).toBeDefined()
      expect(draft.isConcurrencySafe({ action: 'read' })).toBe(true)
      expect(draft.isConcurrencySafe({ action: 'list' })).toBe(true)
      expect(draft.isConcurrencySafe({ action: 'update' })).toBe(false)
      expect(find('nai_image_info').isConcurrencySafe({ action: 'recover' })).toBe(true)
      expect(find('nai_library_read').isConcurrencySafe({})).toBe(true)
      expect(find('nai_gallery_read').isConcurrencySafe({ include_recipe: true })).toBe(true)
      const kind = find('nai_library_read').parameters.properties.kind
      expect(kind.type).toBe('string')
      expect(kind.enum).toBeUndefined()
      for (const value of ['character', 'branch', 'artist', 'blend', 'preset']) expect(kind.description).toContain(value)
      const originalQuery = wb.store.queryJobs
      let received: any
      wb.store.queryJobs = ((options: any) => {
        received = options
        return { total: 1, items: [{ id: 'job-1', status: 'completed', operation: 'generate', created_at: '2025-01-02T00:00:00.000Z', request: { model: 'nai-diffusion-5-full', prompt: 'forest scene' }, assets: [{ mime: 'image/png', path: 'C:/images/forest.png' }], context: { secret: 'not returned' } }] }
      }) as any
      const galleryContext = { signal: new AbortController().signal }
      const gallery = await find('nai_gallery_read').execute({ query: 'forest', model: 'nai-diffusion-5-full', character_id: 'character-1', artist_id: 'artist-1', schedule_id: 'schedule-1', after: '2025-01-01T00:00:00.000Z', limit: 5 }, galleryContext)
      expect(received).toMatchObject({ query: 'forest', model: 'nai-diffusion-5-full', characterId: 'character-1', artistId: 'artist-1', scheduleId: 'schedule-1', limit: 5 })
      expect(gallery.items[0]).toMatchObject({ id: 'job-1', prompt_preview: 'forest scene', image_paths: ['C:/images/forest.png'] })
      expect(gallery.items[0].request).toBeUndefined()
      expect(gallery.items[0].context).toBeUndefined()
      const fullGallery = await find('nai_gallery_read').execute({ include_recipe: true }, galleryContext)
      expect(fullGallery.items[0].request).toEqual({ model: 'nai-diffusion-5-full', prompt: 'forest scene' })
      wb.store.queryJobs = originalQuery
    } finally { wb.stop(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('registers retired callers only when legacyTools is explicitly true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nai-legacy-schema-')), wb = new Workbench(dir)
    try {
      const names: string[] = []
      registerTools({ effect: (fn: () => void) => fn(), tools: { register: (tool: any) => names.push(tool.name) } } as never, wb, { legacyTools: true })
      expect(names).toEqual(expect.arrayContaining([...DEFAULT_TOOL_NAMES, 'nai_workbench_submit', 'nai_queue_pause', 'nai_job_cancel', 'nai_img2img', 'nai_validate_request', 'nai_validate_operation', 'nai_draft_read', 'nai_draft_patch', 'nai_library_delete', 'nai_schedule_delete', 'nai_server_info']))
      expect(names).toHaveLength(37)
      expect(new Set(names).size).toBe(names.length)
    } finally { wb.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})
