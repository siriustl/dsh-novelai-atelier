import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InspirationEngine } from '../src/workbench/inspiration.ts'
import { VERSION } from '../src/version.ts'

const network = vi.hoisted(() => ({ fetch: vi.fn(), agents: [] as any[], sockets: 0 }))
vi.mock('undici', () => ({
  fetch: network.fetch,
  ProxyAgent: class {
    close = vi.fn(async () => {})
    destroy = vi.fn(async () => {})
    constructor(readonly url: string) { network.agents.push(this) }
  },
}))
vi.mock('../src/workbench/tags.ts', () => ({ loadTagCatalog: () => [{ zh: '测试译词', name: 'translated_tag' }] }))
vi.mock('node:child_process', () => ({ execFile: (...args: any[]) => args.at(-1)(new Error('No system proxy')) }))
vi.mock('node:net', () => ({ connect: ({ port }: { port: number }) => {
  network.sockets++
  const handlers: Record<string, (...args: any[]) => void> = {}
  const socket = { setTimeout: vi.fn(), destroy: vi.fn(), once: (name: string, fn: (...args: any[]) => void) => { handlers[name] = fn; return socket } }
  queueMicrotask(() => port === 7890 ? handlers['connect']?.() : handlers['error']?.(new Error('refused')))
  return socket
} }))
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const danbooru = (id = 1) => ({ id, tag_string_general: 'forest soft_light', tag_string_character: 'character_a', tag_string_artist: 'artist_name', preview_file_url: `https://cdn.donmai.us/preview/${id}.jpg`, file_url: `https://cdn.donmai.us/original/${id}.png`, score: 12 })
const pixiv = (id = 1) => ({ id: String(id), title: `Artwork ${id}`, userName: 'Creator', tags: ['forest', '景色'], url: `https://i.pximg.net/${id}.jpg` })
const aitag = (id = 1) => ({ id, userId: 45, title: `Work ${id}`, tags: '["forest","sky"]', AI_type: 'NAI' })
const engines: InspirationEngine[] = []
const engine = (getProxy: (() => string | null) | undefined = () => 'http://proxy.test:8080') => { const e = new InspirationEngine('unused', getProxy); engines.push(e); return e }

beforeEach(() => { network.fetch.mockReset(); network.agents.length = 0; network.sockets = 0 })
afterEach(async () => { await Promise.all(engines.splice(0).map((e) => e.close())); vi.unstubAllEnvs(); vi.useRealTimers() })

