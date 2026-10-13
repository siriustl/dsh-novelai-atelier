/** Reviewable workspace proposals for the embedded AI. Ported from workspace_actions.py. */
import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import type { Workbench } from './app.ts'
import type { Rec } from './store.ts'
import { applyLibrary, defaultDraft } from './library.ts'
import { differences, lockPath } from './schedulePlanner.ts'
import { PrepareImageRequestSchema } from '../core/preparation.ts'
import { inspectImage } from '../core/metadata.ts'
import { recoverRequest } from '../core/recovery.ts'
import { presets, stableStringify, publicJob, publicSchedule } from './app.ts'
import { ConflictError, encode, nowStamp, asUtc } from './util.ts'
import { creativeRead, creativeTarget, creativePrepare, creativeApply, CREATIVE_READS, CREATIVE_TITLES } from './creativeActions.ts'

const TITLES: Record<string, string> = {
  'library.create': '创建资料', 'library.update': '更新资料', 'library.delete': '删除资料',
  'schedules.create': '创建定时计划', 'schedules.update': '更新定时计划', 'schedules.delete': '删除定时计划',
  'jobs.cancel': '取消任务', 'jobs.favorite': '修改收藏', 'jobs.pause': '暂停或恢复队列',
  'draft.reset': '清空当前草稿', 'draft.apply_library': '将资料应用到草稿',
  'draft.use_asset': '选择草稿输入图片', 'draft.recover': '从图片恢复草稿',
  'settings.update': '更新工作台设置', 'assets.prepare': '准备图片画布',
  ...CREATIVE_TITLES,
}

export function workspaceActionTitles(): Record<string, string> {
  return { ...TITLES }
}

export class WorkspaceActions {
  constructor(private wb: Workbench) {}

  async read(action: string, args: Rec): Promise<Rec> {
    if (CREATIVE_READS.has(action)) return creativeRead(this.wb, action, args)
    if (action === 'status') return this.wb.bootstrap()
    if (action === 'credits') return await this.wb.credits()
    if (action === 'library_get') return this.wb.store.getEntry(String(args['id']))
    if (action === 'assets') return { assets: this.wb.store.listAssets() }
    if (action === 'jobs') return args['id'] ? publicJob(this.wb.store.getJob(String(args['id']))) : { jobs: this.wb.jobs() }
    if (action === 'schedules') {
      if (args['id']) return publicSchedule(this.wb.store.getSchedule(String(args['id'])))
      return { schedules: this.wb.store.listSchedules().map(publicSchedule) }
    }
    if (action === 'schedule_runs') return { runs: this.wb.store.listScheduleRuns(String(args['id'])) }
    if (action === 'settings') return this.wb.settings.public()
    if (action === 'schema') return (await import('./describe.ts')).describeOperation()
    if (action === 'presets') return presets(String(args['model'] ?? 'nai-diffusion-5-full'))
    if (action === 'tags') {
      const query = String(args['query'] ?? '')
      if (query.length < 2 || query.length > 60) throw new Error('标签查询需要 2–60 字符')
      const tags = await this.wb.executor.suggestTags(query, String(args['model'] ?? 'nai-diffusion-5-full'), 'en')
      return { tags }
    }
    if (action === 'inspect' || action === 'recover') {
      const path = String(this.wb.store.getAsset(String(args['asset_id']))['path'])
      return action === 'inspect' ? inspectImage(path) : await recoverRequest(path)
    }
    throw new Error('未知工作台读取操作')
  }

  target(action: string, args: Rec): Rec | null {
    if (CREATIVE_TITLES[action]) return creativeTarget(this.wb, action, args)
    const store = this.wb.store
    if (action.startsWith('library.') && action !== 'library.create') return store.getEntry(String(args['entry_id']))
    if (action.startsWith('schedules.') && action !== 'schedules.create') {
      const schedule = store.listSchedules().find((s) => s['id'] === args['schedule_id'])
      if (!schedule) throw new Error(String(args['schedule_id']))
      return schedule
    }
    if (action.startsWith('draft.')) return store.getDraft((args['draft_id'] as string) ?? null)
    if (action === 'jobs.cancel' || action === 'jobs.favorite') return publicJob(store.getJob(String(args['job_id'])))
    if (action === 'jobs.pause') return { paused: store.getPaused() }
    if (action === 'settings.update') return this.wb.settings.public()
    return null
  }

