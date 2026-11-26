/** Bridge between NovelAI Atelier and DSH's native host `ctx.schedule` service. */
import { asUtc, localInstant, validTimezone } from './util.ts'
import { OutputSubdirSchema } from '../core/outputDirectory.ts'
import type { Rec } from './store.ts'

export const NAI_SCHEDULE_MARKER = '[NAI-Atelier 定时生图]'

export type DshScheduleTiming =
  | { kind: 'at'; at: string }
  | { kind: 'after'; after_seconds: number }
  | { kind: 'every'; every_seconds: number }
  | { kind: 'daily'; daily: { time: string; time_zone: string } }
  | { kind: 'weekly'; weekly: { time: string; time_zone: string; weekdays: number[] } }
  | { kind: 'cron'; cron: { expression: string; time_zone: string } }
  | { kind: 'rrule'; rrule: string }

export type DshScheduleTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new_once'; create?: { cwd?: string; agentPreset?: string } }
  | { kind: 'new'; create?: { cwd?: string; agentPreset?: string } }

export interface DshScheduleService {
  deliveryLimits?(): { newSessionIntervalSeconds: number; retention?: { days: number; records: number } }
  create(
    request: { title: string; prompt: string; timing: DshScheduleTiming; target?: DshScheduleTarget },
    actorSessionId?: string,
    signal?: AbortSignal,
  ): Promise<Rec>
  list(request?: { active?: boolean; limit?: number; offset?: number }): Promise<{ items: Rec[]; shown: number; total: number; limit: number; offset: number }>
  catalog?(): Promise<Rec[]>
  view(request: { id: string }): Promise<Rec>
  history(request: { id: string; limit: number; beforeMessageId?: string }): Promise<Rec>
  run(request: { id: string }, signal?: AbortSignal): Promise<Rec>
  edit(
    request: {
      id: string
      action: 'update' | 'delete'
      expectedUpdatedAt?: string
      patch?: {
        title?: string
        prompt?: string
        timing?: DshScheduleTiming
        target?: DshScheduleTarget
        active?: boolean
      }
    },
    actorSessionId?: string,
    signal?: AbortSignal,
  ): Promise<Rec>
}

export interface ScheduleActor {
  sessionId?: string
  cwd?: string
  agentPreset?: string
}

/** Whether a DSH scheduled task belongs to / invokes NovelAI Atelier. */
export function isNaiScheduleTask(task: Rec): boolean {
  const prompt = String(task['prompt'] ?? '')
  return prompt.includes(NAI_SCHEDULE_MARKER)
    || /\bnai_(?:generate_image|edit_image|use_tools)\b/u.test(prompt)
}

