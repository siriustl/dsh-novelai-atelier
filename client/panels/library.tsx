/** Character / artist / blend / preset library with prompt sets, examples, import/export. */
import type { WorkbenchState } from '../shell.tsx'
import { R, h, Button, Card, Field, Modal, ErrorBox, Select, Toggle, keyboardActivate } from '../ui.tsx'
import { api, uploadFile, assetThumb, downloadPost, type Rec } from '../api.ts'
import { Icon, type IconName } from '../icons.tsx'
import { ImagePreview } from '../image.tsx'
import { clearPendingDraft } from '../draft-cache.ts'
import { dateTimeLabel } from '../format.ts'
import { appendScenePrompt, appendPresetCharacters, entryPrompt } from '../../src/workbench/library.ts'

const KINDS = [
  ['all', '全部'], ['character', '角色'], ['branch', '分支'], ['artist', '画师'], ['blend', '混合'], ['preset', '预设'],
] as const
const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map(([value, label]) => [value, label]))
const KIND_ICON: Record<string, IconName> = { character: 'users', branch: 'layers', artist: 'brush', blend: 'layers', preset: 'sparkles' }
const SORTS = [
  ['updated', '最近更新'], ['created', '最近创建'], ['name', '名称'], ['used', '最常使用'], ['favorite', '收藏优先'], ['kind', '类型'],
] as const
const PAGE_SIZE = 48
const EMPTY_FACETS: Rec = { all: 0, kinds: {}, favorites: 0, tags: [] }

type LibraryQueryResult = {
  items?: Rec[]
  total?: number
  next_offset?: number | null
  facets?: Rec
}