describe('real inspiration sources', () => {
  it('uses actual Pixiv search with its artwork response, never Danbooru', async () => {
    network.fetch.mockResolvedValue(json({ error: false, body: { illustManga: { data: [pixiv(8)], total: 1 } } }))
    const result = await engine().search({ query: '森林 & sky', source: 'pixiv', limit: 24 })
    const url = new URL(network.fetch.mock.calls[0]![0])
    expect(url.hostname).toBe('www.pixiv.net')
    expect(decodeURIComponent(url.pathname)).toBe('/ajax/search/artworks/森林 & sky')
    expect(url.searchParams.get('word')).toBe('森林 & sky')
    expect(result.errors).toEqual([])
    expect(result.items[0]).toMatchObject({ id: 'pixiv_8', source: 'pixiv', prompt: '', promptKind: 'reference', tags: ['forest', '景色'], previewUrl: 'https://i.pximg.net/8.jpg' })
    expect(result.hasMore).toBe(false)
  })

  it('uses the real Pixiv ranking feed for an empty query', async () => {
    network.fetch.mockResolvedValue(json({ contents: [{ illust_id: 10, title: 'Ranked', tags: ['forest'], url: 'https://i.pximg.net/rank.jpg' }], next: false }))
    const result = await engine().search({ query: '', source: 'pixiv' })
    expect(new URL(network.fetch.mock.calls[0]![0]).pathname).toBe('/ranking.php')
    expect(result.items[0]?.id).toBe('pixiv_10')
  })

  it('uses actual AITag search, leaving metadata-dependent prompts unloaded', async () => {
    network.fetch.mockResolvedValue(json({ items: [aitag(12)], total: 1 }))
    const result = await engine().search({ query: 'forest', source: 'aitag' })
    const url = new URL(network.fetch.mock.calls[0]![0])
    expect(url.hostname).toBe('aitag.win')
    expect(url.pathname).toBe('/api/ai_works_search')
    expect(url.searchParams.get('q')).toBe('forest')
    expect(url.searchParams.get('page_size')).toBe('60')
    expect(result.items[0]).toMatchObject({ id: 'aitag_12', previewUrl: 'https://ai-img.10118899.xyz/NAI/45/12_p0.webp', prompt: '', needsDetail: true, tags: ['forest', 'sky'] })
  })

  it('includes all three sources and keeps genuine successes when one is blocked', async () => {
    network.fetch.mockImplementation(async (url: string) => url.includes('danbooru') ? new Response('<html>challenge</html>', { status: 403 }) : url.includes('aitag') ? json({ items: [aitag(20)], total: 1 }) : json({ contents: [pixiv(21)], next: false }))
    const result = await engine().search({ query: '', source: 'all' })
    expect(result.items.map((item) => item.source)).toEqual(['pixiv', 'aitag'])
    expect(result.errors).toEqual([{ source: 'danbooru', code: 'HTTP_403', message: expect.stringContaining('HTTP 403') }])
  })

  it.each([1, 2])('probes all sources and caps combined results when limit=%s', async (limit) => {
    network.fetch.mockImplementation(async (url: string) => url.includes('danbooru') ? json([danbooru(10)]) : url.includes('aitag') ? json({ items: [aitag(20)], total: 1 }) : json({ contents: [pixiv(30)], next: false }))
    const result = await engine().search({ query: '', source: 'all', limit })
    expect(network.fetch).toHaveBeenCalledTimes(3)
    expect(new Set(network.fetch.mock.calls.map(([url]) => new URL(url).hostname))).toEqual(new Set(['danbooru.donmai.us', 'www.pixiv.net', 'aitag.win']))
    expect(result.items).toHaveLength(limit)
    expect(result.total).toBe(limit)
    expect(result.errors).toEqual([])
  })

  it.each([1, 2])('keeps healthy sources available at low limit=%s when Danbooru is blocked', async (limit) => {
    network.fetch.mockImplementation(async (url: string) => url.includes('danbooru') ? new Response('blocked', { status: 403 }) : url.includes('aitag') ? json({ items: [aitag(20)], total: 1 }) : json({ contents: [pixiv(30)], next: false }))
    const result = await engine().search({ query: '', source: 'all', limit })
    expect(network.fetch).toHaveBeenCalledTimes(3)
    expect(result.items).toHaveLength(limit)
    expect(result.items[0]?.source).toBe('pixiv')
    expect(result.errors[0]?.code).toBe('HTTP_403')
  })

  it.each([1, 2])('reports real truncated items as hasMore even when upstreams end (limit=%s)', async (limit) => {
    const e = engine()
    vi.spyOn(e as any, 'sourcePage').mockImplementation(async (...args: unknown[]) => ({ items: [{ id: `${args[0]}_1`, source: args[0], prompt: 'forest' }], hasMore: false }))
    const result = await e.search({ query: 'forest', source: 'all', limit })
    expect(result.items).toHaveLength(limit)
    expect(result.hasMore).toBe(true)
    expect(result.total).toBe(limit)
  })

  it('defines low-limit pages as stable per-source samples, not rotating global offsets', async () => {
    const e = engine()
    const fetchPage = vi.spyOn(e as any, 'sourcePage').mockResolvedValue({ items: [], hasMore: false })
    await e.search({ query: 'forest', source: 'all', limit: 1, page: 4 })
    expect(fetchPage.mock.calls.map((call) => call.slice(0, 4))).toEqual([
      ['danbooru', 'forest', 1, 4], ['pixiv', 'forest', 1, 4], ['aitag', 'forest', 1, 4],
    ])
  })

  it('reports total failure and never substitutes curated or unrelated works', async () => {
    network.fetch.mockResolvedValue(new Response('blocked', { status: 403 }))
    const result = await engine().search({ query: 'nothing', source: 'all' })
    expect(result.items).toEqual([])
    expect(result.errors).toHaveLength(3)
  })

  it('identifies this client to Danbooru instead of impersonating a browser', async () => {
    network.fetch.mockResolvedValue(json([danbooru(11)]))
    await engine().search({ query: 'forest', source: 'danbooru' })
    const headers = network.fetch.mock.calls[0]![1].headers
    expect(headers['User-Agent']).toBe(`dsh-novelai-atelier/${VERSION} (NovelAI Atelier)`)
    expect(headers['User-Agent']).not.toMatch(/Mozilla|Chrome/u)
  })

  it('distinguishes an explicit Cloudflare challenge from an ordinary 403', async () => {
    network.fetch.mockResolvedValue(new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } }))
    const result = await engine().search({ query: 'forest', source: 'danbooru' })
    expect(result.errors[0]).toMatchObject({ source: 'danbooru', code: 'DANBOORU_CHALLENGE' })
    expect(result.errors[0]?.message).toContain('不会复用浏览器会话')
  })

  it('keeps Danbooru artist/character/general tags attributed to Danbooru', async () => {
    network.fetch.mockResolvedValue(json([danbooru()]))
    const result = await engine().search({ query: '星空 测试译词', source: 'danbooru', page: 2, limit: 10 })
    const url = new URL(network.fetch.mock.calls[0]![0])
    expect(url.searchParams.get('tags')).toBe('starry_sky translated_tag')
    expect(url.searchParams.get('page')).toBe('2')
    expect(result.items[0]).toMatchObject({ author: 'artist name', source: 'danbooru', prompt: 'character a, forest, soft light', promptKind: 'tags' })
  })

  it('never discards unknown non-English search text in favor of popular posts', async () => {
    network.fetch.mockResolvedValue(json([]))
    await engine().search({ query: '未知关键词', source: 'danbooru' })
    expect(new URL(network.fetch.mock.calls[0]![0]).searchParams.get('tags')).toBe('未知关键词')
  })

  it('does not silently discard the third Danbooru search tag', async () => {
    const result = await engine().search({ query: 'forest sky rain', source: 'danbooru' })
    expect(result.errors[0]?.code).toBe('QUERY_LIMIT')
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it.each(['pixiv'] as const)('slices fixed upstream pages without skipping boundary items (%s)', async (source) => {
    network.fetch.mockImplementation(async (value: string) => {
      const url = new URL(value)
      const page = Number(url.searchParams.get(source === 'pixiv' ? 'p' : 'page'))
      const data = Array.from({ length: 60 }, (_, index) => source === 'pixiv' ? pixiv((page - 1) * 60 + index + 1) : aitag((page - 1) * 60 + index + 1))
      return json(source === 'pixiv' ? { body: { illustManga: { data, total: 120 } } } : { items: data, total: 120 })
    })
    const e = engine()
    const result = await e.search({ query: 'forest', source, page: 3, limit: 24 })
    expect(result.items).toHaveLength(24)
    expect(result.items[0]?.id).toBe(`${source}_49`)
    expect(result.items.at(-1)?.id).toBe(`${source}_72`)
    expect(network.fetch).toHaveBeenCalledTimes(2)
    const last = await e.search({ query: 'forest', source, page: 5, limit: 24 })
    expect(last.items.at(-1)?.id).toBe(`${source}_120`)
    expect(last.hasMore).toBe(false)
  })

  it.each(['pixiv'] as const)('rejects a short nonterminal upstream page immediately (%s)', async (source) => {
    network.fetch.mockResolvedValue(json(source === 'pixiv' ? { body: { illustManga: { data: [pixiv(1)], total: 1000 } } } : { items: [aitag(1)], total: 1000 }))
    const result = await engine().search({ query: 'forest', source, limit: 24 })
    expect(result.errors[0]?.code).toBe('INVALID_RESPONSE')
    expect(result.items).toEqual([])
    expect(network.fetch).toHaveBeenCalledOnce()
  })

  it.each(['pixiv'] as const)('rejects an empty page that still advertises more results (%s)', async (source) => {
    network.fetch.mockResolvedValue(json(source === 'pixiv' ? { body: { illustManga: { data: [], total: 1000 } } } : { items: [], total: 1000 }))
    const result = await engine().search({ query: 'forest', source, limit: 24 })
    expect(result.errors[0]?.code).toBe('INVALID_RESPONSE')
    expect(network.fetch).toHaveBeenCalledOnce()
  })

  it.each(['pixiv'] as const)('never reads a third page when the crossing page has inconsistent size (%s)', async (source) => {
    network.fetch.mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get(source === 'pixiv' ? 'p' : 'page'))
      const data = Array.from({ length: page === 1 ? 60 : 1 }, (_, index) => source === 'pixiv' ? pixiv((page - 1) * 60 + index + 1) : aitag((page - 1) * 60 + index + 1))
      return json(source === 'pixiv' ? { body: { illustManga: { data, total: 1000 } } } : { items: data, total: 1000 })
    })
    const result = await engine().search({ query: 'forest', source, limit: 24, page: 3 })
    expect(result.errors[0]?.code).toBe('INVALID_RESPONSE')
    expect(network.fetch).toHaveBeenCalledTimes(2)
  })

  it.each([1, 8, 24, 50])('traverses sparse AITag pages without skipped or duplicate works (limit=%s)', async (limit) => {
    const batches = [Array.from({ length: 59 }, (_, index) => aitag(index + 1)), Array.from({ length: 59 }, (_, index) => aitag(index + 61)), [aitag(121)]]
    network.fetch.mockImplementation(async (value: string) => {
      const url = new URL(value)
      const page = Number(url.searchParams.get('page'))
      expect(url.searchParams.get('page_size')).toBe('60')
      return json({ page, page_size: 60, total: 121, items: batches[page - 1] ?? [] })
    })
    const e = engine(), ids: string[] = []
    let hasMore = true, page = 1
    while (hasMore && page <= 121) {
      const result = await e.search({ query: '', source: 'aitag', limit, page })
      expect(result.errors).toEqual([])
      expect(result.items.length).toBeLessThanOrEqual(limit)
      ids.push(...result.items.map((item) => item.id))
      hasMore = result.hasMore
      page++
    }
    expect(hasMore).toBe(false)
    expect(ids).toEqual(batches.flat().map((work) => `aitag_${work.id}`))
    expect(new Set(ids).size).toBe(ids.length)
    expect(network.fetch).toHaveBeenCalledTimes(3)
  })

  it('allows empty AITag subpages to advance to a populated upstream page', async () => {
    network.fetch.mockImplementation(async (value: string) => {
      const page = Number(new URL(value).searchParams.get('page'))
      return json({ page, page_size: 60, total: 61, items: page === 1 ? [] : [aitag(61)] })
    })
    const e = engine()
    for (const page of [1, 2, 3]) {
      const result = await e.search({ query: '', source: 'aitag', limit: 24, page })
      expect(result).toMatchObject({ items: [], hasMore: true, errors: [] })
    }
    expect(await e.search({ query: '', source: 'aitag', limit: 24, page: 4 })).toMatchObject({ items: [{ id: 'aitag_61' }], hasMore: false, errors: [] })
  })

  it.each([
    { page: 2, page_size: 60, items: [aitag()] },
    { page: 1, page_size: 24, items: [aitag()] },
    { page: 1, page_size: 60, items: Array.from({ length: 61 }, (_, index) => aitag(index + 1)) },
  ])('rejects incompatible AITag page metadata rather than guessing (%j)', async (payload) => {
    network.fetch.mockResolvedValue(json({ ...payload, total: 1000 }))
    const result = await engine().search({ query: '', source: 'aitag' })
    expect(result.errors[0]?.code).toBe('INVALID_RESPONSE')
    expect(result.items).toEqual([])
  })

  it('ends AITag paging on the final sparse local slice', async () => {
    network.fetch.mockResolvedValue(json({ page: 1, page_size: 60, total: 59, items: Array.from({ length: 59 }, (_, index) => aitag(index + 1)) }))
    const e = engine()
    expect(await e.search({ query: '', source: 'aitag', page: 2 })).toMatchObject({ hasMore: true, errors: [] })
    const last = await e.search({ query: '', source: 'aitag', page: 3 })
    expect(last.items).toHaveLength(11)
    expect(last.items[0]?.id).toBe('aitag_49')
    expect(last.items.at(-1)?.id).toBe('aitag_59')
    expect(last.hasMore).toBe(false)
  })

  it('uses verified ai_type=1 for Pixiv search and preserves the source marking', async () => {
    network.fetch.mockResolvedValue(json({ body: { illustManga: { data: [{ ...pixiv(1), aiType: 1 }], total: 1 } } }))
    const result = await engine().search({ query: 'forest', source: 'pixiv', pixivAi: 'exclude' })
    expect(new URL(network.fetch.mock.calls[0]![0]).searchParams.get('ai_type')).toBe('1')
    expect(result.errors).toEqual([])
    expect(result.items[0]).toMatchObject({ prompt: '', promptKind: 'reference', aiMark: 'not-ai' })
  })

  it('applies Pixiv exclusion without filtering the other real sources', async () => {
    network.fetch.mockImplementation(async (value: string) => {
      const url = new URL(value)
      if (url.hostname === 'www.pixiv.net') {
        expect(url.searchParams.get('ai_type')).toBe('1')
        return json({ body: { illustManga: { data: [{ ...pixiv(1), aiType: 1 }], total: 1 } } })
      }
      expect(url.searchParams.has('ai_type')).toBe(false)
      return url.hostname === 'aitag.win' ? json({ items: [aitag(1)], total: 1 }) : json([danbooru(1)])
    })
    const result = await engine().search({ query: 'forest', source: 'all', pixivAi: 'exclude' })
    expect(result.errors).toEqual([])
    expect(result.items.map((item) => item.source)).toEqual(['danbooru', 'pixiv', 'aitag'])
  })

  it.each([2, undefined, 0])('fails explicitly when Pixiv does not confirm AI exclusion (%s)', async (aiType) => {
    network.fetch.mockResolvedValue(json({ body: { illustManga: { data: [{ ...pixiv(1), aiType }], total: 1 } } }))
    const result = await engine().search({ query: 'forest', source: 'pixiv', pixivAi: 'exclude' })
    expect(result.items).toEqual([])
    expect(result.errors[0]?.code).toBe('FILTER_NOT_CONFIRMED')
  })

  it('does not classify an unmarked ranking as a human artist feed', async () => {
    const result = await engine().search({ query: '', source: 'pixiv', pixivAi: 'exclude' })
    expect(result.items).toEqual([])
    expect(result.errors[0]?.code).toBe('FILTER_REQUIRES_QUERY')
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('validates Pixiv filters before networking and never requests unsupported AI-only search', async () => {
    await expect(engine().search({ query: 'forest', source: 'pixiv', pixivAi: 'only' as any })).rejects.toMatchObject({ code: 'INVALID_FILTER' })
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('preserves AI markings in Pixiv detail without manufacturing a prompt recipe', async () => {
    network.fetch.mockResolvedValue(json({ error: false, body: { ...pixiv(1), aiType: 2 } }))
    const item = await engine().detail({ source: 'pixiv', id: '1' })
    expect(item).toMatchObject({ prompt: '', promptKind: 'reference', tags: ['forest', '景色'], aiMark: 'ai' })
  })

  it('caps ranking requests at the public limit of 50 so consecutive pages never need three upstream pages', async () => {
    network.fetch.mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get('p'))
      return json({ contents: Array.from({ length: 50 }, (_, index) => pixiv((page - 1) * 50 + index + 1)), next: page + 1 })
    })
    const e = engine()
    const first = await e.search({ query: '', source: 'pixiv', limit: 60 })
    const second = await e.search({ query: '', source: 'pixiv', limit: 60, page: 2 })
    expect(first.items).toHaveLength(50)
    expect(second.items).toHaveLength(50)
    expect(first.items[0]?.id).toBe('pixiv_1')
    expect(first.items.at(-1)?.id).toBe('pixiv_50')
    expect(second.items[0]?.id).toBe('pixiv_51')
    expect(second.items.at(-1)?.id).toBe('pixiv_100')
    expect(network.fetch).toHaveBeenCalledTimes(2)
    const direct = await e.searchPixiv('', 60, undefined, 3)
    expect(direct).toHaveLength(50)
    expect(direct[0]?.id).toBe('pixiv_101')
    expect(network.fetch).toHaveBeenCalledTimes(3)
  })

  it('rejects a short ranking page with an explicit next-page marker', async () => {
    network.fetch.mockResolvedValue(json({ contents: [pixiv(1)], next: 2 }))
    const result = await engine().search({ query: '', source: 'pixiv', limit: 24 })
    expect(result.errors[0]?.code).toBe('INVALID_RESPONSE')
    expect(network.fetch).toHaveBeenCalledOnce()
  })

  it('rejects invalid sources and clamps non-finite paging inputs', async () => {
    const e = engine()
    await expect(e.search({ query: '', source: 'codex' as any })).rejects.toThrow('未知')
    network.fetch.mockResolvedValue(json([]))
    const result = await e.search({ query: '', source: 'danbooru', limit: Number.NaN, page: Infinity })
    expect(result.page).toBe(1)
    expect(new URL(network.fetch.mock.calls[0]![0]).searchParams.get('limit')).toBe('24')
  })
})