/** Convert user- or tool-friendly timing arguments into DSH's strict typed timing selector. */
export function normalizeDshTiming(input: Rec): DshScheduleTiming {
  if (input['timing'] instanceof Object && !Array.isArray(input['timing'])) {
    return input['timing'] as DshScheduleTiming
  }
  const rrule = typeof input['rrule'] === 'string' ? input['rrule'].trim() : ''
  if (rrule) return { kind: 'rrule', rrule }

  const kind = String(input['kind'] ?? 'daily').trim().toLowerCase()
  const tz = String(input['timezone'] ?? input['time_zone'] ?? 'Asia/Shanghai').trim() || 'Asia/Shanghai'

  if (kind === 'daily') {
    if (!validTimezone(tz)) throw new Error('未知 IANA 时区：' + tz)
    const rawTime = String(input['time'] ?? '').trim()
    if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/u.test(rawTime)) throw new Error('每日计划需要 HH:MM 或 HH:MM:SS 时间（如 09:00）')
    const time = rawTime.length === 5 ? `${rawTime}:00` : rawTime
    return { kind: 'daily', daily: { time, time_zone: tz } }
  }
  if (kind === 'weekly') {
    if (!validTimezone(tz)) throw new Error('未知 IANA 时区：' + tz)
    const rawTime = String(input['time'] ?? '').trim()
    if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/u.test(rawTime)) throw new Error('每周计划需要 HH:MM 或 HH:MM:SS 时间（如 09:00）')
    const time = rawTime.length === 5 ? `${rawTime}:00` : rawTime
    const rawDays = input['weekdays']
    if (!Array.isArray(rawDays) || !rawDays.length) throw new Error('每周计划需要至少选择一个星期（weekdays）')
    const weekdays = [...new Set(rawDays.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 7))]
    if (!weekdays.length) throw new Error('weekdays 需要 0-6 或 1-7 的整数列表')
    return { kind: 'weekly', weekly: { time, time_zone: tz, weekdays } }
  }
  if (kind === 'interval' || kind === 'every') {
    const seconds = input['every_seconds'] != null
      ? Number(input['every_seconds'])
      : Math.round(Number(input['interval_minutes'] ?? 0) * 60)
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 31536000) {
      throw new Error('间隔计划需要不少于 1 分钟（60 秒）的整数间隔')
    }
    return { kind: 'every', every_seconds: seconds }
  }
  if (kind === 'after') {
    const seconds = Number(input['after_seconds'] ?? 0)
    if (!Number.isInteger(seconds) || seconds < 1) throw new Error('延时计划需要正整数 after_seconds')
    return { kind: 'after', after_seconds: seconds }
  }
  if (kind === 'cron') {
    if (!validTimezone(tz)) throw new Error('未知 IANA 时区：' + tz)
    const expression = String(input['expression'] ?? input['cron'] ?? '').trim()
    if (!expression) throw new Error('cron 计划需要 expression')
    return { kind: 'cron', cron: { expression, time_zone: tz } }
  }
  if (kind === 'once' || kind === 'at') {
    const at = String(input['at'] ?? '').trim()
    if (!at) throw new Error('单次计划需要有效的 at 时间')
    let targetDate: Date
    if (/(Z|[+-]\d{2}:?\d{2})$/u.test(at)) {
      targetDate = asUtc(at)
    } else {
      if (!validTimezone(tz)) throw new Error('未知 IANA 时区：' + tz)
      const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(at)
      if (!match) throw new Error('单次计划时间格式需要 YYYY-MM-DD HH:MM 或带时区的 ISO 8601')
      targetDate = localInstant(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), tz, Number(match[6] ?? 0))
    }
    return { kind: 'at', at: targetDate.toISOString() }
  }
  throw new Error(`不支持的定时类型：${kind}`)
}

/** Resolve target string/object into a DSH ScheduleService target. */
export function resolveDshTarget(target: unknown, actor?: ScheduleActor): DshScheduleTarget {
  const create: { cwd?: string; agentPreset?: string } = {}
  if (actor?.cwd) create.cwd = actor.cwd
  if (actor?.agentPreset) create.agentPreset = actor.agentPreset

  if (target instanceof Object && !Array.isArray(target)) {
    const obj = target as Rec
    if (obj['kind'] === 'session' && typeof obj['sessionId'] === 'string' && obj['sessionId']) {
      return { kind: 'session', sessionId: obj['sessionId'] }
    }
    if (obj['kind'] === 'new' || obj['kind'] === 'new_once') {
      const customCreate = obj['create'] instanceof Object ? obj['create'] as { cwd?: string; agentPreset?: string } : undefined
      return { kind: obj['kind'], create: customCreate ?? create }
    }
  }
  const choice = typeof target === 'string' ? target.trim() : 'new_once'
  if (choice === 'this_session') {
    if (!actor?.sessionId) throw new Error('当前无活动会话上下文，请选择 new_once 或 new 目标模式')
    return { kind: 'session', sessionId: actor.sessionId }
  }
  if (choice === 'new') return { kind: 'new', create }
  return { kind: 'new_once', create }
}

function cleanSubdir(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  return OutputSubdirSchema.parse(text)
}