export function LibraryPanel({ state }: { state: WorkbenchState }): Rec {
  const r = R()
  const [kind, setKind] = r.useState<string>('all')
  const [query, setQuery] = r.useState('')
  const [queryInput, setQueryInput] = r.useState('')
  const [favorite, setFavorite] = r.useState(false)
  const [tag, setTag] = r.useState('')
  const [sort, setSort] = r.useState('updated')
  const [rows, setRows] = r.useState<Rec[]>([])
  const [total, setTotal] = r.useState(0)
  const [facets, setFacets] = r.useState<Rec>(EMPTY_FACETS)
  const [nextOffset, setNextOffset] = r.useState<number | null>(null)
  const [editing, setEditing] = r.useState<Rec | null>(null)
  const [context, setContext] = r.useState<Rec[]>([])
  const [error, setError] = r.useState<string | null>(null)
  const [busy, setBusy] = r.useState(false)
  const [loadingMore, setLoadingMore] = r.useState(false)
  const [selected, setSelected] = r.useState<Set<string>>(() => new Set())
  const [exportBusy, setExportBusy] = r.useState(false)
  const [favoriteBusy, setFavoriteBusy] = r.useState<string | null>(null)
  const [importOpen, setImportOpen] = r.useState(false)
  const exportPending = r.useRef(false)
  const loadVersion = r.useRef(0)
  const contextRef = r.useRef<Rec[] | null>(null)
  const contextPending = r.useRef<Promise<Rec[]> | null>(null)

  const load = async (offset = 0, mode: 'replace' | 'append' = 'replace'): Promise<void> => {
    const version = ++loadVersion.current
    if (mode === 'replace') setBusy(true)
    else setLoadingMore(true)
    const params = new URLSearchParams({
      kind, query, favorite: String(favorite), sort,
      offset: String(offset), limit: String(PAGE_SIZE),
    })
    if (tag) params.set('tag', tag)
    try {
      const result = await api<LibraryQueryResult>(`/library/query?${params.toString()}`)
      if (version !== loadVersion.current) return
      const items = Array.isArray(result.items) ? result.items : []
      setRows((current) => mode === 'append' ? [...current, ...items] : items)
      // Legacy/fully hydrated rows can double as the editor's composition context.
      if (items.length && items.every((row) => row['data'])) contextRef.current = items
      setTotal(Number(result.total ?? 0))
      setFacets(result.facets ?? EMPTY_FACETS)
      setNextOffset(result.next_offset ?? null)
      if (mode === 'replace') setSelected((current) => new Set([...current].filter((id) => items.some((row) => row['id'] === id))))
      setError(null)
    } catch (e) {
      if (version === loadVersion.current) setError((e as Error).message)
    } finally {
      if (version === loadVersion.current) { setBusy(false); setLoadingMore(false) }
    }
  }

  const ensureContext = async (): Promise<Rec[]> => {
    if (contextRef.current) return contextRef.current
    if (!contextPending.current) {
      contextPending.current = api<Rec[]>('/library')
        .then((values) => { contextRef.current = Array.isArray(values) ? values : []; return contextRef.current })
        .finally(() => { contextPending.current = null })
    }
    return contextPending.current
  }

  const openById = async (id: string): Promise<void> => {
    try {
      const [full, contextRows] = await Promise.all([api<Rec>(`/library/${encodeURIComponent(id)}`), ensureContext()])
      setContext(contextRows)
      setEditing(structuredClone(full))
    } catch (e) { setError((e as Error).message) }
  }

  const openEntry = (entry: Rec): void => {
    if (entry['data']) {
      setEditing(structuredClone(entry))
      if (contextRef.current) setContext(contextRef.current)
      else void ensureContext().then(setContext).catch((e) => setError((e as Error).message))
      return
    }
    void openById(String(entry['id']))
  }

  const newEntrySeed = (): Rec => ({
    kind: kind === 'all' ? 'character' : kind,
    name: '',
    data: { prompt: '', negative_prompt: '', prompt_sets: [], examples: [], notes: '', tags: [], favorite: false },
  })

  const createEntry = (seed?: Rec): void => {
    if (contextRef.current) {
      setContext(contextRef.current)
      setEditing(seed ?? newEntrySeed())
      return
    }
    void ensureContext().then((contextRows) => {
      setContext(contextRows)
      setEditing(seed ?? newEntrySeed())
    }).catch((e) => setError((e as Error).message))
  }

  const refreshContext = (): void => { contextRef.current = null; contextPending.current = null }

  r.useEffect(() => {
    if (queryInput === query) return
    const timer = setTimeout(() => setQuery(queryInput), 300)
    return () => clearTimeout(timer)
  }, [queryInput, query])
  r.useEffect(() => { void load(0, 'replace') }, [kind, query, favorite, tag, sort])
  r.useEffect(() => { setSelected(new Set()) }, [kind, query, favorite, tag, sort])
  r.useEffect(() => {
    if (!state.librarySeed) return
    const seed = structuredClone(state.librarySeed)
    setKind(String(seed['kind'] ?? 'preset'))
    setEditing(seed)
    void ensureContext().then(setContext).catch((e) => setError((e as Error).message))
    state.clearLibrarySeed?.()
  }, [state.librarySeed])

  const exportLibrary = async (ids: string[] | null): Promise<void> => {
    if (exportPending.current || (ids && !ids.length)) return
    exportPending.current = true
    setExportBusy(true)
    setError(null)
    try { await downloadPost('/library/export', ids ? { ids } : {}, ids ? 'atelier-library-selection.zip' : 'atelier-library.zip') }
    catch (e) { setError((e as Error).message) }
    finally { exportPending.current = false; setExportBusy(false) }
  }

  const remove = async (entry: Rec): Promise<void> => {
    if (!confirm(`删除「${String(entry['name'])}」？`)) return
    try {
      await api(`/library/${encodeURIComponent(String(entry['id']))}?revision=${String(entry['revision'])}`, 'DELETE')
      refreshContext()
      await load(0, 'replace')
    } catch (e) { setError((e as Error).message) }
  }

  const toggleFavorite = async (entry: Rec): Promise<void> => {
    const id = String(entry['id'])
    if (favoriteBusy) return
    setFavoriteBusy(id)
    try {
      const saved = await api<Rec>(`/library/${encodeURIComponent(id)}/favorite`, 'POST', {
        favorite: entry['favorite'] !== true, revision: entry['revision'],
      })
      setRows((current) => current.map((row) => row['id'] === id ? { ...row, favorite: saved['data']?.['favorite'] === true, revision: saved['revision'] } : row))
      void load(0, 'replace')
    } catch (e) { setError((e as Error).message) }
    finally { setFavoriteBusy(null) }
  }

  const applyToDraft = async (entry: Rec, promptSet = -1): Promise<void> => {
    const draft = state.draft
    if (!draft) throw new Error('当前草稿不可用')
    const req = structuredClone((draft['request'] ?? {}) as Rec)
    const preview = await api<Rec>('/library/preview', 'POST', { entry_id: entry['id'], prompt_set: promptSet })
    const p = String(preview['prompt'] ?? '')
    const np = String(preview['negative_prompt'] ?? '')
    let slot: number | null = null
    if (entry['kind'] === 'character' || entry['kind'] === 'branch') {
      const characters = ((req['characters'] ?? []) as Rec[]).slice()
      const limit = String(req['model'] ?? 'nai-diffusion-5-full').startsWith('nai-diffusion-5-') ? 22 : 6
      if (characters.length >= limit) throw new Error(`已达模型角色上限 ${limit}`)
      slot = characters.length
      characters.push({ prompt: p, negative_prompt: np })
      req['characters'] = characters
    } else {
      req['prompt'] = appendScenePrompt(String(req['prompt'] ?? ''), p)
      if (np) req['negative_prompt'] = [req['negative_prompt'], np].filter(Boolean).join(', ')
      if (entry['kind'] === 'preset' && promptSet === -1) appendPresetCharacters(req, (preview['entry']?.['data'] ?? entry['data'] ?? {}) as Rec)
    }
    const refs = ((draft['library_refs'] ?? []) as Rec[]).slice()
    refs.push({ id: entry['id'], revision: preview['entry']?.['revision'] ?? entry['revision'], name: entry['name'], parent_id: entry['parent_id'] ?? entry['id'], prompt_set: promptSet, ...(slot !== null ? { slot } : {}) })
    await state.patchDraft({ id: draft['id'], request: req, library_refs: refs }, Number(draft['revision']))
    clearPendingDraft(String(draft['id']))
    // Usage data is advisory; the draft application must not fail if it cannot be recorded.
    void api(`/library/${encodeURIComponent(String(entry['id']))}/use`, 'POST', {}).catch(() => {})
  }

  const kindCount = (value: string): number => value === 'all'
    ? Number(facets['kinds'] ? Object.values(facets['kinds'] as Rec).reduce((sum: number, count) => sum + Number(count), 0) : total)
    : Number((facets['kinds'] as Rec | undefined)?.[value] ?? 0)
  const tags = Array.isArray(facets['tags']) ? facets['tags'] as Rec[] : []
  const hasFilter = Boolean(query || favorite || tag || (kind !== 'all'))
  const selectedVisible = [...selected].filter((id) => rows.some((row) => String(row['id']) === id))

  const renderCard = (entry: Rec): Rec => {
    const id = String(entry['id'])
    const isBranch = entry['kind'] === 'branch'
    const isCharacter = entry['kind'] === 'character'
    const parentName = String(entry['parent_name'] ?? '')
    const displayName = isBranch && parentName ? `${parentName} - ${String(entry['name'])}` : String(entry['name'])
    const prompt = String(entry['prompt_preview'] ?? '')
    const tagsOfEntry = Array.isArray(entry['tags']) ? entry['tags'] as string[] : []
    const branches = Array.isArray(entry['branches']) ? entry['branches'] as Rec[] : []
    const cover = entry['cover_asset_id'] ? assetThumb(String(entry['cover_asset_id'])) : ''
    return h('div', {
      className: 'nai-lib-card', key: id, role: 'group', tabIndex: 0,
      'data-kind': String(entry['kind']), 'aria-label': displayName,
      onKeyDown: keyboardActivate(() => openEntry(entry)),
      onClick: () => openEntry(entry),
    },
      h('label', { className: 'nai-library-selection', onClick: (event: Rec) => event.stopPropagation() }, h('input', {
        type: 'checkbox', 'aria-label': `选择资料 ${displayName}`, checked: selected.has(id),
        onChange: (event: Rec) => setSelected((current) => { const next = new Set(current); event.target.checked ? next.add(id) : next.delete(id); return next }),
      })),
      h('button', {
        type: 'button', className: `nai-lib-favorite ${entry['favorite'] === true ? 'active' : ''}`,
        title: entry['favorite'] === true ? '取消收藏' : '收藏此资料',
        'aria-label': entry['favorite'] === true ? `取消收藏 ${displayName}` : `收藏 ${displayName}`,
        disabled: favoriteBusy === id,
        onClick: (event: Rec) => { event.stopPropagation(); void toggleFavorite(entry) },
      }, h(Icon, { name: 'star', size: 14 })),
      h('div', { className: 'preview-box' },
        cover
          ? h(ImagePreview, { alt: displayName, src: cover })
          : h('div', { className: 'preview-empty' },
              h('span', { className: 'nai-lib-glyph' }, h(Icon, { name: KIND_ICON[String(entry['kind'])] ?? 'library', size: 30 })),
              h('span', null, '暂无例图')),
        h('span', { className: 'nai-lib-kind' }, isBranch && parentName ? `${parentName} · 分支` : (KIND_LABEL[String(entry['kind'])] ?? String(entry['kind']))),
        Number(entry['example_count'] ?? 0) > 1 ? h('span', { className: 'nai-lib-examples' }, h(Icon, { name: 'image', size: 11 }), String(entry['example_count'])) : null,
      ),
      h('div', { className: 'content' },
        h('div', { className: 'header-row' },
          h('div', { className: 'name', title: displayName }, displayName),
          h('span', { className: 'nai-pill nai-lib-revision' }, `v${String(entry['revision'])}`),
        ),
        h('div', { className: 'prompt-preview', title: prompt || '无提示词' },
          prompt || h('span', { className: 'faint' }, '（未设置主提示词）')),
        tagsOfEntry.length ? h('div', { className: 'nai-lib-tagline' },
          tagsOfEntry.slice(0, 3).map((value) => h('button', {
            type: 'button', key: value, className: 'nai-tag click', title: `按标签筛选：${value}`,
            onClick: (event: Rec) => { event.stopPropagation(); setTag(value) },
          }, value)),
          tagsOfEntry.length > 3 ? h('span', { className: 'nai-tag' }, `+${tagsOfEntry.length - 3}`) : null) : null,
        isCharacter && branches.length ? h('div', { className: 'nai-lib-branches' },
          h('span', { className: 'faint' }, '分支'),
          branches.map((branch) => h('button', {
            type: 'button', key: String(branch['id']), className: 'nai-pill', title: `打开分支「${String(branch['name'])}」`,
            onClick: (event: Rec) => { event.stopPropagation(); void openById(String(branch['id'])) },
          }, h(Icon, { name: 'layers', size: 11 }), String(branch['name'])))) : null,
        h('div', { className: 'nai-lib-meta' },
          h('span', null, `${Number(entry['use_count'] ?? 0) ? `用过 ${Number(entry['use_count'])} 次` : '未使用'}`),
          Number(entry['prompt_set_count'] ?? 0) ? h('span', null, `${Number(entry['prompt_set_count'])} 组词`) : null,
          entry['last_used_at'] ? h('span', null, `最近 ${dateTimeLabel(entry['last_used_at'])}`) : null),
        h('div', { className: 'actions' },
          Button({
            small: true, kind: 'primary', icon: 'copy',
            onClick: (event: Rec) => { event.stopPropagation(); void applyToDraft(entry).then(() => state.go('create')).catch((error) => setError((error as Error).message)) },
            title: '将该资料填入当前创作草稿并切换至创作页',
          }, '填入草稿'),
          h('div', { className: 'nai-lib-card-tools' },
            isBranch && parentName ? Button({
              small: true, kind: 'ghost', icon: 'users',
              onClick: (event: Rec) => { event.stopPropagation(); void openById(String(entry['parent_id'])) },
              title: `跳转到角色「${parentName}」本体`,
            }, '本体') : null,
            isCharacter ? Button({
              small: true, kind: 'ghost', icon: 'plus',
              onClick: (event: Rec) => {
                event.stopPropagation()
                void ensureContext().then((contextRows) => {
                  setContext(contextRows)
                  setEditing({ kind: 'branch', parent_id: id, name: '', data: { prompt: '', negative_prompt: '', prompt_sets: [], examples: [], notes: '', tags: [], favorite: false } })
                }).catch((error) => setError((error as Error).message))
              },
              title: '为此角色新建分支',
            }, '分支') : null,
            Button({
              small: true, kind: 'ghost', icon: 'edit',
              onClick: (event: Rec) => { event.stopPropagation(); openEntry(entry) },
            }, '编辑'),
            Button({
              small: true, kind: 'ghost', icon: 'trash', iconOnly: true,
              onClick: (event: Rec) => { event.stopPropagation(); void remove(entry) },
              title: '删除此资料',
              style: { color: 'var(--nai-danger)' },
            }),
          ),
        ),
      ),
    )
  }

  return Card({},
    h('div', { className: 'nai-lib-head' },
      h('div', { className: 'nai-lib-heading' },
        h('h2', { className: 'nai-section-title' }, '资料库'),
        h('span', { className: 'nai-lib-count' }, `${total} 条资料${favorite ? ' · 收藏' : ''}${tag ? ` · #${tag}` : ''}`)),
      h('div', { className: 'nai-lib-head-actions' },
        Button({ icon: 'plus', onClick: () => createEntry() }, '＋ 新建'),
        Button({ small: true, kind: 'ghost', icon: 'upload', onClick: () => setImportOpen(true) }, '导入'),
        Button({ small: true, kind: 'ghost', icon: 'download', disabled: exportBusy || !total, onClick: () => void exportLibrary(null) }, '导出全部'))),
    h('div', { className: 'nai-lib-searchrow' },
      h('div', { className: 'nai-search' }, h(Icon, { name: 'search' }), h('input', {
        'aria-label': '搜索资料', placeholder: '搜索名称、标签或内容…', value: queryInput,
        onChange: (e: Rec) => setQueryInput((e.target as HTMLInputElement).value),
      })),
      Select({ value: sort, ariaLabel: '资料排序', onChange: setSort, options: SORTS.map(([value, label]) => ({ value, label })) }),
      h(Toggle, { checked: favorite, onChange: setFavorite, label: '只看收藏' })),
    h('div', { className: 'nai-lib-kinds', role: 'group', 'aria-label': '资料类型' },
      KINDS.map(([value, label]) => h('button', {
        type: 'button', key: value, className: value === kind ? 'active' : '',
        'aria-pressed': value === kind, onClick: () => setKind(value),
      }, h('span', null, label), h('span', { className: 'nai-lib-chip-count' }, String(kindCount(value)))))),
    tags.length ? h('div', { className: 'nai-lib-tags', 'aria-label': '标签筛选' },
      h(Icon, { name: 'tag', size: 13 }),
      tags.map((item) => {
        const value = String(item['name'])
        return h('button', {
          type: 'button', key: value, className: `nai-tag click ${tag === value ? 'active' : ''}`,
          title: `按标签筛选：${value}`, onClick: () => setTag(tag === value ? '' : value),
        }, `#${value}`, h('span', { className: 'nai-lib-chip-count' }, String(item['count'])))
      })) : null,
    ErrorBox({ error }),
    busy && !rows.length ? h('div', { className: 'nai-lib-grid' }, Array.from({ length: 6 }, (_, index) => h('div', { key: `skeleton-${index}`, className: 'nai-lib-card nai-skeleton' },
      h('div', { className: 'skeleton-block skeleton-cover' }), h('div', { className: 'skeleton-block skeleton-line' }), h('div', { className: 'skeleton-block skeleton-line short' })))) : null,
    !busy && !rows.length ? h('div', { className: 'nai-empty nai-empty-rich' },
      h('span', { className: 'nai-empty-glyph' }, h(Icon, { name: hasFilter ? 'search' : 'library', size: 34 })),
      h('strong', null, hasFilter ? '没有匹配的资料' : '资料库还是空的'),
      h('p', null, hasFilter ? '换一个关键词、类型或标签试试；也可以清除全部筛选。' : '把角色、画师、混合方案或常用预设存进来，下次填入草稿只需一次点击。'),
      hasFilter
        ? Button({ icon: 'undo', onClick: () => { setQuery(''); setQueryInput(''); setFavorite(false); setTag(''); setKind('all') } }, '清除筛选')
        : Button({ icon: 'plus', kind: 'primary', onClick: () => createEntry() }, '新建第一条资料')) : null,
    rows.length ? h('div', { className: 'nai-lib-grid', 'data-layout': 'masonry', 'aria-label': '资料瀑布流' }, rows.map(renderCard)) : null,
    selectedVisible.length ? h('div', { className: 'nai-selection-bar', role: 'status' },
      h('strong', null, `已选择 ${selectedVisible.length} 项`),
      Button({ small: true, icon: 'download', disabled: exportBusy, onClick: () => void exportLibrary(selectedVisible) }, `导出所选 (${selectedVisible.length})`),
      Button({ small: true, icon: 'close', iconOnly: true, kind: 'ghost', title: '取消选择', disabled: exportBusy, onClick: () => setSelected(new Set()) })) : null,
    h('div', { className: 'nai-lib-pager' },
      h('span', { className: 'faint' }, rows.length ? `已显示 ${rows.length} / ${total}` : ''),
      h('span', { style: { flex: 1 } }),
      Button({ small: true, kind: 'ghost', disabled: busy || !rows.length, onClick: () => setSelected(new Set(rows.map((row) => String(row['id'])))) }, '选择当前结果'),
      nextOffset !== null ? Button({ small: true, icon: loadingMore ? 'loader' : 'download', disabled: loadingMore, onClick: () => void load(nextOffset, 'append') }, loadingMore ? '加载中…' : '加载更多') : null),
    editing ? h(EntryEditor, {
      entry: editing,
      allEntries: context,
      allCharacters: context.filter((value) => value['kind'] === 'character'),
      allBranches: context.filter((value) => value['kind'] === 'branch'),
      onClose: () => setEditing(null),
      onSaved: () => { setEditing(null); refreshContext(); void load(0, 'replace') },
      onApplyToDraft: applyToDraft,
      onApplied: () => state.go('create'),
      guardNavigation: state.guardNavigation,
      onSwitchEntry: (next: Rec) => setEditing(structuredClone(next)),
      fail: (e: unknown) => setError((e as Error).message),
    }) : null,
    importOpen ? h(ImportDialog, {
      onClose: () => setImportOpen(false),
      onPreview: async (file: File) => {
        const data = new FormData()
        data.append('file', file)
        return api<Rec>('/library/import-preview', 'POST', data)
      },
      onMerge: async (file: File, choices: Rec, expectedRevisions: Rec) => {
        const data = new FormData()
        data.append('file', file)
        data.append('choices', JSON.stringify(choices))
        data.append('expected_revisions', JSON.stringify(expectedRevisions))
        await api('/library/import-merge', 'POST', data)
        setImportOpen(false)
        refreshContext()
        await load(0, 'replace')
      },
      fail: (e: unknown) => setError((e as Error).message),
    }) : null,
  )
}

function EntryEditor({
  entry, allEntries, allCharacters, allBranches, onClose, onSaved, onApplyToDraft, onSwitchEntry, fail, guardNavigation, onApplied
}: {
  entry: Rec
  allEntries: Rec[]
  allCharacters: Rec[]
  allBranches: Rec[]
  onClose: () => void
  onSaved: () => void
  onApplyToDraft?: (entry: Rec, promptSet: number) => Promise<void>
  onApplied?: () => void
  onSwitchEntry?: (entry: Rec) => void
  fail: (e: unknown) => void
  guardNavigation?: WorkbenchState['guardNavigation']
}): Rec {
  const r = R()
  const [value, setValue] = r.useState<Rec>(structuredClone(entry))
  const [error, setError] = r.useState<string | null>(null)
  const [saving, setSaving] = r.useState(false)
  const [uploadCount, setUploadCount] = r.useState(0)
  const savePending = r.useRef(false)
  const uploadPending = r.useRef(0)
  const editorVersion = r.useRef(0)
  const latestValue = r.useRef(value)
  latestValue.current = value
  const fingerprint = (item: Rec): string => JSON.stringify({ ...item, data: { ...item['data'], prompt_sets: item['data']?.['prompt_sets'] ?? [], examples: item['data']?.['examples'] ?? [] } })
  const baseline = r.useRef(fingerprint(entry))
  const [promptSet, setPromptSet] = r.useState(-1)
  const canLeave = (): boolean => !savePending.current && !uploadPending.current && (fingerprint(latestValue.current) === baseline.current || confirm('资料编辑尚未保存，放弃本次编辑？'))
  r.useEffect(() => guardNavigation?.(async () => canLeave()), [guardNavigation])

  r.useEffect(() => {
    const version = ++editorVersion.current
    uploadPending.current = 0
    setUploadCount(0)
    setValue(structuredClone(entry))
    latestValue.current = structuredClone(entry)
    baseline.current = fingerprint(entry)
    setPromptSet(-1)
    setError(null)
    return () => { if (editorVersion.current === version) editorVersion.current++ }
  }, [entry['id'], entry['kind'], entry['parent_id'], entry['revision']])

  const data = value['data'] as Rec
  const promptSets = (data['prompt_sets'] ??= []) as Rec[]
  const examples = (data['examples'] ??= []) as string[]
  const isNew = !value['id']
  const isBranch = value['kind'] === 'branch'
  const isCharacter = value['kind'] === 'character'

  const parentEntry = isBranch ? allCharacters.find((c) => c['id'] === value['parent_id']) : null
  const parentName = parentEntry ? String(parentEntry['name']) : ''
  let composed: { prompt: string; negative: string } | null = null
  let previewError: string | null = null
  try {
    composed = entryPrompt(value, [...allEntries.filter((item) => item['id'] !== value['id']), value], promptSet)
  } catch (e) { previewError = (e as Error).message }

  const switchTarget = (target: Rec): void => {
    if (!canLeave()) return
    if (onSwitchEntry) onSwitchEntry(target)
    else setValue(structuredClone(target))
  }
  const close = (): void => { if (canLeave()) onClose() }

  const save = async (apply = false): Promise<void> => {
    if (savePending.current || uploadPending.current) return
    savePending.current = true
    setSaving(true); setError(null)
    try {
      const dirty = fingerprint(latestValue.current) !== baseline.current
      const saved = apply && !isNew && !dirty ? latestValue.current : isNew
        ? await api<Rec>('/library', 'POST', latestValue.current)
        : await api<Rec>(`/library/${String(value['id'])}`, 'PUT', { ...latestValue.current, revision: value['revision'] })
      if (apply && onApplyToDraft) {
        latestValue.current = saved
        baseline.current = fingerprint(saved)
        setValue(saved)
        await onApplyToDraft(saved, promptSet)
        savePending.current = false
        onSaved()
        onApplied?.()
      } else onSaved()
    } catch (e) { setError((e as Error).message) }
    finally { savePending.current = false; setSaving(false) }
  }
  // Ctrl/Cmd+S saves from anywhere inside the editor; the ref keeps one listener
  // bound to the latest closure instead of re-registering on every keystroke.
  const saveRef = r.useRef(save)
  saveRef.current = save
  r.useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void saveRef.current()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])
  const addExample = async (file: File): Promise<void> => {
    if (savePending.current) return
    const version = editorVersion.current
    uploadPending.current++
    setUploadCount(uploadPending.current)
    try {
      const asset = await uploadFile(file)
      if (version !== editorVersion.current) return
      setValue((current) => ({ ...current, data: { ...current['data'], examples: [...(current['data']['examples'] ?? []), String(asset['id'])] } }))
    } catch (e) { if (version === editorVersion.current) setError((e as Error).message) }
    finally {
      if (version === editorVersion.current) { uploadPending.current--; setUploadCount(uploadPending.current) }
    }
  }

  const KIND_OPTIONS = [['character', '角色'], ['branch', '分支（需角色）'], ['artist', '画师'], ['blend', '混合'], ['preset', '预设']]
  const modalTitle = isNew
    ? (isBranch ? '新建角色分支' : '新建资料')
    : (isBranch
        ? `编辑分支 · ${parentName ? `${parentName} - ` : ''}${String(value['name'])}`
        : `编辑 · ${String(value['name'])}`)

  const myBranches = isCharacter && value['id'] ? allBranches.filter((b) => b['parent_id'] === value['id']) : []

  return h(Modal, {
    title: modalTitle, onClose: close, wide: true,
    footer: h('div', { className: 'modal-actions' },
      onApplyToDraft ? Button({ kind: 'ghost', disabled: saving || uploadCount > 0, onClick: () => void save(true), title: '保存编辑后填入当前创作草稿' }, '保存并填入草稿') : null,
      Button({ onClick: close, disabled: saving }, '取消'),
      Button({ kind: 'primary', disabled: saving || uploadCount > 0, title: '保存（Ctrl/⌘+S）', onClick: () => void save() }, '保存')),
  },
    h('fieldset', { disabled: saving, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } },
    ErrorBox({ error }),
    h('div', { className: 'nai-row' },
      h(Field, { label: '类型' }, Select({
        value: String(value['kind']), disabled: !isNew,
        onChange: (v: string) => setValue({ ...value, kind: v }),
        options: KIND_OPTIONS.map(([v2, l]) => ({ value: v2, label: l })),
      })),
      h(Field, { label: '名称' }, h('input', { value: String(value['name'] ?? ''), onChange: (e: Rec) => setValue({ ...value, name: (e.target as HTMLInputElement).value }) })),
      isBranch ? h(Field, { label: '所属角色' },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          Select({
            value: String(value['parent_id'] ?? ''),
            onChange: (v: string) => setValue({ ...value, parent_id: v }),
            options: [
              { value: '', label: '请选择所属角色…' },
              ...allCharacters.map((c) => ({ value: String(c['id']), label: String(c['name']) })),
            ],
            style: { flex: 1 },
          }),
          parentEntry ? Button({
            small: true, kind: 'ghost', icon: 'users',
            onClick: () => switchTarget(parentEntry),
            title: `快速跳转到角色「${parentName}」本体`,
          }, '角色本体') : null,
        ),
      ) : null,
    ),
    h('div', { className: 'nai-grid nai-lib-editor-meta', style: { gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'end' } },
      Field({ label: '标签', hint: '用逗号分隔，用于检索与画廊筛选；最多 16 个' }, h('input', {
        'aria-label': '资料标签',
        value: (Array.isArray(data['tags']) ? data['tags'] as string[] : []).join(', '),
        placeholder: '例如：黑发, 红瞳, 制服',
        onChange: (e: Rec) => {
          data['tags'] = (e.target as HTMLInputElement).value.split(/[,，]/u).map((tag) => tag.trim()).filter(Boolean)
          setValue({ ...value })
        },
      })),
      h('div', { className: 'nai-lib-editor-side' },
        Toggle({
          checked: data['favorite'] === true, label: '收藏此资料',
          onChange: (checked: boolean) => setValue({ ...value, data: { ...data, favorite: checked } }),
        }),
        h('span', { className: 'nai-lib-usage' },
          Number(data['use_count'] ?? 0) ? `使用 ${Number(data['use_count'])} 次` : '尚未使用',
          data['last_used_at'] ? ` · 最近 ${dateTimeLabel(data['last_used_at'])}` : ''))),
    h('div', { style: { height: 8 } }),
    h('div', { className: 'nai-grid', style: { gridTemplateColumns: '1fr 1fr' } },
      Field({
        label: '主提示词',
        hint: ['character', 'branch'].includes(String(value['kind'])) ? '定义角色专属的发型、瞳色、服装等身份特征' : undefined
      }, h('textarea', {
        id: 'nai-lib-entry-prompt',
        value: String(data['prompt'] ?? ''),
        style: { minHeight: 70 },
        placeholder: '输入主提示词…支持 tag 与自然语言混合',
        onChange: (e: Rec) => { data['prompt'] = (e.target as HTMLTextAreaElement).value; setValue({ ...value }) }
      })),
      Field({ label: '主负面' }, h('textarea', {
        id: 'nai-lib-entry-negative',
        value: String(data['negative_prompt'] ?? ''),
        style: { minHeight: 70 },
        placeholder: '输入主负面提示词…',
        onChange: (e: Rec) => { data['negative_prompt'] = (e.target as HTMLTextAreaElement).value; setValue({ ...value }) }
      })),
    ),
    isBranch ? h(Toggle, {
      checked: !data['replace_identity'], label: '继承角色本体提示词',
      onChange: (inherit: boolean) => setValue({ ...value, data: { ...data, replace_identity: !inherit } }),
    }) : null,
    value['kind'] === 'blend' ? h(BlendEditor, { data, onChange: () => setValue({ ...value }) }) : null,
    isCharacter ? h('div', {
      style: {
        marginTop: 10, padding: '10px 12px',
        background: 'var(--nai-panel-2)',
        borderRadius: 8,
        border: '1px solid var(--nai-border-soft)',
      }
    },
      h('div', { className: 'nai-row', style: { marginBottom: myBranches.length ? 8 : 4 } },
        h('strong', { style: { fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 } },
          h(Icon, { name: 'layers' }), '分支',
          h('span', { className: 'nai-pill', style: { fontSize: 10, padding: '1px 6px' } }, `${myBranches.length}`)
        ),
        h('span', { style: { flex: 1 } }),
        !isNew ? Button({
          small: true, kind: 'primary', icon: 'plus',
          onClick: () => {
            switchTarget({
              kind: 'branch',
              parent_id: value['id'],
              name: '',
              data: { prompt: '', negative_prompt: '', prompt_sets: [], examples: [], notes: '' },
            })
          },
          title: '为此角色创建新分支（如默认服装、泳装、战斗形态等）',
        }, '新建分支') : null,
      ),
      myBranches.length === 0
        ? h('div', { style: { color: 'var(--nai-faint)', fontSize: 12, padding: '2px 0' } },
            isNew ? '保存角色后可为此角色创建分支' : '该角色暂无分支（可点击右上角「新建分支」添加，如「默认服装」或「泳装」）'
          )
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            myBranches.map((b) => {
              const bExamples = ((b['data'] as Rec)?.['examples'] ?? []) as string[]
              const bPrompt = String((b['data'] as Rec)?.['prompt'] ?? '')
              return h('div', {
                key: String(b['id']),
                className: 'nai-card',
                style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', margin: 0, background: 'var(--nai-panel)' }
              },
                bExamples.length ? h('img', { alt: '资料例图',
                  src: assetThumb(bExamples[0]),
                  style: { width: 32, height: 42, objectFit: 'cover', borderRadius: 4, background: 'var(--nai-bg)' }
                }) : null,
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { fontWeight: 600, fontSize: 12 } }, String(b['name'])),
                  h('div', {
                    style: {
                      fontSize: 11, color: 'var(--nai-faint)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                    }
                  }, bPrompt || '（无分支提示词）')
                ),
                Button({
                  small: true, kind: 'ghost', icon: 'edit',
                  onClick: () => switchTarget(b),
                  title: `跳转编辑分支「${String(b['name'])}」`,
                }, '编辑此分支'),
              )
            }),
          ),
    ) : null,
    h('div', { style: { marginTop: 10 } },
      h('div', { className: 'nai-row' },
        h('strong', { style: { fontSize: 12 } }, '提示词组（同一身份的不同形态/服装）'),
        h('span', { style: { flex: 1 } }),
        Button({ small: true, icon: 'plus', onClick: () => { promptSets.push({ name: `组 ${promptSets.length + 1}`, prompt: '', negative_prompt: '' }); setValue({ ...value }) } }, '添加词组')),
      promptSets.map((set, i) => h('div', { className: 'nai-card', key: i, style: { padding: 8, marginTop: 6 } },
        h('div', { className: 'nai-row' },
          h('input', { value: String(set['name'] ?? ''), style: { width: 140 }, onChange: (e: Rec) => { set['name'] = (e.target as HTMLInputElement).value; setValue({ ...value }) } }),
          h('span', { style: { flex: 1 } }),
          Button({ small: true, kind: 'danger', icon: 'trash', onClick: () => { promptSets.splice(i, 1); setPromptSet((current) => current === i ? -1 : current > i ? current - 1 : current); setValue({ ...value }) } }, '删除')),
        h('textarea', { 'aria-label': `词组 ${i + 1} 提示词`, value: String(set['prompt'] ?? ''), placeholder: '词组提示词', style: { minHeight: 40, width: '100%', marginTop: 4 }, onChange: (e: Rec) => { set['prompt'] = (e.target as HTMLTextAreaElement).value; setValue({ ...value }) } }),
        h('textarea', { 'aria-label': `词组 ${i + 1} 负面提示词`, value: String(set['negative_prompt'] ?? ''), placeholder: '词组负面提示词', style: { minHeight: 40, width: '100%', marginTop: 4 }, onChange: (e: Rec) => { set['negative_prompt'] = (e.target as HTMLTextAreaElement).value; setValue({ ...value }) } }),
      ))),
    promptSets.length ? h('div', { className: 'nai-row', style: { marginTop: 10 } },
      h('span', { className: 'faint', style: { fontSize: 11 } }, '预览 / 应用时使用：'),
      Field({ label: '应用词组' }, Select({ value: String(promptSet), onChange: (selected: string) => setPromptSet(Number(selected)), options: [{ value: '-1', label: '主提示词' }, ...promptSets.map((group, index) => ({ value: String(index), label: String(group['name'] ?? `组 ${index + 1}`) }))] }))) : null,
    h('div', { className: 'nai-grid', style: { marginTop: 10, gridTemplateColumns: '1fr 1fr' }, 'aria-label': '合成预览' },
      Field({ label: '合成提示词' }, h('textarea', { readOnly: true, value: composed?.prompt ?? '', style: { minHeight: 60 } })),
      Field({ label: '合成负面词' }, h('textarea', { readOnly: true, value: composed?.negative ?? '', style: { minHeight: 60 } })),
      ErrorBox({ error: previewError })),
    h('div', { style: { marginTop: 10 } },
      h('div', { className: 'nai-row' },
        h('strong', { style: { fontSize: 12 } }, '例图'),
        h('span', { style: { flex: 1 } }),
        h('label', { className: 'nai-btn small' }, h(Icon, { name: 'plus' }), ' 上传例图',
          h('input', {
            type: 'file', accept: 'image/*', className: 'nai-file-input',
            onChange: (e: Rec) => {
              const file = (e.target as HTMLInputElement).files?.[0]
              if (file) void addExample(file)
            },
          }))),
      h('div', {
        className: 'nai-dropzone nai-row',
        style: { marginTop: 8, gap: 10, flexWrap: 'wrap' },
        onDragOver: (event: Rec) => { event.preventDefault(); event.stopPropagation() },
        onDrop: (event: Rec) => {
          event.preventDefault(); event.stopPropagation()
          const file = (event.dataTransfer as Rec | undefined)?.files?.[0] as File | undefined
          if (file) void addExample(file)
        },
      },
        examples.length ? null : h('span', { className: 'nai-dropzone-hint' }, '把图片拖到这里，或使用上方「上传例图」'),
        examples.map((id, index) =>
          h('span', { key: id, style: { position: 'relative', display: 'inline-block' } },
            h('img', { alt: '资料例图',
              src: assetThumb(id),
              style: {
                width: 120, height: 160, borderRadius: 8, objectFit: 'contain',
                background: 'var(--nai-panel-2)', border: '1px solid var(--nai-border-soft)',
                display: 'block',
              },
            }),
            index === 0
              ? h('span', { className: 'nai-cover-badge' }, '封面')
              : h('button', {
                  type: 'button', className: 'nai-cover-action', title: '设为资料卡封面',
                  onClick: () => {
                    const idx = examples.indexOf(id)
                    if (idx <= 0) return
                    const [moved] = examples.splice(idx, 1)
                    if (moved) examples.unshift(moved)
                    setValue({ ...value })
                  },
                }, '设为封面'),
            h('button', {
              type: 'button', 'aria-label': '移除此例图',
              onClick: () => { const idx = examples.indexOf(id); if (idx >= 0) { examples.splice(idx, 1); setValue({ ...value }) } },
              title: '移除此例图',
              style: {
                position: 'absolute', top: -6, right: -6, cursor: 'pointer', border: 0, padding: 0,
                background: 'var(--nai-danger)', color: '#fff', borderRadius: 999,
                width: 20, height: 20, display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
              },
            }, h(Icon, { name: 'close', size: 12 })),
          )),
      ),
    ),
      Field({ label: '备注' }, h('textarea', { value: String(data['notes'] ?? ''), style: { minHeight: 40 }, onChange: (e: Rec) => { data['notes'] = (e.target as HTMLTextAreaElement).value; setValue({ ...value }) } }))),
  )
}