describe('AITag actual metadata detail', () => {
  it('parses Comment JSON, V4 base/negative prompts and positioned characters', async () => {
    const recipe = { v4_prompt: { use_coords: true, caption: { base_caption: 'forest, sunlight', char_captions: [{ char_caption: 'traveler', centers: [{ x: 0.2, y: 0.7 }] }] } }, v4_negative_prompt: { caption: { base_caption: 'blur', char_captions: [{ char_caption: 'bad hands' }] } }, steps: 28 }
    network.fetch.mockResolvedValue(json({ work: aitag(8), images: [{ file_name: '8_p0', author_id: 45, image_type: 'NAI', ai_json: JSON.stringify({ Comment: JSON.stringify(recipe) }) }] }))
    const item = await engine().detail({ source: 'aitag', id: 'aitag_8' })
    expect(new URL(network.fetch.mock.calls[0]![0]).pathname).toBe('/api/work/8')
    expect(item).toMatchObject({ id: 'aitag_8', prompt: 'forest, sunlight', negativePrompt: 'blur', needsDetail: false, params: { steps: 28 }, characters: [{ prompt: 'traveler', negative_prompt: 'bad hands', x: 0.2, y: 0.7 }] })
  })

  it.each([
    { use_coords: false, centers: [{ x: 0.2, y: 0.7 }] },
    { use_coords: undefined, centers: [{ x: 0.2, y: 0.7 }] },
    { use_coords: true, centers: [] },
    { use_coords: true, centers: [{ x: 0.2 }] },
    { use_coords: true, centers: [{ x: 2, y: 0.7 }] },
  ])('keeps unpositioned characters free of invented coordinates (%j)', async ({ use_coords, centers }) => {
    network.fetch.mockResolvedValue(json({ work: aitag(8), images: [{ ai_json: { v4_prompt: { use_coords, caption: { base_caption: 'forest', char_captions: [{ char_caption: 'traveler', centers }] } } } }] }))
    const item = await engine().detail({ source: 'aitag', id: '8' })
    expect(item.characters).toEqual([{ prompt: 'traveler', negative_prompt: '' }])
  })

  it('does not invent a prompt when the real work has no metadata', async () => {
    network.fetch.mockResolvedValue(json({ work: aitag(), images: [] }))
    expect(await engine().detail({ source: 'aitag', id: '1' })).toMatchObject({ prompt: '', needsDetail: false })
  })

  it.each(['[', '(a+)+$', 'danbooru|pixiv'])('rejects invalid detail sources before interpreting identifiers (%s)', async (source) => {
    await expect(engine().detail({ source: source as any, id: 'a'.repeat(100) })).rejects.toMatchObject({ code: 'INVALID_ITEM' })
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('accepts only the selected source literal identifier prefix', async () => {
    await expect(engine().detail({ source: 'aitag', id: 'pixiv_1' })).rejects.toMatchObject({ code: 'INVALID_ITEM' })
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('validates detail identifiers before any network request', async () => {
    await expect(engine().detail({ source: 'aitag', id: '../secret' })).rejects.toThrow('无效')
    expect(network.fetch).not.toHaveBeenCalled()
  })
})

describe('network lifecycle and error contracts', () => {
  it('presents non-JSON challenge pages and network timeouts, not empty success', async () => {
    const e = engine()
    network.fetch.mockResolvedValueOnce(new Response('<html>challenge</html>'))
    expect((await e.search({ query: '', source: 'danbooru' })).errors[0]?.code).toBe('INVALID_RESPONSE')
    network.fetch.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }))
    expect((await e.search({ query: '', source: 'pixiv' })).errors[0]?.code).toBe('TIMEOUT')
  })

  it('honors caller cancellation rather than reporting a no-results response', async () => {
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    await expect(engine().search({ query: '', source: 'all', signal: abort.signal })).rejects.toThrow('cancelled')
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('rejects an invalid proxy without exposing its credentials', async () => {
    const result = await engine(() => 'socks5://user:private-password@localhost:1080').search({ query: '', source: 'danbooru' })
    expect(result.errors[0]?.code).toBe('PROXY_CONFIG')
    expect(JSON.stringify(result)).not.toContain('private-password')
  })

  it('reuses one dispatcher, gracefully rotates settings, and recreates after stop', async () => {
    let proxy = 'http://proxy-a:8080'
    const e = engine(() => proxy)
    network.fetch.mockImplementation(async () => json([]))
    await Promise.all([e.searchDanbooru('', 2), e.searchDanbooru('', 2)])
    expect(network.agents).toHaveLength(1)
    proxy = 'http://proxy-b:8080'
    await e.searchDanbooru('', 2)
    expect(network.agents[0].close).toHaveBeenCalledOnce()
    await e.close()
    expect(network.agents[1].destroy).toHaveBeenCalledOnce()
    await e.searchDanbooru('', 2)
    expect(network.agents).toHaveLength(3)
  })

  it('does not reopen a dispatcher when stopped during automatic proxy discovery', async () => {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) vi.stubEnv(name, '')
    const e = engine(() => null)
    network.fetch.mockImplementation(async () => json([]))
    const pending = e.search({ query: '', source: 'danbooru' })
    await e.close()
    expect((await pending).errors[0]?.code).toBe('CLOSED')
    expect(network.agents).toHaveLength(0)
    await e.searchDanbooru('', 2)
    expect(network.agents).toHaveLength(1)
  })

  it('discovers a live local proxy once across concurrent searches and caches it', async () => {
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) vi.stubEnv(name, '')
    const e = engine(() => null)
    network.fetch.mockImplementation(async () => json([]))
    await Promise.all([e.searchDanbooru('', 2), e.searchDanbooru('', 2), e.searchDanbooru('', 2)])
    expect(network.agents).toHaveLength(1)
    expect(network.agents[0].url).toBe('http://127.0.0.1:7890')
    expect(network.sockets).toBe(10)
    await e.searchDanbooru('', 2)
    expect(network.sockets).toBe(10)
  })
})

describe('bounded inspiration cache', () => {
  it('shares successful searches while allowing one caller to cancel independently', async () => {
    let resolve!: (response: Response) => void
    network.fetch.mockReturnValue(new Promise<Response>((done) => { resolve = done }))
    const e = engine(), controller = new AbortController()
    const first = e.search({ source: 'danbooru', query: 'forest', signal: controller.signal })
    const second = e.search({ source: 'danbooru', query: 'forest' })
    controller.abort(new Error('caller cancelled'))
    await expect(first).rejects.toThrow('caller cancelled')
    expect(network.fetch).toHaveBeenCalledOnce()
    expect(network.fetch.mock.calls[0]![1].signal.aborted).toBe(false)
    resolve(json([danbooru(1)]))
    const result = await second
    result.items[0]!.prompt = 'mutated by caller'
    const cached = await e.search({ source: 'danbooru', query: 'forest' })
    expect(cached.items[0]?.prompt).toBe('character a, forest, soft light')
    expect(network.fetch).toHaveBeenCalledOnce()
  })

  it('shares validated details and does not let a cancelled caller abort its peer', async () => {
    let resolve!: (response: Response) => void
    network.fetch.mockReturnValue(new Promise<Response>((done) => { resolve = done }))
    const e = engine(), controller = new AbortController()
    const first = e.detail({ source: 'aitag', id: '1', signal: controller.signal })
    const second = e.detail({ source: 'aitag', id: '1' })
    controller.abort(new Error('detail cancelled'))
    await expect(first).rejects.toThrow('detail cancelled')
    resolve(json({ work: aitag(1), images: [{ ai_json: { prompt: 'real original' } }] }))
    expect(await second).toMatchObject({ prompt: 'real original' })
    expect(await e.detail({ source: 'aitag', id: '1' })).toMatchObject({ prompt: 'real original' })
    expect(network.fetch).toHaveBeenCalledOnce()
  })

  it('never caches HTTP, shape, or filter failures as successful results', async () => {
    network.fetch.mockResolvedValueOnce(new Response('blocked', { status: 403 }))
      .mockResolvedValueOnce(json({ items: 'invalid' }))
      .mockResolvedValueOnce(json({ items: [aitag(1)], total: 1, page_size: 60, page: 1 }))
    const e = engine()
    expect((await e.search({ source: 'aitag', query: '' })).errors[0]?.code).toBe('HTTP_403')
    expect((await e.search({ source: 'aitag', query: '' })).errors[0]?.code).toBe('INVALID_RESPONSE')
    expect((await e.search({ source: 'aitag', query: '' })).errors).toEqual([])
    expect(network.fetch).toHaveBeenCalledTimes(3)
  })

  it('never caches an unconfirmed Pixiv filter result', async () => {
    network.fetch.mockResolvedValueOnce(json({ body: { illustManga: { data: [{ ...pixiv(1), aiType: 2 }], total: 1 } } }))
      .mockResolvedValueOnce(json({ body: { illustManga: { data: [{ ...pixiv(2), aiType: 1 }], total: 1 } } }))
    const e = engine()
    expect((await e.search({ source: 'pixiv', query: 'forest', pixivAi: 'exclude' })).errors[0]?.code).toBe('FILTER_NOT_CONFIRMED')
    expect((await e.search({ source: 'pixiv', query: 'forest', pixivAi: 'exclude' })).items[0]?.id).toBe('pixiv_2')
    expect(network.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retain individual cache values over two MiB', async () => {
    network.fetch.mockImplementation(async () => json([{ ...danbooru(1), tag_string_general: 'x'.repeat(1_100_000) }]))
    const e = engine()
    await e.searchDanbooru('forest')
    await e.searchDanbooru('forest')
    expect((e as any).responseCache.size).toBe(0)
    expect((e as any).cacheBytes).toBe(0)
    expect(network.fetch).toHaveBeenCalledTimes(2)
  })

  it('expires successful responses after thirty seconds and clears them at stop', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    network.fetch.mockImplementation(async () => json([danbooru(network.fetch.mock.calls.length)]))
    const e = engine()
    expect((await e.searchDanbooru('forest'))[0]?.id).toBe('danbooru_1')
    expect((await e.searchDanbooru('forest'))[0]?.id).toBe('danbooru_1')
    vi.setSystemTime(1_030_001)
    expect((await e.searchDanbooru('forest'))[0]?.id).toBe('danbooru_2')
    await e.close()
    expect((await e.searchDanbooru('forest'))[0]?.id).toBe('danbooru_3')
  })

  it('bounds retained cache entries and byte size', async () => {
    const e = engine()
    for (let index = 0; index < 40; index++) await (e as any).cachedRead(`query${index}`, async () => ({ id: index }))
    expect((e as any).responseCache.size).toBe(32)
    for (let index = 0; index < 12; index++) await (e as any).cachedRead(`large${index}`, async () => ({ text: 'x'.repeat(900_000) }))
    expect((e as any).responseCache.size).toBeLessThanOrEqual(32)
    expect((e as any).cacheBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
  })
})

describe('image proxy boundary', () => {
  it.each(['http://i.pximg.net/a.jpg', 'https://evil.test/a.jpg', 'https://i.pximg.net:444/a.jpg', 'https://user:password@i.pximg.net/a.jpg'])('rejects unsafe image URL %s', async (url) => {
    await expect(engine().fetchImage(url)).rejects.toThrow('不允许')
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('blocks redirects to a private host before sending a second request', async () => {
    network.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } }))
    await expect(engine().fetchImage('https://i.pximg.net/a.jpg')).rejects.toThrow('重定向')
    expect(network.fetch).toHaveBeenCalledOnce()
  })

  it('uses the application identity for Danbooru CDN images', async () => {
    network.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } }))
    await engine().fetchImage('https://cdn.donmai.us/preview/example.jpg')
    const headers = network.fetch.mock.calls[0]![1].headers
    expect(headers['User-Agent']).toBe(`dsh-novelai-atelier/${VERSION} (NovelAI Atelier)`)
    expect(headers.Referer).toBe('https://danbooru.donmai.us/')
    expect(headers.Accept).toContain('image/')
  })

  it('sends the correct source referer and preserves the actual image type', async () => {
    network.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/webp; charset=binary' } }))
    const image = await engine().fetchImage('https://ai-img.10118899.xyz/NAI/1/2_p0.webp')
    expect(image.contentType).toBe('image/webp')
    expect(image.buffer.length).toBe(3)
    expect(network.fetch.mock.calls[0]![1].headers.Referer).toBe('https://aitag.win/')
  })

  it('does not proxy HTML or SVG as executable content', async () => {
    network.fetch.mockResolvedValue(new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }))
    await expect(engine().fetchImage('https://i.pximg.net/a.jpg')).rejects.toThrow('图片内容')
  })

  it('rejects oversized images before allocating their declared length', async () => {
    network.fetch.mockResolvedValue(new Response('tiny', { headers: { 'Content-Type': 'image/png', 'Content-Length': String(21 * 1024 * 1024) } }))
    await expect(engine().fetchImage('https://i.pximg.net/a.jpg')).rejects.toThrow('大小限制')
  })
})