/** Build a clean, self-contained DSH scheduled-task prompt for NovelAI Atelier. */
export function buildNaiSchedulePrompt(spec: Rec, libraryEntries: Rec[] = []): string {
  // Raw custom DSH instruction mode: keep user prompt intact and ensure marker so Workbench can track it.
  const rawCustom = typeof spec['dsh_prompt'] === 'string' ? spec['dsh_prompt'].trim()
    : typeof spec['prompt'] === 'string' && !spec['request'] && !spec['instruction'] && !spec['ai_recipe']
      ? spec['prompt'].trim()
      : ''
  if (rawCustom) {
    return rawCustom.includes(NAI_SCHEDULE_MARKER) || /\bnai_(?:generate_image|edit_image|use_tools)\b/u.test(rawCustom)
      ? rawCustom
      : `${NAI_SCHEDULE_MARKER}\n${rawCustom}`
  }

  const mode = String(spec['execution_mode'] ?? spec['mode'] ?? 'ai') === 'fixed' ? 'fixed' : 'ai'
  const operation = String(spec['operation'] ?? 'generate')
  const req = (spec['request'] instanceof Object && !Array.isArray(spec['request']) ? spec['request'] : {}) as Rec
  const recipe = (spec['ai_recipe'] instanceof Object && !Array.isArray(spec['ai_recipe']) ? spec['ai_recipe'] : {}) as Rec

  const instruction = String(spec['instruction'] ?? recipe['instruction'] ?? '').trim()
  const randomize = String(spec['randomize'] ?? recipe['randomize'] ?? '').trim()
  const fixedPrompt = String(spec['fixed_prompt'] ?? recipe['fixed_prompt'] ?? (mode === 'fixed' ? (req['prompt'] ?? '') : '')).trim()
  const fixedNeg = String(spec['fixed_negative_prompt'] ?? recipe['fixed_negative_prompt'] ?? req['negative_prompt'] ?? '').trim()
  const refIds = [...new Set([
    ...((Array.isArray(spec['library_refs']) ? spec['library_refs'] : []) as unknown[]).map(String),
    ...((Array.isArray(recipe['library_refs']) ? recipe['library_refs'] : []) as unknown[]).map(String),
  ].filter(Boolean))]

  const count = Math.max(1, Math.min(20, Math.round(Number(spec['count'] ?? 1) || 1)))
  const outputSubdir = cleanSubdir(spec['output_subdir'] ?? req['output_subdir'])
  const endpoint = typeof spec['endpoint'] === 'string' && spec['endpoint'].trim() ? spec['endpoint'].trim() : ''

  const model = String(spec['model'] ?? req['model'] ?? 'nai-diffusion-5-full')
  const v5Tier = String(spec['v5_tier'] ?? req['v5_tier'] ?? '')
  const width = spec['width'] ?? req['width']
  const height = spec['height'] ?? req['height']
  const steps = spec['steps'] ?? req['steps']
  const scale = spec['scale'] ?? req['scale']
  const sampler = spec['sampler'] ?? req['sampler']
  const qualityPreset = spec['quality_preset'] ?? req['quality_preset']
  const negativePreset = spec['negative_preset'] ?? req['negative_preset']
  const seedMode = String(spec['seed_mode'] ?? (mode === 'fixed' ? 'random' : 'random'))
  const seed = spec['seed'] ?? req['seed']
  const preciseRefs = Array.isArray(spec['precise_references'])
    ? spec['precise_references']
    : Array.isArray(req['precise_references'])
      ? req['precise_references']
      : []

  if (mode === 'ai' && !instruction && !randomize && !fixedPrompt && !refIds.length) {
    throw new Error('请填写创作要求、固定提示词或选择资料库条目')
  }
  if (mode === 'fixed' && !fixedPrompt && !String(req['prompt'] ?? '').trim() && operation !== 'upscale' && operation !== 'augment') {
    throw new Error('固定参数模式需要提供生图提示词')
  }

  const lines: string[] = [
    NAI_SCHEDULE_MARKER,
    '这是用户已明确授权的定时生图任务。请按以下约束直接完成本次生成，完成后简要汇报生成结果路径、seed 与关键画面观察：',
    '1. 若当前会话尚未加载完整 NAI 工具，先调用 `nai_use_tools({enabled:true})`。',
  ]

  let step = 2
  if (refIds.length) {
    const entryById = new Map(libraryEntries.map((e) => [String(e['id']), e]))
    const labels = refIds.map((id) => {
      const entry = entryById.get(id)
      return entry ? `${String(entry['name'])} (${id})` : id
    })
    lines.push(`${step++}. 调用 \`nai_library_read({ids:${JSON.stringify(refIds)}})\` 读取最新资料设定并融入提示词：${labels.join('、')}。`)
  }

  if (mode === 'ai') {
    lines.push(`${step++}. 按创作要求重新构思本次提示词（首次生成前先读 \`nai_get_prompt_guide\` 的 \`prompting\` 与对应模型指南）：`)
    if (instruction) lines.push(`   - 创作要求：${instruction}`)
    if (randomize) lines.push(`   - 每次变化方向：${randomize}`)
    if (fixedPrompt) lines.push(`   - 必须包含的固定正面词：${fixedPrompt}`)
    if (fixedNeg) lines.push(`   - 固定负面词：${fixedNeg}`)
  } else {
    lines.push(`${step++}. 使用固定提示词直接生成，不要随意改写核心内容：`)
    if (fixedPrompt) lines.push(`   - 正面提示词：${fixedPrompt}`)
    if (fixedNeg) lines.push(`   - 负面提示词：${fixedNeg}`)
  }

  const paramBits: string[] = [`operation=${operation}`, `model=${model}`]
  if (v5Tier && v5Tier !== 'high') paramBits.push(`v5_tier=${v5Tier}`)
  if (width && height) paramBits.push(`size=${width}x${height}`)
  if (steps != null) paramBits.push(`steps=${steps}`)
  if (scale != null) paramBits.push(`scale=${scale}`)
  if (sampler) paramBits.push(`sampler=${sampler}`)
  if (qualityPreset) paramBits.push(`quality_preset=${qualityPreset}`)
  if (negativePreset) paramBits.push(`negative_preset=${negativePreset}`)
  if (seedMode === 'fixed' && seed != null) paramBits.push(`seed=${seed}`)
  if (outputSubdir) paramBits.push(`output_subdir=${JSON.stringify(outputSubdir)}`)
  if (endpoint) paramBits.push(`endpoint=${JSON.stringify(endpoint)}`)

  const toolName = operation === 'generate' || operation === 'reference_generate' ? 'nai_generate_image' : 'nai_edit_image'
  lines.push(`${step++}. 逐次调用 \`${toolName}\` 生成恰好 ${count} 张图片，不得超额生成。固定参数：${paramBits.join('，')}。`)

  if (preciseRefs.length) {
    lines.push(`   - 精确参考图（precise_references）：${JSON.stringify(preciseRefs)}`)
  }
  if (outputSubdir) {
    lines.push(`   - 输出目录约束：必须传 \`output_subdir: ${JSON.stringify(outputSubdir)}\`，不可省略或改名。`)
  }
  if (endpoint) {
    lines.push(`   - 接口约束：必须传顶层 \`endpoint: ${JSON.stringify(endpoint)}\`，不要切换到其他接口。`)
  }

  return lines.join('\n')
}

