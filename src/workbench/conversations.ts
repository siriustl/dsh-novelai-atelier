/** Durable conversational runs and explicit context assembly. Ported from conversations.py. */
import { createHash } from 'node:crypto'
import { publicJob, type Workbench } from './app.ts'
import type { Rec } from './store.ts'
import { Assistant, AssistantCancelled, AssistantError, ASSISTANT_SYSTEM as SYSTEM, TOOLS, clean, estimateTokens, fullGuide }  from './assistant.ts'
import { ConflictError, encode, nowStamp, randomId } from './util.ts'

export class Conversations {
  private running = new Set<string>()
  private controllers = new Map<string, AbortController>()

  constructor(private wb: Workbench) {}

  recover(): void {
    // A server restart cannot know whether a provider consumed a request.
    const data = this.wb.store.data
    for (const row of data.assistant_runs.filter((r) => ['queued', 'running'].includes(r.status))) {
      const value = JSON.parse(row.data) as Rec
      value['error'] = '服务已重启，请检查已保存的操作和任务；本轮未自动重试。'
      row.status = 'interrupted'
      row.data = encode(value)
      row.updated_at = nowStamp()
    }
    this.wb.store.internalPersist()
  }

  shutdown(): void {
    for (const ident of [...this.running]) void this.cancel(ident)
  }

  context(ident: string, opts: { message?: string; asset_ids?: string[] | null; library_ids?: string[] | null } = {}): Rec {
    const conv = this.wb.store.getConversation(ident)
    const options = conv['context'] as Rec
    const draft = this.wb.store.getDraft(conv['draft_mode'] === 'linked' ? (conv['draft_id'] as string) : null)
    const profileId = String(conv['profile_id'] ?? 'default')
    const config = this.wb.settings.aiConfig(profileId)
    const key = this.wb.settings.aiKey(profileId)
    const excludedIds = new Set((options['excluded_message_ids'] ?? []) as string[])
    const messages = conv['messages'] as Rec[]
    const eligible = messages.filter((m) => !excludedIds.has(String(m['id'])))
    const count = Number(options['history_limit'] ?? 40)
    const chosen = count > 0 ? eligible.slice(-count) : []
    const excluded = messages.filter((m) => !chosen.includes(m))
      .map((m) => ({ id: m['id'], reason: excludedIds.has(String(m['id'])) ? '手动排除' : '超出历史范围' }))
    const refs = [...new Set([...((options['library_ids'] ?? []) as string[]), ...((opts.library_ids ?? []) as string[])])]
    const library: Rec[] = []
    const missing: string[] = []
    for (const rid of refs) {
      try {
        const entry = this.wb.store.getEntry(rid)
        library.push(entry)
        const deps = [
          ...((entry['parent_id'] ? [entry['parent_id'] as string] : [])),
          ...(((entry['data'] as Rec)['artists'] ?? []) as Array<Rec>).map((a) => String(a['id'])),
        ]
        for (const dep of deps) {
          if (!library.some((e) => e['id'] === dep)) library.push(this.wb.store.getEntry(dep))
        }
      } catch {
        missing.push(rid)
      }
    }
    const assets = [...new Set([...((opts.asset_ids ?? []) as string[]), ...((options['asset_ids'] ?? []) as string[])])]
    if (assets.length > 4) throw new Error('本轮附件与固定图片合计不能超过四张')
    for (const aid of assets) this.wb.store.getAsset(aid)
    if (assets.length && this.wb.dshChat(profileId).chatVision !== true) throw new Error('当前模型渠道不支持图片输入，请移除图片或换选支持识图的模型')
    const contextData: Rec = {
      personal_preferences: String((this.wb.settings.raw())['creative_preferences'] ?? ''),
      pinned_requirements: String(options['pinned'] ?? ''),
      editable_summary: String(options['summary'] ?? ''),
      library,
    }
    const modelTopic = String((draft['request'] as Rec)['model'] ?? '').includes('4-5') ? 'v4.5' : 'v5'
    const topics = [...new Set(((options['guides'] ?? ['prompting']) as string[]).map((t) => (t === 'male' ? 'prompting' : t === 'model' ? modelTopic : t)))]
    const guides = topics.map((t) => ({ topic: t, characters: fullGuide(t).length }))
    const guideText = topics.map((t) => fullGuide(t)).join('\n')
    const message = opts.message ?? ''
    const baseEstimate = estimateTokens(SYSTEM + guideText) + estimateTokens(TOOLS) + estimateTokens(draft)
      + estimateTokens(contextData) + estimateTokens(message) + assets.length * 1600 + 500
    const allowance = Number(config['context_budget'] ?? 32000) - Number(config['max_output_tokens'] ?? 4096)
    const history: Rec[] = []
    const truncated: Rec[] = []
    for (const msg of chosen) {
      const extras: Rec = {}
      for (const k of ['proposal', 'actions', 'applied', 'applied_actions', 'jobs', 'receipts', 'asset_ids', 'library_ids', 'historical_copy']) {
        if (msg[k]) extras[k] = msg[k]
      }
      // State is read from the durable proposal/job, not a browser flag.
      for (const action of (extras['actions'] ?? []) as Rec[]) {
        const row = this.wb.store.data.workspace_proposals.find((p) => p.id === action['id'])
        if (row) {
          action['execution_status'] = row.status
          action['execution_result'] = row.result ? JSON.parse(row.result) : null
        }
      }
      if (extras['jobs']) {
        extras['jobs'] = (extras['jobs'] as Rec[]).map((j) => publicJob(this.wb.store.getJob(String(j['id']))))
      }
      let text = String(msg['content'])
      if (Object.keys(extras).length) text += '\n本条关联的实际记录（未执行的建议不代表已修改）：\n' + JSON.stringify(clean(extras, '', key))
      let cleaned = clean(text, '', key) as string
      if (text.length > 60000) {
        truncated.push({ id: msg['id'], reason: '单条关联记录过长，仅发送前 60000 字符', original_characters: text.length })
        cleaned += '\n[本条记录已截断，可按任务/资料 ID 读取完整内容]'
      }
      history.push({ role: msg['role'], content: cleaned, source_id: msg['id'] })
    }
    // Remove whole messages, never silently slice off their meanings.
    while (history.length && baseEstimate + history.reduce((a, m) => a + estimateTokens(m), 0) > allowance) {
      const removed = history.shift()!
      excluded.push({ id: removed['source_id'], reason: '上下文预算不足' })
    }
    const total = baseEstimate + history.reduce((a, m) => a + estimateTokens(m), 0)
    const selectedIds = history.map((h) => h['source_id'] as string)
    const oldImages = [...new Set(chosen.filter((m) => selectedIds.includes(String(m['id']))).flatMap((m) => (m['asset_ids'] ?? []) as string[]))]
    return {
      draft, profile_id: profileId, model: config['model'],
      history, context_data: clean(contextData, '', key), options,
      asset_ids: assets, library_ids: refs, included_message_ids: selectedIds,
      excluded_messages: excluded, truncated_messages: truncated, missing_library_ids: missing, guides,
      estimated_input_tokens: total, context_budget: Number(config['context_budget'] ?? 32000),
      max_output_tokens: Number(config['max_output_tokens'] ?? 4096), estimate_only: true,
      fits: total <= allowance,
      vision_note: '实际图像采用最长边 640 像素预览；本轮最多四张、8 MB。历史附件保留引用，不会自动重复发送像素。',
      historical_asset_ids: oldImages,
    }
  }

