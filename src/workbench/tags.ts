/** Tag dictionary & autocomplete suggestions.
 * Matches English prefixes/phrases and Chinese keywords against curated Danbooru & NovelAI tags. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface TagEntry {
  name: string
  zh: string
  category: string
  count: number
}

export interface TagSuggestion {
  name: string
  zh: string
  category: string
  count: number
  matchType: 'exact' | 'prefix' | 'contains'
}

let loadedTags: TagEntry[] | null = null

export function loadTagCatalog(assetDir?: string): TagEntry[] {
  if (loadedTags) return loadedTags
  const candidateDirs: string[] = []
  if (assetDir) candidateDirs.push(assetDir)
  try {
    candidateDirs.push(fileURLToPath(new URL('../../assets', import.meta.url)))
    candidateDirs.push(fileURLToPath(new URL('../assets', import.meta.url)))
  } catch {}
  candidateDirs.push(join(process.cwd(), 'assets'), join(process.cwd(), 'dist', 'assets'))

  for (const dir of candidateDirs) {
    const file = join(dir, 'tags', 'common-tags.json')
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8')
        const items = JSON.parse(raw) as TagEntry[]
        if (Array.isArray(items) && items.length > 0) {
          loadedTags = items
          return loadedTags
        }
      }
    } catch {}
  }

  // Built-in fallback
  loadedTags = [
    { name: '1girl', zh: '单人女性', category: 'character', count: 6500000 },
    { name: '1boy', zh: '单人男性', category: 'character', count: 2500000 },
    { name: 'solo', zh: '单人', category: 'character', count: 6000000 },
    { name: 'masterpiece', zh: '杰作', category: 'quality', count: 5000000 },
    { name: 'best quality', zh: '最佳品质', category: 'quality', count: 4800000 },
    { name: 'transparent background', zh: '透明背景(V5)', category: 'meta', count: 150000 },
  ]
  return loadedTags
}

export function normalizeTag(str: string): string {
  return str.replaceAll('_', ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function searchTags(query: string, limit = 15, assetDir?: string): TagSuggestion[] {
  const q = normalizeTag(query)
  const qCompact = query.replace(/[\s_]+/g, '').toLowerCase()
  if (!q && !qCompact) return []
  const catalog = loadTagCatalog(assetDir)

  const exact: TagSuggestion[] = []
  const prefix: TagSuggestion[] = []
  const contains: TagSuggestion[] = []

  for (const item of catalog) {
    const en = normalizeTag(item.name)
    const enCompact = item.name.replace(/[\s_]+/g, '').toLowerCase()
    const zh = item.zh.toLowerCase()

    if (en === q || zh === q || (qCompact && enCompact === qCompact)) {
      exact.push({ ...item, matchType: 'exact' })
    } else if (en.startsWith(q) || zh.startsWith(q) || (qCompact && enCompact.startsWith(qCompact))) {
      prefix.push({ ...item, matchType: 'prefix' })
    } else if (en.includes(q) || zh.includes(q) || (qCompact && enCompact.includes(qCompact))) {
      contains.push({ ...item, matchType: 'contains' })
    }
  }

  const byCount = (a: TagSuggestion, b: TagSuggestion) => b.count - a.count
  exact.sort(byCount)
  prefix.sort(byCount)
  contains.sort(byCount)

  return [...exact, ...prefix, ...contains].slice(0, limit)
}

export function translateTags(tags: string[], assetDir?: string): Record<string, string> {
  const catalog = loadTagCatalog(assetDir)
  const map: Record<string, string> = {}
  const lookup = new Map<string, string>()

  for (const item of catalog) {
    lookup.set(normalizeTag(item.name), item.zh)
    lookup.set(item.zh.toLowerCase(), item.name)
  }

  for (const raw of tags) {
    const key = normalizeTag(raw)
    const found = lookup.get(key)
    if (found) map[raw] = found
  }
  return map
}
