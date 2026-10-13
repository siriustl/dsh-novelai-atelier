/** Workbench orchestration: validate/quote/submit pipeline + schedules. Ported from application.py. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { redactBinaryPayload, OperationExecutor, defaultOutputDir } from '../core/service.ts'
import { GenerationLock, NovelAIClient } from '../core/client.ts'
import { quoteOperation } from '../core/billing.ts'
import { normalizeRequest } from '../core/normalize.ts'
import { prepareOperation, zodMessage } from '../core/operations.ts'
import type { Rec } from './store.ts'
import { Store, ConflictError } from './store.ts'
import { Settings } from './settings.ts'
import { Assets } from './assets.ts'
import { Worker, JobNotSubmitted } from './worker.ts'
import { prepareImage, PrepareImageRequestSchema } from '../core/preparation.ts'
import { creativeDraft, fixedPrefix } from './schedulePlanner.ts'
import { defaultDraft } from './library.ts'
import { specCatalog } from '../core/specs.ts'
import { existsSync, readFileSync } from 'node:fs'
import { WorkspaceActions } from './workspaceActions.ts'
import { Conversations } from './conversations.ts'
import { composeSchedule } from './planSchedule.ts'
import type { DshLlmBridge } from './dshLlm.ts'

export const OPERATIONS = ['generate', 'img2img', 'inpaint', 'upscale', 'augment', 'enhance', 'encode_vibe', 'reference_generate'] as const
export const MODELS = ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated']

import { VERSION } from '../version.ts'
export { VERSION }

export function workbenchDirectory(): string {
  return process.env['NOVELAI_WORKBENCH_DIR'] || join(homedir(), '.novelai-workbench')
}

export function guide(topic: string): string {
  const allowed = new Set(['overview', 'quickstart', 'prompting', 'v5', 'v4.5', 'characters-artists', 'workbench', 'examples', 'parameters', 'sources', 'advanced', 'composition'])
  if (!allowed.has(topic)) throw new Error('未知指南主题')
  const name = topic === 'overview' ? 'overview.md' : `${topic}.md`
  for (const base of [join(import.meta.dirname ?? '.', '../assets/guides'), join(import.meta.dirname ?? '.', '../../assets/guides'), join(process.cwd(), 'assets/guides')]) {
    const path = join(base, name)
    if (existsSync(path)) return readFileSync(path, 'utf8')
  }
  throw new Error('指南文件缺失')
}

export function presets(model: string): Rec {
  if (!MODELS.includes(model)) throw new Error('未知模型')
  const data = specCatalog().models[model]!
  return {
    quality_presets: data['quality_presets'], negative_presets: data['uc_presets'],
    default_quality_preset: 'standard', default_negative_preset: 'heavy',
  }
}

export interface WorkbenchHooks {
  /** Assistant factory for scheduled AI composition; wired after assistant.ts loads. */
  planSchedule?: (run: Rec, signal?: AbortSignal) => Promise<Rec>
}

export class Workbench {
  store: Store
  settings: Settings
  assets: Assets
  executor: OperationExecutor
  worker: Worker
  workspace: WorkspaceActions
  conversations: Conversations
  hooks: WorkbenchHooks = {}
  maintenance = false
  /** Invalidates writes prepared against data replaced by a restore. */
  restoreEpoch = 0

  assertRestoreEpoch(epoch: number): void {
    if (this.maintenance || epoch !== this.restoreEpoch) throw new ConflictError('工作台已被更新（备份恢复），请刷新后重试')
  }
  /** Data directory root (assets/, backups/, outputs/ live here). */
  readonly root: string
  /** Whether start() is currently in effect (worker + conversation recovery). */
  workerStarted = false

