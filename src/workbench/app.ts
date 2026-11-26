/** Workbench orchestration: validate/quote/submit pipeline + DSH native schedule bridge. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { redactBinaryPayload, OperationExecutor, defaultOutputDir } from '../core/service.ts'
import { GenerationLock, NovelAIClient } from '../core/client.ts'
import { quoteOperation } from '../core/billing.ts'
import { normalizeRequest } from '../core/normalize.ts'
import { prepareOperation, zodMessage, type PreparedOperation } from '../core/operations.ts'
import type { Rec } from './store.ts'
import { Store, ConflictError } from './store.ts'
import { Settings } from './settings.ts'
import { Assets } from './assets.ts'
import { Worker, JobNotSubmitted } from './worker.ts'
import { prepareImage, PrepareImageRequestSchema } from '../core/preparation.ts'
import { defaultDraft } from './library.ts'
import { specCatalog } from '../core/specs.ts'
import { InspirationEngine } from './inspiration.ts'
import {
  buildNaiSchedulePrompt,
  formatDshTask,
  isNaiScheduleTask,
  legacyPlanToDshPayload,
  normalizeDshTiming,
  resolveDshTarget,
  type DshScheduleService,
  type ScheduleActor,
} from './dshSchedule.ts'

export const OPERATIONS = ['generate', 'img2img', 'inpaint', 'outpaint', 'upscale', 'augment', 'enhance', 'encode_vibe', 'reference_generate'] as const
export const MODELS = ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated']
/** Out-of-band handoff so validate() -> quote() never preprocesses reference images twice while keeping validation pure JSON. */
export const PREPARED_OPS = new WeakMap<Rec, PreparedOperation>()

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

export class Workbench {
  store: Store
  settings: Settings
  assets: Assets
  executor: OperationExecutor
  worker: Worker
  inspiration: InspirationEngine
  maintenance = false
  /** Invalidates writes prepared against data replaced by a restore. */
  restoreEpoch = 0

  assertRestoreEpoch(epoch: number): void {
    if (this.maintenance || epoch !== this.restoreEpoch) throw new ConflictError('工作台已被更新（备份恢复），请刷新后重试')
  }
  /** Data directory root (assets/, backups/, outputs/ live here). */
  readonly root: string
  /** Whether start() is currently in effect. */
  workerStarted = false

  /** Optional token injected from plugin config / DSH credentials. */
  pluginToken = ''

  private dshSchedule: DshScheduleService | null = null

