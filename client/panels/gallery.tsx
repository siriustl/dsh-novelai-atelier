/** Gallery: paginated job results with preview, favorite/archive and filters. */
import type { WorkbenchState } from '../shell.tsx'
import { R, h, Button, Card, Modal, ErrorBox, Empty, Select, Toggle, Spinner, keyboardActivate } from '../ui.tsx'
import { api, assetUrl, assetThumb, fileUrl, downloadPost, downloadUrl, type Rec } from '../api.ts'
import { Icon } from '../icons.tsx'
import { ImagePreview } from '../image.tsx'
import { operationLabel } from '../format.ts'

export function GalleryPanel({ state }: { state: WorkbenchState }): Rec {
  const r = R()
  const [items, setItems] = r.useState<Rec[]>([])
  const [total, setTotal] = r.useState(0)
  const [offset, setOffset] = r.useState(0)
  const [query, setQuery] = r.useState('')
  const [queryInput, setQueryInput] = r.useState('')
  const [favorite, setFavorite] = r.useState(false)
  const [archived, setArchived] = r.useState(false)
  const [status, setStatus] = r.useState('')
  const [error, setError] = r.useState<string | null>(null)
  const [preview, setPreview] = r.useState<Rec | null>(null)
  const [loading, setLoading] = r.useState(true)
  const [selected, setSelected] = r.useState<Set<string>>(() => new Set())
  const [density, setDensity] = r.useState('normal')
  const [actionBusy, setActionBusy] = r.useState(false)
  const mutating = r.useRef(false)
  const latestFilters = r.useRef('')
  latestFilters.current = new URLSearchParams({ query, offset: String(offset), limit: '48', favorite: String(favorite), archived: String(archived), status }).toString()
  const limit = 48
  const loadVersion = r.useRef(0)

  // Debounced search: only hit the API 300ms after the user stops typing.
  r.useEffect(() => {
    if (queryInput === query) return
    const t = setTimeout(() => { setQuery(queryInput); setOffset(0) }, 300)
    return () => clearTimeout(t)
  }, [queryInput, query])

  const load = async (): Promise<void> => {
    const version = ++loadVersion.current
    const filters = latestFilters.current
    setLoading(true)
    try {
      const result = await api<Rec>('/gallery?' + filters)
      if (version !== loadVersion.current || filters !== latestFilters.current) return
      const resultTotal = Number(result['total'] ?? 0)
      const requestedOffset = Number(new URLSearchParams(filters).get('offset'))
      if (requestedOffset > 0 && requestedOffset >= resultTotal) {
        setOffset(Math.max(0, Math.floor((resultTotal - 1) / limit) * limit))
        return
      }
      const rows = (result['items'] ?? []) as Rec[]
      setItems(rows)
      setPreview((current) => current ? rows.find((row) => row['id'] === current['id']) ?? current : null)
      setTotal(Number(result['total'] ?? 0))
      setError(null)
    } catch (e) { if (version === loadVersion.current) setError((e as Error).message) } finally { if (version === loadVersion.current) setLoading(false) }
  }

  R().useEffect(() => { void load() }, [offset, query, favorite, archived, status])
  R().useEffect(() => {
    const timer = setInterval(() => { void load() }, 6000)
    return () => clearInterval(timer)
  }, [offset, query, favorite, archived, status])

  r.useEffect(() => { setSelected(new Set()) }, [query, favorite, archived, status])
  const previewVersion = r.useRef(0)
  const openPreview = (job: Rec): void => { previewVersion.current++; setPreview(job) }
  const closePreview = (): void => { previewVersion.current++; setPreview(null) }
  r.useEffect(() => {
    if (!state.focusJobId) return
    const version = ++previewVersion.current
    const controller = new AbortController()
    void api<Rec>(`/jobs/${encodeURIComponent(state.focusJobId)}`, 'GET', undefined, undefined, controller.signal)
      .then((job) => { if (!controller.signal.aborted && version === previewVersion.current) setPreview(job) })
      .catch((e) => { if (!controller.signal.aborted && version === previewVersion.current) setError((e as Error).message) })
    return () => controller.abort()
  }, [state.focusJobId])

  const curate = async (ids: string[], patch: Rec): Promise<void> => {
    if (mutating.current) return
    mutating.current = true
    setActionBusy(true)
    try {
      await api('/gallery/curate', 'POST', { ids, ...patch })
      // Keep the open preview in sync so favorite/archive buttons don't go stale.
      setPreview((p) => (p && ids.includes(String(p['id'])) ? { ...p, ...patch } : p))
      await load()
      setSelected(new Set())
    } catch (e) { setError((e as Error).message) } finally { mutating.current = false; setActionBusy(false) }
  }
  const exportSelected = async (): Promise<void> => {
    if (mutating.current || !selected.size) return
    mutating.current = true; setActionBusy(true)
    try { await downloadPost('/gallery/export', { ids: [...selected] }, 'atelier-artworks.zip') }
    catch (e) { setError((e as Error).message) } finally { mutating.current = false; setActionBusy(false) }
  }
  const cancelJob = async (id: string): Promise<void> => {
    try { await api(`/jobs/${id}/cancel`, 'POST', {}); await load() } catch (e) { setError((e as Error).message) }
  }

  const firstAsset = (job: Rec): Rec | null => {
    const assets = (job['assets'] ?? []) as Rec[]
    return assets.find((a) => String(a['mime'] ?? '').startsWith('image/')) ?? null
  }

  return Card({ title: '画廊与任务' },
    h('div', { className: 'nai-toolbar' },
      h('div', { className: 'nai-search' }, h(Icon, { name: 'search' }), h('input', {
        'aria-label': '搜索作品', placeholder: '搜索提示词 / 任务 ID…', value: queryInput,
        onChange: (e: Rec) => { setQueryInput((e.target as HTMLInputElement).value) },
      })),
      Select({
        value: status, onChange: (v: string) => { setStatus(v); setOffset(0) },
        options: [
          { value: '', label: '全部状态' }, { value: 'queued', label: '排队' }, { value: 'running', label: '执行中' },
          { value: 'completed', label: '已完成' }, { value: 'failed', label: '失败' },
          { value: 'cancelled', label: '已取消' },
        ],
      }),
      h(Toggle, { checked: favorite, onChange: (v: boolean) => { setFavorite(v); setOffset(0) }, label: '收藏' }),
      h(Toggle, { checked: archived, onChange: (v: boolean) => { setArchived(v); setOffset(0) }, label: '归档' }),
      h('div', { className: 'nai-segmented', role: 'group', 'aria-label': '画廊密度' },
        Button({ icon: 'grid', iconOnly: true, title: '标准网格', 'aria-pressed': density === 'normal', onClick: () => setDensity('normal') }),
        Button({ icon: 'columns', iconOnly: true, title: '紧凑网格', 'aria-pressed': density === 'compact', onClick: () => setDensity('compact') })),
      items.length ? Button({ small: true, kind: 'ghost', disabled: actionBusy, onClick: () => setSelected(new Set(items.map((item) => String(item['id'])))) }, '选择本页') : null,
    ),
    selected.size ? h('div', { className: 'nai-selection-bar', role: 'status' },
      h('strong', null, `已选择 ${selected.size} 项`),
      Button({ small: true, icon: 'star', disabled: actionBusy, onClick: () => void curate([...selected], { favorite: true }) }, '收藏所选'),
      Button({ small: true, icon: 'files', disabled: actionBusy, onClick: () => void curate([...selected], { archived: !archived }) }, archived ? '取消归档所选' : '归档所选'),
      Button({ small: true, icon: 'download', disabled: actionBusy, onClick: () => void exportSelected() }, '导出所选'),
      Button({ small: true, icon: 'close', iconOnly: true, kind: 'ghost', title: '取消选择', disabled: actionBusy, onClick: () => setSelected(new Set()) })) : null,
    ErrorBox({ error }),
    loading && !items.length ? h('div', { className: 'nai-empty' }, '加载中 ', Spinner()) : null,
    !loading && !items.length ? h('div', { className: 'nai-empty' }, h(Icon, { name: 'image', size: 28 }), h('p', null, query || favorite || archived || status ? '没有匹配的作品' : '暂无作品'), Button({ icon: 'plus', kind: 'ghost', onClick: () => state.go('create') }, '新建作品')) : null,
    h('div', { className: 'nai-gallery', 'data-density': density }, items.map((job) => {
      const asset = firstAsset(job)
      const id = String(job['id'])
      const req = (job['request'] ?? {}) as Rec
      return h('div', { className: 'cell', key: id, role: 'group', tabIndex: 0, 'aria-label': `查看作品：${String(req['prompt'] || id).slice(0, 120)}`, onKeyDown: keyboardActivate(() => openPreview(job)), onClick: () => openPreview(job) },
        h('label', { className: 'nai-gallery-selection', onClick: (event: Rec) => event.stopPropagation() }, h('input', {
          type: 'checkbox', 'aria-label': `选择作品 ${id}`, checked: selected.has(id), disabled: actionBusy,
          onChange: (event: Rec) => setSelected((current) => { const next = new Set(current); event.target.checked ? next.add(id) : next.delete(id); return next }),
        })),
        h('div', { className: 'flags' },
          job['favorite'] ? h('span', { title: '已收藏', style: { color: 'var(--nai-warn)' } }, h(Icon, { name: 'star', size: 12 })) : null,
          job['status'] !== 'completed' ? h('span', null, statusLabel(String(job['status']))) : null,
          ((req['characters'] as unknown[])?.length)
            ? h('span', null, h(Icon, { name: 'users', size: 12 }), String((req['characters'] as unknown[]).length))
            : null,
          (job['status'] === 'queued' || job['status'] === 'running')
            ? h('button', { type: 'button', className: 'nai-icon-btn', 'aria-label': '取消任务',
                onClick: (e: Rec) => { e.stopPropagation(); void cancelJob(id) },
                title: '取消尚未提交的任务',
                style: { cursor: 'pointer', color: 'var(--nai-danger)' },
              }, h(Icon, { name: 'close', size: 12 }))
            : null),
        h('div', { className: 'img-wrap' },
          asset
            ? h(ImagePreview, { alt: String(req['prompt'] || '生成作品'), src: assetThumbSrc(asset) })
            : h('div', { className: 'empty-thumb' },
                h(Icon, { name: job['operation'] === 'encode_vibe' ? 'layers' : 'image', size: 28 }), operationLabel(job['operation']) + ' · ' + statusLabel(String(job['status'])))),
        h('div', { className: 'meta' },
          h('div', { className: 'meta-prompt', title: String(req['prompt'] ?? '') },
            String(req['prompt'] ?? '').slice(0, 50) || id.slice(0, 12)),
          h('div', { className: 'meta-row' },
            h('span', { style: { color: 'var(--nai-faint)', fontSize: 10 } },
              req['width'] && req['height'] ? `${req['width']}×${req['height']}` : String(job['operation'])),
            h('span', { style: { display: 'flex', gap: 4 } },
              String(req['model'] ?? '').includes('4-5') || String(req['model'] ?? '').includes('4.5')
                ? h('span', { className: 'nai-pill', style: { padding: '0 4px', fontSize: 9 } }, 'V4.5')
                : h('span', { className: 'nai-pill', style: { padding: '0 4px', fontSize: 9 } }, 'V5'),
              job['actual_anlas'] != null ? h('span', { style: { color: 'var(--nai-accent)', fontWeight: 600 } }, `${job['actual_anlas']}A`) : null,
            )
          )
        ),
      )
    })),
    total > limit ? h('div', { className: 'nai-row', style: { marginTop: 10, justifyContent: 'center' } },
      Button({ small: true, disabled: offset === 0, onClick: () => setOffset(Math.max(0, offset - limit)) }, '上一页'),
      h('span', { className: 'nai-pill' }, `${offset + 1}–${Math.min(offset + limit, total)} / ${total}`),
      Button({ small: true, disabled: offset + limit >= total, onClick: () => setOffset(offset + limit) }, '下一页'),
    ) : null,
    preview ? h(JobPreview, { job: preview, draft: state.draft!, externalError: error, onClose: closePreview, onCurate: curate, reload: load, fail: (e: unknown) => setError((e as Error).message), go: state.go, refresh: state.refresh }) : null,
  )
}