  start(ident: string, body: Rec, key: string): Rec {
    if (typeof key !== 'string' || key.length < 1 || key.length > 200) throw new Error('AI 请求需要稳定的幂等键')
    const allowed = new Set(['message', 'asset_ids', 'library_ids', 'allow_generate', 'max_images', 'max_total_anlas', 'draft_revision', 'draft_id'])
    if (Object.keys(body).some((k) => !allowed.has(k))) throw new Error('AI 请求包含未知字段')
    const message = String(body['message'] ?? '')
    if (message.trim().length < 1 || message.trim().length > 16000) throw new Error('请输入 1–16000 字的消息')
    const maxImages = Number(body['max_images'] ?? 1)
    const maxTotalAnlas = Number(body['max_total_anlas'] ?? 0)
    if (typeof body['allow_generate'] !== 'boolean' && body['allow_generate'] !== undefined) throw new Error('图片授权无效')
    if (!Number.isInteger(maxImages) || maxImages < 1 || maxImages > 50) throw new Error('图片授权无效')
    if (!Number.isInteger(maxTotalAnlas) || maxTotalAnlas < 0 || maxTotalAnlas > 100000) throw new Error('Anlas 授权无效')
    const fingerprint = createHash('sha256').update(encode([ident, body])).digest('hex')
    const data = this.wb.store.data
    const existing = data.assistant_runs.find((r) => r.idempotency_key === key)
    if (existing) {
      const run = runView(this.wb, existing)
      if (run['fingerprint'] !== fingerprint) throw new ConflictError('同一请求标识对应不同消息')
      return run
    }
    const context = this.context(ident, { message, asset_ids: body['asset_ids'] as string[], library_ids: body['library_ids'] as string[] })
    if (!context['fits']) throw new Error('固定上下文已经超过预算，请减少资料/指南或提高上下文预算')
    const draft = context['draft'] as Rec
    if (body['draft_id'] != null && (body['draft_id'] !== draft['id'] || body['draft_revision'] !== draft['revision']))
      throw new ConflictError('选择的草稿或版本已改变，请刷新上下文后发送')
    const rid = randomId()
    const mid = randomId()
    const now = nowStamp()
    const profile = String(context['profile_id'])
    const cleanMessage = clean(message, '', this.wb.settings.aiKey(profile))
    const runData: Rec = {
      fingerprint, request: { ...structuredClone(body), message: cleanMessage }, context, events: [], user_message_id: mid,
    }
    // One active assistant request per conversation (unique index in Python).
    if (data.assistant_runs.some((r) => r.conversation_id === ident && ['queued', 'running'].includes(r.status)))
      throw new ConflictError('此会话已有正在进行的请求，请等待或停止后再发送')
    data.assistant_runs.push({ id: rid, conversation_id: ident, status: 'queued', data: encode(runData), cancel_requested: 0, idempotency_key: key, created_at: now, updated_at: now })
    const msgData: Rec = {
      asset_ids: context['asset_ids'], library_ids: context['library_ids'],
      draft_snapshot: draft, run_id: rid, model: context['model'],
      authorization: Object.fromEntries(['allow_generate', 'max_images', 'max_total_anlas'].map((k) => [k, body[k] ?? undefined])),
    }
    data.messages.push({ id: mid, conversation_id: ident, role: 'user', content: String(cleanMessage), data: encode(msgData), created_at: now })
    const conv = data.conversations.find((c) => c.id === ident)
    if (conv) conv.updated_at = now
    this.wb.store.internalPersist()
    void this.execute(rid)
    return this.wb.store.getAssistantRun(rid)
  }

