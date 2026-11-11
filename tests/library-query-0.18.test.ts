import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/workbench/store.ts'

const roots: string[] = []
function store(): Store {
  const root = mkdtempSync(join(tmpdir(), 'nai-library-query-'))
  roots.push(root)
  return new Store(root)
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const save = (value: Store, kind: string, name: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  value.saveEntry({ kind, name, data, ...extra })

describe('library query projection and facets', () => {
  it('returns facets, search, tags, favorites and parent-aware branch rows', () => {
    const s = store()
    const mira = save(s, 'character', 'Mira', { prompt: 'girl, silver hair, red coat', tags: ['主角', '红瞳'], favorite: true })
    save(s, 'branch', '默认服装', { prompt: 'black dress' }, { parent_id: mira['id'] })
    save(s, 'artist', 'Aki', { prompt: 'artist:aki' })
    save(s, 'preset', '晨光', { prompt: 'morning light, soft shadow' })

    const all = s.queryEntries({ limit: 20 })
    expect(all.total).toBe(4)
    expect(all.facets).toMatchObject({ all: 4, kinds: { character: 1, branch: 1, artist: 1, blend: 0, preset: 1 }, favorites: 1 })
    expect(all.facets.tags).toEqual(expect.arrayContaining([{ name: '主角', count: 1 }, { name: '红瞳', count: 1 }]))

    const tagged = s.queryEntries({ tag: '红瞳' })
    expect(tagged.total).toBe(1)
    expect(tagged.items[0]).toMatchObject({ id: mira['id'], tags: ['主角', '红瞳'], favorite: true })

    const search = s.queryEntries({ query: 'mira' })
    expect(search.total).toBe(2)
    const branch = search.items.find((item: Record<string, unknown>) => item['kind'] === 'branch')!
    expect(branch).toMatchObject({ name: '默认服装', parent_name: 'Mira' })
    expect(branch['parent_id']).toBe(mira['id'])

    const allKinds = s.queryEntries({ kind: 'all', favorite: true })
    expect(allKinds.total).toBe(1)
    expect(allKinds.facets.kinds).toMatchObject({ character: 1, branch: 0, artist: 0, blend: 0, preset: 0 })
  })

  it('searches blend artists by name and supports name/used sorting and pagination', () => {
    const s = store()
    const aki = save(s, 'artist', 'Aki', { prompt: 'artist:aki' })
    save(s, 'blend', 'Aki mix', { artists: [{ id: aki['id'], weight: 0.6 }] })
    const alpha = save(s, 'character', 'Alpha', { prompt: 'a' })
    const beta = save(s, 'character', 'Beta', { prompt: 'b' })
    s.recordEntryUse(String(beta['id']))
    s.recordEntryUse(String(beta['id']))

    expect(s.queryEntries({ query: 'aki' }).items.map((item: Record<string, unknown>) => item['kind'])).toEqual(expect.arrayContaining(['artist', 'blend']))
    expect(s.queryEntries({ sort: 'name' }).items.map((item: Record<string, unknown>) => item['name']).slice(0, 2)).toEqual(['Aki', 'Aki mix'])
    expect(s.queryEntries({ sort: 'used' }).items[0]).toMatchObject({ id: beta['id'], use_count: 2 })

    const page = s.queryEntries({ offset: 1, limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(4)
    expect(page.next_offset).toBe(3)
    expect(() => s.queryEntries({ limit: 101 })).toThrow(/1 to 100/)
    expect(() => s.queryEntries({ sort: 'unknown' })).toThrow(/排序/)
  })

  it('invalidates cached parses when rows change and tracks favorites and uses', () => {
    const s = store()
    const entry = save(s, 'character', 'Old name', { prompt: 'old prompt' })
    expect(s.queryEntries({ query: 'old prompt' }).total).toBe(1)

    s.saveEntry({ name: 'New name', data: { prompt: 'new prompt' } }, String(entry['id']), 0)
    expect(s.queryEntries({ query: 'old prompt' }).total).toBe(0)
    expect(s.queryEntries({ query: 'new prompt' }).total).toBe(1)

    const favorited = s.setEntryFavorite(String(entry['id']), true)
    expect(favorited['revision']).toBe(2)
    expect(s.queryEntries({ favorite: true }).total).toBe(1)

    s.recordEntryUse(String(entry['id']))
    expect(s.getEntry(String(entry['id']))['data']).toMatchObject({ use_count: 1, favorite: true })
    expect(s.getEntry(String(entry['id']))['data']['last_used_at']).toEqual(expect.any(String))
    const second = save(s, 'artist', 'Aki', { prompt: 'artist:aki' })
    const used = s.recordEntriesUse([String(entry['id']), String(second['id']), String(entry['id'])])
    expect(used).toHaveLength(2)
    expect(s.getEntry(String(entry['id']))['data']).toMatchObject({ use_count: 2 })
    expect(s.getEntry(String(second['id']))['data']).toMatchObject({ use_count: 1 })

    s.deleteEntry(String(entry['id']))
    s.deleteEntry(String(second['id']))
    expect(s.queryEntries().total).toBe(0)
  })

  it('validates entry metadata at the save boundary', () => {
    const s = store()
    expect(() => save(s, 'character', 'Bad tags', { prompt: 'x', tags: 'not-an-array' })).toThrow(/标签/)
    expect(() => save(s, 'character', 'Bad favorite', { prompt: 'x', favorite: 'yes' })).toThrow(/收藏/)
    expect(() => save(s, 'character', 'Too many tags', { prompt: 'x', tags: Array.from({ length: 17 }, (_, index) => `t${index}`) })).toThrow(/最多/)
  })
})