  constructor(root?: string) {
    const dir = root ?? workbenchDirectory()
    this.root = dir
    this.store = new Store(dir)
    this.settings = new Settings(this.store, dir, () => this.pluginToken ?? '', () => this.dshBridge !== null)
    this.assets = new Assets(this.store, dir, () => {
      const epoch = this.restoreEpoch
      return () => this.assertRestoreEpoch(epoch)
    })
    this.executor = new OperationExecutor(
      {
        token: () => this.settings.naiToken(),
        baseUrl: () => String(this.settings.raw()['nai_base_url']),
        proxy: () => (this.settings.raw()['proxy_url'] as string) || null,
        outputDir: () => String(this.settings.raw()['output_directory'] || defaultOutputDir()),
        dataDir: () => dir,
        retryDelaySeconds: () => Number(this.settings.raw()['retry_delay_seconds']),
        retryMaxAttempts: () => Number(this.settings.raw()['retry_max_attempts']),
      },
      new GenerationLock(),
    )
    this.workspace = new WorkspaceActions(this)
    this.conversations = new Conversations(this)
    this.worker = new Worker(this.store, (job) => this.runJob(job), (run, signal) => this.planSchedule(run, signal))
    this.hooks.planSchedule = (run, signal) => composeSchedule(this, run, signal)
    this.pluginToken = ''
  }

  /** Optional token injected from plugin config / DSH credentials. */
  pluginToken = ''

  private dshBridge: DshLlmBridge | null = null

  /** Wire the DSH host LLM runtime (called from the plugin entry once services resolve). */
  setDshLlm(bridge: DshLlmBridge | null): void {
    this.dshBridge = bridge
  }

  /** Assistant 上下文插槽：AI 构思走 DSH 渠道；未接桥时为空对象。 */
  dshChat(profileId = 'default'): { chatComplete(payload: Rec, signal?: AbortSignal): Promise<Rec>; chatVision: boolean } {
    const bridge = this.dshBridge
    if (!bridge) return {
      chatComplete: async () => { throw new Error('DSH LLM 桥未就绪，无法调用模型') },
      chatVision: false,
    }
    const ai = this.settings.aiConfig(profileId)
    const override = (ai['dsh_provider'] || ai['dsh_model'])
      ? { provider: String(ai['dsh_provider'] ?? ''), model: String(ai['dsh_model'] ?? '') }
      : undefined
    return { chatComplete: (payload, signal) => bridge.complete(payload, signal, override), chatVision: bridge.vision === true }
  }

  /** DSH 渠道目录（provider/model 枚举 + 当前默认），供设置页选择。 */
  async aiChannelCatalog(): Promise<Rec> {
    if (!this.dshBridge) return { providers: [], default_selection: {}, available: false }
    const catalog = await this.dshBridge.catalog()
    return { ...catalog, available: true, override: this.settings.aiConfig() }
  }

  /** 测试 DSH 渠道连通性（发一个极小补全）。 */
  async testAiChannel(): Promise<Rec> {
    if (!this.dshBridge) throw new Error('DSH LLM 桥不可用（需要 llm 与 agentDefaultModel 服务）')
    const started = Date.now()
    const override = this.settings.aiConfig()
    const message = await this.dshBridge.complete({ messages: [{ role: 'user', content: '请只回复两个字母：OK' }], max_tokens: 512 }, undefined, { provider: override['dsh_provider'], model: override['dsh_model'] })
    const route = await this.dshBridge.describe()
    return { ok: true, reply: String(message['content'] ?? '').slice(0, 100), route: { ...route, provider: override['dsh_provider'] || route['provider'], model: override['dsh_model'] || route['model'] }, elapsed_ms: Date.now() - started }
  }

  start(): void {
    this.store.clearStaleInternalErrorPause()
    this.conversations.recover()
    this.worker.start()
    this.workerStarted = true
  }

  stop(): void {
    this.conversations.shutdown()
    this.worker.stop()
    this.workerStarted = false
  }

  client(context?: Rec): NovelAIClient {
    if (!context) {
      const current = this.settings.raw()
      return new NovelAIClient({ token: this.settings.naiToken(), baseUrl: String(current['nai_base_url']), proxy: (current['proxy_url'] as string) || null,
        retryDelaySeconds: Number(current['retry_delay_seconds']), retryMaxAttempts: Number(current['retry_max_attempts']) })
    }
    return new NovelAIClient({
      token: this.settings.secret(context['nai_secret'] as string),
      baseUrl: String(context['nai_base_url']),
      proxy: (context['proxy_url'] as string) || null,
      retryDelaySeconds: Number(context['retry_delay_seconds'] ?? 3),
      retryMaxAttempts: Number(context['retry_max_attempts'] ?? 3),
    })
  }

