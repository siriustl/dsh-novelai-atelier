/** Pure final checks for AI-created scheduled requests. Ported from scheduled_assistant.py. */
import { createHash } from 'node:crypto'

const MISSING = Symbol('missing')

export function lockPath(value: string): string {
  const normalized = value.trim().replace(/^\//u, '').replace(/\//gu, '.').replace(/\[(\d+)\]/gu, '.$1')
  return normalized === 'operation' || normalized === 'request' || normalized.startsWith('request.') ? normalized : 'request.' + normalized
}

function getPath(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split('.')) {
    if (current instanceof Object && !Array.isArray(current)) current = (current as Record<string, unknown>)[key] ?? MISSING
    else if (Array.isArray(current) && /^\d+$/u.test(key) && Number(key) < current.length) current = current[Number(key)]
    else return MISSING
  }
  return current
}

function protectedCheck(before: unknown, after: unknown, path = 'request'): void {
  if (after instanceof Object && !Array.isArray(after)) {
    const original = before instanceof Object && !Array.isArray(before) ? before as Record<string, unknown> : {}
    for (const [key, value] of Object.entries(after)) {
      const child = `${path}.${key}`
      if ((key.toLowerCase().endsWith('_path') || ['token', 'api_key', 'base_url', 'proxy_url', 'output_directory'].includes(key.toLowerCase())) && JSON.stringify(value) !== JSON.stringify(original[key] ?? null))
        throw new Error(`AI 不可修改输入文件或连接设置：${child}`)
      protectedCheck(original[key], value, child)
    }
  } else if (Array.isArray(after)) {
    const original = Array.isArray(before) ? before : []
    after.forEach((value, index) => protectedCheck(original[index], value, `${path}.${index}`))
  }
}

/** Reject a changed lock, removed fixed text or escalated spending ceiling. */
export function checkScheduledRequest(schedule: Record<string, unknown>, request: unknown): Record<string, unknown> {
  if (!(request instanceof Object) || Array.isArray(request)) throw new Error('AI 计划需要完整 request 对象')
  const req = request as Record<string, unknown>
  const base = schedule['request'] as Record<string, unknown>
  const before = { operation: schedule['operation'], request: base }
  const after = { operation: schedule['operation'], request: req }
  const recipe = (schedule['ai_recipe'] ?? {}) as Record<string, unknown>
  for (const raw of (recipe['locked_fields'] ?? []) as string[]) {
    const path = lockPath(raw)
    if (JSON.stringify(getPath(before, path)) !== JSON.stringify(getPath(after, path)))
      throw new Error(`AI 改动了计划锁定字段：${path}`)
  }
  for (const [field, fixedKey] of [['prompt', 'fixed_prompt'], ['negative_prompt', 'fixed_negative_prompt']] as const) {
    const fixed = (recipe[fixedKey] ?? '') as string
    const value = req[field]
    if (fixed && (typeof value !== 'string' || !value.includes(fixed)))
      throw new Error(`AI 结果缺少固定提示词：${fixedKey}`)
  }
  protectedCheck(base, req)
  return structuredClone(req)
}

/** Stable idempotency key helper (SHA-256 hex, mirroring store fingerprints). */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