  private async execute(rid: string): Promise<void> {
    this.running.add(rid)
    const controller = new AbortController()
    this.controllers.set(rid, controller)
    const run = this.wb.store.getAssistantRun(rid)
    const ctx = run['context'] as Rec
    const body = run['request'] as Rec
    const draftId = String((ctx['draft'] as Rec)['id'])
    const revision = (ctx['draft'] as Rec)['revision'] as number
    const profile = String(ctx['profile_id'])
    const receipts: Rec[] = []
    const cancelled = (): boolean => {
      const latest = this.wb.store.getAssistantRun(rid)
      return latest['cancel_requested'] === true
    }
    const event = (value: Rec): void => {
      if (value['type'] === 'tool_result') receipts.push(value)
      this.wb.store.updateAssistantRun(rid, { event: value })
    }
    const wb = this.wb
    const assistant = new Assistant({
      getDraft: () => wb.store.getDraft(draftId),
      searchLibrary: (query, kind) => wb.store.listEntries(query, kind),
      validate: (operation, request) => wb.validate(operation, request),
      quote: (operation, request) => wb.quote(operation, request),
      async submit(operation, request, count, budget, rev) {
        if (cancelled()) throw new AssistantCancelled('请求已停止')
        return wb.submitJobs({
          operation, request, count, max_total_anlas: budget, draft_id: draftId, draft_revision: rev,
        }, `assistant-${rid}-${receipts.length}`)
      },
      getConfig: () => wb.settings.aiConfig(profile),
      getApiKey: () => wb.settings.aiKey(profile),
      ...wb.dshChat(profile),
      getAssetImage: (assetId) => wb.assets.vision(assetId),
      readWorkspace: (action, args) => wb.workspace.read(action, args),
      proposeAction: async (action, args) => {
        const merged = action.startsWith('draft.') ? { ...args, draft_id: draftId } : args
        return wb.workspace.propose(action, merged)
      },
    }, {
      onEvent: event,
      signal: controller.signal,
      cancelled,
    })
    this.wb.store.updateAssistantRun(rid, { status: 'running', event: { type: 'started', message: '正在整理上下文' } })
    try {
      const result = await assistant.run(String(body['message']), {
        history: ctx['history'] as Rec[],
        draftRevision: revision,
        allowGenerate: Boolean(body['allow_generate']),
        maxImages: Number(body['max_images'] ?? 1),
        maxTotalAnlas: Number(body['max_total_anlas'] ?? 0),
        assetIds: ctx['asset_ids'] as string[],
        contextOptions: ctx['options'] as Rec,
        contextData: ctx['context_data'] as Rec,
      })
      const message = this.wb.store.addMessage(String(run['conversation_id']), 'assistant', String(result['reply']), {
        ...result, run_id: rid, receipts, draft_snapshot: ctx['draft'],
        context_manifest: Object.fromEntries(['included_message_ids', 'excluded_messages', 'asset_ids', 'library_ids', 'guides', 'estimated_input_tokens', 'context_budget'].map((k) => [k, ctx[k]])),
      })
      this.wb.store.updateAssistantRun(rid, {
        status: result['cancelled'] === true ? 'cancelled' : 'completed',
        data: { result_message_id: message['id'], usage: (result['usage'] ?? []) as Rec[] },
        event: { type: 'finished', message: '本轮已保存' },
      })
    } catch (error) {
      const safe = error instanceof AssistantError || error instanceof ConflictError ? (error as Error).message : 'AI 请求未完成，请检查连接或所选草稿。未自动重试。'
      const status = cancelled() ? 'cancelled' : 'failed'
      this.wb.store.addMessage(String(run['conversation_id']), 'assistant', safe, { run_id: rid, error: true, receipts, model: ctx['model'] })
      this.wb.store.updateAssistantRun(rid, { status, data: { error: safe }, event: { type: status, message: safe } })
    } finally {
      this.running.delete(rid)
      this.controllers.delete(rid)
    }
  }