function BlendEditor({ data, onChange }: { data: Rec; onChange: () => void }): Rec {
  const r = R()
  const [rows, setRows] = r.useState<Rec[]>([])
  const artists = (data['artists'] ??= []) as Rec[]
  r.useEffect(() => {
    void import('../api.ts').then(({ api }) => api<Rec[]>('/library?kind=artist')).then(setRows).catch(() => {})
  }, [])
  return h('div', { style: { marginTop: 8 } },
    h('div', { className: 'nai-row' },
      h('strong', { style: { fontSize: 12 } }, '混合画师（权重非 1 时生成加权语法）'),
      h('span', { style: { flex: 1 } }),
      Select({
        value: '', onChange: (v: string) => {
          if (v && !artists.some((a) => a['id'] === v)) { artists.push({ id: v, weight: 1 }); onChange() }
        },
        options: [{ value: '', label: '＋ 添加画师…' }, ...rows.map((a) => ({ value: String(a['id']), label: String(a['name']) }))],
      })),
    artists.map((artist, i) => h('div', { className: 'nai-row', key: i, style: { marginTop: 4 } },
      h('span', { style: { minWidth: 120 } }, String(rows.find((a) => a['id'] === artist['id'])?.['name'] ?? String(artist['id']).slice(0, 10))),
      h('input', { type: 'number', step: 0.05, value: Number(artist['weight'] ?? 1), style: { width: 90 }, onChange: (e: Rec) => { artist['weight'] = Number((e.target as HTMLInputElement).value); onChange() } }),
      h('span', { style: { flex: 1 } }),
      Button({ small: true, icon: 'close', iconOnly: true, kind: 'ghost', title: '移除此画师', onClick: () => { artists.splice(i, 1); onChange() }, style: { color: 'var(--nai-danger)' } }),
    )),
  )
}