  async credits(): Promise<Rec> {
    return await this.executor.credits() as unknown as Rec
  }

  async validate(operation: string, request: Rec): Promise<Rec> {
    if (operation === 'prepare_image') {
      const parsed = PrepareImageRequestSchema.safeParse(request)
      if (!parsed.success) throw new Error(zodMessage(parsed.error))
      return { valid: true, resolved_request: parsed.data, warnings: [], api_payload: null }
    }
    if (!(OPERATIONS as readonly string[]).includes(operation)) throw new Error('不支持的操作')
    const prepared = await prepareOperation(request, operation)
    const resolved = structuredClone(prepared.summary['request']) as Rec
    if (prepared.generation_request !== null) {
      const parameters = prepared.payload['parameters'] as Rec
      resolved['seed'] = parameters['seed']
      if (resolved['focus_box']) resolved['focus_size'] = [parameters['width'], parameters['height']]
      else {
        resolved['width'] = parameters['width']
        resolved['height'] = parameters['height']
      }
      if ('extra_noise_seed' in resolved) resolved['extra_noise_seed'] = parameters['extra_noise_seed']
    }
    return {
      valid: true, resolved_request: resolved, warnings: prepared.warnings,
      api_payload: redactBinaryPayload(prepared.payload), preparation: prepared.summary,
      expected_outputs: prepared.expected_outputs, expected_dimensions: prepared.expected_dimensions,
    }
  }

  async quote(operation: string, request: Rec): Promise<Rec> {
    const valid = await this.validate(operation, request)
    if (operation === 'prepare_image') return { ...valid, estimated_anlas: 0 }
    const prepared = await prepareOperation(valid['resolved_request'] as Rec, operation)
    const credits = await this.executor.credits()
    return { ...valid, ...quoteOperation(prepared, credits) }
  }

  fingerprint(body: unknown): string {
    return createHash('sha256').update(stableStringify(body)).digest('hex')
  }

  async submitJobs(body: Rec, idempotencyKey?: string | null, signal?: AbortSignal): Promise<Rec> {
    const epoch = this.restoreEpoch
    this.assertRestoreEpoch(epoch)
    const fp = this.fingerprint(body)
    if (idempotencyKey) {
      const existing = this.store.getSubmission(idempotencyKey, fp)
      if (existing !== null) return { jobs: existing.map((j) => publicJob(j)) }
    }
    signal?.throwIfAborted()
    const operation = (body['operation'] ?? 'generate') as string
    if (!(OPERATIONS as readonly string[]).includes(operation)) throw new Error('请选择远程生图操作；本地图片处理请使用准备图片')
    const variants = body['variants'] as Rec[] | undefined
    if (variants !== undefined && variants !== null && (!Array.isArray(variants) || variants.length < 1 || variants.length > 50 || variants.some((v) => !(v instanceof Object))))
      throw new Error('参数对照需要 1–50 组修改')
    const count = variants ? variants.length : (body['count'] ?? 1) as number
    const budget = (body['max_total_anlas'] ?? 0) as number
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('单批次数需要为 1–50')
    if (!Number.isInteger(budget) || budget < 0 || budget > 100000) throw new Error('总预算无效')
    const draft = this.store.getDraft((body['draft_id'] as string) ?? null)
    if (body['draft_revision'] != null && body['draft_revision'] !== draft['revision']) throw new ConflictError('草稿已被修改，请刷新后重试')
    const request = (await this.validate(operation, body['request'] as Rec))['resolved_request'] as Rec
    this.assertRestoreEpoch(epoch)
    signal?.throwIfAborted()
    const frozen = this.assets.freezePaths(request) as Rec
    const context = this.settings.freeze()
    const seedMode = (body['seed_mode'] ?? 'increment') as string
    if (!['fixed', 'increment', 'random'].includes(seedMode)) throw new Error('种子模式无效')
    const snapshots: Rec[] = []
    for (let i = 0; i < count; i++) {
      let selected = structuredClone(frozen)
      if (variants) {
        const variant = variants[i]!
        const allowed = new Set(['model', 'scale', 'steps', 'cfg_rescale', 'strength', 'noise', 'seed', 'sampler', 'quality_preset', 'negative_preset', 'prompt_suffix'])
        if (Object.keys(variant).some((k) => !allowed.has(k))) throw new Error('对照批次只能改变提示词片段、模型及生成参数')
        for (const [k, v] of Object.entries(variant)) {
          if (k !== 'prompt_suffix') selected[k] = v
        }
        if (variant['prompt_suffix']) selected['prompt'] = `${selected['prompt'] ?? ''}, ${String(variant['prompt_suffix'])}`
        selected = (await this.validate(operation, normalizeRequest(selected)))['resolved_request'] as Rec
        signal?.throwIfAborted()
      }
      if ('seed' in selected) {
        const seed = selected['seed'] as number
        selected['seed'] = seedMode === 'fixed' ? seed
          : seedMode === 'random' ? Math.floor(Math.random() * 2 ** 32)
            : ((seed ?? 0) + i) % 4294967296
      }
      snapshots.push({
        operation, request: selected, context,
        draft_id: draft['id'], draft_revision: draft['revision'],
        library_refs: structuredClone(body['library_refs'] ?? draft['library_refs']),
        ...(variants ? { comparison: { index: i, parameters: variants[i] } } : {}),
      })
    }
    signal?.throwIfAborted()
    this.assertRestoreEpoch(epoch)
    const jobs = this.store.createJobs(snapshots, budget, idempotencyKey ?? null, {
      submissionFingerprint: idempotencyKey ? fp : undefined,
      expectedDraftRevision: (body['draft_revision'] as number | undefined) ?? undefined,
    })
    this.worker.wake()
    return { jobs: jobs.map((j) => publicJob(j)) }
  }