function assetThumbSrc(asset: Rec): string {
  const path = String(asset['path'] ?? '')
  const id = String(asset['id'] ?? '')
  return id ? assetThumb(id) : fileUrl(path)
}

function statusLabel(status: string): string {
  return ({ queued: '排队', running: '执行中', completed: '完成', failed: '失败', cancelled: '已取消' } as Rec)[status] ?? status
}

/** Human labels for request fields shown in the parameter panel. */
const PARAM_LABELS: Rec = {
  model: '模型', prompt: '提示词', negative_prompt: '负面提示词', width: '宽度', height: '高度',
  steps: '步数', scale: '引导（Scale）', seed: '种子', sampler: '采样器', noise_schedule: '噪声计划',
  cfg_rescale: 'CFG Rescale', quality_preset: '质量预设', negative_preset: '负面预设',
  variety_boost: '多样性增强', transparent_background: '透明背景', strength: '重绘强度', noise: '噪声',
  defry: '去噪强度（defry）', information_extracted: '信息提取量', tool: '导演工具', emotion: '目标表情',
  mask_mode: '遮罩通道', image_path: '源图路径', mask_path: '遮罩路径',
  normalize_vibe_strengths: '归一化 Vibe 强度', append_enhance_tags: '追加增强 tag', color_correct: '色彩校正',
  mode: '模式', characters: '角色槽', vibes: 'Vibe 参考', precise_references: 'Precise 参考图',
  extra_noise_seed: '额外噪声种子', params_version: '参数版本', req_params: '请求参数',
}

