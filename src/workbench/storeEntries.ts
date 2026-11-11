/** Store part: entry library, asset library, portable import. Ported from store.py entries/assets + import_entries. */
import type { EntryRow } from './storeDoc.ts'
import type { Store, Rec } from './store.ts'
import { ConflictError, KeyError, encode, integer, nowStamp, randomId, timestamp } from './util.ts'
import { ENTRY_KINDS } from './storeDoc.ts'

/** Library display order; also the order of the type chips in the workbench. */
export const ENTRY_KIND_ORDER = ['character', 'branch', 'artist', 'blend', 'preset'] as const
export const ENTRY_TAG_LIMIT = 16
export const ENTRY_TAG_MAX_LENGTH = 32
export const ENTRY_QUERY_LIMIT = 100
export const ENTRY_QUERY_DEFAULT = 48
const ENTRY_SORTS = ['updated', 'created', 'name', 'used', 'favorite', 'kind'] as const

interface EntryMeta {
  tags: string[]
  favorite: boolean
  use_count: number
  last_used_at: string | null
}

interface CachedEntry {
  encoded: string
  data: Rec
  meta: EntryMeta
  ownText: string
}

export interface EntryQuery {
  query?: string
  kind?: string | null
  tag?: string | null
  favorite?: boolean
  sort?: string
  offset?: number
  limit?: number
}

function entryMeta(input: unknown): EntryMeta {
  const value = input instanceof Object && !Array.isArray(input) ? input as Rec : {}
  const tags = Array.isArray(value['tags'])
    ? value['tags'].filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean)
    : []
  const useCount = Number(value['use_count'])
  return {
    tags: [...new Set(tags)].slice(0, ENTRY_TAG_LIMIT),
    favorite: value['favorite'] === true,
    use_count: Number.isSafeInteger(useCount) && useCount > 0 ? useCount : 0,
    last_used_at: typeof value['last_used_at'] === 'string' && value['last_used_at'] ? value['last_used_at'] : null,
  }
}

/** Validate metadata the editor/agent can write without rejecting legacy entries that lack it. */
function validateEntryMeta(entryData: Rec): void {
  if (entryData['tags'] !== undefined) {
    const tags = entryData['tags']
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) throw new Error('资料标签必须是文本列表')
    const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
    if (normalized.length > ENTRY_TAG_LIMIT) throw new Error(`资料标签最多 ${ENTRY_TAG_LIMIT} 个`)
    if (normalized.some((tag) => tag.length > ENTRY_TAG_MAX_LENGTH)) throw new Error(`单个资料标签最多 ${ENTRY_TAG_MAX_LENGTH} 个字符`)
    entryData['tags'] = normalized
  }
  if (entryData['favorite'] !== undefined && typeof entryData['favorite'] !== 'boolean') throw new Error('收藏状态必须是布尔值')
  if (entryData['use_count'] !== undefined && (!Number.isSafeInteger(entryData['use_count']) || (entryData['use_count'] as number) < 0))
    throw new Error('使用次数必须是非负整数')
  if (entryData['last_used_at'] !== undefined && entryData['last_used_at'] !== null && typeof entryData['last_used_at'] !== 'string')
    throw new Error('最近使用时间必须是文本或空值')
}

