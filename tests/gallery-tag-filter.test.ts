import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workbench } from '../src/workbench/app.ts'

const roots: string[] = []
function workbench(): Workbench {
  const root = mkdtempSync(join(tmpdir(), 'nai-gallery-tag-'))
  roots.push(root)
  return new Workbench(root)
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const job = (wb: Workbench, request: Record<string, unknown>): Record<string, unknown> =>
  wb.store.recordDirectJob({ operation: 'generate', request, library_refs: [] }, { artifact_paths: [], anlas_spent: 0, warnings: [] }, 0)

describe('gallery character and artist tag filters', () => {
  it('matches the character first tag in scene or character prompts, ignoring case and extra spaces', () => {
    const wb = workbench()
    const character = wb.store.saveEntry({ kind: 'character', name: '东云彰人', data: { prompt: 'shinonome akito, orange hair' } })
    const inScene = job(wb, { model: 'nai-diffusion-5-full', prompt: 'stage, Shinonome  Akito, spotlight' })
    const inSlot = job(wb, { model: 'nai-diffusion-5-full', prompt: 'portrait', characters: [{ prompt: 'shinonome akito, jacket' }] })
    const unrelated = job(wb, { model: 'nai-diffusion-5-full', prompt: 'forest' })

    const result = wb.store.queryJobs({ characterId: String(character['id']) })
    expect(result.total).toBe(2)
    expect(result.items.map((item) => item['id'])).toEqual(expect.arrayContaining([inScene['id'], inSlot['id']]))
    expect(result.items.some((item) => item['id'] === unrelated['id'])).toBe(false)
    wb.stop()
  })

  it('matches the whole artist prompt and requires both filters when both are selected', () => {
    const wb = workbench()
    const character = wb.store.saveEntry({ kind: 'character', name: '凌阳', data: { prompt: 'lingyang (wuthering waves), white hair' } })
    const artist = wb.store.saveEntry({ kind: 'artist', name: 'WLOP', data: { prompt: 'wlop' } })
    const both = job(wb, { model: 'nai-diffusion-5-full', prompt: 'lingyang (wuthering waves), portrait, wlop' })
    const artistOnly = job(wb, { model: 'nai-diffusion-5-full', prompt: 'scenery, wlop' })
    const characterOnly = job(wb, { model: 'nai-diffusion-5-full', prompt: 'lingyang (wuthering waves), portrait' })

    const byArtist = wb.store.queryJobs({ artistId: String(artist['id']) })
    expect(byArtist.items.map((item) => item['id'])).toEqual(expect.arrayContaining([both['id'], artistOnly['id']]))
    expect(byArtist.items.some((item) => item['id'] === characterOnly['id'])).toBe(false)

    const byBoth = wb.store.queryJobs({ characterId: String(character['id']), artistId: String(artist['id']) })
    expect(byBoth.total).toBe(1)
    expect(byBoth.items[0]?.['id']).toBe(both['id'])
    wb.stop()
  })

  it('matches nothing for missing entries, wrong kinds and empty first tags', () => {
    const wb = workbench()
    const artist = wb.store.saveEntry({ kind: 'artist', name: 'WLOP', data: { prompt: 'wlop' } })
    const blank = wb.store.saveEntry({ kind: 'character', name: 'Blank', data: { prompt: ' , silver hair' } })
    job(wb, { model: 'nai-diffusion-5-full', prompt: 'scenery, wlop' })

    expect(wb.store.queryJobs({ characterId: 'missing' }).total).toBe(0)
    expect(wb.store.queryJobs({ characterId: String(artist['id']) }).total).toBe(0)
    expect(wb.store.queryJobs({ artistId: String(blank['id']) }).total).toBe(0)
    expect(wb.store.queryJobs({ characterId: String(blank['id']) }).total).toBe(0)
    wb.stop()
  })

  it('takes the literal first tag without skipping generic words', () => {
    const wb = workbench()
    const character = wb.store.saveEntry({ kind: 'character', name: 'Mira', data: { prompt: '1boy, mira, red coat' } })
    const generic = job(wb, { model: 'nai-diffusion-5-full', prompt: '1boy, forest' })
    const named = job(wb, { model: 'nai-diffusion-5-full', prompt: '1boy, mira, red coat' })

    const result = wb.store.queryJobs({ characterId: String(character['id']) })
    expect(result.items.map((item) => item['id'])).toEqual(expect.arrayContaining([generic['id'], named['id']]))
    wb.stop()
  })
})
