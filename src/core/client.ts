/** NovelAI image API client. */
import { ProxyAgent } from 'undici'
import { VERSION } from '../version.ts'

export const DEFAULT_IMAGE_URL = 'https://image.novelai.net'
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

export class NovelAIError extends Error {
  status_code?: number
  server_message?: string
  notSubmitted?: boolean
  submission_outcome_unknown?: boolean
  retryable?: boolean
  retry_after_seconds?: number
  receiptPath?: string
  partialResult?: Record<string, unknown>
  constructor(message: string) {
    super(message)
    this.name = 'NovelAIError'
  }
}

export class NovelAINotSubmitted extends NovelAIError {
  readonly notSubmitted = true
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Operation cancelled before submission')
    this.name = cause instanceof Error ? cause.name : 'NovelAINotSubmitted'
    this.cause = cause
    if (cause instanceof NovelAIError) {
      this.status_code = cause.status_code
      this.server_message = cause.server_message
      this.retryable = cause.retryable
      this.retry_after_seconds = cause.retry_after_seconds
    }
  }
}

export function numeric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export interface NormalizedCredits {
  active: unknown; tier: unknown; expires_at: unknown
  anlas: { subscription: number | null; purchased: number | null; total: number | null }
  perks: Record<string, unknown>
  v5_usage: Record<string, unknown> | null
  v5_usage_summary: Record<string, unknown> | null
}

/** Explain usagelimit.Status using the official image OpenAPI field units. */
export function summarizeV5Usage(usage: unknown): Record<string, unknown> | null {
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const negative = u.isNegative
  const percent = u.percent
  let seconds: number | null = numeric(u.timeUntilNextPercent) && (u.timeUntilNextPercent as number) >= 0
    ? u.timeUntilNextPercent as number : null
  return {
    pool_available: typeof negative === 'boolean' ? !negative : null,
    remaining_percent: numeric(percent) && percent >= 0 ? percent : null,
    refill_one_percentage_point_seconds: seconds,
    refill_percentage_points_per_day: seconds && seconds > 0 ? 86400 / seconds : null,
    refill_paused_above_cap: seconds !== null ? seconds === 0 : null,
  }
}

export function normalizeSubscription(data: unknown): NormalizedCredits {
  const subRaw = (data && typeof data === 'object' && 'subscription' in (data as Record<string, unknown>))
    ? (data as Record<string, unknown>).subscription : data
  if (!subRaw || typeof subRaw !== 'object') throw new NovelAIError('NovelAI returned an unrecognized subscription structure')
  const sub = subRaw as Record<string, unknown>
  const balance = sub.trainingStepsLeft
  const b = balance && typeof balance === 'object' ? balance as Record<string, unknown> : {}
  const fixed = numeric(b.fixedTrainingStepsLeft) && b.fixedTrainingStepsLeft >= 0 ? b.fixedTrainingStepsLeft : null
  const purchased = numeric(b.purchasedTrainingSteps) && b.purchasedTrainingSteps >= 0 ? b.purchasedTrainingSteps : null
  let total: number | null = null
  if (numeric(balance) && balance >= 0) total = balance
  else if (fixed !== null && purchased !== null) total = fixed + purchased
  if (total !== null && total < 0) total = null
  const usage = sub.usage
  return {
    active: sub.active, tier: sub.tier, expires_at: sub.expiresAt,
    anlas: { subscription: fixed, purchased, total },
    perks: (sub.perks && typeof sub.perks === 'object' ? sub.perks : {}) as Record<string, unknown>,
    v5_usage: usage && typeof usage === 'object' ? usage as Record<string, unknown> : null,
    v5_usage_summary: summarizeV5Usage(usage),
  }
}

const FREE_PIXELS = 1_048_576
const FREE_STEPS = 28

/** How much of the official subscription contract applies to a configured endpoint. */
export type FreeMode = 'official' | 'opus' | 'none'

/** Allowance read from a relay's own site API, when the user configured one. */
export interface AllowanceSummary {
  ok?: boolean
  percent?: number | null
  available_images?: number | null
  capacity_images?: number | null
  share_count?: number | null
}

const allowanceNote = (allowance: AllowanceSummary | null | undefined): string | null => {
  if (!allowance || allowance.ok !== true || allowance.percent == null) return null
  const detail = [
    allowance.available_images != null && allowance.capacity_images != null
      ? `${allowance.available_images}/${allowance.capacity_images} images` : null,
    allowance.share_count ? `${allowance.share_count}-way share` : null,
  ].filter(Boolean).join(', ')
  return `V5 allowance left: ${allowance.percent}%${detail ? ` (${detail})` : ''}`
}