  knownPaths(value: unknown): void {
    const known = new Set(this.wb.store.listAssets().map((a) => resolvePath(String(a['path']))))
    const check = (item: unknown): void => {
      if (item instanceof Object && !Array.isArray(item)) {
        for (const [key, child] of Object.entries(item)) {
          if (key.endsWith('_path') && child && !known.has(resolvePath(String(child))))
            throw new Error('AI 只能使用已导入工作台的素材；请先上传文件')
          check(child)
        }
      } else if (Array.isArray(item)) {
        for (const child of item) check(child)
      }
    }
    check(value)
  }

  async propose(action: string, inputArgs: Rec): Promise<Rec> {
    if (!(action in TITLES) || !(inputArgs instanceof Object)) throw new Error('不支持的工作台操作')
    if (encode(inputArgs).length > 120000) throw new Error('操作内容过大')
    const args = structuredClone(inputArgs)
    if (action.startsWith('draft.')) args['draft_id'] ??= this.wb.store.getDraft()['id']
    const before = this.target(action, args)
    let after: Rec | null = null
    let summary = TITLES[action]!
    if (CREATIVE_TITLES[action]) {
      ;[after, summary] = await creativePrepare(this.wb, action, args, before)
    } else if (action === 'library.create' || action === 'library.update') {
      const entry = args['entry'] as Rec
      if (!(entry instanceof Object) || !((entry['data'] ?? {}) instanceof Object)) throw new Error('资料需要有效对象')
      const merged: Rec = { ...(before ?? {}), ...entry }
      if (before && 'data' in entry) {
        merged['data'] = { ...((before['data'] ?? {}) as Rec), ...(entry['data'] as Rec) }
        ;(args['entry'] as Rec)['data'] = structuredClone(merged['data'])
      }
      if (!['character', 'branch', 'artist', 'blend', 'preset'].includes(String(merged['kind'])) || !String(merged['name'] ?? '').trim())
        throw new Error('资料需要名称和类型')
      if (before) {
        if ((entry['revision'] ?? before['revision']) !== before['revision']) throw new ConflictError('资料版本已更新')
        ;(args['entry'] as Rec)['revision'] = before['revision']
      }
      after = merged
      summary += '：' + String(merged['name'])
    } else if (action.startsWith('schedules.') && action !== 'schedules.delete') {
      const supplied = args['schedule'] as Rec
      const source = { ...(before ?? {}), ...supplied } as Rec
      if (before === null) source['enabled'] ??= false
      this.knownPaths(source['request'] ?? {})
      let prepared = await this.wb.prepareScheduleData(source, false) as Rec
      if (before && !('ai_recipe' in supplied)) delete prepared['ai_recipe']
      prepared = await this.wb.resolveScheduleRecipe(prepared, (args['schedule_id'] as string) ?? null)
      const preview = structuredClone(prepared)
      after = this.wb.store.previewSchedule(preview, (args['schedule_id'] as string) ?? null)
      args['schedule'] = Object.fromEntries(Object.entries(prepared).filter(([k]) =>
        !['id', 'snapshot', 'context', 'created_at', 'updated_at', 'runs', 'spent', 'reserved', 'next_run', 'revision'].includes(k)
        && (before === null || k in supplied)))
      ;if (before) (args['schedule'] as Rec)['revision'] = before['revision']
      summary = `${after['name']}：${after['enabled'] ? '开启' : '暂不启用'}；每次 ${after['count']} 张，最多 ${after['max_runs']} 次`
    } else if (action.startsWith('draft.')) {
      after = structuredClone(before) as Rec
      if (action === 'draft.reset') {
        Object.assign(after!, defaultDraft())
      } else if (action === 'draft.apply_library') {
        after = applyLibrary(after!, this.wb.store.getEntry(String(args['entry_id'])), this.wb.store.listEntries(), {
          prompt_set: (args['prompt_set'] as number) ?? -1, target_slot: (args['target_slot'] as number | null) ?? null,
        })
      } else if (action === 'draft.use_asset') {
        const field = String(args['field'] ?? 'image_path')
        if (!['image_path', 'mask_path'].includes(field)) throw new Error('只能选择原图或遮罩')
        if (field === 'mask_path' && after!['operation'] !== 'inpaint') throw new Error('遮罩只能用于局部重绘；请先选择局部重绘操作和原图')
        const asset = this.wb.store.getAsset(String(args['asset_id']))
        if (!String(asset['mime']).startsWith('image/')) throw new Error('请选择图片素材')
        if (field === 'image_path' && after!['operation'] === 'generate') after!['operation'] = 'img2img'
        ;(after!['request'] as Rec)[field] = asset['path']
      } else {
        // draft.recover: inspect the asset's original metadata for a reusable request.
        const asset = this.wb.store.getAsset(String(args['asset_id']))
        const recovered = await recoverRequest(String(asset['path']))
        const candidate = (recovered['request'] ?? recovered['recovered_request']) as Rec | undefined
        if (!(candidate instanceof Object) || recovered['ready_to_reuse'] !== true)
          throw new Error('此图片没有可直接恢复的完整请求；请先查看元信息并补齐缺失参数')
        this.knownPaths(candidate)
        await this.wb.validate(String(recovered['operation'] ?? 'generate'), candidate)
        after!['operation'] = recovered['operation'] ?? 'generate'
        after!['request'] = candidate
        after!['library_refs'] = []
      }
      // Clear/reset is an explicit user operation; other actions respect locks.
      if (action !== 'draft.reset') {
        const locks = ((before?.['locked_fields'] ?? []) as unknown[]).map((p) => lockPath(String(p)))
        for (const change of differences(before, after)) {
          const p = change['field']
          if (locks.some((lock) => p === lock || p.startsWith(lock + '.') || lock.startsWith(p + '.')))
            throw new Error('操作会修改已锁定字段：' + p)
        }
        if ((after!['request'] as Rec)['prompt']) {
          await this.wb.validate(String(after!['operation']), after!['request'] as Rec)
        }
      }
    } else if (action === 'settings.update') {
      const values = args['settings'] as Rec
      if (!(values instanceof Object) || Array.isArray(values) || Object.keys(values).some((k) => !['output_directory', 'ai'].includes(k)))
        throw new Error('AI 只能调整保存目录、DSH 渠道和输出上限；连接地址和密钥请在设置页修改')
      const ai = (values['ai'] ?? {}) as Rec
      if (!(ai instanceof Object) || Array.isArray(ai) || Object.keys(ai).some((k) => !['dsh_provider', 'dsh_model', 'max_output_tokens'].includes(k)))
        throw new Error('AI 设置包含不允许的字段')
      if ('output_directory' in values) {
        const directory = String(values['output_directory'])
        if (!directory.trim() || directory.includes('\0')) throw new Error('请选择有效的图片保存目录')
        values['output_directory'] = directory.trim()
      }
      for (const key of ['dsh_provider', 'dsh_model']) {
        if (key in ai) {
          const value = String(ai[key] ?? '').trim()
          if (value.length > 200) throw new Error('DSH 渠道 ID 过长')
          ai[key] = value
        }
      }
      if ('max_output_tokens' in ai && (typeof ai['max_output_tokens'] !== 'number' || !Number.isInteger(ai['max_output_tokens']) || ai['max_output_tokens'] < 256 || ai['max_output_tokens'] > 200000))
        throw new Error('max_output_tokens 需要 256–200000 的整数')
      after = { ...(before ?? {}), ...values, ai: { ...((before?.['ai'] ?? {}) as Rec), ...ai } }
    } else if (action === 'assets.prepare') {
      this.knownPaths(args['request'])
      const parsed = PrepareImageRequestSchema.safeParse(args['request'])
      if (!parsed.success) throw new Error('准备请求无效')
      after = (await this.wb.validate('prepare_image', args['request'] as Rec))['resolved_request'] as Rec
    } else if (action === 'jobs.pause') {
      if (typeof args['paused'] !== 'boolean') throw new Error('paused 必须是布尔值')
      after = { paused: args['paused'] }
      summary = args['paused'] ? '暂停后续提交' : '恢复队列，已启用的计划和排队任务将继续执行'
    } else if (action === 'jobs.favorite') {
      if (typeof args['favorite'] !== 'boolean') throw new Error('favorite 必须是布尔值')
      after = { ...(before ?? {}), favorite: args['favorite'] }
    }
    if (action.endsWith('.delete') && before) summary += '：' + String(before['name'] ?? before['title'] ?? '')
    const proposal: Rec = {
      id: randomUUID().replace(/-/gu, ''), action, title: TITLES[action]!, summary,
      arguments: args,
      before: action.startsWith('schedules.') && before ? publicScheduleShallow(before) : before,
      after, requires_confirmation: true, created_at: nowStamp(),
    }
    const data = this.wb.store.data
    data.workspace_proposals.push({ id: proposal['id'] as string, data: encode(proposal), status: 'pending', result: null, created_at: proposal['created_at'] as string })
    this.wb.store.internalPersist()
    return proposal
  }