function ImportDialog({ onClose, onPreview, onMerge, fail }: {
  onClose: () => void
  onPreview: (file: File) => Promise<Rec>
  onMerge: (file: File, choices: Rec, expectedRevisions: Rec) => Promise<void>
  fail: (e: unknown) => void
}): Rec {
  const r = R()
  const [file, setFile] = r.useState<File | null>(null)
  const [preview, setPreview] = r.useState<Rec | null>(null)
  const [choices, setChoices] = r.useState<Rec>({})
  const [revisions, setRevisions] = r.useState<Rec>({})
  const [busy, setBusy] = r.useState(false)
  const [error, setError] = r.useState<string | null>(null)
  const previewVersion = r.useRef(0)
  const merging = r.useRef(false)
  r.useEffect(() => () => { previewVersion.current++ }, [])
  const close = (): void => { if (!merging.current) { previewVersion.current++; onClose() } }
  const entries = (preview?.['entries'] ?? []) as Array<Rec>
  return h(Modal, { title: '导入资料包', onClose: close, wide: true },
    ErrorBox({ error }),
    h('div', { className: 'nai-row' },
      h('label', { className: 'nai-btn' }, file ? `已选择：${file.name}` : '选择 .zip 资料包',
        h('input', {
          type: 'file', accept: '.zip', className: 'nai-file-input',
          onChange: (e: Rec) => {
            if (merging.current) return
            const version = ++previewVersion.current
            const f = (e.target as HTMLInputElement).files?.[0] ?? null
            setFile(f); setPreview(null); setChoices({}); setRevisions({}); setError(null)
            setBusy(Boolean(f))
            if (f) {
              void onPreview(f)
                .then((result) => { if (version === previewVersion.current) setPreview(result) })
                .catch((e) => { if (version === previewVersion.current) setError((e as Error).message) })
                .finally(() => { if (version === previewVersion.current) setBusy(false) })
            }
          },
        })),
      h('span', { style: { flex: 1 } }),
      Button({
        kind: 'primary', disabled: !file || !preview || busy,
        onClick: () => {
          if (!file || !preview || busy || merging.current) return
          merging.current = true
          setBusy(true)
          void onMerge(file, choices, revisions).catch((e) => setError((e as Error).message)).finally(() => { merging.current = false; setBusy(false) })
        },
      }, busy ? '导入中…' : '导入'),
    ),
    h('div', { style: { height: 8 } }),
    !preview ? h('div', { className: 'nai-empty' }, '选择资料包后将显示对比预览，可为同名条目选择复制/跳过/更新。') : null,
    entries.map((row) => {
      const entry = row['entry'] as Rec
      const existing = row['existing'] as Rec | null
      return h('div', { className: 'nai-list item', key: String(entry['id']) },
        h('div', { className: 'grow' },
          h('div', null, h('strong', null, String(entry['name'])), ' ', h('span', { className: 'nai-tag' }, String(entry['kind']))),
          existing ? h('div', { className: 'sub' }, `已存在同名条目（rev ${String(existing['revision'])}）`) : null,
        ),
        existing ? Select({
          value: String(choices[String(entry['id'])] ?? (row['ambiguous'] ? '' : 'copy')),
          onChange: (v: string) => {
            setChoices({ ...choices, [String(entry['id'])]: v })
            if (v === 'update' || v === 'skip') setRevisions({ ...revisions, [String(existing['id'])]: existing['revision'] })
          },
          options: [
            { value: 'copy', label: '作为新条目复制' },
            { value: 'skip', label: '跳过' },
            { value: 'update', label: '更新现有条目' },
          ],
        }) : null,
      )
    }),
  )
}
