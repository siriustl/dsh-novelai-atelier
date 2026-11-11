import { describe, expect, it } from 'vitest'
import { searchTags, translateTags } from '../src/workbench/tags.ts'

describe('Tag dictionary and autocomplete', () => {
  it('searches by English prefix and normalizes underscores', () => {
    const results = searchTags('twin_t', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.name).toBe('twintails')
    expect(results[0]!.zh).toContain('双马尾')
  })

  it('searches by Chinese keywords', () => {
    const results = searchTags('白发', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.name === 'white hair')).toBe(true)
  })

  it('translates tags in both directions', () => {
    const map = translateTags(['1girl', 'white hair', '双马尾', 'unknown_xyz'])
    expect(map['1girl']).toContain('单人女性')
    expect(map['white hair']).toContain('白发')
    expect(map['双马尾']).toBe('twintails')
    expect(map['unknown_xyz']).toBeUndefined()
  })
})
