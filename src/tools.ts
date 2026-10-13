/** Model-facing tool definitions replacing the 0.7.0 MCP stdio server. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { Workbench, VERSION, MODELS, guide as readGuide, publicSchedule } from './workbench/app.ts'
import { NovelAIError } from './core/client.ts'
import { zodMessage } from './core/operations.ts'
import { GenerationRequestSchema } from './core/models.ts'
import { specCatalog } from './core/specs.ts'
import type { Rec } from './workbench/store.ts'
import { normalizeRequest, mergeRequest } from './core/normalize.ts'
import { entryPrompt } from './workbench/library.ts'
import { toolOutputValue } from './tool-output.ts'

const GENERATE_PARAMETERS = {
  prompt: { type: 'string', description: '生图正面提示词（支持 NovelAI tag / 权重 / 自然语言）' },
  model: {
    type: 'string',
    enum: ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'v5', 'v5-curated', 'v4.5', 'v4.5-curated'],
    default: 'nai-diffusion-5-full',
    description: '模型 ID（默认 nai-diffusion-5-full；亦支持 v5 / v4.5 等别名）',
  },
  width: { type: 'number', default: 832, description: '宽（64 的倍数，如 832、1024、512；非 64 倍数会自动就近对齐）' },
  height: { type: 'number', default: 1216, description: '高（64 的倍数，如 1216、1024、768；非 64 倍数会自动就近对齐）' },
  negative_prompt: { type: 'string', default: '', description: '负面提示词（排除元素）' },
  sampler: {
    type: 'string',
    enum: ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m', 'k_dpmpp_sde', 'Euler Ancestral', 'Euler', 'DPM++ 2M', 'DPM++ 2S Ancestral', 'DPM++ SDE'],
    default: 'k_euler_ancestral',
    description: '采样器（支持 k_euler_ancestral 或友好名称如 Euler / Euler Ancestral）',
  },
  steps: { type: 'number', description: '采样步数 1-50（默认 23；Opus 免费规格上限通常为 28）' },
  scale: { type: 'number', description: 'CFG 相关度（推荐 V5: 7.0, V4.5: 5.0）' },
  cfg_rescale: { type: 'number', default: 0, description: 'CFG rescale (0-1)' },
  noise_schedule: { type: 'string', enum: ['karras', 'exponential', 'polyexponential'], default: 'karras', description: 'V5 supports karras only; V4.5 supports all three schedules' },
  seed: { type: 'number', description: '随机种子 (0-4294967295)；固定种子用于复现或对比' },
  quality_preset: { type: 'string', enum: ['standard', 'light', 'none'], default: 'standard', description: '质量预设（standard=标准，light=轻度仅V5，none=不追加）' },
  negative_preset: { type: 'string', enum: ['heavy', 'light', 'humanFocus', 'furryFocus', 'none'], default: 'heavy', description: '负面预设（heavy=强烈防崩，light=轻度，none=不追加）' },
  transparent_background: { type: 'boolean', default: false, description: '透明背景抠图（仅 V5 支持）' },
  variety_boost: { type: 'boolean', default: false, description: '多样性增强（仅 V4.5 支持）' },
  text: { type: 'string', description: '画面内独立排版文字块' },
  characters: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: true,
      properties: {
        prompt: { type: 'string', required: true },
        negative_prompt: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
    },
    description: 'V5最多22角色，V4.5最多6；prompt以boy/girl开头，身份/发色/瞳色/服装放角色槽，基础词只写场景构图。x/y为0–1。',
  },
  request: { type: 'object', additionalProperties: true, description: '同名嵌套字段优先。' },
} as const

const { default: _modelDefault, ...MODEL_PARAMETER } = GENERATE_PARAMETERS.model

const COMMON_EDIT_PARAMETERS = {
  prompt: GENERATE_PARAMETERS.prompt,
  model: GENERATE_PARAMETERS.model,
  seed: GENERATE_PARAMETERS.seed,
  request: { type: 'object', additionalProperties: true, description: '完整参数；通用字段同nai_generate_image。完整契约用nai_get_presets({operation})读取；嵌套优先。' },
} as const

const IMG2IMG_PARAMETERS = {
  image_path: { type: 'string', description: '本地原图路径（PNG/JPEG/WebP）' },
  strength: { type: 'number', default: 0.7, description: '重绘强度 0.01-0.99（越大改变越多）' },
  extra_noise_seed: { type: 'number', description: 'Extra noise seed (0-4294967295), fixed for reproducible edits' },
  noise: { type: 'number', default: 0, description: '添加的额外噪声 0-0.99' },
  color_correct: { type: 'boolean', default: false, description: '色彩校正（保持原图色调）' },
  ...COMMON_EDIT_PARAMETERS,
  width: { type: 'number', description: 'Optional output width, multiple of 64; omitted uses source dimensions' },
  height: { type: 'number', description: 'Optional output height, multiple of 64; omitted uses source dimensions' },
} as const

const INPAINT_PARAMETERS = {
  image_path: { type: 'string', description: '本地原图路径' },
  mask_path: { type: 'string', description: '同尺寸遮罩路径（白色重绘，黑色保留）' },
  mask_mode: { type: 'string', enum: ['luminance', 'alpha'], default: 'luminance', description: '遮罩通道类型' },
  strength: { type: 'number', default: 1, description: '重绘强度 0-1（1=完全按提示词重画）' },
  extra_noise_seed: IMG2IMG_PARAMETERS.extra_noise_seed,
  focus_box: { type: 'array', items: { type: 'number' }, description: 'Optional [left, top, right, bottom] source crop; right/bottom excluded' },
  focus_size: { type: 'array', items: { type: 'number' }, description: 'Optional [width, height] for the focus crop, multiples of 64' },
  color_correct: { type: 'boolean', default: true, description: '色彩校正' },
  ...COMMON_EDIT_PARAMETERS,
  width: IMG2IMG_PARAMETERS.width,
  height: IMG2IMG_PARAMETERS.height,
} as const

const UPSCALE_PARAMETERS = {
  image_path: { type: 'string', description: '本地原图路径（每维翻倍，源图最大 3.1MP）' },
  max_anlas: { type: 'number', default: 0, description: '历史兼容字段，不限制远程实际扣费' },
  request: { type: 'object', additionalProperties: true, description: '（兼容项）' },
} as const

const AUGMENT_PARAMETERS = {
  image_path: { type: 'string', description: '本地原图路径' },
  tool: {
    type: 'string',
    enum: ['bg-removal', 'lineart', 'sketch', 'colorize', 'emotion', 'declutter', 'declutter-keep-bubbles'],
    description: '导演工具功能名称',
  },
  emotion: { type: 'string', description: '目标表情（当 tool=emotion 时必填）' },
  prompt: { type: 'string', description: '引导词（仅 colorize / emotion 时有效）' },
  defry: { type: 'number', default: 0, description: '去噪强度 0-5' },
  max_anlas: { type: 'number', default: 0, description: '历史兼容字段，不限制远程实际扣费' },
  request: { type: 'object', additionalProperties: true, description: '（兼容项）' },
} as const

const ENHANCE_PARAMETERS = {
  ...IMG2IMG_PARAMETERS,
  image_path: { type: 'string', description: '本地原图路径' },
  strength: { type: 'number', default: 0.2, description: '增强重绘幅度（默认 0.2）' },
  mode: { type: 'string', enum: ['regular', 'max'], default: 'regular', description: '增强模式（max 仅 V5）' },
  append_enhance_tags: { type: 'boolean', default: true, description: '是否自动追加增强 tag' },
  width: { type: 'number', description: '新宽度（留空保持原图宽度）' },
  height: { type: 'number', description: '新高度（留空保持原图高度）' },
  max_anlas: { type: 'number', default: 0, description: '历史兼容字段，不限制远程实际扣费' },
  request: { type: 'object', additionalProperties: true, description: '（兼容项）' },
} as const

const ENCODE_VIBE_PARAMETERS = {
  image_path: { type: 'string', description: '本地原图路径' },
  model: { type: 'string', enum: ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'v4.5', 'v4.5-curated'], default: 'nai-diffusion-4-5-full', description: 'Vibe 模型（仅 V4.5 支持）' },
  information_extracted: { type: 'number', default: 0.7, description: '信息提取量 (0.01-1)' },
  max_anlas: { type: 'number', default: 0, description: '历史兼容字段，不限制远程实际扣费；编码通常消耗 2 Anlas' },
  request: { type: 'object', additionalProperties: true, description: '（兼容项）' },
} as const

const PREPARE_PARAMETERS = {
  image_path: { type: 'string', description: '本地原图路径' },
  width: { type: 'number', description: '目标宽度（64 的倍数）' },
  height: { type: 'number', description: '目标高度（64 的倍数）' },
  mode: { type: 'string', enum: ['contain', 'cover', 'stretch', 'pad'], default: 'contain', description: '缩放填充模式' },
  background: { type: 'string', default: '#ffffff', description: '填充背景色（如 #ffffff 或 transparent）' },
  crop_box: { type: 'array', items: { type: 'number' }, description: '[left, top, right, bottom] source crop, right/bottom excluded' },
  mask_boxes: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'White repaint rectangles [[left, top, right, bottom], ...] on the final canvas' },
  mask_polygons: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'number' } } }, description: 'White repaint polygons [[[x, y], ...], ...] on the final canvas' },
  request: { type: 'object', additionalProperties: true, description: '（兼容项）' },
} as const

const REFERENCE_GENERATE_PARAMETERS = {
  vibes: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Vibe 参考列表 [{encoding_path, strength, information_extracted?}]' },
  precise_references: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Precise 参考图列表 [{image_path, type, strength, fidelity}]' },
  normalize_vibe_strengths: { type: 'boolean', default: true, description: '是否归一化 Vibe 强度' },
  ...COMMON_EDIT_PARAMETERS,
  model: ENCODE_VIBE_PARAMETERS.model,
} as const

// Cross-operation tools reuse the chosen generation/edit tool's request fields.
// Flat arguments remain accepted by execute() for saved callers, but are not
// repeated in every model-facing schema.
const REQUEST_PARAMETER = { type: 'object', additionalProperties: true, description: '所选操作的参数；完整字段用 nai_get_presets({operation}) 读取。嵌套 request 字段优先。' }
const PAYLOAD_PARAMETER = { type: 'boolean', description: '需要脱敏API载荷时设true；默认只返回解析请求与校验/费用。' }

const OPERATION_REQUEST_PARAMETERS: Record<string, Record<string, unknown>> = {
  generate: GENERATE_PARAMETERS,
  img2img: { ...GENERATE_PARAMETERS, ...IMG2IMG_PARAMETERS },
  inpaint: { ...GENERATE_PARAMETERS, ...INPAINT_PARAMETERS },
  enhance: { ...GENERATE_PARAMETERS, ...ENHANCE_PARAMETERS },
  upscale: UPSCALE_PARAMETERS,
  augment: AUGMENT_PARAMETERS,
  encode_vibe: ENCODE_VIBE_PARAMETERS,
  reference_generate: { ...GENERATE_PARAMETERS, ...REFERENCE_GENERATE_PARAMETERS },
  prepare_image: PREPARE_PARAMETERS,
}

const OPERATION_NAMES = ['generate', 'img2img', 'inpaint', 'upscale', 'augment', 'enhance', 'encode_vibe', 'reference_generate'] as const
const OPERATION_SELECTOR = { type: 'string', enum: OPERATION_NAMES, default: 'generate', description: 'Operation for an informational quote or local validation' }
const READ_ONLY_TOOLS = new Set([
  'nai_check_credits', 'nai_quote', 'nai_validate_request', 'nai_validate_operation', 'nai_get_presets',
  'nai_suggest_tags', 'nai_image_info', 'nai_inspect_image', 'nai_get_operation', 'nai_recover_request',
  'nai_get_prompt_guide', 'nai_server_info', 'nai_workbench_status', 'nai_draft_read', 'nai_draft_list', 'nai_library_read',
])

const OBJECT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: never, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

function formatImageRender(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = (value ?? {}) as Rec
  const paths = ((v['artifact_paths'] ?? v['image_paths'] ?? []) as string[]).filter(Boolean)
  const primary = paths[0]
  const preview = primary && /\.(png|jpe?g|webp|gif)$/iu.test(primary) ? `\n![NovelAI output](<${primary}>)` : ''
  return [{ type: 'text', text: JSON.stringify(v) + preview }]
}

const IMAGE_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: never, value: unknown) => formatImageRender(_args, value),
}

export function errorValue(error: unknown): Rec {
  return { error: (error as Error).message, error_type: (error as Error).name }
}

type Args = { [key: string]: any }

const LIBRARY_KINDS = ['character', 'branch', 'artist', 'blend', 'preset'] as const
const LIST_PARAMETERS = {
  query: { type: 'string', description: '搜索文本；省略列出全部匹配项' },
  offset: { type: 'number', description: '分页起点，非负整数；默认 0' },
  limit: { type: 'number', description: '每页数量，1–100；默认 20' },
} as const

function pageBounds(args: Args): { offset: number; limit: number } {
  const offset = args.offset ?? 0, limit = args.limit ?? 20
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative safe integer')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100')
  return { offset, limit }
}

// Providers may require every schema property and supply blanks for optional strings.
// Only test for blankness: preserve meaningful whitespace in paths and exact IDs.
function optionalText(value: string | null | undefined): string | undefined {
  return value == null || value.trim() === '' ? undefined : value
}

function compactPrompt(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  return text.length > 160 ? text.slice(0, 160) + '…' : text
}

const LEGACY_TOOLS = new Set([
  'nai_img2img', 'nai_inpaint', 'nai_upscale', 'nai_augment_image', 'nai_enhance_image',
  'nai_encode_vibe', 'nai_generate_with_references', 'nai_validate_request',
  'nai_inspect_image', 'nai_get_operation', 'nai_recover_request', 'nai_draft_list', 'nai_draft_read', 'nai_draft_patch',
  'nai_validate_operation', 'nai_server_info',
  'nai_library_delete', 'nai_schedule_delete', 'nai_workbench_submit', 'nai_job_cancel', 'nai_queue_pause',
])

export function registerTools(ctx: Context, wb: Workbench, options: { legacyTools?: boolean } = {}): void {
  const registeredNames: string[] = []
  // Retired definitions are never registered unless a caller explicitly opts in.
  const legacyTools = options.legacyTools === true
  // Registration borrows the definition; the loose shape keeps execute() args dynamic.
  const tool = (definition: Record<string, unknown>) => {
    if (!legacyTools && LEGACY_TOOLS.has(String(definition['name']))) return
    const { presentationMeta, execute, ...options } = definition
    if (typeof presentationMeta === 'function') options['output'] = { ...(options['output'] as Rec), presentationMeta }
    options['isConcurrencySafe'] = (args: Args) => options['name'] === 'nai_draft' ? args.action !== 'update' : READ_ONLY_TOOLS.has(String(options['name']))
    options['execute'] = async (args: Args, exec: { signal: AbortSignal }) => {
      exec.signal.throwIfAborted()
      try { return toolOutputValue(await (execute as (args: Args, exec: { signal: AbortSignal }) => Promise<unknown>)(args, exec)) }
      catch (error) {
        if (error instanceof ToolFailure || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) throw error
        throw new ToolFailure(error)
      }
    }
    ctx.effect(() => ctx.tools.register(defineTool(options as never)))
    registeredNames.push(String(options['name']))
  }

  tool({
    name: 'nai_generate_image',
    description: 'NovelAI V5/V4.5 生图，一次返回一张最终图片、路径、seed 与已知费用；多张逐次调用。默认 V5；vibes/precise_references 自动选择参考生图并默认 V4.5，两种参考不可混用。嵌套 request 同名字段优先，无需先报价。可能消耗 Anlas，遵循用户生成意图。',
    parameters: {
      ...GENERATE_PARAMETERS,
      model: { ...MODEL_PARAMETER, description: '普通生图默认 nai-diffusion-5-full；有参考时默认 nai-diffusion-4-5-full。显式模型保持不变。' },
      vibes: REFERENCE_GENERATE_PARAMETERS.vibes,
      precise_references: REFERENCE_GENERATE_PARAMETERS.precise_references,
      normalize_vibe_strengths: REFERENCE_GENERATE_PARAMETERS.normalize_vibe_strengths,
    },
    output: IMAGE_OUTPUT,
    presentationMeta: (_args: unknown, value: unknown) => imageMeta(value),
    async execute(args: Args, exec: { signal: AbortSignal }) {
      try {
        const raw = normalizeRequest(args)
        const references = ['vibes', 'precise_references'].some((key) => Array.isArray(raw[key]) && (raw[key] as unknown[]).length > 0)
        const operation = references ? 'reference_generate' : 'generate'
        raw['model'] ??= references ? 'nai-diffusion-4-5-full' : 'nai-diffusion-5-full'
        const request = references ? raw : GenerationRequestSchema.parse(raw)
        const prepared = await import('./core/operations.ts').then((m) => m.prepareOperation(request, operation))
        return executePrepared(prepared, exec)
      } catch (error) { throw toolFailure(error) }
    },
  })

  async function executePrepared(prepared: Parameters<Workbench['executor']['execute']>[0], exec: { signal: AbortSignal }) {
    const epoch = wb.restoreEpoch
    let result: unknown
    try { result = await wb.executor.execute(prepared, { signal: exec.signal }) }
    catch (error) {
      try {
        wb.assertRestoreEpoch(epoch)
        await wb.registerDirectFailure(error, (prepared.summary as Rec | undefined)?.['request'] ?? null)
      } catch {
        if (error instanceof Error && !['AbortError', 'TimeoutError'].includes(error.name)) error.message += ' Gallery receipt registration failed; the saved operation receipt remains the source of truth.'
      }
      throw error
    }
    return registerResult(result, (prepared.summary as Rec | undefined)?.['request'] ?? null, epoch)
  }

  async function registerResult(result: unknown, request: unknown, epoch: number): Promise<Rec> {
    const value = { ...(result as Rec), warnings: [...((result as Rec)['warnings'] as unknown[] ?? [])] }
    try {
      wb.assertRestoreEpoch(epoch)
      await wb.registerDirectGeneration(value, request)
    }
    catch { value.warnings.push('Image output saved, but gallery registration failed; use artifact_paths and record_path. Do not generate again to repair gallery registration.') }
    return finalize(value)
  }

  tool({
    name: 'nai_edit_image',
    description: '远程编辑，operation 必填：img2img 全图重绘、inpaint 局部重绘、enhance 扩散增强、upscale 2倍放大、augment 导演工具、encode_vibe 编码 V4.5 参考。传 image_path 与便捷 prompt/model，更多字段放 request（同名优先）。inpaint 需 mask_path（白重绘黑保留），augment 需 tool；encode_vibe 默认 V4.5。返回最终图片/参考文件与回执；多张逐次调用。完整字段按需用 nai_get_presets({operation})。',
    parameters: {
      operation: { type: 'string', enum: ['img2img', 'inpaint', 'enhance', 'upscale', 'augment', 'encode_vibe'], required: true },
      ...COMMON_EDIT_PARAMETERS,
      model: { ...MODEL_PARAMETER, description: '默认 V5；encode_vibe 默认 V4.5。模型别名可用。' },
      image_path: IMG2IMG_PARAMETERS.image_path,
      mask_path: INPAINT_PARAMETERS.mask_path,
      strength: { type: 'number', description: '重绘幅度；默认 img2img 0.7 / inpaint 1 / enhance 0.2' },
      width: IMG2IMG_PARAMETERS.width,
      height: IMG2IMG_PARAMETERS.height,
      tool: AUGMENT_PARAMETERS.tool,
      emotion: AUGMENT_PARAMETERS.emotion,
      information_extracted: ENCODE_VIBE_PARAMETERS.information_extracted,
    },
    output: IMAGE_OUTPUT,
    presentationMeta: (_args: unknown, value: unknown) => imageMeta(value),
    async execute(args: Args, exec: { signal: AbortSignal }) {
      try {
        const raw = normalizeRequest(args, ['operation'])
        const prepared = await import('./core/operations.ts').then((m) => m.prepareOperation(raw, args.operation))
        return executePrepared(prepared, exec)
      } catch (error) { throw toolFailure(error) }
    },
  })

  const imageOp = (name: string, operation: string, description: string, parameters: Record<string, unknown>) => tool({
    name,
    description,
    parameters,
    output: IMAGE_OUTPUT,
    presentationMeta: (_args: unknown, value: unknown) => imageMeta(value),
    async execute(args: Args, exec: { signal: AbortSignal }) {
      try {
        const raw = normalizeRequest(args)
        const prepared = await import('./core/operations.ts').then((m) => m.prepareOperation(raw, operation))
        return executePrepared(prepared, exec)
      } catch (error) { throw toolFailure(error) }
    },
  })

  imageOp('nai_img2img', 'img2img', '以本地原图和完整目标提示词重绘。支持直接平铺参数或传入 request。省略 width/height 时使用原图尺寸。', IMG2IMG_PARAMETERS)
  imageOp('nai_inpaint', 'inpaint', '局部重绘：提供 image_path, mask_path(白色重绘), prompt 等。最终图保持原画布尺寸，遮罩外像素严格保留。V5 Curated 不支持。', INPAINT_PARAMETERS)
  imageOp('nai_upscale', 'upscale', '专用放大，每维翻倍。输入 image_path, max_anlas。源图最多 3.1MP。', UPSCALE_PARAMETERS)
  imageOp('nai_augment_image', 'augment', 'Director Tools 图像处理工具。支持 bg-removal/lineart/sketch/colorize/emotion/declutter 等。', AUGMENT_PARAMETERS)
  imageOp('nai_enhance_image', 'enhance', '第二次扩散增强。输入 image_path, strength(默认0.2), mode(regular|max) 等。', ENHANCE_PARAMETERS)
  imageOp('nai_encode_vibe', 'encode_vibe', '把图片编码为可复用的 V4.5 Vibe 文件。输入 image_path, model, max_anlas。每次编码 2 Anlas。', ENCODE_VIBE_PARAMETERS)
  imageOp('nai_generate_with_references', 'reference_generate', 'V4.5 用 Vibe 或 Precise Reference 生图（两者不可混用）。每张 Precise Reference 另收 5 Anlas。', REFERENCE_GENERATE_PARAMETERS)

  tool({
    name: 'nai_check_credits',
    description: '读取 NovelAI 订阅、Anlas 余额与 V5 用量，并报告各模型默认设置的免费资格。不生成不扣费。',
    parameters: {},
    output: OBJECT_OUTPUT,
    async execute(_args: unknown, exec: { signal: AbortSignal }) {
      const credits = await wb.executor.credits(exec.signal)
      const eligibility: Rec = {}
      for (const model of MODELS) {
        const request = GenerationRequestSchema.parse({ model, prompt: 'quota preflight' })
        const { checkFreeEligibility } = await import('./core/client.ts')
        eligibility[model] = checkFreeEligibility({ width: request.width, height: request.height, steps: 23, isV5: model.startsWith('nai-diffusion-5-') }, credits)
      }
      return { ...credits, default_model_eligibility: eligibility }
    },
  })

  tool({
    name: 'nai_quote',
    description: '按 operation/request 查询费用信息，不生成、不授予消费权限。offline:true 只做本地校验（含 prepare_image），返回 resolved_request 与警告，不读账户；默认读取账户返回预计费用及资格，估价不是扣费保证。普通生成不要求先调用；include_payload:true 可查看脱敏载荷。',
    parameters: {
      operation: { ...OPERATION_SELECTOR, enum: [...OPERATION_NAMES, 'prepare_image'] },
      request: REQUEST_PARAMETER,
      offline: { type: 'boolean', default: false, description: 'true 只做离线参数校验，不读账户' },
      include_payload: PAYLOAD_PARAMETER,
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args, exec: { signal: AbortSignal }) {
      const { quoteOperation } = await import('./core/billing.ts')
      const { prepareOperation } = await import('./core/operations.ts')
      const raw = normalizeRequest(args, ['operation', 'include_payload', 'offline'])
      const op = String(args.operation || 'generate')
      const validation = await wb.validate(op, raw)
      if (args.offline) return validationView(validation, args.include_payload)
      if (op === 'prepare_image') throw new Error('prepare_image is local; use offline:true')
      const prepared = await prepareOperation(validation['resolved_request'] as Rec, op)
      exec.signal.throwIfAborted()
      const credits = await wb.executor.credits(exec.signal)
      return validationView({ ...validation, ...quoteOperation(prepared, credits) }, args.include_payload)
    },
  })

  tool({
    name: 'nai_validate_request',
    description: '离线校验operation/request，返回resolved_request与警告；include_payload:true额外返回脱敏API载荷。复用解析种子/尺寸，输入文件须保持不变。不联网不扣费。',
    parameters: {
      operation: { ...OPERATION_SELECTOR, enum: [...OPERATION_NAMES, 'prepare_image'] },
      request: REQUEST_PARAMETER,
      include_payload: PAYLOAD_PARAMETER,
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      const op = String(args.operation || 'generate')
      const raw = normalizeRequest(args, ['operation', 'include_payload'])
      const result = await wb.validate(op, raw)
      return validationView(result, args.include_payload)
    },
  })

  tool({
    name: 'nai_validate_operation',
    description: '离线校验生成/编辑 operation 与 request，operation 必填；返回 resolved_request、警告及费用校验。include_payload:true 返回脱敏 API 载荷。复用种子/尺寸并保持输入文件不变；不联网、不提交、不扣费，消费仍需实时报价与用户授权。',
    parameters: {
      operation: { ...OPERATION_SELECTOR, enum: [...OPERATION_NAMES, 'prepare_image'], required: true },
      request: REQUEST_PARAMETER,
      include_payload: PAYLOAD_PARAMETER,
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      const op = String(args.operation || 'generate')
      const raw = normalizeRequest(args, ['operation', 'include_payload'])
      const result = await wb.validate(op, raw)
      return { ...validationView(result, args.include_payload), requires_live_quote: true }
    },
  })

  tool({
    name: 'nai_get_presets',
    description: '读取模型质量/负面模板。传operation可按需读取完整request参数契约；不生成。',
    parameters: {
      model: { type: 'string', default: 'nai-diffusion-5-full' },
      operation: { type: 'string', description: 'generate/img2img/inpaint/enhance/upscale/augment/encode_vibe/reference_generate/prepare_image；省略只读模板。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      const model = String(normalizeRequest({ model: args.model ?? 'nai-diffusion-5-full' })['model'])
      const spec = specCatalog().models[model]
      if (!spec) throw new ToolFailure(new Error('未知模型'))
      const operation = optionalText(args.operation)
      if (operation && !OPERATION_REQUEST_PARAMETERS[operation]) throw new Error('未知操作')
      return {
        ...(operation ? { operation, request_parameters: Object.fromEntries(Object.entries(OPERATION_REQUEST_PARAMETERS[operation]!).filter(([key]) => key !== 'max_anlas')) } : {}),
        model, default_quality_preset: 'standard', default_negative_preset: 'heavy',
        quality_presets: spec.quality_presets, negative_presets: spec.uc_presets,
        compilation: 'Preset suffix goes after scene text, before Text:. none 保留自写内容并关闭模板注入。',
      }
    },
  })

  tool({
    name: 'nai_suggest_tags',
    description: '查询 NovelAI 官方英文/日文标签建议（不生图、不消耗 Anlas）。parameters: query(2-20 字符), model, language(en|jp), limit(1-50)。',
    parameters: {
      query: { type: 'string', required: true },
      model: { type: 'string', default: 'nai-diffusion-5-full' },
      language: { type: 'string', enum: ['en', 'jp'], default: 'en' },
      limit: { type: 'number', default: 15 },
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args, exec: { signal: AbortSignal }) {
      if (args.query.trim().length < 2 || args.query.trim().length > 20) throw new Error('query must contain 2-20 visible characters')
      const limit = args.limit ?? 15
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer from 1 to 50')
      const model = String(normalizeRequest({ model: args.model ?? 'nai-diffusion-5-full' })['model'])
      if (!(MODELS as readonly string[]).includes(model)) throw new Error('Unsupported NovelAI model')
      const tags = await wb.executor.suggestTags(args.query, model, args.language === 'jp' ? 'jp' : 'en', exec.signal)
      return { tags: tags.slice(0, limit) }
    },
  })

  tool({
    name: 'nai_image_info',
    description: '只读图片/回执信息，不上传不生成。action:inspect 用 path 读取本地 PNG 元数据与 alpha（不等于视觉检查）；operation 用 record_path 或 operation_id 二选一查回执，output_dir 仅配合 operation_id，未知 POST 先查回执且不得手动重试；recover 用 source_path 从回执或原 PNG 恢复请求，model_override 仅补明确模型，不猜缺失文件。',
    parameters: {
      action: { type: 'string', enum: ['inspect', 'operation', 'recover'], required: true },
      path: { type: 'string', description: 'inspect 必填：本地 PNG 路径' },
      record_path: { type: 'string', description: 'operation：回执 JSON 路径；与 operation_id 二选一' },
      operation_id: { type: 'string', description: 'operation：精确操作 ID；与 record_path 二选一' },
      output_dir: { type: 'string', description: 'operation：仅 operation_id 查询时指定目录' },
      source_path: { type: 'string', description: 'recover 必填：回执 JSON 或原始 PNG 路径' },
      model_override: { type: 'string', description: 'recover：模型不明确时提供；空字符串不覆盖' },
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      if (args.action === 'inspect') {
        if (!optionalText(args.path)) throw new Error('inspect requires path')
        if (['record_path', 'operation_id', 'output_dir', 'source_path', 'model_override'].some((key) => optionalText(args[key]))) throw new Error('inspect only accepts path')
        const { inspectImage } = await import('./core/metadata.ts')
        return inspectImage(args.path)
      }
      if (args.action === 'operation') {
        if (['path', 'source_path', 'model_override'].some((key) => optionalText(args[key]))) throw new Error('operation only accepts record_path or operation_id and output_dir')
        const { getOperationStatus } = await import('./core/recovery.ts')
        return getOperationStatus({ record_path: optionalText(args.record_path), operation_id: optionalText(args.operation_id), output_dir: optionalText(args.output_dir) })
      }
      if (args.action === 'recover') {
        if (!optionalText(args.source_path)) throw new Error('recover requires source_path')
        if (['path', 'record_path', 'operation_id', 'output_dir'].some((key) => optionalText(args[key]))) throw new Error('recover only accepts source_path and model_override')
        const { recoverRequest } = await import('./core/recovery.ts')
        return recoverRequest(args.source_path, optionalText(args.model_override) ?? null)
      }
      throw new Error('action must be inspect, operation or recover')
    },
  })

  tool({
    name: 'nai_inspect_image',
    description: '本地读取 PNG 元数据与隐藏 alpha 元数据、透明度统计。parameters: path。不联网不上传。',
    parameters: { path: { type: 'string', required: true } },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      const { inspectImage } = await import('./core/metadata.ts')
      return inspectImage(args.path)
    },
  })

  tool({
    name: 'nai_prepare_image',
    description: '本地裁切/缩放/垫画布/生成矩形或多边形遮罩，不联网不扣费。支持平铺参数或传入 request。原图永不覆盖。',
    parameters: PREPARE_PARAMETERS,
    output: OBJECT_OUTPUT,
    presentationMeta: (_args: unknown, value: unknown) => imageMeta(value),
    async execute(args: Args) {
      const raw = normalizeRequest(args)
      const result = await wb.prepare(raw)
      return result
    },
  })

  tool({
    name: 'nai_get_operation',
    description: '读取已保存的操作回执与产物状态，不重新提交。record_path 或 operation_id 二选一；output_dir 仅配合 operation_id。可选字符串留空视为省略，非空路径保持原值。',
    parameters: {
      record_path: { type: 'string' },
      operation_id: { type: 'string' },
      output_dir: { type: 'string' },
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      const { getOperationStatus } = await import('./core/recovery.ts')
      return getOperationStatus({ record_path: optionalText(args.record_path), operation_id: optionalText(args.operation_id), output_dir: optionalText(args.output_dir) })
    },
  })

  tool({
    name: 'nai_recover_request',
    description: '从回执 JSON 或原始 NovelAI PNG 恢复可复用请求，不生成。丢失字段如实报告，绝不猜测；max_anlas 仅历史兼容，不限制远程实际扣费。',
    parameters: {
      source_path: { type: 'string', required: true },
      model_override: { type: 'string', description: '仅图片元数据模型不明确时指定；留空不覆盖' },
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      const { recoverRequest } = await import('./core/recovery.ts')
      return recoverRequest(args.source_path, optionalText(args.model_override) ?? null)
    },
  })

  tool({
    name: 'nai_get_prompt_guide',
    description: '读取有来源的 NovelAI 提示词指南；先读 prompting 核心，再按需读模型/构图/参数。overview 是目录，不生成。',
    parameters: { topic: { type: 'string', enum: ['overview', 'prompting', 'quickstart', 'v5', 'v4.5', 'characters-artists', 'workbench', 'examples', 'parameters', 'sources', 'advanced', 'composition'], default: 'overview' } },
    // render belongs inside output — defineTool only reads options.output.render.
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: value as string }],
    },
    async execute(args: Args) {
      return readGuide(args.topic ?? 'overview')
    },
  })

  tool({
    name: 'nai_server_info',
    description: '核对实际运行版本、工具列表与输出设置。不联网不返回凭据。',
    parameters: {},
    output: OBJECT_OUTPUT,
    async execute(_args: unknown) {
      const settings = wb.settings.public()
      return {
        runtime_version: VERSION, host: 'deepseek-harness-plugin',
        tools: [...registeredNames],
        output_directory: settings['output_directory'],
        token_configured: settings['token_configured'],
        inpaint_models: ['nai-diffusion-5-full', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'],
        note: '使用 nai_check_credits 验证账户连通性。',
      }
    },
  })

  tool({
    name: 'nai_workbench_status',
    description: '读取工作台与运行版本，不生成。默认返回 runtime_version/tools、草稿、作品、计划及公开设置；info:true 只返回运行版本、工具与输出目录。job_id 精读作品/任务结果，schedule_id 精读计划及最近10轮；两者不可同时提供，不返回凭据。',
    parameters: {
      info: { type: 'boolean', description: 'true 仅返回版本、实际工具列表及输出目录' },
      job_id: { type: 'string', description: 'Optional exact queued job ID to inspect its result or error' },
      schedule_id: { type: 'string', description: 'Optional exact schedule ID to inspect its plan and last ten runs' },
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      const jobId = optionalText(args.job_id), scheduleId = optionalText(args.schedule_id)
      if (jobId !== undefined && scheduleId !== undefined) throw new Error('job_id and schedule_id cannot be combined')
      if (args.info && (jobId !== undefined || scheduleId !== undefined)) throw new Error('info cannot be combined with job_id or schedule_id')
      const runtime = { runtime_version: VERSION, tools: [...registeredNames], output_directory: wb.settings.public()['output_directory'] }
      if (args.info) return runtime
      if (jobId !== undefined) return { ...runtime, job: compactJob(publicJobs(wb.store.getJob(jobId))) }
      if (scheduleId !== undefined) return {
        ...runtime,
        schedule: publicSchedule(wb.store.getSchedule(scheduleId)),
        runs: wb.store.listScheduleRuns(scheduleId, 10),
      }
      const draft = wb.store.getDraft()
      return {
        ...runtime, draft, queue: wb.store.queueState(),
        jobs_recent: wb.jobs().slice(0, 8).map((j) => ({ id: j['id'], status: j['status'], operation: j['operation'], error: j['error'] })),
        library_count: wb.store.listEntries().length,
        schedules: wb.store.listSchedules().map((s) => Object.fromEntries(['id', 'name', 'enabled', 'next_run', 'execution_mode', 'runs', 'max_runs'].map(k => [k, s[k]]))),
        settings: wb.settings.public(),
      }
    },
  })

/** Strip runtime context (sealed credentials, endpoint snapshot) from job records. */
function publicJobs<T>(value: T): T {
  if (Array.isArray(value)) return value.map((j) => (j instanceof Object ? Object.fromEntries(Object.entries(j).filter(([k]) => k !== 'context')) : j)) as T
  if (value instanceof Object) return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'context')) as T
  return value
}

  tool({
    name: 'nai_workbench_submit',
    description: '仅显式 legacyTools 注册提供的旧持久队列入口；默认模型目录不提供。加入 operation/request 并返回任务摘要，不是最终图片。相同幂等键须配相同参数。预算字段仅历史兼容，不保证远程实际扣费。',
    parameters: {
      operation: OPERATION_SELECTOR,
      draft_id: { type: 'string', description: 'Draft provenance; omitted uses the active draft' },
      draft_revision: { type: 'number', description: 'Reject submission when the selected draft has changed' },
      idempotency_key: { type: 'string', description: 'Stable unique key for one intended batch; reuse with identical arguments to recover without duplicate jobs' },
      library_refs: { type: 'array', items: { type: 'json' }, description: 'Library provenance, omitted uses selected draft references' },
      variants: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '取代count；支持model,scale,steps,cfg_rescale,strength,noise,seed,sampler,quality_preset,negative_preset,prompt_suffix。' },
      count: { type: 'number', default: 1, description: '批量生成张数（1-50）' },
      max_total_anlas: { type: 'number', default: 0, description: '历史批次预算字段，仅用于兼容，不限制远程扣费' },
      seed_mode: { type: 'string', enum: ['increment', 'fixed', 'random'], default: 'increment', description: '种子模式：increment(递增)|fixed(固定)|random(随机)' },
      request: REQUEST_PARAMETER,
      include_details: { type: 'boolean', description: 'true返回完整任务快照；默认返回ID、状态、预算与错误。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args, exec: { signal: AbortSignal }) {
      const op = String(args.operation || 'generate')
      const reserved = ['include_details', 'operation', 'count', 'max_total_anlas', 'seed_mode', 'draft_id', 'draft_revision', 'idempotency_key', 'library_refs', 'variants']
      const raw = normalizeRequest(args, reserved)
      const result = await wb.submitJobs({
        operation: op, request: raw, count: args.count ?? 1,
        max_total_anlas: args.max_total_anlas ?? 0, seed_mode: args.seed_mode ?? 'increment',
        ...Object.fromEntries(['draft_id', 'draft_revision', 'library_refs', 'variants'].filter((key) => args[key] !== undefined).map((key) => [key, args[key]])),
      }, args.idempotency_key ?? null, exec.signal)
      return args.include_details ? publicJobs(result) : { ...result, jobs: (result['jobs'] as Rec[]).map(compactJob) }
    },
  })

  // ---- workbench collaboration tools: the DSH conversation replaces the in-panel assistant ----

  const listDrafts = (args: Args) => {
    const { offset, limit } = pageBounds(args)
    const query = (args.query ?? '').trim().toLowerCase()
    const drafts = wb.store.listDrafts().filter((draft) => String(draft['name']).toLowerCase().includes(query))
    const activeId = wb.store.activeDraftId()
    return {
      active_draft_id: activeId, total: drafts.length, offset, limit,
      next_offset: offset + limit < drafts.length ? offset + limit : null,
      drafts: drafts.slice(offset, offset + limit).map((draft) => {
        const request = draft['request'] as Rec
        return {
          id: draft['id'], name: draft['name'], revision: draft['revision'], operation: draft['operation'],
          active: draft['id'] === activeId, model: request['model'], width: request['width'], height: request['height'],
          prompt_preview: compactPrompt(request['prompt']),
        }
      }),
    }
  }

  tool({
    name: 'nai_draft_list',
    description: 'Legacy draft discovery; prefer nai_draft_read({mode:"list"}).',
    parameters: LIST_PARAMETERS,
    output: OBJECT_OUTPUT,
    async execute(args: Args) { return listDrafts(args) },
  })

  tool({
    name: 'nai_draft_read',
    description: '读取或发现共享草稿。mode:read（默认）用 draft_id 精读 operation/request/revision/locked_fields，省略或留空读活动草稿；修改前先读取 id/revision。mode:list 用 query/offset/limit 搜索分页摘要与活动 ID，不切换草稿，再按精确 ID 读取。',
    parameters: {
      mode: { type: 'string', enum: ['read', 'list'], default: 'read' },
      draft_id: { type: 'string', description: 'read：草稿 ID；省略或留空读活动草稿' },
      ...LIST_PARAMETERS,
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      if (args.mode === 'list') {
        if (optionalText(args.draft_id)) throw new Error('list mode cannot be combined with draft_id')
        return listDrafts(args)
      }
      const { offset, limit } = pageBounds(args)
      if (optionalText(args.query) || offset !== 0 || limit !== 20) throw new Error('query and non-default pagination require mode:list')
      return wb.store.getDraft(optionalText(args.draft_id) ?? null)
    },
  })

  const draftParameters = {
    request: REQUEST_PARAMETER,
    draft_id: { type: 'string', description: '精确草稿 ID；省略用活动草稿' },
    locked_fields: { type: 'array', items: { type: 'string' }, description: '草稿锁定字段' },
    library_refs: { type: 'array', items: { type: 'json' }, description: '草稿资料来源' },
    patch: { type: 'object', additionalProperties: true, description: '可选完整草稿补丁；patch.request 优先于 request' },
    base_revision: { type: 'number', description: 'update：先 read 得到的 revision；省略使用当前版本' },
    prompt: { type: 'string', description: 'update：正面提示词' },
    negative_prompt: { type: 'string', description: 'update：负面提示词' },
    model: { type: 'string', description: 'update：模型 ID 或别名' },
    width: { type: 'number', description: 'update：宽度' },
    height: { type: 'number', description: 'update：高度' },
    operation: { type: 'string', description: 'update：操作模式' },
    name: { type: 'string', description: 'update：草稿名称' },
  }

  async function updateDraft(args: Args) {
    if (args.patch !== undefined && (args.patch === null || typeof args.patch !== 'object' || Array.isArray(args.patch))) throw new TypeError('patch must be an object')
    const patchObj = { ...(args.patch ?? {}) } as Args
    if (args.draft_id && patchObj.id && args.draft_id !== patchObj.id) throw new Error('draft_id and patch.id must identify the same draft')
    const current = wb.store.getDraft(args.draft_id ?? patchObj.id ?? null)
    const baseRev = args.base_revision ?? current['revision'] as number
    patchObj['id'] = current['id']
    for (const k of ['name', 'operation', 'locked_fields', 'library_refs']) {
      if (args[k] !== undefined && patchObj[k] === undefined) patchObj[k] = args[k]
    }
    const curReq = current['request'] as Rec
    if (patchObj['request'] !== undefined && (patchObj['request'] === null || typeof patchObj['request'] !== 'object' || Array.isArray(patchObj['request']))) throw new TypeError('patch.request must be an object')
    const patchReq = (patchObj['request'] ?? {}) as Rec
    const topLevelReq = normalizeRequest(args, ['action', 'mode', 'query', 'offset', 'limit', 'name', 'operation', 'locked_fields', 'library_refs', 'patch', 'base_revision', 'draft_id'])
    patchObj['request'] = normalizeRequest({ request: mergeRequest(curReq, mergeRequest(topLevelReq, patchReq)) })
    const draft = wb.store.saveDraft(patchObj as Rec, baseRev)
    let validation: Rec = { ok: true }
    try { await wb.validate(String(draft['operation']), draft['request'] as Rec) }
    catch (error) { validation = { ok: false, message: (error as Error).message } }
    return { draft, validation }
  }

  tool({
    name: 'nai_draft',
    description: '共享草稿，不生成。action:read 读取 draft_id（省略用活动草稿）的完整请求和 revision；list 按 query/offset/limit 搜索摘要；update 用 prompt/model/request 修改，先 read 并传 base_revision。对象深合并、数组替换，patch.request 优先；返回保存草稿与离线校验。',
    parameters: {
      action: { type: 'string', enum: ['read', 'list', 'update'], required: true },
      ...draftParameters,
      ...LIST_PARAMETERS,
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      if (args.action === 'update') return updateDraft(args)
      if (args.action === 'list') {
        if (optionalText(args.draft_id)) throw new Error('list cannot be combined with draft_id')
        return listDrafts(args)
      }
      const { offset, limit } = pageBounds(args)
      if (optionalText(args.query) || offset !== 0 || limit !== 20) throw new Error('query and non-default pagination require action:list')
      return wb.store.getDraft(optionalText(args.draft_id) ?? null)
    },
  })

  tool({
    name: 'nai_draft_patch',
    description: 'Legacy draft update; prefer nai_draft({action:"update"}).',
    parameters: draftParameters,
    output: OBJECT_OUTPUT,
    execute: updateDraft,
  })

  tool({
    name: 'nai_library_read',
    description: '搜索或读取资料库。不传 id：按 query（名称、父角色名或内容）/kind 筛选，offset/limit 分页返回紧凑摘要。传 id：返回完整 entry、父角色 parent 及 composed_prompt（已应用分支继承/画师权重）；可选 prompt_set 指定词组。更新前读取 revision，作为 nai_library_save 的 expected_revision。',
    parameters: {
      ...LIST_PARAMETERS,
      id: { type: 'string', description: '精确读取条目 ID；留空进入列表。精读可附空筛选及默认 offset=0/limit=20' },
      kind: { type: 'string', description: '按资料类型筛选列表：character/branch/artist/blend/preset；留空不过滤' },
      prompt_set: { type: 'number', description: '仅 id 读取时使用；-1 为主提示词（默认），0 起为 prompt_sets 下标' },
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      const id = optionalText(args.id), query = optionalText(args.query), kind = optionalText(args.kind)
      const { offset, limit } = pageBounds(args)
      if (id !== undefined) {
        if (query !== undefined || kind !== undefined || offset !== 0 || limit !== 20) throw new Error('id cannot be combined with query, kind or non-default pagination')
        const entry = wb.store.getEntry(id)
        const parent = entry['kind'] === 'branch' && entry['parent_id'] ? wb.store.getEntry(entry['parent_id'] as string) : null
        const { prompt, negative } = entryPrompt(entry, wb.store.listEntries(), args.prompt_set ?? -1)
        return { entry, parent, composed_prompt: { prompt, negative_prompt: negative } }
      }
      if (args.prompt_set !== undefined && args.prompt_set !== -1) throw new Error('prompt_set requires id')
      const entries = wb.store.listEntries(query?.trim() ?? '', kind ?? null)
      return {
        total: entries.length, offset, limit,
        next_offset: offset + limit < entries.length ? offset + limit : null,
        entries: entries.slice(offset, offset + limit).map((entry) => {
          const data = entry['data'] as Rec
          return {
            id: entry['id'], kind: entry['kind'], name: entry['name'], revision: entry['revision'],
            parent_id: entry['parent_id'], parent_name: entry['parent_name'] ?? null, updated_at: entry['updated_at'],
            prompt_preview: compactPrompt(data['prompt']),
            prompt_set_count: Array.isArray(data['prompt_sets']) ? data['prompt_sets'].length : 0,
            example_count: Array.isArray(data['examples']) ? data['examples'].length : 0,
          }
        }),
      }
    },
  })

  tool({
    name: 'nai_library_save',
    description: '当用户要求记住/保存可复用角色、画师、风格或预设时，立即用此工具存入共享资料库，而非只在对话答应记住。action:save（默认）创建/局部更新 character/branch/artist/blend/preset；风格存 preset。新建需 name/kind/prompt；先 nai_library_read 搜索避免重复，更新先精读 id/revision 并传 expected_revision。省略字段保留，data 深合并、数组整体替换，显式空值清空；entry/data 同名字段优先。action:delete 需 id，可传 expected_revision；先读并确认用户删除意图。不生成。',
    parameters: {
      action: { type: 'string', enum: ['save', 'delete'], default: 'save' },
      name: { type: 'string', description: '资料名称（例如角色名、画师名）' },
      kind: { type: 'string', enum: LIBRARY_KINDS, description: '类型：character(角色)|branch(形态分支)|artist(画师)|blend(画师混合)|preset(预设)' },
      prompt: { type: 'string', description: '主提示词' },
      negative_prompt: { type: 'string', description: '主负面提示词' },
      parent_id: { type: 'string', description: '所属角色 ID（仅 kind=branch 时需要）' },
      notes: { type: 'string', description: '备注说明；省略保留，空字符串清空' },
      prompt_sets: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '提示词组列表；提供时整体替换' },
      examples: { type: 'array', items: { type: 'string' }, description: '已有例图 asset ID 列表；提供时整体替换' },
      data: { type: 'object', additionalProperties: true, description: '资料内容补丁，支持 artists、replace_identity 等类型专属字段；嵌套对象合并，数组整体替换' },
      entry: { type: 'object', additionalProperties: true, description: '条目或局部补丁（兼容项）；entry.id/entry.revision 可用于更新' },
      id: { type: 'string', description: '条目 ID（更新时必需，或使用 entry.id）' },
      expected_revision: { type: 'number', description: '更新时必需的已读取版本号；兼容 entry.revision。版本不符拒绝保存' },
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      if (args.action === 'delete') {
        if (!optionalText(args.id)) throw new Error('delete requires id')
        if (['name', 'kind', 'prompt', 'negative_prompt', 'parent_id', 'notes', 'prompt_sets', 'examples', 'data', 'entry'].some((key) => args[key] !== undefined)) throw new Error('delete only accepts id and expected_revision')
        wb.store.deleteEntry(args.id, args.expected_revision ?? null)
        return { deleted: true, id: args.id }
      }
      if (args.entry !== undefined && (args.entry === null || typeof args.entry !== 'object' || Array.isArray(args.entry))) throw new TypeError('entry must be an object')
      for (const data of [args.data, args.entry?.data]) {
        if (data !== undefined && (data === null || typeof data !== 'object' || Array.isArray(data))) throw new TypeError('data must be an object')
      }
      if (args.id !== undefined && args.entry?.id !== undefined && args.id !== args.entry.id) throw new Error('id and entry.id must identify the same entry')
      const rawEntry = mergeRequest(args, args.entry ?? {})
      const id = rawEntry['id'] ?? null
      if (id !== null && (typeof id !== 'string' || !id.trim())) throw new Error('id must be a non-empty string')
      const expected = args.expected_revision ?? rawEntry['expected_revision'] ?? rawEntry['revision'] ?? null
      if (id !== null && expected === null) throw new Error('Updating a library entry requires expected_revision (or entry.revision); read nai_library_read first')
      if (expected !== null && (!Number.isSafeInteger(expected) || (expected as number) < 0)) throw new Error('expected_revision must be a non-negative safe integer')
      const current = id === null ? null : wb.store.getEntry(id as string)
      const fields = ['prompt', 'negative_prompt', 'prompt_sets', 'examples', 'notes']
      const flatData = Object.fromEntries(fields.filter((key) => rawEntry[key] !== undefined).map((key) => [key, rawEntry[key]]))
      const dataPatch = mergeRequest(flatData, (rawEntry['data'] ?? {}) as Rec)
      rawEntry['data'] = mergeRequest(current ? current['data'] as Rec : { prompt: '', negative_prompt: '', prompt_sets: [], examples: [], notes: '' }, dataPatch)
      for (const key of ['action', 'entry', 'id', 'revision', 'expected_revision', ...fields]) delete rawEntry[key]
      return wb.store.saveEntry(rawEntry, id as string | null, expected as number | null)
    },
  })

  tool({
    name: 'nai_library_delete',
    description: '删除资料库条目。parameters: id, expected_revision(可选)。',
    parameters: {
      id: { type: 'string', required: true },
      expected_revision: { type: 'number' },
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      wb.store.deleteEntry(args.id as string, args.expected_revision ?? null)
      return { deleted: true }
    },
  })

  tool({
    name: 'nai_schedule_save',
    description: '仅在用户要求定时生图时管理计划。action:save（默认）需 schedule 对象，更新加 id；对象需 name、kind(once|daily|interval) 与对应 at/time/interval_minutes，可选 timezone/count/max_runs/enabled/execution_mode(ai|fixed)/operation/request/ai_recipe。action:delete 只需 id，不需 schedule。不指定自动执行意图时先保存 enabled:false。',
    parameters: {
      action: { type: 'string', enum: ['save', 'delete'], default: 'save' },
      schedule: { type: 'object', additionalProperties: true, description: 'save 必填；delete 不提供' },
      id: { type: 'string', description: '更新或删除的精确计划 ID' },
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      if (args.action === 'delete') {
        if (!optionalText(args.id)) throw new Error('delete requires id')
        if (args.schedule !== undefined) throw new Error('delete only accepts id')
        wb.store.deleteSchedule(args.id)
        return { deleted: true, id: args.id }
      }
      if (!args.schedule || typeof args.schedule !== 'object' || Array.isArray(args.schedule)) throw new Error('save requires schedule object')
      return await wb.saveSchedule(args.schedule as Rec, optionalText(args.id))
    },
  })

  tool({
    name: 'nai_schedule_delete',
    description: '删除定时计划。parameters: id。',
    parameters: { id: { type: 'string', required: true } },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      wb.store.deleteSchedule(args.id as string)
      return { deleted: true }
    },
  })

  tool({
    name: 'nai_gallery_curate',
    description: '收藏/归档图库任务（不影响已生成文件）。parameters: ids(任务 ID 列表), favorite(true|false|null), archived(true|false|null)。',
    parameters: {
      ids: { type: 'array', required: true, items: { type: 'string' } },
      favorite: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
      archived: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
    },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      return wb.store.curateJobs(args.ids as string[], { favorite: args.favorite ?? null, archived: args.archived ?? null })
    },
  })

  tool({
    name: 'nai_job_cancel',
    description: '取消排队中的任务（已提交到 NovelAI 的无法撤回）。parameters: id。',
    parameters: { id: { type: 'string', required: true } },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      return publicJobs(wb.store.cancelJob(args.id as string))
    },
  })

  tool({
    name: 'nai_queue_pause',
    description: '暂停或恢复工作台队列（只影响尚未提交的任务）。parameters: paused(布尔)。',
    parameters: { paused: { type: 'boolean', required: true } },
    output: OBJECT_OUTPUT,
    async execute(args: Args) {
      return wb.store.setPaused(Boolean(args.paused))
    },
  })

}

