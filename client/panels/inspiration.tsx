/** Real-source artwork search, inspection, and prompt import. */
import type { WorkbenchState } from '../shell.tsx'
import { R, h, Button, Modal, ErrorBox, OkBox, Empty, Select, Spinner } from '../ui.tsx'
import { api, API_BASE, type Rec } from '../api.ts'
import { Icon } from '../icons.tsx'
import { ImagePreview } from '../image.tsx'
import { ShortestColumnMasonry } from '../masonry.tsx'
import { clearPendingDraft } from '../draft-cache.ts'

const SOURCES = [
  { value: 'all', label: '全部来源' },
  { value: 'danbooru', label: 'Danbooru' },
  { value: 'pixiv', label: 'Pixiv' },
  { value: 'aitag', label: 'AITag' },
]
const proxyImage = (url: unknown): string => url ? `${API_BASE}/inspiration/image?url=${encodeURIComponent(String(url))}` : ''

export function InspirationPanel({ state }: { state: WorkbenchState }): Rec {
  const r = R()
  const [source, setSource] = r.useState('all')
  const [query, setQuery] = r.useState('')
  const [inputVal, setInputVal] = r.useState('')
  const [items, setItems] = r.useState<Rec[]>([])
  const [loading, setLoading] = r.useState(false)
  const [error, setError] = r.useState<string | null>(null)
  const [selectedItem, setSelectedItem] = r.useState<Rec | null>(null)
  const [actionMsg, setActionMsg] = r.useState<string | null>(null)
  const [page, setPage] = r.useState(1)
  const [hasMore, setHasMore] = r.useState(false)
  const [sourceErrors, setSourceErrors] = r.useState<Rec[]>([])
  const [detailError, setDetailError] = r.useState<string | null>(null)
  const [detailLoading, setDetailLoading] = r.useState(false)
  const [detailRetry, setDetailRetry] = r.useState(0)
  const [actionBusy, setActionBusy] = r.useState(false)
  const [pixivAi, setPixivAi] = r.useState('all')
  const actionLock = r.useRef(false)
  const loadVersion = r.useRef(0)
  const searchController = r.useRef<AbortController | null>(null)
  const mounted = r.useRef(true)

  const loadData = async (qText = query, src = source, targetPage = page) => {
    const version = ++loadVersion.current
    searchController.current?.abort()
    const controller = new AbortController()
    searchController.current = controller
    setLoading(true)
    setError(null)
    setItems([])
    setHasMore(false)
    setSourceErrors([])
    try {
      const res = await api<Rec>(
        `/inspiration/search?q=${encodeURIComponent(qText)}&source=${encodeURIComponent(src)}&limit=24&page=${targetPage}${(src === 'pixiv' || src === 'all') && pixivAi !== 'all' ? `&pixivAi=${encodeURIComponent(pixivAi)}` : ''}`,
        'GET', undefined, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]),
      )
      if (version === loadVersion.current) {
        if (!Array.isArray(res?.['items'])) throw new Error('素材搜索返回结构无法识别')
        setItems(res['items'])
        setHasMore(Boolean(res['hasMore']))
        setSourceErrors(Array.isArray(res['errors']) ? res['errors'] : [])
      }
    } catch (e) {
      if (version === loadVersion.current && !controller.signal.aborted) setError((e as Error).name === 'TimeoutError' ? '素材搜索超时，请检查代理后重试' : (e as Error).message)
    } finally {
      if (version === loadVersion.current) setLoading(false)
    }
  }

  r.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  r.useEffect(() => {
    void loadData(query, source, page)
    return () => { ++loadVersion.current; searchController.current?.abort() }
  }, [query, source, page, pixivAi])

  r.useEffect(() => {
    setActionMsg(null)
    setDetailError(null)
    if (!selectedItem?.['needsDetail']) { setDetailLoading(false); return }
    const controller = new AbortController()
    setDetailLoading(true)
    void api<Rec>(`/inspiration/detail?source=${encodeURIComponent(String(selectedItem['source']))}&id=${encodeURIComponent(String(selectedItem['id']))}`, 'GET', undefined, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]))
      .then((item) => {
        if (controller.signal.aborted) return
        if (!item || item['id'] !== selectedItem['id'] || item['source'] !== selectedItem['source'] || typeof item['prompt'] !== 'string') throw new Error('作品详情返回结构无法识别')
        setSelectedItem({ ...selectedItem, ...item, needsDetail: false })
      })
      .catch((e: Error) => { if (!controller.signal.aborted) setDetailError(e.name === 'TimeoutError' ? '作品详情读取超时' : e.message) })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false) })
    return () => controller.abort()
  }, [selectedItem?.['id'], detailRetry])

  const search = () => {
    const next = inputVal.trim()
    if (query === next && page === 1) void loadData(next, source, 1)
    else { setQuery(next); setPage(1) }
  }

  const runAction = async (item: Rec, operation: () => Promise<void>) => {
    if (actionLock.current || item['source'] === 'pixiv' || item['promptKind'] === 'reference' || item['needsDetail'] || !String(item['prompt'] || '').trim()) return
    actionLock.current = true
    setActionBusy(true)
    setDetailError(null)
    setActionMsg(null)
    try { await operation() }
    catch (e) { if (mounted.current) setDetailError((e as Error).message) }
    finally { actionLock.current = false; if (mounted.current) setActionBusy(false) }
  }
  const importToWorkspace = (item: Rec) => runAction(item, async () => {
    const draft = state.draft
    if (!draft) throw new Error('当前草稿未就绪')
    const request = structuredClone((draft['request'] ?? {}) as Rec)
    request['prompt'] = String(item['prompt'])
    request['negative_prompt'] = String(item['negativePrompt'] || '')
    request['characters'] = Array.isArray(item['characters']) ? item['characters'].map((character: Rec) => {
      const x = character['x'], y = character['y']
      const located = typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1
      return {
        prompt: String(character['prompt'] || ''), negative_prompt: String(character['negative_prompt'] || ''),
        ...(located ? { x, y } : {}),
      }
    }) : []
    await state.patchDraft({ id: draft['id'], request, operation: 'generate' }, Number(draft['revision']))
    clearPendingDraft(String(draft['id']))
    if (mounted.current) { setSelectedItem(null); state.go?.('create') }
  })
  const saveToLibrary = (item: Rec) => runAction(item, async () => {
    await api('/library', 'POST', {
      name: String(item['title'] || '灵感素材'), kind: 'preset', data: {
        prompt: String(item['prompt']), negative_prompt: String(item['negativePrompt'] || ''),
        characters: Array.isArray(item['characters']) ? item['characters'] : [],
        notes: `${String(item['source']).toUpperCase()} · ${String(item['author'] || '')}\n${String(item['sourceUrl'] || '')}`,
        prompt_sets: [], examples: [],
      },
    })
    if (mounted.current) setActionMsg('已保存到资料库预设')
  })
  const copyReferenceTags = async (item: Rec) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持复制，请选中作品标签复制')
      await navigator.clipboard.writeText((Array.isArray(item['tags']) ? item['tags'] : []).join(', '))
      if (mounted.current) setActionMsg('已复制 Pixiv 原生标签')
    } catch (error) { if (mounted.current) setDetailError((error as Error).message) }
  }
  const isReference = selectedItem?.['source'] === 'pixiv' || selectedItem?.['promptKind'] === 'reference'
  const canImport = !!selectedItem && !isReference && !selectedItem['needsDetail'] && !detailLoading && !!String(selectedItem['prompt'] || '').trim() && !actionBusy

  return h('section', { className: 'nai-inspiration' },
    h('h2', { className: 'nai-section-title' }, '灵感工坊'),
    h('div', { className: 'nai-toolbar', style: { flexWrap: 'wrap', gap: '8px' } },
      Select({ value: source, onChange: (value) => { setSource(value); setPage(1) }, options: SOURCES }),
      source === 'pixiv' || source === 'all' ? h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
        'Pixiv', Select({ value: pixivAi, onChange: (value) => { setPixivAi(value); setPage(1) }, options: [
          { value: 'all', label: '全部作品' }, { value: 'exclude', label: '排除 AI 标记' },
        ] }),
      ) : null,
      h('div', { className: 'nai-search', style: { minWidth: 'min(180px, 100%)', flex: 1 } },
        h(Icon, { name: 'search' }),
        h('input', { 'aria-label': '搜索素材与灵感', placeholder: '搜索标签或作品', value: inputVal,
          onChange: (event: Rec) => setInputVal((event.target as HTMLInputElement).value),
          onKeyDown: (event: Rec) => { if (event.key === 'Enter') { event.preventDefault(); search() } },
        }),
      ),
      Button({ small: true, icon: 'search', onClick: search }, '搜索'),
      Button({ small: true, icon: 'refresh', iconOnly: true, title: '刷新素材', disabled: loading, onClick: () => void loadData() }),
    ),
    ErrorBox({ error }),
    ...sourceErrors.map((entry) => h('div', { key: entry['source'] },
      ErrorBox({ error: `${String(entry['source']).toUpperCase()}: ${String(entry['message'])}` }),
    )),
    error || sourceErrors.some((entry) => !String(entry['code'] || '').startsWith('FILTER_')) ? Button({ small: true, icon: 'settings', kind: 'ghost', onClick: () => state.go?.('settings') }, '网络设置') : null,
    loading ? h('div', { role: 'status', style: { padding: '16px' } }, h(Spinner, null), ' 正在检索素材') : null,
    !loading && !items.length && !error && !sourceErrors.length ? Empty({ text: hasMore ? '本页没有可显示作品' : '没有匹配作品' }) : null,
    h(ShortestColumnMasonry, {
      items, getItemKey: (item: Rec) => String(item['id']), estimateHeight: () => 290,
      renderItem: (item: Rec) => h('div', {
        role: 'button', tabIndex: 0, className: 'nai-lib-card', 'aria-label': String(item['title'] || '素材详情'),
        onKeyDown: (event: Rec) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setSelectedItem(item) } },
        style: { width: '100%', padding: 0, textAlign: 'left', cursor: 'pointer', borderRadius: '8px', overflow: 'hidden', color: 'var(--nai-text)', background: 'var(--nai-panel)', border: '1px solid var(--nai-border-soft)' },
        onClick: () => { setActionMsg(null); setDetailError(null); setSelectedItem(item) },
      },
      item['previewUrl'] ? h(ImagePreview, { src: proxyImage(item['previewUrl']), alt: String(item['title'] || '作品预览'), style: { display: 'flex', width: '100%', height: 'auto', aspectRatio: '3/4', flex: 'none' } })
        : h('div', { style: { aspectRatio: '3/4', display: 'grid', placeItems: 'center' } }, h(Icon, { name: 'image', size: 32 })),
      h('div', { style: { padding: '8px 10px', overflowWrap: 'anywhere' } },
        h('span', { style: { fontSize: '10px', color: 'var(--nai-dim)' } }, String(item['source']).toUpperCase()),
        h('div', { style: { fontWeight: 600, fontSize: '12px', marginTop: '3px' } }, String(item['title'] || '作品')),
        item['author'] ? h('div', { style: { fontSize: '11px', color: 'var(--nai-faint)', marginTop: '2px' } }, String(item['author'])) : null,
      )),
    }),
    h('div', { className: 'nai-toolbar', style: { justifyContent: 'center', marginTop: '16px', gap: '12px' } },
      Button({ icon: 'previous', iconOnly: true, title: '上一页', disabled: loading || page <= 1, onClick: () => setPage(page - 1) }),
      h('span', { 'aria-live': 'polite' }, `第 ${page} 页`),
      Button({ icon: 'next', iconOnly: true, title: '下一页', disabled: loading || !hasMore, onClick: () => setPage(page + 1) }),
    ),
    selectedItem ? h(Modal, {
      title: String(selectedItem['title'] || '素材详情'), onClose: () => { if (!actionLock.current) setSelectedItem(null) },
      footer: null,
      children: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', overflowWrap: 'anywhere' } },
        selectedItem['previewUrl'] ? h(ImagePreview, { src: proxyImage(selectedItem['previewUrl']), alt: String(selectedItem['title'] || '作品预览'), style: { width: '100%', maxHeight: '360px', aspectRatio: '4/3' } }) : null,
        h('div', null, `${String(selectedItem['source']).toUpperCase()}${selectedItem['author'] ? ` · ${String(selectedItem['author'])}` : ''}`),
        selectedItem['source'] === 'pixiv' ? h('div', null, selectedItem['aiMark'] === 'ai' ? '作品标记：AI 生成' : selectedItem['aiMark'] === 'not-ai' ? '作品标记：未标记为 AI（不认证作者身份）' : '作品标记：未知') : null,
        selectedItem['sourceUrl'] ? h('a', { href: String(selectedItem['sourceUrl']), target: '_blank', rel: 'noopener noreferrer' }, '原作品') : null,
        detailLoading ? h('div', { role: 'status' }, h(Spinner, null), ' 正在读取作品提示词') : null,
        ErrorBox({ error: detailError }),
        detailError && selectedItem['needsDetail'] ? Button({ small: true, icon: 'refresh', onClick: () => setDetailRetry(detailRetry + 1) }, '重试详情') : null,
        !detailLoading ? h('div', null,
          h('strong', null, isReference ? 'Pixiv 原生标签（非 Danbooru）' : selectedItem['promptKind'] === 'original' ? '原始提示词' : 'Danbooru 作品标签（非原始配方）'),
          h('pre', { style: { margin: '8px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', userSelect: 'text' } }, isReference ? (Array.isArray(selectedItem['tags']) ? selectedItem['tags'].join(', ') : '') || '作品未提供标签' : String(selectedItem['prompt'] || (selectedItem['needsDetail'] ? '尚未读取详情' : '作品未提供提示词'))),
        ) : null,
        !isReference && selectedItem['negativePrompt'] ? h('div', null, h('strong', null, '负面提示词'), h('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px' } }, String(selectedItem['negativePrompt']))) : null,
        !isReference && Array.isArray(selectedItem['characters']) ? selectedItem['characters'].map((character: Rec, index: number) => h('div', { key: index }, h('strong', null, `角色 ${index + 1}`), h('pre', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px' } }, String(character['prompt'] || '')))) : null,
        OkBox({ text: actionMsg }),
        h('div', { className: 'nai-toolbar', style: { justifyContent: 'flex-end', flexWrap: 'wrap', gap: '8px' } },
          isReference ? Button({ icon: 'copy', disabled: !Array.isArray(selectedItem['tags']) || !selectedItem['tags'].length, onClick: () => void copyReferenceTags(selectedItem) }, '复制原生标签') : [
            Button({ icon: 'library', disabled: !canImport, onClick: () => void saveToLibrary(selectedItem) }, selectedItem['promptKind'] === 'original' ? '保存到资料库预设' : '保存标签预设'),
            Button({ kind: 'primary', icon: 'brush', disabled: !canImport, onClick: () => void importToWorkspace(selectedItem) }, selectedItem['promptKind'] === 'original' ? '导入生图工作台' : '将标签填入草稿'),
          ],
        ),
      ),
    }) : null,
  )
}
