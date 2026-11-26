/** Store part: gallery queries and curation. */
import type { Store, Rec } from './store.ts'
import { KeyError, integer, nowStamp, asUtc } from './util.ts'
import { entryFilterTag } from './library.ts'

export function applyStoreCreative(store: Store): void {
  const data = () => store.data

  store.queryJobs = (opts: { query?: string; offset?: number; limit?: number; model?: string; scheduleId?: string; characterId?: string; artistId?: string; status?: string; favorite?: boolean; archived?: boolean; after?: string; before?: string } = {}): Rec => {
    const { query = '', offset = 0, limit = 48, model = '', scheduleId = '', characterId = '', artistId = '', status = '', favorite = false, archived = false, after = '', before = '' } = opts
    integer(offset, '分页位置', 0, 2 ** 31)
    integer(limit, '每页数量', 1, 200)
    const dateBound = (value: string): number | null => {
      const normalized = value.trim()
      if (!normalized) return null
      try {
        return asUtc(/^\d{4}-\d{2}-\d{2}$/u.test(normalized) ? normalized + 'T00:00:00Z' : normalized).getTime()
      } catch { throw new Error('Gallery date bounds must be ISO 8601 dates with a timezone or YYYY-MM-DD') }
    }
    const afterTime = dateBound(after), beforeTime = dateBound(before)
    if (afterTime !== null && beforeTime !== null && afterTime > beforeTime) throw new Error('after must not be later than before')
    const rows = data().jobs.filter((j) => j.archived === (archived ? 1 : 0))
    const normalize = (value: unknown): string => typeof value === 'string' ? value.toLowerCase().replace(/\s+/gu, ' ').trim() : ''
    const entries = characterId || artistId ? store.listEntries() : []
    const filterTag = (id: string, kind: string): string | null => {
      if (!id) return null
      const entry = entries.find((row) => row['id'] === id)
      return entry && entry['kind'] === kind ? normalize(entryFilterTag(entry)) : ''
    }
    const characterTag = filterTag(characterId, 'character')
    const artistTag = filterTag(artistId, 'artist')
    const jobText = (snapshot: Rec): string => {
      const request = (snapshot['request'] ?? {}) as Rec
      const characters = Array.isArray(request['characters']) ? request['characters'] as Rec[] : []
      return normalize([request['prompt'], ...characters.map((character) => character?.['prompt'])]
        .filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n'))
    }
    const filtered = rows.filter((j) => {
      if (status && j.status !== status) return false
      if (scheduleId && j.schedule_id !== scheduleId) return false
      if (afterTime !== null && Date.parse(j.created_at) < afterTime) return false
      if (beforeTime !== null && Date.parse(j.created_at) > beforeTime) return false
      if (favorite && j.favorite !== 1) return false
      const snapshot = JSON.parse(j.snapshot) as Rec
      if (model && ((snapshot['request'] as Rec)?.['model'] ?? '') !== model) return false
      if (characterTag === '' || artistTag === '') return false
      if (characterTag || artistTag) {
        const text = jobText(snapshot)
        if (characterTag && !text.includes(characterTag)) return false
        if (artistTag && !text.includes(artistTag)) return false
      }
      if (query) {
        const haystack = JSON.stringify(snapshot).toLowerCase()
        if (!haystack.includes(query.toLowerCase()) && !j.id.toLowerCase().includes(query.toLowerCase()) && !(j.error ?? '').toLowerCase().includes(query.toLowerCase())) return false
      }
      return true
    })
    const sorted = filtered.sort((a, b) => b.created_at.localeCompare(a.created_at))
    const items = sorted.slice(offset, offset + limit).map((j) => {
      const view = JSON.parse(j.snapshot) as Rec
      Object.assign(view, {
        id: j.id, batch_id: j.batch_id, schedule_id: j.schedule_id, status: j.status, error: j.error,
        attempts: j.attempts, created_at: j.created_at, updated_at: j.updated_at, started_at: j.started_at, finished_at: j.finished_at,
        actual_anlas: j.actual,
        cancel_requested: j.cancel_requested === 1, favorite: j.favorite === 1, archived: j.archived === 1,
        result: j.result ? JSON.parse(j.result) : null,
      })
      if (view['result'] instanceof Object && 'assets' in (view['result'] as Rec)) view['assets'] = (view['result'] as Rec)['assets']
      return view
    })
    return { items, total: filtered.length, offset, limit }
  }

  store.curateJobs = (ids: string[], opts: { favorite?: boolean | null; archived?: boolean | null } = {}): Rec => {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 || !ids.every((i) => typeof i === 'string')) throw new Error('请选择 1–500 条任务')
    for (const ident of ids) {
      const row = data().jobs.find((j) => j.id === ident)
      if (!row) throw new KeyError(ident)
      for (const [field, value] of [['favorite', opts.favorite], ['archived', opts.archived]] as const) {
        if (value !== null && value !== undefined) {
          if (typeof value !== 'boolean') throw new Error('收藏和归档需要布尔值')
          row[field] = value ? 1 : 0
          row.updated_at = nowStamp()
        }
      }
    }
    store.internalPersist()
    return { updated: ids.length }
  }
}