function toolFailure(error: unknown): unknown {
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return error
  return new ToolFailure(error)
}

export class ToolFailure extends Error {
  constructor(cause: unknown) {
    const message = cause instanceof NovelAIError
      ? (cause as Error).message
      : zodFriendly(cause)
    const evidence = cause instanceof Error ? cause as Error & { submission_outcome_unknown?: boolean; notSubmitted?: boolean; partialResult?: Rec } : null
    const ambiguous = evidence?.submission_outcome_unknown === true && evidence.notSubmitted !== true
    const recovery = ambiguous ? ' Submission outcome is unknown. Inspect the saved receipt with nai_image_info({action:"operation",record_path:...}); do not manually retry this POST.' : ''
    const warnings = (evidence?.partialResult?.['warnings'] as string[] | undefined) ?? []
    super(message + recovery + (warnings.length ? ` Warnings: ${warnings.join('; ')}` : ''), { cause })
    this.name = cause instanceof Error ? cause.name : 'ToolFailure'
  }
}

function zodFriendly(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'issues' in (cause as Rec)) return `请求无效：${zodMessage(cause as never)}`.slice(0, 800)
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 800)
}

function compactJob(job: Rec): Rec {
  const keys = ['id', 'batch_id', 'operation', 'status', 'attempts', 'draft_id', 'draft_revision', 'cancel_requested', 'max_anlas', 'reserved_anlas', 'actual_anlas', 'error', 'started_at', 'finished_at']
  const result = Object.fromEntries(keys.filter(key => key in job).map(key => [key, job[key]]))
  if ('result' in job) result['result'] = job['result'] ? finalize(job['result']) : null
  return result
}

