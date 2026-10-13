/** Store part: conversations, messages, assistant runs, gallery queries. Ported from creative_store.py. */
import type { Store, Rec } from './store.ts'
import { ConflictError, KeyError, encode, integer, nowStamp, randomId } from './util.ts'

export function applyStoreCreative(store: Store): void {
  const data = () => store.data

  const conversationView = (row: { id: string; title: string; data: string; revision: number; created_at: string; updated_at: string }): Rec =>
    ({ ...(JSON.parse(row.data) as Rec), id: row.id, title: row.title, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at })

  const messageView = (row: { id: string; conversation_id: string; role: string; content: string; data: string; created_at: string }): Rec =>
    ({ ...(JSON.parse(row.data) as Rec), id: row.id, conversation_id: row.conversation_id, role: row.role, content: row.content, created_at: row.created_at })

  const runView = (row: { id: string; conversation_id: string; status: string; data: string; cancel_requested: number; created_at: string; updated_at: string }): Rec =>
    ({ ...(JSON.parse(row.data) as Rec), id: row.id, conversation_id: row.conversation_id, status: row.status, cancel_requested: row.cancel_requested === 1, created_at: row.created_at, updated_at: row.updated_at })

  store.listConversations = (query = ''): Rec[] => {
    const results: Rec[] = []
    for (const row of data().conversations.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
      const view = conversationView(row)
      if (query) {
        const haystack = (row.title + '\n' + data().messages.filter((m) => m.conversation_id === row.id).map((m) => m.content).join('\n')).toLowerCase()
        if (!haystack.includes(query.toLowerCase())) continue
      }
      view['message_count'] = data().messages.filter((m) => m.conversation_id === row.id).length
      results.push(view)
    }
    return results
  }

  store.getConversation = (ident: string): Rec => {
    const row = data().conversations.find((c) => c.id === ident)
    if (!row) throw new KeyError(ident)
    return {
      ...conversationView(row),
      messages: data().messages.filter((m) => m.conversation_id === ident).map(messageView),
      runs: data().assistant_runs.filter((r) => r.conversation_id === ident).slice(-20).reverse().map(runView),
    }
  }

  store.saveConversation = (input: Rec, ident?: string | null): Rec => {
    const now = nowStamp()
    const prev = ident ? data().conversations.find((c) => c.id === ident) : undefined
    if (ident && !prev) throw new KeyError(ident)
    if (prev && input['revision'] !== prev.revision) throw new ConflictError('会话设置已更新，请刷新')
    const title = (input['title'] ?? prev?.title ?? '新创作会话') as string
    if (typeof title !== 'string' || title.trim().length < 1 || title.trim().length > 200) throw new Error('会话名称需要 1–200 字')
    const value: Rec = prev ? JSON.parse(prev.data) as Rec : {
      profile_id: 'default', draft_mode: 'current', draft_id: null,
      context: { history_limit: 40, excluded_message_ids: [], pinned: '', summary: '', library_ids: [], asset_ids: [], guides: ['prompting'] },
    }
    for (const key of ['profile_id', 'draft_mode', 'draft_id', 'context']) {
      if (key in input) value[key] = structuredClone(input[key])
    }
    const rawSettings = data().kv['settings']
    const profiles = rawSettings ? ((JSON.parse(rawSettings) as Rec)['ai_profiles'] ?? {}) as Rec : {}
    if (value['profile_id'] !== 'default' && !Object.prototype.hasOwnProperty.call(profiles, String(value['profile_id'])))
      throw new Error('所选 AI 连接不存在')
    if (!['current', 'linked'].includes(value['draft_mode'] as string)) throw new Error('无效的草稿上下文模式')
    if (value['draft_mode'] === 'linked' && !data().drafts.some((d) => d.id === value['draft_id'])) throw new Error('请选择仍然存在的关联草稿')
    if (typeof value['profile_id'] !== 'string' || (value['draft_id'] !== null && typeof value['draft_id'] !== 'string')) throw new Error('模型配置或草稿 ID 无效')
    const ctx = value['context'] as Rec
    if (!(ctx instanceof Object) || Array.isArray(ctx)) throw new Error('上下文设置必须是对象')
    integer(ctx['history_limit'] ?? 40, '历史消息范围', 0, 500)
    for (const key of ['pinned', 'summary']) {
      if (typeof ctx[key] !== 'string' || (ctx[key] as string).length > 20000) throw new Error('固定要求或摘要超过 20000 字')
    }
    for (const key of ['excluded_message_ids', 'library_ids', 'asset_ids', 'guides']) {
      const values = ctx[key] ?? []
      if (!Array.isArray(values) || !values.every((v) => typeof v === 'string') || values.length > 2000) throw new Error('上下文选择需要 ID 列表')
    }
    if (((ctx['asset_ids'] ?? []) as unknown[]).length > 4) throw new Error('最多固定四张视觉图片')
    const finalId = ident ?? randomId()
    const row = {
      id: finalId, title: title.trim(), data: encode(value),
      revision: prev ? prev.revision + 1 : 0,
      created_at: prev?.created_at ?? now, updated_at: now,
    }
    const idx = data().conversations.findIndex((c) => c.id === finalId)
    if (idx >= 0) data().conversations[idx] = row
    else data().conversations.push(row)
    store.internalPersist()
    return store.getConversation(finalId)
  }

  store.deleteConversation = (ident: string): void => {
    if (data().assistant_runs.some((r) => r.conversation_id === ident && ['queued', 'running'].includes(r.status)))
      throw new ConflictError('请先停止正在执行的 AI 请求，再删除会话')
    const before = data().conversations.length
    data().conversations = data().conversations.filter((c) => c.id !== ident)
    if (data().conversations.length === before) throw new KeyError(ident)
    store.internalPersist()
  }

  store.addMessage = (ident: string, role: string, content: string, data_: Rec | null = null): Rec => {
    if (!['user', 'assistant'].includes(role) || typeof content !== 'string' || content.length > 200000) throw new Error('消息格式无效')
    const mid = randomId()
    const now = nowStamp()
    data().messages.push({ id: mid, conversation_id: ident, role, content, data: encode(data_ ?? {}), created_at: now })
    const conv = data().conversations.find((c) => c.id === ident)
    if (conv) conv.updated_at = now
    store.internalPersist()
    return { id: mid, conversation_id: ident, role, content, created_at: now, ...(data_ ?? {}) }
  }

  store.updateMessage = (mid: string, fields: Rec): Rec => {
    const row = data().messages.find((m) => m.id === mid)
    if (!row) throw new KeyError(mid)
    const value = { ...(JSON.parse(row.data) as Rec), ...structuredClone(fields) }
    row.data = encode(value)
    store.internalPersist()
    return { ...messageView(row), ...structuredClone(fields) }
  }

  store.forkConversation = (ident: string, messageId: string): Rec => {
    const current = store.getConversation(ident)
    const messages = current['messages'] as Rec[]
    const ids = messages.map((m) => m['id'] as string)
    const index = ids.indexOf(messageId)
    if (index < 0) throw new KeyError(messageId)
    const branch = store.saveConversation({ ...current, revision: undefined, title: (current['title'] as string).slice(0, 190) + ' · 分支' })
    for (const message of messages.slice(0, index + 1)) {
      const data = Object.fromEntries(Object.entries(message).filter(([k]) => !['id', 'conversation_id', 'role', 'content', 'created_at'].includes(k)))
      // Cloned proposals are historical records, never a second actionable copy.
      data['historical_copy'] = true
      store.addMessage(branch['id'] as string, message['role'] as string, message['content'] as string, data)
    }
    return store.getConversation(branch['id'] as string)
  }

  store.getAssistantRun = (ident: string): Rec => {
    const row = data().assistant_runs.find((r) => r.id === ident)
    if (!row) throw new KeyError(ident)
    return runView(row)
  }

  store.updateAssistantRun = (ident: string, opts: { status?: string | null; event?: Rec | null; data?: Rec | null; cancel?: boolean } = {}): Rec => {
    const row = data().assistant_runs.find((r) => r.id === ident)
    if (!row) throw new KeyError(ident)
    const value = { ...(JSON.parse(row.data) as Rec), ...(opts.data ?? {}) }
    if (opts.event) {
      const events = (value['events'] ?? []) as Rec[]
      events.push({ at: nowStamp(), ...opts.event })
      value['events'] = events
    }
    row.status = opts.status ?? row.status
    row.data = encode(value)
    row.cancel_requested = opts.cancel || row.cancel_requested === 1 ? 1 : 0
    row.updated_at = nowStamp()
    store.internalPersist()
    return store.getAssistantRun(ident)
  }

  store.queryJobs = (opts: { query?: string; offset?: number; limit?: number; model?: string; scheduleId?: string; libraryId?: string; status?: string; favorite?: boolean; archived?: boolean; after?: string; before?: string } = {}): Rec => {
    const { query = '', offset = 0, limit = 48, model = '', scheduleId = '', libraryId = '', status = '', favorite = false, archived = false, after = '', before = '' } = opts
    integer(offset, '分页位置', 0, 2 ** 31)
    integer(limit, '每页数量', 1, 200)
    const rows = data().jobs.filter((j) => j.archived === (archived ? 1 : 0))
    const filtered = rows.filter((j) => {
      if (status && j.status !== status) return false
      if (scheduleId && j.schedule_id !== scheduleId) return false
      if (after && j.created_at < after) return false
      if (before && j.created_at > before) return false
      if (favorite && j.favorite !== 1) return false
      const snapshot = JSON.parse(j.snapshot) as Rec
      if (model && ((snapshot['request'] as Rec)?.['model'] ?? '') !== model) return false
      if (libraryId) {
        const refs = (snapshot['library_refs'] ?? []) as unknown[]
        const hit = refs.some((r) => typeof r === 'string' ? r === libraryId : ((r as Rec)['id'] === libraryId || (r as Rec)['parent_id'] === libraryId))
        if (!hit) return false
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
