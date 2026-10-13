/** Same-origin workbench requests. Mutations are never retried automatically. */
export type Rec = Record<string, any>

export class ApiError extends Error {
  readonly retryable: boolean
  constructor(message: string, readonly status: number, readonly details?: unknown, readonly code?: string) {
    super(message)
    this.name = 'ApiError'
    this.retryable = status === 0 || status === 408 || status === 429 || status >= 500
  }
}

const apiPrefix = (globalThis as typeof globalThis & { __NAI_ATELIER_API_PREFIX__?: string }).__NAI_ATELIER_API_PREFIX__ ?? '/api/nai'
export const API_BASE = apiPrefix.replace(/\/+$/u, '') + '/api'

async function responseError(res: Response): Promise<ApiError> {
  const text = await res.text()
  let value: Rec | null = null
  try { value = JSON.parse(text) as Rec } catch { /* Non-JSON host failures must not dump HTML into the panel. */ }
  const fallback: Record<number, string> = { 401: '工作台会话已失效', 403: '工作台拒绝了此请求', 404: '资源或接口不存在', 409: '内容已被更新，请核对后重试', 413: '文件或请求内容超过大小限制', 429: '请求过于频繁，请稍后重试', 503: '工作台暂时不可用' }
  return new ApiError(String(value?.['error'] ?? fallback[res.status] ?? `工作台请求失败（HTTP ${res.status}）`).slice(0, 1000), res.status, value?.['details'] ?? value?.['detail'], value?.['code'])
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  try { return await fetch(url, { credentials: 'same-origin', ...init }) }
  catch (error) {
    if (init?.signal?.aborted || (error as Error)?.name === 'AbortError') throw error
    throw new ApiError('无法连接工作台，操作未确认完成', 0)
  }
}

export async function api<T = Rec>(path: string, method = 'GET', body?: unknown, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { 'X-Workbench-Request': '1', ...extraHeaders }
  let payload: BodyInit | undefined
  if (body !== undefined) {
    if (body instanceof FormData) payload = body
    else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
  }
  const res = await request(API_BASE + path, { method, headers, body: payload, signal })
  if (!res.ok) throw await responseError(res)
  if (res.status === 204) return null as T
  try { return await res.json() as T } catch { throw new ApiError('工作台返回了无法识别的响应，操作结果未确认', res.status) }
}

export function uploadFile(file: File | Blob, name?: string): Promise<Rec> {
  const data = new FormData()
  data.append('file', file, name ?? (file instanceof File ? file.name : 'image.png'))
  return api('/assets', 'POST', data)
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function downloadPost(path: string, body: unknown, filename: string): Promise<void> {
  const res = await request(API_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify(body) })
  if (!res.ok) throw await responseError(res)
  saveBlob(await res.blob(), filename)
}

export async function downloadUrl(url: string, filename: string): Promise<void> {
  const res = await request(url)
  if (!res.ok) throw await responseError(res)
  saveBlob(await res.blob(), filename)
}

export function fileUrl(path: string): string { return `${API_BASE}/files/${encodeURIComponent(path).replace(/%2F/gu, '/')}` }
export function assetUrl(id: string): string { return `${API_BASE}/assets/${encodeURIComponent(id)}/file` }
export function assetThumb(id: string): string { return `${API_BASE}/assets/${encodeURIComponent(id)}/thumb` }
