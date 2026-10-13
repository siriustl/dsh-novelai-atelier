/** Store part: entry library, asset library, portable import. Ported from store.py entries/assets + import_entries. */
import type { Store, Rec } from './store.ts'
import { ConflictError, KeyError, encode, integer, nowStamp, randomId, timestamp } from './util.ts'
import { ENTRY_KINDS } from './storeDoc.ts'

export function applyStoreEntries(store: Store): void {
  const data = () => store.data

  store.listEntries = (query = '', kind: string | null = null): Rec[] => {
    if (kind !== null && !ENTRY_KINDS.has(kind)) throw new Error('未知资料类型')
    const needle = query.toLowerCase()
    return data().entries
      .slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
      .filter((row) => (kind === null || row.kind === kind))
      .filter((row) => {
        if (!needle) return true
        const decoded = JSON.stringify(JSON.parse(row.data))
        let parentName = ''
        if (row.kind === 'branch' && row.parent_id) {
          const parent = store._findEntry(row.parent_id)
          if (parent) parentName = parent.name
        }
        return row.name.toLowerCase().includes(needle) ||
               (parentName && parentName.toLowerCase().includes(needle)) ||
               decoded.toLowerCase().includes(needle)
      })
      .map((row) => store._entryRow(row))
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