function clip(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : ''
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

function ownSearchText(data: Rec): string {
  const pieces: string[] = []
  const add = (value: unknown): void => { if (typeof value === 'string' && value) pieces.push(value) }
  add(data['prompt'])
  add(data['negative_prompt'])
  add(data['notes'])
  for (const tag of Array.isArray(data['tags']) ? data['tags'] : []) add(tag)
  for (const set of Array.isArray(data['prompt_sets']) ? data['prompt_sets'] as Rec[] : []) {
    add(set?.['name'])
    add(set?.['prompt'])
    add(set?.['negative_prompt'])
  }
  return pieces.join('\n').toLowerCase()
}

export function applyStoreEntries(store: Store): void {
  const data = () => store.data
  // Parsed-entry cache: searching and faceting must not re-JSON.parse every row on each keystroke.
  const cache = new Map<string, CachedEntry>()

  const cached = (row: EntryRow): CachedEntry => {
    const hit = cache.get(row.id)
    if (hit && hit.encoded === row.data) return hit
    let parsed: Rec
    try { parsed = JSON.parse(row.data) as Rec } catch { parsed = {} }
    const item: CachedEntry = { encoded: row.data, data: parsed, meta: entryMeta(parsed), ownText: ownSearchText(parsed) }
    cache.set(row.id, item)
    return item
  }

  const enriched = (row: EntryRow, index: Map<string, CachedEntry>, rows: Map<string, EntryRow>): CachedEntry & { text: string; parentName: string | null } => {
    const item = cached(row)
    const parts = [row.name, item.ownText]
    let parentName: string | null = null
    if (row.kind === 'branch' && row.parent_id) {
      const parent = index.get(row.parent_id)
      const parentRow = rows.get(row.parent_id)
      if (parentRow) {
        parentName = parentRow.name
        parts.push(parentRow.name)
        if (parent) parts.push(parent.ownText)
      }
    }
    if (row.kind === 'blend') {
      for (const artist of Array.isArray(item.data['artists']) ? item.data['artists'] as Rec[] : []) {
        const ident = typeof artist?.['id'] === 'string' ? artist['id'] : ''
        const ref = index.get(ident)
        const refRow = rows.get(ident)
        if (refRow) parts.push(refRow.name)
        if (ref) parts.push(ref.ownText)
      }
    }
    return { ...item, parentName, text: parts.join('\n').toLowerCase() }
  }

  /** Full rows (agent/export/web compatibility) keep the legacy list shape. */
  store.listEntries = (query = '', kind: string | null = null): Rec[] => {
    if (kind !== null && !ENTRY_KINDS.has(kind)) throw new Error('未知资料类型')
    const needle = query.trim().toLowerCase()
    const rows = data().entries.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
    const index = new Map(rows.map((row) => [row.id, cached(row)]))
    const byId = new Map(rows.map((row) => [row.id, row]))
    return rows
      .filter((row) => kind === null || row.kind === kind)
      .filter((row) => !needle || enriched(row, index, byId).text.includes(needle))
      .map((row) => store._entryRow(row))
  }

  /**
   * Lightweight, paginated library projection for the workbench and Agent tools.
   * Facets intentionally ignore their own filter so the next click stays possible.
   */
  store.queryEntries = (opts: EntryQuery = {}): Rec => {
    const rawKind = opts.kind == null || opts.kind === '' || opts.kind === 'all' ? null : String(opts.kind)
    if (rawKind !== null && !ENTRY_KINDS.has(rawKind)) throw new Error('未知资料类型')
    const query = String(opts.query ?? '').trim()
    if (query.length > 200) throw new Error('搜索文本最多 200 个字符')
    const tag = String(opts.tag ?? '').trim()
    if (tag.length > ENTRY_TAG_MAX_LENGTH) throw new Error(`标签最多 ${ENTRY_TAG_MAX_LENGTH} 个字符`)
    const favorite = opts.favorite === true
    const sort = String(opts.sort ?? 'updated')
    if (!(ENTRY_SORTS as readonly string[]).includes(sort)) throw new Error('未知资料排序方式')
    const offset = opts.offset ?? 0
    const limit = opts.limit ?? ENTRY_QUERY_DEFAULT
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ENTRY_QUERY_LIMIT) throw new Error(`limit must be an integer from 1 to ${ENTRY_QUERY_LIMIT}`)

    const rows = data().entries
    const byId = new Map(rows.map((row) => [row.id, row]))
    const index = new Map(rows.map((row) => [row.id, cached(row)]))
    const all = rows.map((row) => ({ row, item: enriched(row, index, byId) }))
    const terms = query.toLowerCase().split(/\s+/u).filter(Boolean)
    const queryMatch = all.filter(({ item }) => terms.every((term) => item.text.includes(term)))
    const tagNeedle = tag.toLowerCase()
    const matchesTag = (item: CachedEntry): boolean => !tag || item.meta.tags.some((value) => value.toLowerCase() === tagNeedle)
    const matchesFavorite = (item: CachedEntry): boolean => !favorite || item.meta.favorite
    const matchesKind = (row: EntryRow): boolean => rawKind === null || row.kind === rawKind
    const filtered = queryMatch.filter(({ row, item }) => matchesKind(row) && matchesFavorite(item) && matchesTag(item))

    // Each facet ignores only its own filter; query and the other two still apply.
    const kindsBase = queryMatch.filter(({ item }) => matchesFavorite(item) && matchesTag(item))
    const favoritesBase = queryMatch.filter(({ row, item }) => matchesKind(row) && matchesTag(item))
    const tagsBase = queryMatch.filter(({ row, item }) => matchesKind(row) && matchesFavorite(item))
    const kindCounts: Rec = Object.fromEntries(ENTRY_KIND_ORDER.map((kind) => [kind, 0]))
    for (const { row } of kindsBase) kindCounts[row.kind] = Number(kindCounts[row.kind] ?? 0) + 1
    const tagCounts = new Map<string, number>()
    for (const { item } of tagsBase) for (const value of item.meta.tags) tagCounts.set(value, (tagCounts.get(value) ?? 0) + 1)
    const tags = [...tagCounts.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')).slice(0, 12)

    const rank = (kind: string): number => ENTRY_KIND_ORDER.indexOf(kind as (typeof ENTRY_KIND_ORDER)[number])
    type Match = (typeof all)[number]
    const byUpdated = (a: Match, b: Match): number => b.row.updated_at.localeCompare(a.row.updated_at) || a.row.id.localeCompare(b.row.id)
    const compare = (a: Match, b: Match): number => {
      switch (sort) {
        case 'created': return b.row.created_at.localeCompare(a.row.created_at) || byUpdated(a, b)
        case 'name': return a.row.name.localeCompare(b.row.name, 'zh-CN') || byUpdated(a, b)
        case 'used': return b.item.meta.use_count - a.item.meta.use_count || byUpdated(a, b)
        case 'favorite': return Number(b.item.meta.favorite) - Number(a.item.meta.favorite) || byUpdated(a, b)
        case 'kind': return rank(a.row.kind) - rank(b.row.kind) || a.row.name.localeCompare(b.row.name, 'zh-CN') || byUpdated(a, b)
        default: return byUpdated(a, b)
      }
    }
    const ordered = filtered.slice().sort(compare)
    const children = new Map<string, Array<{ id: string; name: string }>>()
    for (const row of rows) {
      if (row.kind !== 'branch' || !row.parent_id) continue
      const list = children.get(row.parent_id) ?? []
      list.push({ id: row.id, name: row.name })
      children.set(row.parent_id, list)
    }
    const page = ordered.slice(offset, offset + limit).map(({ row, item }) => {
      const entryData = item.data
      const promptSets = Array.isArray(entryData['prompt_sets']) ? entryData['prompt_sets'] as Rec[] : []
      const examples = Array.isArray(entryData['examples']) ? entryData['examples'] as string[] : []
      const branches = row.kind === 'character' ? children.get(row.id) ?? [] : undefined
      return {
        id: row.id, kind: row.kind, parent_id: row.parent_id, parent_name: item.parentName,
        name: row.name, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at,
        tags: item.meta.tags, favorite: item.meta.favorite, use_count: item.meta.use_count, last_used_at: item.meta.last_used_at,
        prompt_preview: clip(entryData['prompt'], 160),
        negative_preview: clip(entryData['negative_prompt'], 120),
        prompt_set_count: promptSets.length,
        prompt_set_names: promptSets.map((set) => String(set?.['name'] ?? '')).filter(Boolean).slice(0, 8),
        example_count: examples.length,
        cover_asset_id: examples[0] ?? null,
        ...(branches ? { branches: branches.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) } : {}),
      }
    })
    return {
      items: page, total: ordered.length, offset, limit,
      next_offset: offset + page.length < ordered.length ? offset + page.length : null,
      sort,
      facets: {
        all: kindsBase.length,
        kinds: kindCounts,
        favorites: favoritesBase.filter(({ item }) => item.meta.favorite).length,
        tags,
      },
    }
  }

  store.getEntry = (id: string): Rec => {
    const row = store._findEntry(id)
    if (!row) throw new KeyError(id)
    return store._entryRow(row)
  }

  store.saveEntry = (input: Rec, id: string | null = null, expectedRevision: number | null = null): Rec => {
    const previous = id ? store._findEntry(id) : undefined
    if (id && !previous) throw new KeyError(id)
    if (previous) {
      if (expectedRevision !== null && expectedRevision !== undefined) integer(expectedRevision, '资料版本', 0, 2 ** 53)
      if (expectedRevision === null || expectedRevision === undefined || previous!.revision !== expectedRevision)
        throw new ConflictError('资料已被更新，请刷新后重试')
    }
    const item: Rec = previous
      ? store._entryRow(previous)
      : { kind: null, parent_id: null, name: '', data: {} }
    for (const key of ['kind', 'parent_id', 'name', 'data']) {
      if (key in input) item[key] = structuredClone(input[key])
    }
    if (typeof item['kind'] !== 'string' || !ENTRY_KINDS.has(item['kind'] as string) || typeof item['name'] !== 'string' || !(item['name'] as string).trim())
      throw new Error('资料需要有效类型和名称')
    if (previous && item['kind'] !== previous.kind) throw new Error('不能更改资料类型')
    if (!(item['data'] instanceof Object) || Array.isArray(item['data'])) throw new Error('资料 data 必须是对象')
    if (item['kind'] === 'branch') {
      if (typeof item['parent_id'] !== 'string') throw new Error('分支必须属于一个角色')
      const parent = store._findEntry(item['parent_id'])
      if (!parent || parent.kind !== 'character') throw new Error('分支必须属于一个角色')
    } else if (item['parent_id'] !== null && item['parent_id'] !== undefined) {
      throw new Error('只有角色分支可以有 parent_id')
    }
    const entryData = item['data'] as Rec
    const exampleIds = entryData['examples'] ?? []
    if (!Array.isArray(exampleIds) || !exampleIds.every((v) => typeof v === 'string')) throw new Error('例图必须是 asset ID 列表')
    for (const assetId of exampleIds as string[]) {
      if (!data().assets.some((a) => a.id === assetId)) throw new Error('例图资源不存在，请先上传图片')
    }
    const promptSets = entryData['prompt_sets'] ?? []
    if (!Array.isArray(promptSets) || !promptSets.every((v) => v instanceof Object && !Array.isArray(v))) throw new Error('提示词组必须是对象列表')
    validateEntryMeta(entryData)
    if (item['kind'] === 'blend') {
      const artists = entryData['artists'] ?? []
      if (!Array.isArray(artists)) throw new Error('画师混合需要列表')
      for (const artist of artists as Array<Rec>) {
        const artistId = artist instanceof Object ? artist['id'] : undefined
        if (typeof artistId !== 'string') throw new Error('混合方案需要有效画师引用')
        const target = store._findEntry(artistId)
        if (!target || target.kind !== 'artist') throw new Error('混合方案引用的画师不存在')
      }
    }
    const now = nowStamp()
    const finalId = id ?? randomId()
    const row = {
      id: finalId,
      kind: item['kind'] as string,
      parent_id: (item['parent_id'] as string | null) ?? null,
      name: item['name'] as string,
      revision: previous ? previous.revision + 1 : 0,
      data: encode(item['data']),
      created_at: previous ? previous.created_at : now,
      updated_at: now,
    }
    const idx = data().entries.findIndex((e) => e.id === finalId)
    if (idx >= 0) data().entries[idx] = row
    else data().entries.push(row)
    store.internalPersist()
    cache.delete(finalId)
    return store.getEntry(finalId)
  }

  store.deleteEntry = (id: string, expectedRevision: number | null = null): void => {
    const row = store._findEntry(id)
    if (!row) throw new KeyError(id)
    if (expectedRevision !== null && expectedRevision !== undefined) {
      integer(expectedRevision, '资料版本', 0, 2 ** 53)
      if (row.revision !== expectedRevision) throw new ConflictError('资料已被更新，请刷新后重试')
    }
    if (data().entries.some((e) => e.parent_id === id)) throw new ConflictError('请先删除或移动该角色的分支')
    for (const other of data().entries.filter((e) => e.kind === 'blend')) {
      const artists = (JSON.parse(other.data) as Rec)['artists']
      if (Array.isArray(artists) && artists.some((a) => a instanceof Object && (a as Rec)['id'] === id))
        throw new ConflictError('画师仍被混合方案引用，请先移除方案中的引用')
    }
    data().entries = data().entries.filter((e) => e.id !== id)
    store.internalPersist()
    cache.delete(id)
  }

  /** Record one or more applied entries in a single document write; content revisions stay unchanged. */
  store.recordEntriesUse = (ids: string[], at: string | null = null): Rec[] => {
    const unique = [...new Set(ids)]
    if (!unique.length) return []
    const stamp = at ?? nowStamp()
    const previous = new Map<string, string>()
    const rows: EntryRow[] = []
    try {
      for (const id of unique) {
        const row = store._findEntry(id)
        if (!row) throw new KeyError(id)
        previous.set(id, row.data)
        const entryData = JSON.parse(row.data) as Rec
        const count = Number(entryData['use_count'])
        entryData['use_count'] = (Number.isSafeInteger(count) && count > 0 ? count : 0) + 1
        entryData['last_used_at'] = stamp
        row.data = encode(entryData)
        rows.push(row)
      }
      store.internalPersist()
    } catch (error) {
      for (const [id, before] of previous) {
        const row = store._findEntry(id)
        if (row) row.data = before
      }
      throw error
    }
    for (const id of unique) cache.delete(id)
    return rows.map((row) => store._entryRow(row))
  }

  store.recordEntryUse = (id: string, at: string | null = null): Rec => store.recordEntriesUse([id], at)[0]!

  /** Toggle the favorite flag through the normal save path so validation and revisions stay consistent. */
  store.setEntryFavorite = (id: string, favorite: boolean, expectedRevision: number | null = null): Rec => {
    if (typeof favorite !== 'boolean') throw new Error('收藏状态必须是布尔值')
    const current = store.getEntry(id)
    if (expectedRevision !== null && expectedRevision !== undefined && current['revision'] !== expectedRevision)
      throw new ConflictError('资料已被更新，请刷新后重试')
    return store.saveEntry({ data: { ...(current['data'] as Rec), favorite } }, id, current['revision'] as number)
  }
  store.importEntries = (entries: Rec[], choices: Rec | null = null, expectedRevisions: Rec | null = null): Rec => {
    // Import a portable library atomically, with fresh IDs and rebound links.
    if (!Array.isArray(entries) || entries.length > 2000) throw new Error('资料条目必须是列表，且不超过 2000 条')
    if (!entries.every((e) => e instanceof Object && typeof e['id'] === 'string' && e['id'])) throw new Error('导入条目需要有效 ID')
    const source = new Map(entries.map((e) => [e['id'] as string, structuredClone(e)]))
    if (source.size !== entries.length) throw new Error('资料包含重复 ID')
    const mapping = new Map([...source.keys()].map((old) => [old, randomId()]))
    const stamp = timestamp()
    const choiceMap = choices ?? {}
    for (const key of Object.keys(choiceMap)) {
      if (!source.has(key) || !['copy', 'skip', 'update'].includes(choiceMap[key] as string)) throw new Error('导入决策无效')
    }
    let written = 0, skipped = 0
    const existing = new Map(data().entries.map((e) => [e.id, store._entryRow(e)]))
    const identity = (e: Rec, index: Map<string, Rec>): string => {
      const parent = index.get((e['parent_id'] as string) ?? '')
      return [e['kind'], String(e['name']).toLowerCase(), parent ? String(parent['name']).toLowerCase() : ''].join('\u0000')
    }
    const matches = new Map<string, Rec>()
    for (const [old, entry] of source) {
      let match = existing.get(old)
      if (match && match.kind !== entry['kind']) match = undefined
      if (!match) {
        const candidates = [...existing.values()].filter((e) => identity(e, existing) === identity(entry, source))
        match = candidates.length === 1 ? candidates[0] : undefined
      }
      const mode = (choiceMap[old] as string) ?? 'copy'
      if (mode === 'skip' || mode === 'update') {
        if (!match) throw new ConflictError('导入目标不存在或有同名歧义，请重新预览')
        const expected = (expectedRevisions ?? {}) as Rec
        const matchId = match!.id as string
        if (expected[matchId] !== match!.revision) throw new ConflictError('导入目标已改变，请重新预览')
        mapping.set(old, matchId)
        matches.set(old, match!)
      }
    }
    const stagedEntries = data().entries.slice()
    for (const original of source.values()) {
      const kind = original['kind'], name = original['name'], entryData = (original['data'] ?? {}) as Rec
      if (typeof kind !== 'string' || !ENTRY_KINDS.has(kind) || typeof name !== 'string' || !name.trim())
        throw new Error('导入资料需要有效类型和名称')
      if (!(entryData instanceof Object)) throw new Error('资料 data 必须是对象')
      const parentId = original['parent_id']
      if (kind === 'branch') {
        if (typeof parentId !== 'string' || !source.has(parentId) || source.get(parentId)!['kind'] !== 'character')
          throw new Error('导入分支必须属于资料包内的角色')
      } else if (parentId != null) {
        throw new Error('只有角色分支可以有 parent_id')
      }
      const examples = entryData['examples'] ?? []
      if (!Array.isArray(examples) || !examples.every((v) => typeof v === 'string')) throw new Error('例图必须是 asset ID 列表')
      for (const assetId of examples as string[]) {
        if (!data().assets.some((a) => a.id === assetId)) throw new Error('导入资料缺少例图资源')
      }
      const promptSets = entryData['prompt_sets'] ?? []
      if (!Array.isArray(promptSets) || !promptSets.every((v) => v instanceof Object)) throw new Error('提示词组必须是对象列表')
      validateEntryMeta(entryData)
      if (kind === 'blend') {
        const artists = entryData['artists'] ?? []
        if (!Array.isArray(artists)) throw new Error('画师混合需要列表')
        for (const artist of artists as Array<Rec>) {
          const ident = artist['id']
          if (typeof ident !== 'string' || !source.has(ident) || source.get(ident)!['kind'] !== 'artist')
            throw new Error('混合方案引用的画师不在资料包内')
          artist['id'] = mapping.get(ident)
        }
      }
      const mode = (choiceMap[original['id'] as string] as string) ?? 'copy'
      if (mode === 'skip') { skipped++; continue }
      const previous = matches.get(original['id'] as string)
      const finalId = mapping.get(original['id'] as string)!
      const row = {
        id: finalId, kind, parent_id: typeof parentId === 'string' ? mapping.get(parentId) ?? null : null,
        name, revision: previous ? Number(previous['revision']) + 1 : 0, data: encode(entryData),
        created_at: previous ? String(previous['created_at']) : stamp, updated_at: stamp,
      }
      const idx = stagedEntries.findIndex((e) => e.id === finalId)
      if (idx >= 0) stagedEntries[idx] = row
      else stagedEntries.push(row)
      written++
    }
    const previousEntries = data().entries
    data().entries = stagedEntries
    try { store.internalPersist() } catch (error) {
      data().entries = previousEntries
      throw error
    }
    cache.clear()
    return { id_map: Object.fromEntries(mapping), entries_imported: written, entries_skipped: skipped }
  }

  store.addAsset = (input: Rec): Rec => {
    const item = structuredClone(input)
    item['id'] ??= randomId()
    item['created_at'] ??= timestamp()
    if (typeof item['path'] !== 'string') throw new Error('图片资源需要本地路径')
    const existingRow = data().assets.find((a) => a.id === item['id'])
    if (existingRow) {
      const existing = JSON.parse(existingRow.data) as Rec
      const identityKeys = ['path', 'sha256', 'mime', 'width', 'height']
      if (identityKeys.some((key) => existing[key] !== item[key])) {
        const metadataUpgrade = existing['path'] === item['path'] && existing['sha256'] === item['sha256'] && item['id'] === item['sha256']
          && typeof item['id'] === 'string' && /^[0-9a-f]{64}$/u.test(item['id'])
          && existing['mime'] === 'application/octet-stream' && existing['width'] === null && existing['height'] === null
          && ['image/png', 'image/jpeg', 'image/webp'].includes(String(item['mime']))
          && typeof item['width'] === 'number' && Number.isInteger(item['width']) && item['width'] > 0
          && typeof item['height'] === 'number' && Number.isInteger(item['height']) && item['height'] > 0
          && item['width'] * item['height'] <= 32 * 1024 * 1024
        if (!metadataUpgrade) throw new ConflictError('图片资源 ID 已存在')
        const upgraded = { ...existing, mime: item['mime'], width: item['width'], height: item['height'] }
        const previousData = existingRow.data
        existingRow.data = encode(upgraded)
        try { store.internalPersist() } catch (error) { existingRow.data = previousData; throw error }
        return upgraded
      }
      // Content-addressed uploads and input snapshots are repeatable.
      return existing
    }
    data().assets.push({ id: item['id'] as string, data: encode(item), created_at: item['created_at'] as string })
    store.internalPersist()
    return item
  }

  store.getAsset = (id: string): Rec => {
    const row = data().assets.find((a) => a.id === id)
    if (!row) throw new KeyError(id)
    return JSON.parse(row.data) as Rec
  }

  store.listAssets = (): Rec[] =>
    data().assets
      .slice().sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
      .map((row) => JSON.parse(row.data) as Rec)
}