function validationView(value: Rec, includePayload: boolean | undefined): Rec {
  if (includePayload) return value
  const { api_payload: _payload, preparation: _preparation, ...compact } = value
  return compact
}

function finalize(result: unknown): Rec {
  const value = { ...(result as Rec) }
  value['image_path'] ??= (value['image_paths'] as string[] | undefined)?.[0]
  value['image_path'] ??= ((value['artifact_paths'] as string[] | undefined) ?? []).find((path) => /\.(png|jpe?g|webp|gif)$/iu.test(path))
  if (value['image_path'] === undefined) delete value['image_path']
  // Full account and metadata snapshots remain in the receipt.
  for (const key of ['image_metadata', 'credits_after', 'image_paths', 'dimensions', 'max_anlas', 'estimated_anlas', 'anlas_delta', 'anlas_balance']) delete value[key]
  return value
}

function imageMeta(value: unknown): Rec {
  const v = (value ?? {}) as { [key: string]: any }
  if (typeof v !== 'object') return {}
  const artifactPaths = ((v['artifact_paths'] ?? v['image_paths'] ?? []) as string[]).filter(Boolean)
  const primary = artifactPaths[0]
  return Object.fromEntries(Object.entries({
    image_paths: (v['image_paths'] ?? artifactPaths.filter((path) => /\.(png|jpe?g|webp|gif)$/iu.test(path))) as string[],
    width: v['width'], height: v['height'], seed: v['seed'], model: v['model'],
    anlas_spent: v['anlas_spent'], operation: v['operation'],
    locations: primary ? [{ path: primary }] : [],
  }).filter(([, item]) => item !== undefined))
}

