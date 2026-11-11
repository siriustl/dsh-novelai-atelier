/** Real artwork sources. External failures remain visible; no synthetic feed fallback. */
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import { promisify } from 'node:util'
import { loadTagCatalog } from './tags.ts'
import { VERSION } from '../version.ts'

export type PixivAiFilter = 'all' | 'exclude'
type Source = 'danbooru' | 'pixiv' | 'aitag'
type Row = Record<string, any>
export interface InspirationItem {
  id: string
  source: Source
  title: string
  author?: string
  previewUrl?: string
  originalUrl?: string
  sourceUrl?: string
  prompt: string
  promptKind?: 'tags' | 'original' | 'reference'
  aiMark?: 'ai' | 'not-ai'
  needsDetail?: boolean
  negativePrompt?: string
  characters?: Array<{ label?: string; prompt: string; negative_prompt?: string; x?: number; y?: number }>
  tags?: string[]
  params?: Record<string, unknown>
  score?: number
}
export interface InspirationSearchResult {
  query: string
  total: number
  source: string
  items: InspirationItem[]
  page: number
  hasMore: boolean
  errors: Array<{ source: Source; message: string; code: string }>
}

const DANBOORU_POST_FIELDS = 'id,score,fav_count,preview_file_url,large_file_url,file_url,media_asset[variants],tag_string_general,tag_string_artist,tag_string_copyright,tag_string_character'
const BROWSER_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' }
const DANBOORU_USER_ID = /^\d+$/u.test(process.env['DANBOORU_USER_ID'] ?? '') ? process.env['DANBOORU_USER_ID'] : ''
const DANBOORU_HEADERS = { 'User-Agent': `dsh-novelai-atelier/${VERSION} (NovelAI Atelier${DANBOORU_USER_ID ? `; Danbooru user #${DANBOORU_USER_ID}` : ''})`, Accept: 'application/json' }
const IMAGE_HOSTS = new Set(['cdn.donmai.us', 'i.pximg.net', 's.pximg.net', 'ai-img.10118899.xyz'])
const SOURCES: Source[] = ['danbooru', 'pixiv', 'aitag']
const CHINESE_DANBOORU_MAP: Record<string, string> = {
  '赛博朋克': 'cyberpunk', '星空': 'starry_sky', '奇幻世界': 'fantasy', '奇幻': 'fantasy',
  '水下': 'underwater', '海底': 'underwater', '复古怀旧': 'retro', '复古': 'retro',
  '电影光影': 'cinematic_lighting', '光影': 'cinematic_lighting', '水彩风格': 'watercolor_(medium)',
  '水彩': 'watercolor_(medium)', '厚涂': 'impasto', '废墟遗迹': 'ruins', '废墟': 'ruins',
  '极简构图': 'minimalism', '极简': 'minimalism', '浮世绘': 'ukiyo-e', '都市夜景': 'city_at_night',
  '夜景': 'city_at_night', '白发': 'white_hair', '黑发': 'black_hair', '金发': 'blonde_hair',
  '银发': 'silver_hair', '红发': 'red_hair', '蓝发': 'blue_hair', '粉发': 'pink_hair',
  '绿发': 'green_hair', '紫发': 'purple_hair', '单人': 'solo', '少女': '1girl', '女孩': '1girl',
  '少年': '1boy', '男孩': '1boy', '女仆': 'maid', '女仆装': 'maid', '猫耳': 'cat_ears',
  '兔耳': 'rabbit_ears', '狐耳': 'fox_ears', '精灵耳': 'pointy_ears', '和服': 'kimono',
  '旗袍': 'china_dress', '水手服': 'sailor_suit', '泳装': 'swimsuit', '校服': 'school_uniform',
  '百合': 'yuri', '机甲': 'mecha', '机械': 'mecha', '机娘': 'mecha_musume', '双马尾': 'twintails',
  '单马尾': 'ponytail', '短发': 'short_hair', '长发': 'long_hair', '发光': 'glowing',
  '微笑': 'smile', '动态构图': 'dynamic_angle', '特写': 'close-up', '全身': 'full_body',
  '肖像': 'portrait', '风景': 'scenery', '森林': 'forest', '雨': 'rain', '雪': 'snow',
  '樱花': 'cherry_blossoms', '日落': 'sunset', '夕阳': 'sunset', '天空': 'sky', '大海': 'ocean',
  '海洋': 'ocean', '翅膀': 'wings', '天使': 'angel_wings', '恶魔': 'demon_wings',
  '魔法': 'magic', '发饰': 'hair_ornament', '透明背景': 'transparent_background',
}
const integer = (value: unknown, fallback: number, max: number) => Number.isFinite(Number(value)) ? Math.max(1, Math.min(max, Math.floor(Number(value)))) : fallback
const object = (value: unknown): Row => {
  if (typeof value === 'string') { try { return object(JSON.parse(value)) } catch { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
}
const tags = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((tag) => typeof tag === 'string' ? tag : String(tag?.tag ?? tag?.name ?? '')).filter(Boolean)
  if (typeof value !== 'string') return []
  try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return tags(parsed) } catch { /* Plain tag strings are also used upstream. */ }
  return value.split(/[,，\s]+/u).filter(Boolean)
}
const text = (...values: unknown[]): string => values.find((value) => typeof value === 'string' && value.trim()) as string || ''
const failure = (message: string, code: string) => Object.assign(new Error(message), { code })
const imageUrl = (value: unknown): string => {
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && IMAGE_HOSTS.has(url.hostname) ? url.href : ''
  } catch { return '' }
}