  async runJob(job: Rec): Promise<Rec> {
    const operation = job['operation'] as string
    let client: NovelAIClient | null = null
    // Preflight failures are safe: nothing billable was submitted.
    let prepared
    try {
      prepared = await prepareOperation(job['request'] as Rec, operation)
      const context = job['context'] as Rec
      client = this.client(context)
    } catch (error) {
      if (error instanceof JobNotSubmitted) throw error
      throw new JobNotSubmitted(`${(error as Error).message}`.slice(0, 500) || '生成前检查失败，请检查连接和设置')
    }
    const context = job['context'] as Rec
    const jobId = job['id'] as string
    const scheduleId = job['schedule_id'] as string | null
    const beforeSubmit = (): void => {
      const latest = this.store.getJob(jobId)
      if (this.worker.isStopped || this.store.getPaused() || latest['cancel_requested'] === true) throw new JobNotSubmitted('提交前已停止、暂停或取消，本次未生成图片')
      if (scheduleId) {
        const schedule = this.store.getSchedule(scheduleId)
        const origin = (job['schedule_run'] ?? {}) as Rec
        if (origin['revision'] != null && schedule['revision'] !== origin['revision'])
          throw new JobNotSubmitted('定时计划已更改，本次未生成图片')
      }
    }
    try {
      const result = await this.executor.execute(prepared, { client, outputDir: String(context['output_directory']), beforeSubmit })
      const out = result as Rec
      out['assets'] = []
      for (const path of (out['artifact_paths'] ?? []) as string[]) {
        try {
          ;(out['assets'] as Rec[]).push(await this.assets.fromPath(path))
        } catch (error) {
          ;((out['warnings'] ??= []) as string[]).push(`原图已保存，但图库导入失败：${(error as Error).name}`)
        }
      }
      return out
    } finally {
      client = null
    }
  }

  async prepare(request: Rec): Promise<Rec> {
    const epoch = this.restoreEpoch
    this.assertRestoreEpoch(epoch)
    const parsed = PrepareImageRequestSchema.safeParse(request)
    if (!parsed.success) throw new Error(zodMessage(parsed.error))
    const result = await prepareImage(parsed.data, String(this.settings.raw()['output_directory'] || defaultOutputDir()))
    this.assertRestoreEpoch(epoch)
    result['assets'] = []
    for (const path of result['artifact_paths'] as string[]) {
      this.assertRestoreEpoch(epoch)
      ;(result['assets'] as Rec[]).push(await this.assets.fromPath(path))
      this.assertRestoreEpoch(epoch)
    }
    return result
  }

