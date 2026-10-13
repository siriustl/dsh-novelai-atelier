/** New reviewable operations, shared with the embedded AI. Ported from creative_actions.py. */
import { publicJob, type Workbench } from './app.ts'
import type { Rec } from './store.ts'
import { defaultDraft } from './library.ts'

export const CREATIVE_READS = new Set(['drafts', 'draft_versions', 'conversations', 'conversation', 'conversation_context', 'gallery', 'ai_profiles'])
export const CREATIVE_TITLES: Record<string, string> = {
  'drafts.create': '创建独立草稿', 'drafts.copy': '复制草稿', 'drafts.activate': '切换草稿',
  'drafts.rename': '重命名草稿', 'drafts.delete': '删除草稿', 'drafts.version': '保存命名版本',
  'conversations.rename': '重命名会话', 'conversations.context': '修改会话上下文',
  'conversations.fork': '从消息另开会话', 'conversations.delete': '删除会话',
  'jobs.archive': '归档作品', 'schedules.copy': '复制定时计划', 'schedules.once': '立即执行一次计划',
}

export function creativeRead(wb: Workbench, action: string, args: Rec): Rec {
  if (action === 'drafts') return { drafts: wb.store.listDrafts() }
  if (action === 'draft_versions') return { versions: wb.store.listVersions(String(args['id'])) }
  if (action === 'conversations') return { conversations: wb.store.listConversations(String(args['query'] ?? '')) }
  if (action === 'conversation') return wb.store.getConversation(String(args['id']))
  if (action === 'conversation_context') return conversationsContext(wb, String(args['id']))
  if (action === 'ai_profiles') return { profiles: wb.settings.profiles() }
  if (action === 'gallery') {
    const result = wb.store.queryJobs(args) as Rec
    return { ...result, items: ((result['items'] ?? []) as Rec[]).map(publicJob) }
  }
  throw new Error('未知读取操作')
}

export function conversationsContext(wb: Workbench, ident: string): Rec {
  const conversation = wb.store.getConversation(ident)
  return Object.fromEntries(Object.entries(conversation).filter(([k]) => !['messages', 'runs'].includes(k)))
}

export function creativeTarget(wb: Workbench, action: string, args: Rec): Rec | null {
  if (action.startsWith('drafts.')) {
    return action === 'drafts.create' ? null : wb.store.getDraft((args['draft_id'] as string) ?? null)
  }
  if (action.startsWith('conversations.')) {
    const conversation = wb.store.getConversation(String(args['conversation_id']))
    return Object.fromEntries(Object.entries(conversation).filter(([k]) => !['messages', 'runs', 'updated_at'].includes(k)))
  }
  if (action === 'jobs.archive') return publicJob(wb.store.getJob(String(args['job_id'])))
  if (action.startsWith('schedules.')) return wb.store.getSchedule(String(args['schedule_id']))
  return null
}

export async function creativePrepare(wb: Workbench, action: string, args: Rec, before: Rec | null): Promise<[Rec, string]> {
  const title = CREATIVE_TITLES[action]!
  if (action === 'drafts.create') {
    const draft = { ...defaultDraft(), ...((args['draft'] ?? {}) as Rec) } as Rec
    if (draft['request'] instanceof Object && (draft['request'] as Rec)['prompt']) {
      await wb.validate(String(draft['operation'] ?? 'generate'), draft['request'] as Rec)
    }
    return [draft, `${title}：${draft['name']}`]
  }
  if (['drafts.rename', 'drafts.version', 'conversations.rename'].includes(action)) {
    const name = String(args['name'] ?? '')
    if (name.trim().length < 1 || name.trim().length > 200) throw new Error('请输入有效名称')
    return [{ name }, `${title}：${name}`]
  }
  if (action === 'conversations.context') {
    const values = (args['settings'] ?? {}) as Rec
    if (!(values instanceof Object) || Object.keys(values).some((k) => !['context', 'draft_id', 'draft_mode', 'profile_id'].includes(k)))
      throw new Error('只允许修改会话上下文、草稿关联和模型配置选择')
    const merged = Object.fromEntries(Object.entries({ ...(before ?? {}), ...values }).filter(([k]) => !['messages', 'runs'].includes(k)))
    return [merged, title]
  }
  if (action === 'jobs.archive') {
    if (typeof args['archived'] !== 'boolean') throw new Error('archived 需要布尔值')
    return [{ archived: args['archived'] }, args['archived'] ? '归档作品' : '移出归档']
  }
  if (action === 'schedules.once') {
    return [publicScheduleShallow(before!), `立即执行「${before!['name']}」一次，共 ${before!['count']} 张，计入原计划执行次数`]
  }
  if (action === 'schedules.copy') {
    return [{ ...publicScheduleShallow(before!), enabled: false }, '创建暂停状态的计划副本，保留生成参数']
  }
  return [null as unknown as Rec, title]
}

export async function creativeApply(wb: Workbench, action: string, args: Rec, before: Rec | null, after: Rec, proposalId: string): Promise<Rec> {
  const store = wb.store
  if (action === 'drafts.create') return { draft: store.createDraft(after, false) }
  if (action === 'drafts.copy') return { draft: store.createDraft({ ...before, name: String(before!['name']) + ' · 副本' }, false) }
  if (action === 'drafts.activate') return { draft: store.switchDraft(String(before!['id'])) }
  if (action === 'drafts.rename') return { draft: store.saveDraft({ id: before!['id'], name: args['name'] }, before!['revision'] as number) }
  if (action === 'drafts.delete') return { draft: store.deleteDraft(String(before!['id']), before!['revision'] as number), deleted: true }
  if (action === 'drafts.version') return store.saveVersion(String(before!['id']), String(args['name']), before!['revision'] as number)
  if (action === 'conversations.rename') return store.saveConversation({ title: String(args['name']), revision: before!['revision'] }, String(before!['id']))
  if (action === 'conversations.context') return store.saveConversation({ ...((args['settings'] ?? {}) as Rec), revision: before!['revision'] }, String(before!['id']))
  if (action === 'conversations.fork') return store.forkConversation(String(before!['id']), String(args['message_id']))
  if (action === 'conversations.delete') {
    store.deleteConversation(String(before!['id']))
    return { deleted: true }
  }
  if (action === 'jobs.archive') return store.curateJobs([String(before!['id'])], { archived: Boolean(args['archived']) })
  if (action === 'schedules.once') {
    const result = store.scheduleOnce(String(before!['id']), before!['revision'] as number, proposalId)
    wb.worker.wake()
    return result
  }
  if (action === 'schedules.copy') {
    const data = Object.fromEntries(Object.entries(before!).filter(([k]) =>
      !['id', 'revision', 'expected_revision', 'runs', 'spent', 'reserved', 'next_run', 'created_at', 'updated_at', 'ai_library_snapshot', 'snapshot', 'context'].includes(k)))
    data['name'] = String(before!['name']) + ' · 副本'
    data['enabled'] = false
    return await wb.saveSchedule(data)
  }
  throw new Error('未知操作')
}

function publicScheduleShallow(value: Rec): Rec {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['snapshot', 'context'].includes(k)))
}