export class InspirationEngine {
  private currentAgent: ProxyAgent | null = null
  private currentAgentUrl: string | null = null
  private discovery: Promise<string | null> | null = null
  private discoveredProxy: string | null = null
  private discoveryTime = 0
  private generation = 0
  private responseCache = new Map<string, { expires: number; value: unknown; bytes: number }>()
  private cacheBytes = 0
  private pendingReads = new Map<string, { promise: Promise<unknown>; controller: AbortController }>()
  private danbooruQueue: Promise<void> = Promise.resolve()
  private danbooruLastAt = 0

  private async cachedRead<T>(key: string, read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    key = `${this.getProxy?.() ?? ''}\n${key}`
    for (const [storedKey, entry] of this.responseCache) if (entry.expires <= Date.now()) {
      this.responseCache.delete(storedKey)
      this.cacheBytes -= entry.bytes
    }
    const cached = this.responseCache.get(key)
    if (cached) return structuredClone(cached.value) as T
    let pending = this.pendingReads.get(key)
    if (!pending) {
      // Limit retained work as well as cached data; excess distinct reads keep normal cancellation.
      if (this.pendingReads.size >= 32) return read(signal ?? new AbortController().signal)
      const controller = new AbortController(), generation = this.generation
      const promise = read(controller.signal).then((value) => {
        controller.signal.throwIfAborted()
        const bytes = Buffer.byteLength(JSON.stringify(value))
        if (generation === this.generation && bytes <= 2 * 1024 * 1024) {
          while (this.responseCache.size >= 32 || this.cacheBytes + bytes > 8 * 1024 * 1024) {
            const oldest = this.responseCache.keys().next().value
            if (oldest === undefined) break
            this.cacheBytes -= this.responseCache.get(oldest)!.bytes
            this.responseCache.delete(oldest)
          }
          this.responseCache.set(key, { value: structuredClone(value), bytes, expires: Date.now() + 30_000 })
          this.cacheBytes += bytes
        }
        return value
      }).finally(() => { if (this.pendingReads.get(key)?.promise === promise) this.pendingReads.delete(key) })
      pending = { promise, controller }
      this.pendingReads.set(key, pending)
    }
    // A caller can stop waiting without aborting another caller's shared upstream request.
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal!.reason)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      pending!.promise.then((value) => {
        signal?.removeEventListener('abort', abort)
        if (!signal?.aborted) resolve(structuredClone(value) as T)
      }, (error) => { signal?.removeEventListener('abort', abort); reject(error) })
    })
  }

  constructor(readonly dataDir: string, private readonly getProxy?: () => string | null) {}

  /** Stop releases network resources; a later request can create a fresh dispatcher. */
  async close(): Promise<void> {
    ++this.generation
    for (const pending of this.pendingReads.values()) pending.controller.abort(failure('素材网络请求已停止', 'CLOSED'))
    this.pendingReads.clear()
    this.responseCache.clear()
    this.cacheBytes = 0
    const agent = this.currentAgent
    this.currentAgent = null
    this.currentAgentUrl = null
    await agent?.destroy()
  }

  private async discoverProxy(): Promise<string | null> {
    if (Date.now() - this.discoveryTime < 30_000) return this.discoveredProxy
    if (!this.discovery) this.discovery = (async () => {
      let systemProxy: string | null = null
      if (process.platform === 'win32') {
        try {
          const run = promisify(execFile)
          const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
          const enabled = await run('reg.exe', ['query', key, '/v', 'ProxyEnable'], { timeout: 1000, windowsHide: true })
          if (/ProxyEnable\s+REG_DWORD\s+0x1/iu.test(enabled.stdout)) {
            const server = await run('reg.exe', ['query', key, '/v', 'ProxyServer'], { timeout: 1000, windowsHide: true })
            const raw = server.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)/iu)?.[1]?.trim() || ''
            const entries = Object.fromEntries(raw.split(';').map((part) => part.includes('=') ? part.split('=', 2) : ['default', part]))
            const target = entries['https'] || entries['http'] || entries['default']
            if (target) systemProxy = /^https?:\/\//iu.test(target) ? target : `http://${target}`
          }
        } catch { /* Missing system proxy is normal on portable hosts. */ }
      }
      if (systemProxy && !/^https?:\/\/198\.(?:18|19)\./u.test(systemProxy)) return systemProxy
      const ports = [7897, 7890, 10809, 10808, 2080, 8888, 1080, 6152, 7891, 10801]
      return Promise.any(ports.map((port) => new Promise<string>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port })
        socket.setTimeout(250)
        socket.once('connect', () => { socket.destroy(); resolve(`http://127.0.0.1:${port}`) })
        socket.once('error', reject)
        socket.once('timeout', () => { socket.destroy(); reject(new Error('timeout')) })
      }))).catch(() => systemProxy)
    })().then((proxy) => { this.discoveredProxy = proxy; this.discoveryTime = Date.now(); return proxy }).finally(() => { this.discovery = null })
    return this.discovery
  }

  private async getAgent(): Promise<ProxyAgent | undefined> {
    const generation = this.generation
    const proxy = this.getProxy?.() || process.env['HTTPS_PROXY'] || process.env['https_proxy']
      || process.env['HTTP_PROXY'] || process.env['http_proxy'] || process.env['ALL_PROXY'] || process.env['all_proxy'] || await this.discoverProxy()
    if (generation !== this.generation) throw failure('素材网络请求已停止', 'CLOSED')
    if (proxy === this.currentAgentUrl) return this.currentAgent ?? undefined
    if (proxy) {
      try {
        if (!['http:', 'https:'].includes(new URL(proxy).protocol)) throw new Error()
      } catch { throw failure('素材代理地址无效，请配置 HTTP/HTTPS 代理端口（不支持 SOCKS）', 'PROXY_CONFIG') }
    }
    const previous = this.currentAgent
    this.currentAgent = proxy ? new ProxyAgent(proxy) : null
    this.currentAgentUrl = proxy
    // Changing settings must not interrupt other in-flight requests.
    if (previous) void previous.close().catch(() => {})
    return this.currentAgent ?? undefined
  }

  private async readBody(res: Awaited<ReturnType<typeof undiciFetch>>, maxBytes: number): Promise<Buffer> {
    if (Number(res.headers.get('content-length')) > maxBytes) { await res.body?.cancel(); throw failure('素材响应超过大小限制', 'BODY_TOO_LARGE') }
    const chunks: Uint8Array[] = []
    let size = 0
    if (res.body) {
      const reader = res.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) { await reader.cancel(); throw failure('素材响应超过大小限制', 'BODY_TOO_LARGE') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
    }
    return Buffer.concat(chunks)
  }

  private async fetchHttp(url: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Row | Row[]> {
    signal?.throwIfAborted()
    const timeout = AbortSignal.timeout(15_000)
    try {
      const hostname = new URL(url).hostname
      const requestHeaders = hostname === 'danbooru.donmai.us'
        ? { ...DANBOORU_HEADERS, ...headers }
        : { ...BROWSER_HEADERS, Accept: 'application/json', ...headers }
      const res = await undiciFetch(url, {
        headers: requestHeaders, dispatcher: await this.getAgent(),
        redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (!res.ok) {
        await res.body?.cancel()
        const retryAfter = res.headers.get('retry-after') || ''
        if (hostname === 'danbooru.donmai.us' && res.status === 403 && res.headers.get('cf-mitigated')?.toLowerCase() === 'challenge')
          throw Object.assign(failure('Danbooru 返回 Cloudflare 验证挑战；请在原站完成验证，插件不会复用浏览器会话', 'DANBOORU_CHALLENGE'), { retryAfter })
        const retryHint = retryAfter ? `；上游 Retry-After：${retryAfter}` : ''
        const hint = res.status === 403 ? (hostname === 'danbooru.donmai.us' ? '，请检查 Danbooru 账户权限、API 身份与网络出口' : '，站点拒绝访问或触发防护，请检查素材代理') : res.status === 429 ? '，请求过于频繁，请稍后重试' : ''
        throw Object.assign(failure(`素材接口 HTTP ${res.status}${hint}${retryHint}`, `HTTP_${res.status}`), retryAfter ? { retryAfter } : {})
      }
      const body = await this.readBody(res, 8 * 1024 * 1024)
      try {
        const parsed: unknown = JSON.parse(body.toString('utf8'))
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid response shape')
        return parsed as Row | Row[]
      }
      catch { throw failure('素材接口返回了非 JSON 对象内容，可能是登录页或站点防护页', 'INVALID_RESPONSE') }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (timeout.aborted || ['TimeoutError', 'AbortError'].includes((error as Error).name) || (error as any)?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') throw failure('素材接口连接超时，请检查素材代理后重试', 'TIMEOUT')
      if ((error as any)?.code) throw error
      throw failure('无法连接素材接口，请检查网络和素材代理配置', 'NETWORK_ERROR')
    }
  }

  private async fetchDanbooru(url: string, signal?: AbortSignal): Promise<Row | Row[]> {
    const previous = this.danbooruQueue
    let release!: () => void
    this.danbooruQueue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      signal?.throwIfAborted()
      const delay = Math.max(0, 1000 - (Date.now() - this.danbooruLastAt))
      if (delay) await new Promise<void>((resolve, reject) => {
        const finish = (): void => { signal?.removeEventListener('abort', abort); resolve() }
        const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('请求已取消')) }
        const timer = setTimeout(finish, delay)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
      signal?.throwIfAborted()
      this.danbooruLastAt = Date.now()
      return await this.fetchHttp(url, {}, signal)
    } finally { release() }
  }

  async fetchImage(rawUrl: string, signal?: AbortSignal): Promise<{ buffer: Buffer; contentType: string }> {
    let url = imageUrl(rawUrl)
    if (!url) throw failure('不允许的素材图片地址', 'IMAGE_URL')
    const timeout = AbortSignal.timeout(20_000)
    for (let redirects = 0; redirects <= 3; redirects++) {
      const hostname = new URL(url).hostname
      const referer = hostname.endsWith('pximg.net') ? 'https://www.pixiv.net/' : hostname === 'ai-img.10118899.xyz' ? 'https://aitag.win/' : 'https://danbooru.donmai.us/'
      const headers = hostname === 'cdn.donmai.us' ? DANBOORU_HEADERS : BROWSER_HEADERS
      const res = await undiciFetch(url, { dispatcher: await this.getAgent(), redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { ...headers, Referer: referer, Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' } })
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel()
        url = imageUrl(new URL(res.headers.get('location') || '', url).href)
        if (!url) throw failure('素材图片重定向至不允许的地址', 'IMAGE_URL')
        continue
      }
      if (!res.ok) { await res.body?.cancel(); throw failure(`素材图片 HTTP ${res.status}`, `HTTP_${res.status}`) }
      const contentType = (res.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase()
      if (!/^image\/(?:jpeg|png|webp|gif|avif)$/u.test(contentType)) { await res.body?.cancel(); throw failure('素材图片返回了非受支持的图片内容', 'IMAGE_TYPE') }
      const buffer = await this.readBody(res, 20 * 1024 * 1024)
      if (!buffer.length) throw failure('素材图片内容为空', 'INVALID_RESPONSE')
      return { buffer, contentType }
    }
    throw failure('素材图片重定向次数过多', 'IMAGE_REDIRECT')
  }

  private normalizeDanbooruTag(query: string): string {
    const parts = query.trim().split(/[,，\s]+/u).filter(Boolean)
    if (parts.length > 2) throw failure('Danbooru 访客搜索最多支持两个标签', 'QUERY_LIMIT')
    const catalog = parts.some((part) => /[^\x00-\x7f]/u.test(part)) ? loadTagCatalog(this.dataDir) : []
    return parts.map((part) => {
      const negative = part.startsWith('-') ? '-' : ''
      const term = negative ? part.slice(1) : part
      const translated = CHINESE_DANBOORU_MAP[term] || catalog.find((tag) => tag.zh === term)?.name || term
      return negative + translated.replaceAll(' ', '_').toLowerCase()
    }).join(' ')
  }

  private danbooruItem(post: Row): InspirationItem | null {
    if (!post || !/^\d+$/u.test(String(post.id))) return null
    const variants: Row[] = Array.isArray(post.media_asset?.variants) ? post.media_asset.variants : []
    const preview = [variants.find((variant) => variant.type === '360x360')?.url, post.preview_file_url, variants.find((variant) => variant.type === '720x720')?.url, post.large_file_url, post.file_url].map(imageUrl).find(Boolean)
    if (!preview) return null
    const general = tags(post.tag_string_general).map((tag) => tag.replaceAll('_', ' '))
    const characters = tags(post.tag_string_character).map((tag) => tag.replaceAll('_', ' '))
    return {
      id: `danbooru_${post.id}`, source: 'danbooru', title: characters.slice(0, 2).join(', ') || tags(post.tag_string_copyright).join(', ').replaceAll('_', ' ') || `Post #${post.id}`,
      author: tags(post.tag_string_artist).join(', ').replaceAll('_', ' '), previewUrl: preview,
      originalUrl: imageUrl(post.file_url) || imageUrl(post.large_file_url) || preview,
      sourceUrl: `https://danbooru.donmai.us/posts/${post.id}`, prompt: [...characters, ...general].join(', '),
      promptKind: 'tags', tags: general, score: Number(post.score ?? post.fav_count) || 0,
    }
  }

  private pixivItem(post: Row): InspirationItem | null {
    if (!post || !/^\d+$/u.test(String(post.id ?? post.illust_id))) return null
    const id = String(post.id ?? post.illust_id)
    const preview = [post.url, post.urls?.small, post.urls?.regular, post.url_s, post.url_m].map(imageUrl).find(Boolean)
    if (!preview) return null
    const artworkTags = tags(post.tags?.tags ?? post.tags)
    return {
      id: `pixiv_${id}`, source: 'pixiv', title: String(post.title || post.illust_title || `Artwork #${id}`),
      author: String(post.userName || post.user_name || ''), previewUrl: preview, originalUrl: imageUrl(post.urls?.original) || preview,
      sourceUrl: `https://www.pixiv.net/artworks/${id}`, prompt: '', promptKind: 'reference', tags: artworkTags,
      ...(post.aiType === 2 || post.aiType === '2' ? { aiMark: 'ai' as const } : post.aiType === 1 || post.aiType === '1' ? { aiMark: 'not-ai' as const } : {}),
      score: Number(post.bookmarkCount ?? post.total_bookmarks) || 0,
    }
  }

  private aitagItem(work: Row, firstImage?: Row): InspirationItem | null {
    if (!work || !/^\d+$/u.test(String(work.id))) return null
    const image = firstImage ?? work.first_image ?? work.firstImage
    const imageType = image?.image_type || work.AI_type || work.ai_type
    const authorId = image?.author_id ?? work.userId ?? work.user_id
    const fileName = String(image?.file_name || `${work.id}_p0`).replace(/\.(?:png|jpe?g|webp)$/iu, '')
    const preview = [image?.remote_image_url, work.remote_cover_url, work.remoteFirstImageUrl,
      imageType && authorId ? `https://ai-img.10118899.xyz/${encodeURIComponent(imageType)}/${encodeURIComponent(authorId)}/${encodeURIComponent(fileName)}.webp` : ''].map(imageUrl).find(Boolean)
    return {
      id: `aitag_${work.id}`, source: 'aitag', title: String(work.title || `Artwork #${work.id}`),
      author: String(work.userName || work.user_name || authorId || ''), previewUrl: preview, originalUrl: preview,
      sourceUrl: `https://aitag.win/i/${work.id}`, prompt: '', promptKind: 'original', needsDetail: true,
      tags: tags(work.tags), score: Number(work.total_bookmarks) || 0,
    }
  }

  /** AITag can return fewer than its declared 60 slots. Never pack across page boundaries. */
  private async aitagPage(query: string, limit: number, page: number, signal?: AbortSignal): Promise<{ items: InspirationItem[]; hasMore: boolean }> {
    const size = 60
    const slices = Math.ceil(size / limit)
    const remotePage = Math.floor((page - 1) / slices) + 1
    const start = ((page - 1) % slices) * limit
    const url = new URL('https://aitag.win/api/ai_works_search')
    for (const [key, value] of Object.entries({ page: String(remotePage), page_size: String(size), sort: 'new', time_range: 'all', ...(query ? { q: query } : {}) })) url.searchParams.set(key, value)
    const payload = await this.cachedRead(`aitag-page:${url.href}`, async (sharedSignal) => {
      const result = await this.fetchHttp(url.href, { Referer: 'https://aitag.win/' }, sharedSignal) as Row
      if (result.error === true || result.success === false) throw failure('素材接口拒绝请求，可能需要登录或稍后重试', 'UPSTREAM_ERROR')
      const rows = Array.isArray(result) ? result : result.items ?? result.data ?? result.results
      if (!Array.isArray(rows)) throw failure('AITag 搜索返回结构无法识别', 'INVALID_RESPONSE')
      if (rows.length > size || (result.page_size !== undefined && Number(result.page_size) !== size)
        || (result.page !== undefined && Number(result.page) !== remotePage)) throw failure('AITag 返回了不匹配的分页信息', 'INVALID_RESPONSE')
      return { rows: rows as Row[], total: result.total ?? result.total_count ?? result.count }
    }, signal)
    const rows = payload.rows
    const rawTotal = payload.total
    const total = rawTotal == null ? NaN : Number(rawTotal)
    const more = Number.isFinite(total) && total >= 0 ? remotePage * size < total : rows.length === size
    return {
      items: rows.slice(start, start + limit).map((row) => this.aitagItem(row)).filter((item): item is InspirationItem => !!item),
      hasMore: rows.length > start + limit || more,
    }
  }

  /** Fixed-size Pixiv pages are sliced by absolute offset so no works are skipped. */
  private async fixedPage(query: string, limit: number, page: number, signal?: AbortSignal, pixivAi: PixivAiFilter = 'all'): Promise<{ items: InspirationItem[]; hasMore: boolean }> {
    if (pixivAi === 'exclude' && !query) throw failure('Pixiv 公开 AI 标记筛选需要搜索词，排行榜不提供可靠的作品标记', 'FILTER_REQUIRES_QUERY')
    const size = query ? 60 : 50
    const offset = (page - 1) * limit
    const firstPage = Math.floor(offset / size) + 1
    const start = offset % size
    let rows: Row[] = []
    let more = false
    for (let remotePage = firstPage; remotePage < firstPage + 2 && rows.length < start + limit; remotePage++) {
      let url: URL
      if (query) {
        url = new URL(`https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(query)}`)
        for (const [key, value] of Object.entries({ word: query, p: String(remotePage), mode: 'all', order: 'date_d', s_mode: 's_tag_full', type: 'all', lang: 'zh', ...(pixivAi === 'exclude' ? { ai_type: '1' } : {}) })) url.searchParams.set(key, value)
      } else {
        url = new URL(`https://www.pixiv.net/ranking.php?mode=daily&format=json&p=${remotePage}`)
      }
      const payload = await this.fetchHttp(url.href, { Referer: 'https://www.pixiv.net/' }, signal) as Row
      if (payload.error === true || payload.success === false) throw failure('素材接口拒绝请求，可能需要登录或稍后重试', 'UPSTREAM_ERROR')
      const batch = query ? payload.body?.illustManga?.data : payload.contents
      if (!Array.isArray(batch)) throw failure('素材接口返回结构无法识别', 'INVALID_RESPONSE')
      if (pixivAi === 'exclude' && batch.some((row: Row) => row.aiType !== 1 && row.aiType !== '1')) throw failure('Pixiv 未确认排除 AI 标记筛选，不能将结果视为非 AI 标记作品', 'FILTER_NOT_CONFIRMED')
      rows.push(...batch)
      const total = Number(payload.body?.illustManga?.total)
      more = Number.isFinite(total) ? remotePage * size < total : !query && 'next' in payload ? Boolean(payload.next) : batch.length === size
      if (batch.length > size || (more && batch.length < size)) throw failure('素材接口分页结构不一致，无法可靠定位作品页', 'INVALID_RESPONSE')
      if (!more || batch.length === 0) break
    }
    return { items: rows.slice(start, start + limit).map((row) => this.pixivItem(row)).filter((item): item is InspirationItem => !!item), hasMore: rows.length > start + limit || more }
  }

  private async sourcePage(source: Source, query: string, limit: number, page: number, signal?: AbortSignal, pixivAi: PixivAiFilter = 'all'): Promise<{ items: InspirationItem[]; hasMore: boolean }> {
    if (source === 'aitag') return this.aitagPage(query, limit, page, signal)
    return this.cachedRead(JSON.stringify(['search', source, query, limit, page, pixivAi]), (sharedSignal) => this.loadSourcePage(source, query, limit, page, sharedSignal, pixivAi), signal)
  }

  private async loadSourcePage(source: 'danbooru' | 'pixiv', query: string, limit: number, page: number, signal?: AbortSignal, pixivAi: PixivAiFilter = 'all'): Promise<{ items: InspirationItem[]; hasMore: boolean }> {
    if (source === 'pixiv') return this.fixedPage(query, limit, page, signal, pixivAi)
    const tag = this.normalizeDanbooruTag(query)
    const url = new URL('https://danbooru.donmai.us/posts.json')
    url.searchParams.set('tags', tag || 'order:rank')
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('page', String(page))
    url.searchParams.set('only', DANBOORU_POST_FIELDS)
    const rows = await this.fetchDanbooru(url.href, signal)
    if (!Array.isArray(rows)) throw failure('Danbooru 返回结构无法识别', 'INVALID_RESPONSE')
    return { items: rows.map((row) => this.danbooruItem(row)).filter((item): item is InspirationItem => !!item), hasMore: rows.length === limit }
  }

  async searchDanbooru(query: string, limit = 24, signal?: AbortSignal, page = 1): Promise<InspirationItem[]> { return (await this.sourcePage('danbooru', query, integer(limit, 24, 50), integer(page, 1, 1000), signal)).items }
  async searchPixiv(query: string, limit = 24, signal?: AbortSignal, page = 1): Promise<InspirationItem[]> { return (await this.sourcePage('pixiv', query, integer(limit, 24, 50), integer(page, 1, 1000), signal)).items }
  async searchAITag(query: string, limit = 24, signal?: AbortSignal, page = 1): Promise<InspirationItem[]> { return (await this.sourcePage('aitag', query, integer(limit, 24, 50), integer(page, 1, 1000), signal)).items }

  async search(opts: { query: string; source?: 'all' | Source; limit?: number; page?: number; signal?: AbortSignal; pixivAi?: PixivAiFilter }): Promise<InspirationSearchResult> {
    const query = opts.query.trim().slice(0, 500)
    const pixivAi = opts.pixivAi ?? 'all'
    if (pixivAi !== 'all' && pixivAi !== 'exclude') throw failure('未知的 Pixiv AI 标记筛选', 'INVALID_FILTER')
    const source = opts.source ?? 'all'
    if (source !== 'all' && !SOURCES.includes(source)) throw failure('未知的素材来源', 'INVALID_SOURCE')
    const page = integer(opts.page ?? 1, 1, 1000)
    const limit = integer(opts.limit ?? 24, 24, 50)
    const selected = source === 'all' ? SOURCES : [source]
    const errors: InspirationSearchResult['errors'] = []
    const results = await Promise.all(selected.map(async (src, index) => {
      // Small all-source limits sample each source's page, not a global exhaustive cursor.
      const size = Math.max(1, Math.floor(limit / selected.length) + (index < limit % selected.length ? 1 : 0))
      try { return await this.sourcePage(src, query, size, page, opts.signal, pixivAi) }
      catch (error) {
        if (opts.signal?.aborted) throw opts.signal.reason
        errors.push({ source: src, message: (error as Error).message, code: String((error as any)?.code || 'SOURCE_ERROR') })
        return { items: [], hasMore: false }
      }
    }))
    const items: InspirationItem[] = []
    const seen = new Set<string>()
    for (let index = 0; index < limit; index++) for (const result of results) {
      const item = result.items[index]
      if (item && !seen.has(item.id)) { seen.add(item.id); items.push(item) }
    }
    const visible = items.slice(0, limit)
    return { query, source, total: visible.length, items: visible, page, hasMore: items.length > limit || results.some((result) => result.hasMore), errors }
  }

  async detail(opts: { source: Source; id: string; signal?: AbortSignal }): Promise<InspirationItem> {
    return this.cachedRead(JSON.stringify(['detail', opts.source, opts.id]), (signal) => this.loadDetail({ ...opts, signal }), opts.signal)
  }

  private async loadDetail(opts: { source: Source; id: string; signal?: AbortSignal }): Promise<InspirationItem> {
    if (!SOURCES.includes(opts.source)) throw failure('无效的素材来源或作品编号', 'INVALID_ITEM')
    const rawId = String(opts.id)
    const prefix = `${opts.source}_`
    const id = rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId
    if (!/^\d+$/u.test(id)) throw failure('无效的素材来源或作品编号', 'INVALID_ITEM')
    if (opts.source === 'danbooru') {
      const payload = await this.fetchDanbooru(`https://danbooru.donmai.us/posts/${id}.json`, opts.signal)
      const item = this.danbooruItem(payload as Row)
      if (!item) throw failure('作品详情不可用', 'INVALID_RESPONSE')
      return item
    }
    if (opts.source === 'pixiv') {
      const payload = await this.fetchHttp(`https://www.pixiv.net/ajax/illust/${id}`, { Referer: 'https://www.pixiv.net/' }, opts.signal) as Row
      const item = !payload.error && this.pixivItem(payload.body)
      if (!item) throw failure('Pixiv 作品不可用或需要登录', 'INVALID_RESPONSE')
      return item
    }
    const payload = await this.fetchHttp(`https://aitag.win/api/work/${id}`, { Referer: 'https://aitag.win/' }, opts.signal) as Row
    const images = payload.images ?? payload.work?.images ?? payload.data?.images ?? payload.result?.images
    if (!Array.isArray(images)) throw failure('AITag 作品详情结构无法识别', 'INVALID_RESPONSE')
    const image = [...images].sort((a, b) => String(a.file_name).localeCompare(String(b.file_name), undefined, { numeric: true }))[0] || {}
    const item = this.aitagItem({ ...object(payload.work ?? payload.data?.work ?? payload.result?.work), id }, image)!
    const metadata = object(image.ai_json)
    const comment = object(metadata.Comment ?? metadata.comment)
    const recipe = Object.keys(comment).length ? comment : metadata
    item.prompt = text(recipe.v4_prompt?.caption?.base_caption, recipe.prompt, metadata.v4_prompt?.caption?.base_caption, metadata.prompt, metadata.Description, image.prompt_text)
    item.negativePrompt = text(recipe.v4_negative_prompt?.caption?.base_caption, recipe.uc, recipe.negative_prompt, metadata.uc, metadata.negative_prompt)
    const positive: Row[] = Array.isArray(recipe.v4_prompt?.caption?.char_captions) ? recipe.v4_prompt.caption.char_captions : []
    const negative: Row[] = Array.isArray(recipe.v4_negative_prompt?.caption?.char_captions) ? recipe.v4_negative_prompt.caption.char_captions : []
    item.characters = positive.map((character, index) => {
      const center = character.centers?.[0]
      const located = recipe.v4_prompt?.use_coords === true && typeof center?.x === 'number' && typeof center?.y === 'number'
        && Number.isFinite(center.x) && Number.isFinite(center.y) && center.x >= 0 && center.x <= 1 && center.y >= 0 && center.y <= 1
      return { prompt: text(character.char_caption), negative_prompt: text(negative[index]?.char_caption), ...(located ? { x: center.x, y: center.y } : {}) }
    })
    item.params = Object.fromEntries(['steps', 'scale', 'sampler', 'seed', 'width', 'height'].filter((key) => recipe[key] !== undefined).map((key) => [key, recipe[key]]))
    item.needsDetail = false
    return item
  }
}