  prepareScheduleData(data: Rec, freeze = true): Promise<Rec> {
    return this.prepareScheduleDataAsync(data, freeze)
  }

  async saveSchedule(data: Rec, ident?: string | null): Promise<Rec> {
    const epoch = this.restoreEpoch
    this.assertRestoreEpoch(epoch)
    const changes = structuredClone(data)
    let merged = data
    if (ident) {
      const current = this.store.listSchedules().find((s) => s['id'] === ident)
      if (!current) throw new Error('计划不存在')
      merged = { ...current, ...data }
      if ('revision' in changes) changes['expected_revision'] = changes['revision']
    }
    let prepared = await this.prepareScheduleDataAsync(merged)
    if (ident) {
      prepared = { ...changes, ...Object.fromEntries(['operation', 'request', 'snapshot'].map((key) => [key, prepared[key]])) } as Rec
    }
    prepared = await this.resolveScheduleRecipe(prepared, ident)
    this.assertRestoreEpoch(epoch)
    const result = this.store.saveSchedule(prepared, ident ?? null)
    return publicSchedule(result)
  }

  async resolveScheduleRecipe(data: Rec, ident?: string | null): Promise<Rec> {
    const normalized = this.store.previewSchedule(data, ident ?? null) as Rec
    if (normalized['execution_mode'] === 'ai') {
      const enriched = creativeDraft(normalized).draft['request'] as Rec
      await this.validate(normalized['operation'] as string, { ...enriched, prompt: enriched['prompt'] || 'scenery' })
      data = structuredClone(data)
      // Identity and artist fragments belong to the frozen recipe, not the editable base request.
      data['request'] = structuredClone(normalized['request'])
      data['snapshot'] = { ...(normalized['snapshot'] as Rec ?? {}), request: data['request'] }
    }
    return data
  }

  async prepareScheduleDataAsync(data: Rec, freeze = true): Promise<Rec> {
    const epoch = this.restoreEpoch
    const copy = structuredClone(data)
    const operation = (copy['operation'] ?? 'generate') as string
    if (!(OPERATIONS as readonly string[]).includes(operation)) throw new Error('定时计划需要选择生图或远程图像操作；本地画布准备请直接执行')
    const raw = normalizeRequest((copy['request'] ?? {}) as Rec)
    const ai = copy['execution_mode'] === 'ai'
    if (ai && !['generate', 'img2img', 'inpaint', 'enhance', 'reference_generate'].includes(operation))
      throw new Error('AI 计划需要支持提示词的操作；放大等操作可使用固定请求计划')
    const blank = Boolean(ai) && !raw['prompt']
    if (blank) raw['prompt'] = 'scenery'
    const request = (await this.validate(operation, raw))['resolved_request'] as Rec
    if (freeze) this.assertRestoreEpoch(epoch)
    if (blank) request['prompt'] = ''
    copy['operation'] = operation
    copy['request'] = freeze ? this.assets.freezePaths(request) : request
    copy['snapshot'] = { operation, request: copy['request'], context: freeze ? this.settings.freeze() : {} }
    return copy
  }

  planSchedule(run: Rec, signal?: AbortSignal): Promise<Rec> {
    signal?.throwIfAborted()
    if (!this.hooks.planSchedule) throw new JobNotSubmitted('尚未配置定时 AI 助手，本轮未提交生图')
    return this.hooks.planSchedule(run, signal)
  }

  async previewSchedule(data: Rec): Promise<Rec> {
    let prepared = await this.prepareScheduleDataAsync(data, false)
    prepared = await this.resolveScheduleRecipe(prepared, (data['id'] as string) ?? null)
    const schedule = this.store.previewSchedule(prepared, (data['id'] as string) ?? null) as Rec
    if ((schedule['execution_mode'] ?? 'fixed') !== 'ai') {
      return { operation: schedule['operation'], request: schedule['request'], ai_reply: '固定请求预览', jobs: [] }
    }
    const plan = await this.planSchedule({ schedule, scheduled_for: new Date().toISOString(), preview: true })
    const { snapshots: _s, ...rest } = plan
    void _s
    return { ...rest, jobs: [], preview: true }
  }