/** Full parameter inspector for a finished job: scalars in a kv grid, objects as JSON. */
function ParamsView({ request }: { request: Rec }): Rec {
  const isEmptyContainer = (v: unknown): boolean =>
    v instanceof Object && (Array.isArray(v) ? v.length === 0 : Object.keys(v as Rec).length === 0)
  const present = (value: unknown): boolean => value != null && value !== '' && !isEmptyContainer(value)
  const entries: Array<[string, unknown]> = []
  for (const k of Object.keys(PARAM_LABELS)) if (k in request && present(request[k])) entries.push([k, request[k]])
  for (const k of Object.keys(request).sort()) if (!['max_anlas', 'max_total_anlas'].includes(k) && !PARAM_LABELS[k] && present(request[k])) entries.push([k, request[k]])
  if (!entries.length) return h('div', { className: 'nai-empty' }, '这条记录没有可展示的参数')
  const simple = entries.filter(([, v]) => !(v instanceof Object))
  const complex = entries.filter(([, v]) => v instanceof Object)
  return h('div', { className: 'nai-params' },
    simple.length ? h('div', { className: 'nai-kv' }, simple.map(([k, v]) => [
      h('span', { key: k + '#k', className: 'k' }, PARAM_LABELS[k] ?? k),
      h('span', { key: k + '#v', style: { wordBreak: 'break-all' } },
        typeof v === 'boolean' ? (v ? '开' : '关') : String(v)),
    ])) : null,
    complex.map(([k, v]) => {
      if (k === 'characters' && Array.isArray(v)) {
        return h('div', { key: k, style: { marginTop: 8 } },
          h('div', { style: { fontSize: 11, color: 'var(--nai-faint)', marginBottom: 4 } }, `角色槽（${v.length} 个）`),
          v.map((c: Rec, i: number) => h('div', {
            key: i,
            style: { background: 'var(--nai-bg)', border: '1px solid var(--nai-border)', borderRadius: 6, padding: '6px 8px', marginTop: 4 },
          },
            h('div', { style: { fontWeight: 'bold', fontSize: 11, marginBottom: 2 } },
              `👤 角色 ${i + 1}${c['x'] != null || c['y'] != null ? ` (X: ${Math.round(Number(c['x'] ?? 0.5) * 100)}%, Y: ${Math.round(Number(c['y'] ?? 0.5) * 100)}%)` : ''}`),
            h('div', { style: { fontSize: 11, wordBreak: 'break-word', color: 'var(--nai-dim)' } }, String(c['prompt'] ?? '')),
            c['negative_prompt'] ? h('div', { style: { fontSize: 11, color: 'var(--nai-danger)', marginTop: 2, wordBreak: 'break-word' } }, '负面: ' + String(c['negative_prompt'])) : null,
          )),
        )
      }
      return h('div', { key: k, style: { marginTop: 8 } },
        h('div', { style: { fontSize: 11, color: 'var(--nai-faint)', marginBottom: 2 } },
          `${PARAM_LABELS[k] ?? k}（${Array.isArray(v) ? v.length : Object.keys(v as Rec).length} 项）`),
        h('pre', { className: 'nai-param-json' }, JSON.stringify(v, null, 2)),
      )
    }),
  )
}