  constructor(root?: string) {
    const dir = root ?? workbenchDirectory()
    this.root = dir
    this.store = new Store(dir)
    this.settings = new Settings(this.store, dir, () => this.pluginToken ?? '')
    this.assets = new Assets(this.store, dir, () => {
      const epoch = this.restoreEpoch
      return () => this.assertRestoreEpoch(epoch)
    })
    this.executor = new OperationExecutor(
      {
        target: (endpointId?: string) => this.settings.target(endpointId),
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
    this.inspiration = new InspirationEngine(dir, () => (this.settings.raw()['proxy_url'] as string) || null)
    this.worker = new Worker(this.store, (job) => this.runJob(job))
    this.pluginToken = ''
  }

  /** Wire the DSH host native schedule service (`ctx.schedule`). */
  setDshSchedule(service: DshScheduleService | null): void {
    this.dshSchedule = service
  }

  get dshScheduleAvailable(): boolean {
    return this.dshSchedule !== null
  }

  private requireDshSchedule(): DshScheduleService {
    if (!this.dshSchedule) throw new Error('当前 DSH 宿主未启用原生定时任务服务（ctx.schedule 不可用）')
    return this.dshSchedule
  }

  async listDshSchedules(opts: { all?: boolean; active?: boolean } = {}): Promise<{ available: boolean; tasks: Rec[]; legacy: Rec[] }> {
    const legacy = this.store.listSchedules().map(publicSchedule)
    if (!this.dshSchedule) return { available: false, tasks: [], legacy }
    const allTasks = this.dshSchedule.catalog
      ? await this.dshSchedule.catalog()
      : (await this.dshSchedule.list({ limit: 500, offset: 0 })).items
    const filtered = allTasks.filter((task) => {
      if (!opts.all && !isNaiScheduleTask(task)) return false
      if (opts.active !== undefined) return (task['status'] === 'active') === opts.active
      return true
    })
    return { available: true, tasks: filtered.map(formatDshTask), legacy }
  }

  async viewDshSchedule(id: string): Promise<Rec> {
    const svc = this.requireDshSchedule()
    const task = await svc.view({ id })
    if (task['code'] === 'schedule_not_found') throw new Error(`定时任务不存在：${id}`)
    const history = await svc.history({ id, limit: 20 }).catch(() => null)
    return { task: formatDshTask(task), history }
  }

  async historyDshSchedule(id: string, limit = 20): Promise<Rec> {
    const svc = this.requireDshSchedule()
    const result = await svc.history({ id, limit: Math.max(1, Math.min(100, limit)) })
    if (result['code'] === 'schedule_not_found') throw new Error(`定时任务不存在：${id}`)
    return result
  }

  async createDshSchedule(spec: Rec, actor?: ScheduleActor, signal?: AbortSignal): Promise<Rec> {
    const svc = this.requireDshSchedule()
    const title = String(spec['title'] ?? spec['name'] ?? '').trim()
    if (!title || title.length > 120) throw new Error('定时任务名称需要 1–120 字')
    const timing = normalizeDshTiming(spec)
    const prompt = buildNaiSchedulePrompt(spec, this.store.listEntries())
    const target = resolveDshTarget(spec['target'] ?? 'new_once', actor)
    const created = await svc.create({ title, prompt, timing, target }, actor?.sessionId, signal)
    const wantPaused = spec['active'] === false || spec['enabled'] === false
    if (wantPaused && created['id']) {
      const paused = await svc.edit({
        id: String(created['id']),
        action: 'update',
        expectedUpdatedAt: typeof created['updatedAt'] === 'string' ? created['updatedAt'] : undefined,
        patch: { active: false },
      }, actor?.sessionId, signal)
      return formatDshTask(paused['code'] ? created : paused)
    }
    return formatDshTask(created)
  }

  async editDshSchedule(id: string, input: Rec, actor?: ScheduleActor, signal?: AbortSignal): Promise<Rec> {
    const svc = this.requireDshSchedule()
    const patch: NonNullable<Parameters<DshScheduleService['edit']>[0]['patch']> = {}
    if (input['title'] !== undefined || input['name'] !== undefined) {
      const title = String(input['title'] ?? input['name'] ?? '').trim()
      if (!title || title.length > 120) throw new Error('定时任务名称需要 1–120 字')
      patch.title = title
    }
    const hasPromptFields = ['dsh_prompt', 'prompt', 'instruction', 'randomize', 'fixed_prompt', 'fixed_negative_prompt', 'request', 'ai_recipe', 'library_refs', 'output_subdir', 'endpoint', 'count', 'model', 'execution_mode', 'mode'].some((k) => input[k] !== undefined)
    if (hasPromptFields) {
      patch.prompt = buildNaiSchedulePrompt(input, this.store.listEntries())
    }
    const hasTimingFields = ['timing', 'rrule', 'kind', 'time', 'at', 'interval_minutes', 'every_seconds', 'after_seconds', 'weekdays', 'expression', 'cron'].some((k) => input[k] !== undefined)
    if (hasTimingFields) {
      patch.timing = normalizeDshTiming(input)
    }
    if (input['target'] !== undefined) {
      patch.target = resolveDshTarget(input['target'], actor)
    }
    if (input['active'] !== undefined || input['enabled'] !== undefined) {
      patch.active = Boolean(input['active'] ?? input['enabled'])
    }
    if (!Object.keys(patch).length) throw new Error('请至少提供一个要修改的字段')
    const result = await svc.edit({
      id,
      action: 'update',
      expectedUpdatedAt: typeof input['expected_updated_at'] === 'string' ? input['expected_updated_at']
        : typeof input['expectedUpdatedAt'] === 'string' ? input['expectedUpdatedAt'] : undefined,
      patch,
    }, actor?.sessionId, signal)
    if (result['code'] === 'schedule_not_found') throw new Error(`定时任务不存在：${id}`)
    if (result['code'] === 'schedule_conflict') throw new ConflictError('定时任务已被更新，请刷新后重试')
    return formatDshTask(result)
  }

  async deleteDshSchedule(id: string, expectedUpdatedAt?: string, actor?: ScheduleActor, signal?: AbortSignal): Promise<Rec> {
    const svc = this.requireDshSchedule()
    const result = await svc.edit({ id, action: 'delete', expectedUpdatedAt }, actor?.sessionId, signal)
    if (result['code'] === 'schedule_not_found') throw new Error(`定时任务不存在：${id}`)
    if (result['code'] === 'schedule_conflict') throw new ConflictError('定时任务已被更新，请刷新后重试')
    return { deleted: true, id }
  }

  async runDshSchedule(id: string, signal?: AbortSignal): Promise<Rec> {
    const svc = this.requireDshSchedule()
    const result = await svc.run({ id }, signal)
    if (result['code'] === 'schedule_not_found') throw new Error(`定时任务不存在：${id}`)
    if (result['code'] === 'schedule_execution_pending') return { id, pending: true, message: '该任务已有一次执行正在排队或运行中' }
    return formatDshTask(result)
  }

  async migrateLegacySchedule(legacyId: string, opts: { deleteLegacy?: boolean; actor?: ScheduleActor } = {}, signal?: AbortSignal): Promise<Rec> {
    const legacy = this.store.getSchedule(legacyId)
    const payload = legacyPlanToDshPayload(legacy, this.store.listEntries())
    const created = await this.createDshSchedule({
      title: payload.title,
      dsh_prompt: payload.prompt,
      timing: payload.timing,
      active: payload.active,
      target: 'new_once',
    }, opts.actor, signal)
    if (opts.deleteLegacy !== false) {
      this.store.deleteSchedule(legacyId)
    }
    return { migrated: true, legacy_id: legacyId, task: created }
  }

  start(): void {
    this.store.clearStaleInternalErrorPause()
    this.worker.start()
    this.workerStarted = true
  }

  stop(): void {
    this.worker.stop()
    void this.inspiration.close()
    this.workerStarted = false
  }

  client(context?: Rec): NovelAIClient {
    if (!context) {
      const current = this.settings.raw()
      let target: { baseUrl: string; token: string } | null = null
      try { target = this.settings.target() } catch { target = null }
      return new NovelAIClient({
        token: target?.token ?? this.settings.naiToken(),
        baseUrl: target?.baseUrl ?? String(current['nai_base_url']),
        proxy: (current['proxy_url'] as string) || null,
        retryDelaySeconds: Number(current['retry_delay_seconds']),
        retryMaxAttempts: Number(current['retry_max_attempts']),
      })
    }
    if (context['nai_secret']) {
      return new NovelAIClient({
        token: this.settings.secret(context['nai_secret'] as string),
        baseUrl: String(context['nai_base_url']),
        proxy: (context['proxy_url'] as string) || null,
        retryDelaySeconds: Number(context['retry_delay_seconds'] ?? 3),
        retryMaxAttempts: Number(context['retry_max_attempts'] ?? 3),
      })
    }
    const frozen = this.settings.target(context['endpoint_id'] ? String(context['endpoint_id']) : undefined)
    return new NovelAIClient({
      token: frozen.token,
      baseUrl: frozen.baseUrl,
      proxy: (context['proxy_url'] as string) || null,
      retryDelaySeconds: Number(context['retry_delay_seconds'] ?? 3),
      retryMaxAttempts: Number(context['retry_max_attempts'] ?? 3),
    })
  }

  async credits(endpointId?: string): Promise<Rec> {
    return await this.executor.credits(undefined, endpointId) as unknown as Rec
  }

  /** Every enabled endpoint in one call; the header reads this to stay endpoint-aware. */
  async creditsOverview(): Promise<Rec> {
    const list = this.settings.endpoints().filter((item) => item['enabled'] !== false)
    const rows = await Promise.all(list.map(async (item) => {
      const id = String(item['id'])
      const meta = {
        id, name: item['name'], base_url: item['base_url'], official: item['official'] === true,
        free_mode: item['free_mode'], v5_share: item['v5_share'], active: item['active'] === true,
        subscription_note: item['subscription_note'], subscription_expires: item['subscription_expires'],
        quota_kind: item['quota_kind'],
      }
      try {
        return { ...meta, ok: true, credits: await this.credits(id), allowance: await this.endpointAllowance(id) }
      } catch (error) {
        return { ...meta, ok: false, error: (error as Error).message }
      }
    }))
    const active = (rows.find((row) => row['active'] === true) ?? rows[0]) as Rec | undefined
    const primary = (active?.['ok'] === true ? active['credits'] : {}) as Rec
    return { ...primary, active_endpoint: active?.['id'] ?? '', endpoints: rows }
  }

  /**
   * Read the allowance a gateway hides from its NAI-shaped API. The site session
   * expires independently, so this is best-effort and never blocks generation.
   */
  async endpointAllowance(endpointId?: string): Promise<Rec | null> {
    const target = this.settings.quotaTarget(endpointId)
    if (!target) return null
    try {
      const response = await fetch(target.url, {
        headers: { Authorization: `Bearer ${target.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000), redirect: 'manual',
      })
      if (!response.ok) return { ok: false, status: response.status, note: response.status === 401 ? '站点登录令牌已失效' : '额度接口返回错误' }
      const envelope = await response.json() as Rec
      if (envelope['code'] != null && Number(envelope['code']) !== 200)
        return { ok: false, status: response.status, note: String(envelope['message'] ?? '额度接口返回错误') }
      const data = (envelope['data'] ?? envelope) as Rec
      const allocation = (data['allocation'] ?? data) as Rec
      const available = Number(allocation['available_images'] ?? NaN)
      const capacity = Number(allocation['capacity_images'] ?? NaN)
      const share = Number(allocation['share_count'] ?? (data['entitlement'] as Rec | undefined)?.['share_count'] ?? NaN)
      if (!Number.isFinite(available) && !Number.isFinite(capacity))
        return { ok: false, status: response.status, note: '额度接口返回的字段无法识别' }
      return {
        ok: true,
        available_images: Number.isFinite(available) ? available : null,
        capacity_images: Number.isFinite(capacity) ? capacity : null,
        percent: Number.isFinite(available) && Number.isFinite(capacity) && capacity > 0
          ? Math.round((Math.min(1, Math.max(0, available / capacity)) * 10000)) / 100 : null,
        share_count: Number.isFinite(share) ? share : null,
        reset_description: typeof data['reset_description'] === 'string' ? data['reset_description'] : null,
      }
    } catch (error) {
      return { ok: false, note: (error as Error).name === 'TimeoutError' ? '额度接口超时' : '额度接口不可用' }
    }
  }

  /** Validate and attach the prepared operation via a non-enumerable symbol so quote() reuses it without resizing twice. */
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
    const validation: Rec = {
      valid: true, resolved_request: resolved, warnings: prepared.warnings,
      api_payload: redactBinaryPayload(prepared.payload), preparation: prepared.summary,
      expected_outputs: prepared.expected_outputs, expected_dimensions: prepared.expected_dimensions,
    }
    PREPARED_OPS.set(validation, prepared)
    return validation
  }

  async quote(operation: string, request: Rec, endpointId?: string, signal?: AbortSignal): Promise<Rec> {
    const validation = await this.validate(operation, request)
    if (operation === 'prepare_image') return { ...validation, estimated_anlas: 0 }
    const prepared = PREPARED_OPS.get(validation)
      ?? await prepareOperation(validation['resolved_request'] as Rec, operation)
    signal?.throwIfAborted()
    const credits = await this.executor.credits(signal, endpointId)
    let target: ReturnType<Settings['target']> | null = null
    try { target = this.settings.target(endpointId) } catch { target = null }
    const meta = target
      ? { id: target.id, name: target.name, free_mode: target.freeMode, v5_share: target.v5Share }
      : { id: '', name: '', free_mode: 'official' as const, v5_share: 1 }
    const siteToken = this.settings.quotaTarget(endpointId) !== null
    return {
      ...validation,
      ...quoteOperation(prepared, credits, {
        freeMode: meta.free_mode,
        v5Share: meta.v5_share,
        endpoint: meta,
        siteToken,
      }),
    }
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
    let prepared: PreparedOperation
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
    const beforeSubmit = (): void => {
      const latest = this.store.getJob(jobId)
      if (this.worker.isStopped || this.store.getPaused() || latest['cancel_requested'] === true) throw new JobNotSubmitted('提交前已停止、暂停或取消，本次未生成图片')
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

  resetDraft(revision: number, draftId?: string | null): Rec {
    return this.store.saveDraft({ ...defaultDraft(), ...(draftId ? { id: draftId } : {}) }, revision)
  }

  jobs(): Rec[] {
    return this.store.listJobs().map((j) => publicJob(j))
  }

  /** Register a direct tool generation (queue-bypassing) so it appears in the gallery. */
  async registerDirectGeneration(result: Rec, request: unknown): Promise<Rec | null> {
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
      return this.store.recordDirectJob(snapshot, { ...result, assets }, typeof actual === 'number' && Number.isFinite(actual) ? actual : null)
    } catch (error) {
      ;((result['warnings'] ??= []) as string[]).push(`图片或回执已保存，但画廊记录保存失败：${(error as Error).message}`)
      return null
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
      dsh_schedule_available: this.dshScheduleAvailable,
    }
    if (compact) {
      return {
        ...common, jobs: this.store.listJobs(12).map(publicJob),
        summary: {
          active_jobs: this.store.data.jobs.filter((job) => ['queued', 'running'].includes(job.status)).length,
          library_count: this.store.data.entries.length,
          legacy_schedule_count: this.store.data.schedules.length,
        },
      }
    }
    return { ...common, library: this.store.listEntries(), jobs: this.jobs(), legacy_schedules: this.store.listSchedules().map(publicSchedule) }
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

export { JobNotSubmitted, ConflictError }