  resetDraft(revision: number, draftId?: string | null): Rec {
    return this.store.saveDraft({ ...defaultDraft(), ...(draftId ? { id: draftId } : {}) }, revision)
  }

  jobs(): Rec[] {
    return this.store.listJobs().map((j) => publicJob(j))
  }

  /** Register a direct tool generation (queue-bypassing) so it appears in the gallery. */
  async registerDirectGeneration(result: Rec, request: unknown): Promise<void> {
    const epoch = this.restoreEpoch
    try {
      this.assertRestoreEpoch(epoch)
      const artifacts = ((result['artifact_paths'] ?? []) as string[]).slice(0, 16)
      const assets: Rec[] = []
      for (const path of artifacts) {
        this.assertRestoreEpoch(epoch)
        try { assets.push(await this.assets.fromPath(path)) } catch (error) {
          ;((result['warnings'] ??= []) as string[]).push(`图片已保存，但图库素材登记失败：${(error as Error).message}`)
        }
      }
      this.assertRestoreEpoch(epoch)
      const snapshot = { operation: String(result['operation'] ?? 'generate'), request: (request ?? {}) as Rec, library_refs: [] }
      const actual = result['anlas_spent']
      this.store.recordDirectJob(snapshot, { ...result, assets }, typeof actual === 'number' && Number.isFinite(actual) ? actual : null)
    } catch (error) {
      ;((result['warnings'] ??= []) as string[]).push(`图片或回执已保存，但画廊记录保存失败：${(error as Error).message}`)
    }
  }

  async registerDirectFailure(error: unknown, request: unknown): Promise<void> {
    const failure = error as { notSubmitted?: boolean; partialResult?: Rec; receiptPath?: string; submission_outcome_unknown?: boolean }
    if (failure.notSubmitted || !failure.partialResult) return
    const result = failure.partialResult
    if (failure.receiptPath) result['record_path'] = failure.receiptPath
    if (failure.submission_outcome_unknown) result['submission_outcome_unknown'] = true
    await this.registerDirectGeneration(result, request)
  }

  bootstrap(compact = false): Rec {
    const common = {
      version: VERSION, models: MODELS, operations: [...OPERATIONS, 'prepare_image'],
      draft: this.store.getDraft(), settings: this.settings.public(), paused: this.store.getPaused(),
      queue: this.store.queueState(), worker_error: this.worker.lastError,
    }
    if (compact) {
      return {
        ...common, jobs: this.store.listJobs(12).map(publicJob),
        summary: {
          active_jobs: this.store.data.jobs.filter((job) => ['queued', 'running'].includes(job.status)).length,
          library_count: this.store.data.entries.length, schedule_count: this.store.data.schedules.length,
        },
      }
    }
    return { ...common, library: this.store.listEntries(), jobs: this.jobs(), schedules: this.store.listSchedules().map(publicSchedule) }
  }

  async applyProposal(body: Rec): Promise<Rec> {
    const epoch = this.restoreEpoch
    const { mergeDraftPatch } = await import('./assistant.ts')
    this.assertRestoreEpoch(epoch)
    const draft = this.store.getDraft((body['draft_id'] as string) ?? null)
    if (draft['revision'] !== body['base_revision']) throw new ConflictError('AI 建议基于旧草稿，请重新生成建议')
    const updated = mergeDraftPatch(draft, body['patch'] as Rec)
    await this.validate(updated['operation'] as string, updated['request'] as Rec)
    this.assertRestoreEpoch(epoch)
    return this.store.saveDraft(updated, draft['revision'] as number)
  }
}

export function publicJob(job: Rec): Rec {
  const data = Object.fromEntries(Object.entries(job).filter(([k]) => !['context', 'snapshot'].includes(k)))
  data['assets'] = ((job['result'] as Rec | null)?.['assets'] ?? []) as Rec[]
  return data
}

export function publicSchedule(value: Rec): Rec {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['snapshot', 'context'].includes(k)))
}

/** Deterministic JSON stringify for fingerprints (Python sort_keys equivalent). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('数据必须是有限 JSON 值')
      return JSON.stringify(value)
    }
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export { JobNotSubmitted, ConflictError, fixedPrefix }