  cancel(rid: string): Rec {
    const run = this.wb.store.getAssistantRun(rid)
    if (!['queued', 'running'].includes(String(run['status']))) return run
    this.controllers.get(rid)?.abort()
    return this.wb.store.updateAssistantRun(rid, {
      cancel: true,
      event: { type: 'cancel_requested', message: '停止后续操作；正在等待的网络请求可能先返回。已提交的图片任务会保留。' },
    })
  }

  importLegacy(messages: unknown): Rec {
    if (!Array.isArray(messages) || messages.length > 200) throw new Error('旧会话格式无效')
    const fingerprint = createHash('sha256').update(encode(messages)).digest('hex')
    const key = 'legacy-chat-' + fingerprint
    const data = this.wb.store.data
    const existing = data.kv[key]
    if (existing) return { id: JSON.parse(existing), already_imported: true }
    const conv = this.wb.store.saveConversation({ title: '浏览器历史会话（已迁入）' })
    for (const msg of messages as Rec[]) {
      if (msg instanceof Object && ['user', 'assistant'].includes(String(msg['role'])) && typeof msg['content'] === 'string') {
        this.wb.store.addMessage(String(conv['id']), String(msg['role']), String(clean(msg['content'])), { historical_copy: true, legacy_record: clean(msg) })
      }
    }
    data.kv[key] = encode(conv['id'])
    this.wb.store.internalPersist()
    return { id: conv['id'], imported: true }
  }

  async applyMessage(mid: string, body: Rec): Promise<Rec> {
    const data = this.wb.store.data
    const row = data.messages.find((m) => m.id === mid)
    if (!row) throw new Error('消息不存在')
    const msg: Rec = { ...(JSON.parse(row.data) as Rec), id: row.id, conversation_id: row.conversation_id, role: row.role, content: row.content, created_at: row.created_at }
    if (msg['historical_copy']) throw new Error('分支或迁入历史仅作参考，请让 AI 重新给出当前建议')
    if (body['action_id']) {
      const aid = String(body['action_id'])
      if (!((msg['actions'] ?? []) as Rec[]).some((a) => a['id'] === aid)) throw new Error('此操作不属于该消息')
      const result = await this.wb.workspace.apply(aid)
      const appliedActions = [...new Set([...((msg['applied_actions'] ?? []) as string[]), aid])]
      this.wb.store.updateMessage(mid, { applied_actions: appliedActions })
      return result
    }
    const proposal = msg['proposal'] as Rec | undefined
    if (!proposal) throw new Error('该消息没有草稿建议')
    if (msg['applied']) return { draft: this.wb.store.getDraft(proposal['draft_id'] as string), already_applied: true }
    const patch = (body['patch'] ?? proposal['patch']) as Rec
    const subset = (part: unknown, source: unknown): boolean => {
      if (Array.isArray(part) || Array.isArray(source)) {
        return Array.isArray(part) && Array.isArray(source) && encode(part) === encode(source)
      }
      if (part instanceof Object && source instanceof Object) {
        return Object.entries(part).every(([k, v]) => Object.prototype.hasOwnProperty.call(source, k) && subset(v, (source as Rec)[k]))
      }
      return encode(part) === encode(source)
    }
    if (!subset(patch, proposal['patch'])) throw new Error('应用内容必须来自该建议')
    const result = await this.wb.applyProposal({ ...proposal, patch })
    this.wb.store.updateMessage(mid, { applied: true, applied_patch: patch, applied_revision: (result as Rec)['revision'] })
    return { draft: result }
  }
}

function runView(wb: Workbench, row: { id: string; conversation_id: string; status: string; data: string; cancel_requested: number; created_at: string; updated_at: string }): Rec {
  void wb
  return { ...(JSON.parse(row.data) as Rec), id: row.id, conversation_id: row.conversation_id, status: row.status, cancel_requested: row.cancel_requested === 1, created_at: row.created_at, updated_at: row.updated_at }
}