export function checkFreeEligibility(r: { width: number; height: number; steps: number; isV5: boolean }, credits: NormalizedCredits, mode: FreeMode = 'official', allowance?: AllowanceSummary | null): {
  eligible: boolean; estimated_anlas: number | null; reasons: string[]; policy: string; v5_usage_condition: string | null; mode: FreeMode
} {
  const reasons: string[] = []
  if (mode === 'none')
    return {
      eligible: false, estimated_anlas: null, reasons: ['该接口没有声明免费额度；费用按官方公式估算'],
      policy: 'Endpoint declared no free allowance', v5_usage_condition: null, mode,
    }
  if (mode === 'opus') {
    // Non-official gateways report placeholder subscription fields, so the user's
    // declaration replaces the tier/usage checks; size and step limits still apply.
    if (r.width * r.height > FREE_PIXELS) reasons.push('Free images must contain at most 1,048,576 pixels')
    if (r.steps > FREE_STEPS) reasons.push('Free images must use at most 28 steps')
    return {
      eligible: reasons.length === 0, estimated_anlas: reasons.length === 0 ? 0 : null, reasons,
      policy: 'Endpoint declared Opus-like free small images; server subscription state is not checked',
      v5_usage_condition: r.isV5
        ? allowanceNote(allowance) ?? 'V5 draws from this endpoint\'s own allowance; configure a site session token to read its remaining percentage'
        : null,
      mode,
    }
  }
  if (credits.active !== true || !numeric(credits.tier) || credits.tier < 3)
    reasons.push('A currently active Opus subscription is required')
  if (!numeric(credits.expires_at) || credits.expires_at <= Date.now() / 1000)
    reasons.push('Subscription expiration is missing or has passed')
  if (r.width * r.height > FREE_PIXELS) reasons.push('Free images must contain at most 1,048,576 pixels')
  if (r.steps > FREE_STEPS) reasons.push('Free images must use at most 28 steps')
  const perks = credits.perks ?? {}
  // Current official responses omit this legacy perk; the website gates on tier >= 3 and active.
  if (perks.unlimitedImageGeneration === false)
    reasons.push('Subscription explicitly disables the free image generation perk')
  if (r.isV5) {
    const usage = credits.v5_usage
    if (!usage || typeof usage !== 'object' || usage.isNegative !== false)
      reasons.push('V5 needs a verified nonnegative usage state (isNegative=false); displayed 0% is eligible')
  }
  const v5Usage = r.isV5 ? credits.v5_usage : null
  return {
    eligible: reasons.length === 0,
    estimated_anlas: reasons.length === 0 ? 0 : null,
    reasons,
    policy: 'Informational free eligibility; max_anlas is not a server-side spending cap',
    // Only report the allowance caveat when it is the actual blocker; a failing
    // subscription check already explains the refusal.
    v5_usage_condition: r.isV5 && v5Usage?.isNegative === true ? 'V5 usage is negative (allowance exhausted)' : null,
    mode,
  }
}

export interface ClientOptions {
  token: string
  baseUrl?: string
  proxy?: string | null
  signal?: AbortSignal
  retryDelaySeconds?: number
  /** Total attempts, including the initial request. */
  retryMaxAttempts?: number
}

export class NovelAIClient {
  readonly imageUrl: string
  private token: string
  private proxy: string | null
  private signal?: AbortSignal
  readonly retryDelaySeconds: number
  readonly retryMaxAttempts: number

