export function modelLabel(value: unknown): string {
  const model = String(value ?? '')
  return ({ 'nai-diffusion-5-full': 'V5 Full', 'nai-diffusion-5-curated': 'V5 Curated', 'nai-diffusion-4-5-full': 'V4.5 Full', 'nai-diffusion-4-5-curated': 'V4.5 Curated' } as Record<string, string>)[model] ?? model
}

export function operationLabel(value: unknown): string {
  const operation = String(value ?? '')
  return ({ generate: '文生图', img2img: '图生图', enhance: '图像增强', upscale: '图像放大', augment: '导演工具', inpaint: '局部重绘', reference_generate: '参考图生成', encode_vibe: 'Vibe 编码', prepare_image: '画布准备' } as Record<string, string>)[operation] ?? operation
}

export function dateTimeLabel(value: unknown): string {
  if (value == null || value === '') return '—'
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value)) ? Number(value) : null
  const date = numeric === null ? new Date(String(value)) : new Date(numeric < 1e12 ? numeric * 1000 : numeric)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN')
}

/** Compact relative label for dense gallery metadata; absolute dates remain in tooltips. */
export function relativeTimeLabel(value: unknown): string {
  if (value == null || value === '') return '—'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return '—'
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} 天前`
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