/** Convert a legacy workbench.json schedule record into a DSH schedule creation payload. */
export function legacyPlanToDshPayload(legacy: Rec, libraryEntries: Rec[] = []): {
  title: string
  prompt: string
  timing: DshScheduleTiming
  active: boolean
} {
  const title = String(legacy['name'] ?? '定时生图').trim().slice(0, 120) || '定时生图'
  const kind = String(legacy['kind'] ?? 'daily')
  const tz = String(legacy['timezone'] ?? 'Asia/Shanghai')
  let timing: DshScheduleTiming
  if (kind === 'daily') {
    timing = normalizeDshTiming({ kind: 'daily', time: legacy['time'] ?? '09:00', timezone: tz })
  } else if (kind === 'interval') {
    timing = normalizeDshTiming({ kind: 'interval', interval_minutes: legacy['interval_minutes'] ?? 60 })
  } else {
    const rawAt = String(legacy['at'] ?? '')
    const parsed = rawAt ? Date.parse(rawAt) : NaN
    const at = Number.isFinite(parsed) && parsed > Date.now() + 60_000
      ? new Date(parsed).toISOString()
      : new Date(Date.now() + 3600_000).toISOString()
    timing = { kind: 'at', at }
  }
  const prompt = buildNaiSchedulePrompt(legacy, libraryEntries)
  return { title, prompt, timing, active: legacy['enabled'] === true }
}

/** Compact user-facing representation of a DSH scheduled task. */
export function formatDshTask(task: Rec): Rec {
  return {
    id: task['id'],
    title: task['title'],
    prompt: task['prompt'],
    kind: task['kind'],
    status: task['status'],
    scheduledAt: task['scheduledAt'],
    scheduledAtLocal: task['scheduledAtLocal'] ?? task['scheduledAt'],
    ...(task['rrule'] !== undefined ? { rrule: task['rrule'] } : {}),
    ...(task['time'] !== undefined ? { time: task['time'] } : {}),
    ...(task['timeZone'] !== undefined ? { timeZone: task['timeZone'] } : {}),
    ...(task['weekdays'] !== undefined ? { weekdays: task['weekdays'] } : {}),
    ...(task['everySeconds'] !== undefined ? { everySeconds: task['everySeconds'] } : {}),
    ...(task['expression'] !== undefined ? { expression: task['expression'] } : {}),
    target: task['target'],
    updatedAt: task['updatedAt'],
    lastDelivery: task['lastDelivery'] ?? null,
    executionActive: task['executionActive'] === true,
    is_nai_task: isNaiScheduleTask(task),
  }
}