  async apply(ident: string): Promise<Rec> {
    const data = this.wb.store.data
    const row = data.workspace_proposals.find((p) => p.id === ident)
    if (!row) throw new Error('提案不存在')
    if (row.status === 'done') return JSON.parse(row.result!) as Rec
    if (row.status !== 'pending') throw new ConflictError('该操作已处理或结果待核对，请刷新工作台，不要重复执行')
    if (Date.now() - asUtc(row.created_at).getTime() > 86400_000) throw new ConflictError('操作建议已过期，请重新提出')
    const proposal = JSON.parse(row.data) as Rec
    row.status = 'applying'
    this.wb.store.internalPersist()
    const action = proposal['action'] as string
    const args = proposal['arguments'] as Rec
    try {
      let current = this.target(action, args)
      if (current && action.startsWith('schedules.')) current = publicScheduleShallow(current)
      if (stable(current) !== stable(proposal['before'])) throw new ConflictError('操作对象已更改，请重新让 AI 检查后提出建议')
      let result: Rec
      if (CREATIVE_TITLES[action]) {
        result = await creativeApply(this.wb, action, args, current, proposal['after'] as Rec, ident)
      } else if (action === 'library.create') {
        result = this.wb.store.saveEntry(args['entry'] as Rec)
      } else if (action === 'library.update') {
        result = this.wb.store.saveEntry(args['entry'] as Rec, String(args['entry_id']), (current as Rec)['revision'] as number)
      } else if (action === 'library.delete') {
        this.wb.store.deleteEntry(String(args['entry_id']), (current as Rec)['revision'] as number)
        result = { deleted: true }
      } else if (action === 'schedules.create' || action === 'schedules.update') {
        result = await this.wb.saveSchedule(args['schedule'] as Rec, (args['schedule_id'] as string) ?? null)
      } else if (action === 'schedules.delete') {
        this.wb.store.deleteSchedule(String(args['schedule_id']), (current as Rec)['revision'] as number)
        result = { deleted: true }
      } else if (action === 'jobs.cancel') {
        result = publicJob(this.wb.store.cancelJob(String(args['job_id'])))
      } else if (action === 'jobs.favorite') {
        result = publicJob(this.wb.store.updateJob(String(args['job_id']), { favorite: args['favorite'] }))
      } else if (action === 'jobs.pause') {
        this.wb.store.setPaused(Boolean(args['paused']))
        result = { paused: args['paused'] }
      } else if (action.startsWith('draft.')) {
        result = this.wb.store.saveDraft(proposal['after'] as Rec, (current as Rec)['revision'] as number)
      } else if (action === 'settings.update') {
        result = this.wb.settings.save(args['settings'] as Rec)
      } else if (action === 'assets.prepare') {
        this.knownPaths(args['request'])
        result = await this.wb.prepare(args['request'] as Rec)
      } else {
        throw new Error('未知操作')
      }
      const response: Rec = { action, result }
      if (result instanceof Object && result['draft'] instanceof Object) response['draft'] = result['draft']
      if (action.startsWith('draft.')) response['draft'] = result
      row.status = 'done'
      row.result = encode(response)
      this.wb.store.internalPersist()
      return response
    } catch (error) {
      row.status = 'failed'
      this.wb.store.internalPersist()
      throw error
    }
  }
}

function stable(value: unknown): string {
  return stableStringify(value)
}

function publicScheduleShallow(value: Rec): Rec {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['snapshot', 'context'].includes(k)))
}