function JobPreview({ job, draft, onClose, onCurate, reload, fail, go, refresh, externalError }: {
  externalError?: string | null
  draft: Rec
  job: Rec; onClose: () => void; onCurate: (ids: string[], patch: Rec) => Promise<void>; reload: () => Promise<void>; fail: (e: unknown) => void
  go: (page: string) => void; refresh: () => Promise<void>
}): Rec {
  const r = R()
  const [paramsOpen, setParamsOpen] = r.useState(false)
  const [copied, setCopied] = r.useState('')
  const assets = (job['assets'] ?? []) as Rec[]
  const id = String(job['id'])
  const request = (job['request'] ?? {}) as Rec
  const characters = ((request['characters'] ?? []) as Rec[]).filter((c) => c && typeof c === 'object')
  const firstImage = assets.find((a) => String(a['mime'] ?? '').startsWith('image/')) ?? null
  const vibeAsset = assets.find((asset) => /\.(?:vibe|naiv4vibe)$/iu.test(String(asset['path'] ?? asset['name'] ?? ''))) ?? null
  const [vibeBusy, setVibeBusy] = r.useState(false)
  const [vibeError, setVibeError] = r.useState<string | null>(null)
  const [revealBusy, setRevealBusy] = r.useState(false)
  const [revealError, setRevealError] = r.useState<string | null>(null)
  const [revealDirectory, setRevealDirectory] = r.useState<string | null>(null)
  const revealPending = r.useRef(false)
  const vibePending = r.useRef(false)

  const revealImage = async (): Promise<void> => {
    if (!firstImage || revealPending.current) return
    revealPending.current = true
    setRevealBusy(true)
    setRevealError(null)
    setRevealDirectory(null)
    try {
      const result = await api('/gallery/reveal', 'POST', { job_id: id, ...(firstImage['id'] ? { asset_id: String(firstImage['id']) } : {}) })
      if (result?.['opened'] !== true) throw new Error('文件管理器未确认启动，请重试')
      setRevealDirectory(typeof result['directory'] === 'string' ? result['directory'] : '')
    } catch (e) { setRevealError((e as Error).message) }
    finally { revealPending.current = false; setRevealBusy(false) }
  }

  const copyText = async (text: string, tag: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tag)
      setTimeout(() => setCopied((cur) => (cur === tag ? '' : cur)), 1500)
    } catch (e) { setVibeError((e as Error).message) }
  }

  const copyFullPrompt = async (): Promise<void> => {
    const parts: string[] = []
    if (request['prompt']) parts.push(`[画面总提示词]\n${request['prompt']}`)
    if (request['negative_prompt']) parts.push(`[画面总负面]\n${request['negative_prompt']}`)
    characters.forEach((c, idx) => {
      const pos = (c['x'] != null || c['y'] != null) ? ` (X: ${Math.round(Number(c['x'] ?? 0.5) * 100)}%, Y: ${Math.round(Number(c['y'] ?? 0.5) * 100)}%)` : ''
      parts.push(`[角色 ${idx + 1}${pos}]\n${c['prompt'] ?? ''}`)
      if (c['negative_prompt']) parts.push(`[角色 ${idx + 1} 负面]\n${c['negative_prompt']}`)
    })
    await copyText(parts.join('\n\n'), 'full_prompt')
  }

  const reuseNewDraft = async (): Promise<void> => {
    await api('/drafts', 'POST', { draft: { name: '复用 ' + id.slice(0, 10), operation: String(job['operation'] ?? 'generate'), request } })
    await refresh()
    onClose()
    go('create')
  }

  const applyToActiveDraft = async (): Promise<void> => {
    await api('/draft', 'PATCH', { id: draft['id'], base_revision: draft['revision'], operation: String(job['operation'] ?? 'generate'), request })
    await refresh()
    onClose()
    go('create')
  }

  const sendToImg2Img = async (): Promise<void> => {
    const assetPath = String(firstImage?.['path'] ?? job['image_path'] ?? '')
    const newReq = { ...request, image_path: assetPath, strength: request['strength'] ?? 0.7 }
    await api('/draft', 'PATCH', { id: draft['id'], base_revision: draft['revision'], operation: 'img2img', request: newReq })
    await refresh()
    onClose()
    go('create')
  }

  const sendToInpaint = async (): Promise<void> => {
    const assetPath = String(firstImage?.['path'] ?? job['image_path'] ?? '')
    const newReq: Rec = { ...request, image_path: assetPath }
    if (String(newReq['model']) === 'nai-diffusion-5-curated') newReq['model'] = 'nai-diffusion-5-full'
    delete newReq['mask_path']
    await api('/draft', 'PATCH', { id: draft['id'], base_revision: draft['revision'], operation: 'inpaint', request: newReq })
    await refresh()
    onClose()
    go('create')
  }

  const sendToUpscale = async (): Promise<void> => {
    const assetPath = String(firstImage?.['path'] ?? job['image_path'] ?? '')
    const newReq = { image_path: assetPath }
    await api('/draft', 'PATCH', { id: draft['id'], base_revision: draft['revision'], operation: 'upscale', request: newReq })
    await refresh()
    onClose()
    go('create')
  }

  const sendToVibe = async (): Promise<void> => {
    if (!vibeAsset || vibePending.current) return
    const current = structuredClone((draft['request'] ?? {}) as Rec)
    if (((current['vibes'] ?? []) as Rec[]).length || ((current['precise_references'] ?? []) as Rec[]).length) {
      if (!confirm('使用此 Vibe 将替换当前草稿的 Vibe 和 Precise 参考图，继续？')) return
    }
    vibePending.current = true
    setVibeBusy(true); setVibeError(null)
    try {
      if (((current['characters'] ?? []) as Rec[]).length > 6) throw new Error('V4.5 最多支持 6 个角色，请先调整当前草稿的角色槽')
      const model = ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'].includes(String(request['model']))
        ? String(request['model']) : 'nai-diffusion-4-5-full'
      const next: Rec = { ...current, model, vibes: [{ encoding_path: String(vibeAsset['path']), strength: 0.6 }], precise_references: [] }
      if (next['quality_preset'] === 'light') next['quality_preset'] = 'standard'
      if (next['transparent_background']) next['transparent_background'] = false
      await api('/draft', 'PATCH', { id: draft['id'], base_revision: draft['revision'], operation: 'reference_generate', request: next })
      await refresh()
      onClose()
      go('create')
    } catch (e) { setVibeError((e as Error).message) } finally { vibePending.current = false; setVibeBusy(false) }
  }

  return h(Modal, {
    title: `作品 · ${id.slice(0, 18)}…`, onClose, wide: true,
  },
    ErrorBox({ error: vibeError ?? externalError }),
    (job['result']?.['warnings'] ?? []).length ? h('div', { className: 'nai-warn', role: 'status' }, (job['result']['warnings'] as string[]).map((warning) => h('p', { key: warning }, warning))) : null,
    h('div', { className: 'nai-row', style: { alignItems: 'flex-start' } },
      h('div', { className: 'nai-preview-media', style: { flex: 1, minWidth: 0 } },
        assets.filter((asset) => String(asset['mime'] ?? '').startsWith('image/')).map((asset) => h('a', {
          key: String(asset['id']), href: assetUrl(String(asset['id'])), target: '_blank', rel: 'noreferrer',
          title: '点击在新窗口查看原图', style: { display: 'block' },
        }, h(ImagePreview, { alt: String(request['prompt'] || '生成作品'),
          src: assetUrl(String(asset['id'])), className: 'nai-preview-image', loading: 'eager',
          style: { cursor: 'zoom-in' },
        }))),
        assets.filter((asset) => !String(asset['mime'] ?? '').startsWith('image/')).map((asset) => Button({
          key: 'f' + String(asset['id']), small: true,
          title: '下载输出文件',
          style: { margin: '0 6px 6px 0' },
          onClick: () => { void downloadUrl(assetUrl(String(asset['id'])), String(asset['name'] ?? asset['id'])).catch((e) => setVibeError((e as Error).message)) },
        }, `⬇ ${String(asset['name'] ?? asset['id'])}`)),
        !assets.length ? h('div', { className: 'nai-empty' }, statusLabel(String(job['status'])) + (job['error'] ? '：' + String(job['error']) : '')) : null,

        // Direct Prompts and Character Slots Section
        h('div', { style: { marginTop: 12, borderTop: '1px solid var(--nai-border)', paddingTop: 10 } },
          String(request['prompt'] ?? '') ? h('div', {
            style: { marginBottom: 10, background: 'var(--nai-bg)', border: '1px solid var(--nai-border)', borderRadius: 6, padding: '8px 10px' },
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
              h('strong', { style: { fontSize: 12, color: 'var(--nai-accent)' } }, '画面总提示词'),
              Button({ small: true, onClick: () => { void copyText(String(request['prompt']), 'prompt') } },
                copied === 'prompt' ? '已复制 ✓' : '⧉ 复制')
            ),
            h('div', { style: { fontSize: 12, lineHeight: 1.5, wordBreak: 'break-word', color: 'var(--nai-dim)' } }, String(request['prompt'])),
            request['negative_prompt'] ? h('div', { style: { marginTop: 6, fontSize: 11, color: 'var(--nai-faint)', wordBreak: 'break-word' } },
              h('span', { style: { color: 'var(--nai-danger)', marginRight: 4 } }, '负面：'),
              String(request['negative_prompt'])
            ) : null,
          ) : null,

          characters.length ? h('div', { style: { marginBottom: 10 } },
            h('div', { style: { fontSize: 12, fontWeight: 'bold', color: 'var(--nai-accent)', marginBottom: 6 } },
              `👥 独立角色词槽（${characters.length} 个角色）`),
            characters.map((c, i) => {
              const hasPos = c['x'] != null || c['y'] != null
              const posLabel = hasPos ? ` (X: ${Math.round(Number(c['x'] ?? 0.5) * 100)}%, Y: ${Math.round(Number(c['y'] ?? 0.5) * 100)}%)` : ''
              return h('div', {
                key: i,
                style: {
                  marginBottom: 8, background: 'var(--nai-bg)',
                  border: '1px solid var(--nai-border)',
                  borderLeft: '3px solid var(--nai-accent)',
                  borderRadius: 6, padding: '8px 10px',
                },
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
                  h('div', { style: { fontSize: 12, fontWeight: 'bold' } },
                    `👤 角色 ${i + 1}`,
                    hasPos ? h('span', { className: 'nai-pill', style: { marginLeft: 6, fontSize: 10, padding: '1px 5px' } }, posLabel) : null
                  ),
                  Button({ small: true, onClick: () => { void copyText(String(c['prompt'] ?? ''), `char_${i}`) } },
                    copied === `char_${i}` ? '已复制 ✓' : '⧉ 复制角色词')
                ),
                h('div', { style: { fontSize: 12, lineHeight: 1.5, wordBreak: 'break-word', color: 'var(--nai-dim)' } }, String(c['prompt'] ?? '')),
                c['negative_prompt'] ? h('div', { style: { marginTop: 4, fontSize: 11, color: 'var(--nai-faint)', wordBreak: 'break-word' } },
                  h('span', { style: { color: 'var(--nai-danger)', marginRight: 4 } }, '角色负面：'),
                  String(c['negative_prompt'])
                ) : null,
              )
            })
          ) : null,
        ),
      ),
      h('div', { className: 'nai-preview-details', style: { width: 300, flex: 'none' } },
        h('div', { className: 'nai-kv' },
          h('span', { className: 'k' }, '状态'), h('span', null, statusLabel(String(job['status']))),
          h('span', { className: 'k' }, '操作'), h('span', null, operationLabel(job['operation'])),
          h('span', { className: 'k' }, '模型'), h('span', null, String(request['model'] ?? '-')),
          h('span', { className: 'k' }, '种子'),
          h('button', {
            type: 'button', className: 'nai-btn small ghost', disabled: request['seed'] == null,
            style: { justifyContent: 'flex-start', padding: '0 4px', minHeight: 22 },
            title: '复制种子',
            onClick: () => { if (request['seed'] != null) void copyText(String(request['seed']), 'seed') },
          },
            String(request['seed'] ?? '-'),
            request['seed'] != null ? h('span', { style: { fontSize: 10, color: 'var(--nai-faint)' } }, copied === 'seed' ? '✓' : '⧉') : null
          ),
          h('span', { className: 'k' }, '尺寸'), h('span', null, `${request['width'] ?? '?'}×${request['height'] ?? '?'}`),
          h('span', { className: 'k' }, '消耗'), h('span', null, job['actual_anlas'] == null ? '未确认' : `${job['actual_anlas']} Anlas`),
          job['result']?.['record_path'] ? h('span', { className: 'k' }, '原始记录') : null,
          job['result']?.['record_path'] ? h('span', { style: { overflowWrap: 'anywhere' } }, String(job['result']['record_path'])) : null,
          characters.length ? h('span', { className: 'k', key: 'chk' }, '角色') : null,
          characters.length ? h('span', { key: 'chv' }, `${characters.length} 个角色槽`) : null,
          job['created_at'] ? h('span', { className: 'k', key: 'ck' }, '创建') : null,
          job['created_at'] ? h('span', { key: 'cv' }, new Date(String(job['created_at'])).toLocaleString('zh-CN')) : null,
        ),
        h('div', { style: { marginTop: 10 }, className: 'nai-row' },
          Button({
            small: true, kind: paramsOpen ? 'primary' : 'ghost',
            title: '展开这条作品生成时的全部参数（含角色、参考图等）',
            onClick: () => setParamsOpen(!paramsOpen),
          }, paramsOpen ? '收起参数' : '⚙ 查看参数'),
          characters.length ? Button({
            small: true, onClick: () => { void copyFullPrompt() },
            title: '复制画面总提示词与各个独立角色的提示词',
          }, copied === 'full_prompt' ? '已复制 ✓' : '⧉ 复制全部词 (含角色)') : (String(request['prompt'] ?? '') ? Button({
            small: true, onClick: () => { void copyText(String(request['prompt']), 'prompt_side') },
            title: '复制提示词到剪贴板',
          }, copied === 'prompt_side' ? '已复制 ✓' : '⧉ 复制提示词') : null),
        ),
        paramsOpen ? h('div', { style: { marginTop: 8 } },
          h('div', { className: 'nai-row', style: { marginBottom: 6 } },
            h('span', { style: { fontSize: 11, color: 'var(--nai-faint)' } }, '生成时的完整参数'),
            h('span', { style: { flex: 1 } }),
            Button({ small: true, onClick: () => { void copyText(JSON.stringify(request, null, 2), 'json') } },
              copied === 'json' ? '已复制 ✓' : '⧉ 复制 JSON'),
          ),
          h(ParamsView, { request }),
        ) : null,
        h('div', { style: { marginTop: 10 }, className: 'nai-row' },
          Button({
            small: true, onClick: () => void onCurate([id], { favorite: !job['favorite'] }).catch((e) => setVibeError((e as Error).message)),
          }, job['favorite'] ? '★ 取消收藏' : '☆ 收藏'),
          Button({
            small: true, onClick: () => void onCurate([id], { archived: !job['archived'] }).catch((e) => setVibeError((e as Error).message)),
          }, job['archived'] ? '移出归档' : '归档'),
          (job['status'] === 'queued' || job['status'] === 'running')
            ? Button({
                small: true, kind: 'danger',
                title: '取消尚未提交的任务；已提交的生成不会重复提交',
                onClick: () => { void api(`/jobs/${id}/cancel`, 'POST', {}).then(reload).then(onClose).catch((e) => setVibeError((e as Error).message)) }
              }, '取消任务')
            : null,
        ),
        h('div', { style: { marginTop: 12, borderTop: '1px solid var(--nai-border-soft)', paddingTop: 10 } },
          h('div', { style: { fontSize: 11, color: 'var(--nai-faint)', marginBottom: 6 } }, '快捷流转到创作与编辑：'),
          h('div', { className: 'nai-row', style: { gap: 6, marginBottom: 8 } },
            Button({
              small: true, kind: 'primary',
              title: '将本图所有参数（提示词、尺寸、种子、角色槽等）直接覆盖填入当前工作台草稿',
              onClick: () => void applyToActiveDraft().catch((e) => setVibeError((e as Error).message)),
            }, '📋 应用参数到当前草稿'),
            Button({
              small: true, kind: 'ghost',
              title: '以本图参数另存为一份新草稿并激活',
              onClick: () => void reuseNewDraft().catch((e) => setVibeError((e as Error).message)),
            }, '⤵ 存为新草稿'),
          ),
          vibeAsset ? Button({
            small: true, kind: 'primary', disabled: vibeBusy || !vibeAsset['path'],
            title: '替换当前草稿的参考图，使用此编码的 V4.5 模型进行参考图生成',
            onClick: () => { void sendToVibe() },
          }, vibeBusy ? '应用中…' : '用作 Vibe 参考') : null,
          firstImage ? h('div', { className: 'nai-row', style: { gap: 6, marginBottom: 8 } },
            Button({
              small: true, kind: 'ghost',
              title: '以此图为底图，带入提示词进行图生图（Img2Img）',
              onClick: () => void sendToImg2Img().catch((e) => setVibeError((e as Error).message)),
            }, '🎨 发送到图生图'),
            Button({
              small: true, kind: 'ghost',
              title: '以此图为底图，进入局部重绘（Inpaint）',
              onClick: () => void sendToInpaint().catch((e) => setVibeError((e as Error).message)),
            }, '🖌️ 发送到局部重绘'),
            Button({
              small: true, kind: 'ghost',
              title: '发送到专用高清放大（Upscale）',
              onClick: () => void sendToUpscale().catch((e) => setVibeError((e as Error).message)),
            }, '🔍 发送到放大'),
          ) : null,
          h('div', { className: 'nai-row', style: { gap: 6 } },
            firstImage ? Button({
              small: true, icon: 'folder', disabled: revealBusy,
              title: '在系统文件管理器中定位此原图',
              onClick: () => { void revealImage() },
            }, revealBusy ? '正在打开…' : '打开所在文件夹') : null,
            Button({
              small: true,
              title: '打包下载这条作品的图片与参数记录（zip）',
              onClick: () => void downloadPost('/gallery/export', { ids: [id] }, 'atelier-artworks.zip').catch((e) => setVibeError((e as Error).message)),
            }, '⬇ 导出作品包'),
          ),
          ErrorBox({ error: revealError }),
          revealDirectory !== null ? h('div', {
            role: 'status', style: { marginTop: 6, fontSize: 12, color: 'var(--nai-dim)', overflowWrap: 'anywhere' },
          }, '已请求打开文件夹', revealDirectory ? `：${revealDirectory}` : '') : null,
        ),
        job['error'] ? h('div', {
          style: { marginTop: 10, padding: '8px 10px', borderRadius: 6, background: 'color-mix(in srgb, var(--nai-danger) 10%, transparent)', color: 'var(--nai-danger)', fontSize: 12, wordBreak: 'break-word' }
        }, '错误：' + String(job['error'])) : null,
        h('div', { style: { marginTop: 8, fontSize: 11, color: 'var(--nai-faint)', wordBreak: 'break-all' } },
          '输出：', String(job['image_path'] ?? '-')),
      ),
    ),
  )
}