  constructor(opts: ClientOptions) {
    const base = opts.baseUrl?.trim() || DEFAULT_IMAGE_URL
    let parsed: URL
    try { parsed = new URL(base) } catch { throw new Error('NovelAI base URL is not a valid URL') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new Error('NovelAI base URL must be an HTTP(S) service URL')
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error('NovelAI base URL must not contain credentials, query or fragment')
    this.imageUrl = base.replace(/\/+$/u, '')
    this.token = opts.token
    this.proxy = opts.proxy || null
    this.signal = opts.signal
    this.retryDelaySeconds = opts.retryDelaySeconds ?? 3
    this.retryMaxAttempts = opts.retryMaxAttempts ?? 3
    if (!Number.isFinite(this.retryDelaySeconds) || this.retryDelaySeconds < 0 || this.retryDelaySeconds > 300)
      throw new Error('Retry delay must be between 0 and 300 seconds')
    if (!Number.isInteger(this.retryMaxAttempts) || this.retryMaxAttempts < 1 || this.retryMaxAttempts > 10)
      throw new Error('Retry attempts must be an integer between 1 and 10, including the initial request')
  }

  private async request(method: string, url: string, init: { json?: unknown; query?: Record<string, string> } = {}, signal?: AbortSignal): Promise<Response> {
    const target = new URL(url)
    for (const [k, v] of Object.entries(init.query ?? {})) target.searchParams.set(k, v)
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.token}`,
      'User-Agent': `dsh-novelai-atelier/${VERSION}`,
    }
    if (init.json !== undefined) headers['Content-Type'] = 'application/json'
    const requestSignal = signal ?? this.signal
    requestSignal?.throwIfAborted()
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    requestSignal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), 180_000)
    timer.unref?.()
    let response: Response
    let dispatcher: ProxyAgent | undefined
    let fetchStarted = false
    let responseStatus: number | undefined
    try {
      const opts: RequestInit & { dispatcher?: unknown } = {
        method, headers, signal: controller.signal,
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
        redirect: 'manual',
      }
      dispatcher = this.proxy ? new ProxyAgent(this.proxy) : undefined
      if (dispatcher) (opts as { dispatcher?: unknown }).dispatcher = dispatcher
      fetchStarted = true
      response = await fetch(target, opts)
      responseStatus = response.status
      // Bound the decoded body while receiving it; cancellation and timeout
      // must remain active until the last body byte has been received.
      if (!response.body) throw new Error('empty response body')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {})
          const action = method === 'POST' ? ' Generation outcome is unknown; no automatic retry.' : ''
          throw new NovelAIError('NovelAI response exceeds the 64 MiB limit.' + action)
        }
        chunks.push(value)
      }
      const body = new Uint8Array(received)
      let off = 0
      for (const c of chunks) { body.set(c, off); off += c.byteLength }
      const cleanHeaders = new Headers()
      response.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())) cleanHeaders.set(k, v)
      })
      response = new Response(body, { status: response.status, statusText: response.statusText, headers: cleanHeaders })
    } catch (error) {
      const rejected = method === 'POST' && responseStatus !== undefined && responseStatus >= 400 && responseStatus < 500 && responseStatus !== 408
      if (error instanceof NovelAIError) {
        error.notSubmitted = rejected
        error.submission_outcome_unknown = method === 'POST' && !rejected
        if (responseStatus !== undefined && responseStatus >= 300) error.status_code = responseStatus
        throw error
      }
      const cause = (error as { cause?: { message?: string; code?: string } })?.cause
      const detail = cause?.message || cause?.code || (error as Error).message
      const connectionFailure = responseStatus === undefined && provenConnectFailure(error)
      const notSubmitted = method === 'POST' && (!fetchStarted || connectionFailure || rejected)
      const action = method === 'POST'
        ? notSubmitted ? 'No generation was submitted' : 'Generation outcome is unknown; no automatic retry'
        : 'Read-only quota checks may be retried safely'
      const networkError = new NovelAIError(`NovelAI network error (${(error as Error).name}: ${detail}). ${action}.`)
      networkError.cause = error
      if (responseStatus !== undefined && responseStatus >= 300) networkError.status_code = responseStatus
      networkError.notSubmitted = notSubmitted
      networkError.submission_outcome_unknown = method === 'POST' && !notSubmitted
      networkError.retryable = connectionFailure && !requestSignal?.aborted
      if (requestSignal?.aborted) networkError.name = 'AbortError'
      throw networkError
    } finally {
      clearTimeout(timer)
      requestSignal?.removeEventListener('abort', onAbort)
      // Each request owns this pool; destroy also closes a failed unread body.
      void dispatcher?.destroy().catch(() => {})
    }
    if (response.status >= 300) {
      const messages: Record<number, string> = {
        401: 'Token is invalid or expired', 402: 'Insufficient allowance; no paid fallback was attempted',
        403: 'Request was denied', 429: 'Rate limited; wait before retrying',
      }
      const err = new NovelAIError(`NovelAI HTTP ${response.status}: ${messages[response.status] ?? 'Request failed'}.`)
      err.status_code = response.status
      err.notSubmitted = method === 'POST' && response.status >= 400 && response.status < 500 && response.status !== 408
      err.submission_outcome_unknown = method === 'POST' && !err.notSubmitted
      const retryAfter = response.headers.get('retry-after')
      if (retryAfter) {
        const seconds = Number(retryAfter)
        const delay = Number.isFinite(seconds) ? seconds : (Date.parse(retryAfter) - Date.now()) / 1000
        if (Number.isFinite(delay) && delay >= 0) err.retry_after_seconds = delay
      }
      // Diagnostics are intentionally separate from ordinary tool errors. Never retain
      // arbitrary response bodies or echoed request data in the exception message.
      try {
        const detail = (await response.json() as { message?: unknown })?.message
        if (typeof detail === 'string' && detail.length <= 2000) {
          err.server_message = detail.replace(new RegExp(escapeRegExp(this.token), 'gu'), '[REDACTED]').replace(/pst-[A-Za-z0-9_-]+/gu, '[REDACTED]')
        }
      } catch { /* non-JSON error body */ }
      throw err
    }
    return response
  }

  private async readRequest(url: string, init: { query?: Record<string, string> } = {}, signal?: AbortSignal): Promise<Response> {
    signal ??= this.signal
    for (let attempt = 1; attempt <= this.retryMaxAttempts; attempt++) {
      try {
        return await this.request('GET', url, init, signal)
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) throw error
        const status = error instanceof NovelAIError ? error.status_code : undefined
        const retryable = status === undefined || status === 408 || status === 429 || status >= 500
        if (!retryable || attempt === this.retryMaxAttempts) throw error
        await waitForRetry(Math.max(this.retryDelaySeconds, error instanceof NovelAIError ? error.retry_after_seconds ?? 0 : 0) * 1000, signal)
      }
    }
    throw new NovelAIError('NovelAI read-only request failed')
  }

  async credits(signal?: AbortSignal): Promise<NormalizedCredits> {
    const response = await this.readRequest(this.imageUrl + '/user/subscription', {}, signal)
    try { return normalizeSubscription(await response.json()) } catch (error) {
      if (error instanceof NovelAIError) throw error
      throw new NovelAIError('NovelAI quota response is not recognized')
    }
  }

  async generate(payload: unknown, signal?: AbortSignal): Promise<Uint8Array> {
    return this.postOperation('/ai/generate-image', payload, signal)
  }

  async suggestTags(prompt: string, model: string, language = 'en', signal?: AbortSignal): Promise<Array<{ tag: string; japanese?: string; count?: number }>> {
    const query: Record<string, string> = { model, prompt }
    if (model.startsWith('nai-diffusion-5-')) query.type = 'animev5'
    if (language === 'jp') query.lang = 'jp'
    const response = await this.readRequest(this.imageUrl + '/ai/generate-image/suggest-tags', { query }, signal)
    try {
      const data = await response.json() as unknown
      if (language === 'jp' && Array.isArray(data))
        return data.map((item: Record<string, unknown>) => ({ tag: item['en_tag'] as string, japanese: item['jp_tag'] as string | undefined, count: item['power'] as number | undefined }))
      const tags = ((data as { tags?: unknown }).tags ?? []) as Array<Record<string, unknown>>
      return tags.map((item) => ({ tag: item['tag'] as string, count: item['count'] as number | undefined }))
    } catch {
      throw new NovelAIError('NovelAI tag suggestion response has an unrecognized structure')
    }
  }

  async postOperation(endpoint: string, payload: unknown, signal?: AbortSignal, beforeSubmit?: () => void): Promise<Uint8Array> {
    signal ??= this.signal
    try { signal?.throwIfAborted() } catch (error) { throw new NovelAINotSubmitted(error) }
    if (!['/ai/generate-image', '/ai/upscale', '/ai/augment-image', '/ai/encode-vibe'].includes(endpoint))
      throw new NovelAINotSubmitted(new NovelAIError('Unsupported NovelAI operation endpoint'))
    for (let attempt = 1; attempt <= this.retryMaxAttempts; attempt++) {
      try {
        signal?.throwIfAborted()
        beforeSubmit?.()
        signal?.throwIfAborted()
      } catch (error) {
        throw new NovelAINotSubmitted(error)
      }
      try {
        const response = await this.request('POST', this.imageUrl + endpoint, { json: payload }, signal)
        return new Uint8Array(await response.arrayBuffer())
      } catch (error) {
        const confirmed = error instanceof NovelAIError && (error.notSubmitted === true || error.status_code === 429)
        const retryable = confirmed && (error.status_code === 429 || error.retryable === true)
        if (retryable && attempt < this.retryMaxAttempts && !signal?.aborted) {
          const seconds = Math.max(this.retryDelaySeconds, error.retry_after_seconds ?? 0)
          try { await waitForRetry(seconds * 1000, signal) } catch (cancelled) { throw new NovelAINotSubmitted(cancelled) }
          continue
        }
        if (confirmed) throw new NovelAINotSubmitted(error)
        throw error
      }
    }
    throw new NovelAIError('NovelAI operation failed')
  }
}

const CONNECT_FAILURE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'])

function provenConnectFailure(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const value = current as { code?: unknown; cause?: unknown }
    if (typeof value.code === 'string' && CONNECT_FAILURE_CODES.has(value.code)) return true
    current = value.cause
  }
  return false
}

function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }

/** Serialize all generations through one in-process queue lock (single DSH host process). */
export class GenerationLock {
  private chain: Promise<unknown> = Promise.resolve()
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => {})
    return await next
  }
}
