/** Character / artist / blend / preset library with prompt sets, examples, import/export. */
import type { WorkbenchState } from '../shell.tsx'
import { R, h, Button, Card, Field, Modal, ErrorBox, Empty, Select, Spinner, keyboardActivate } from '../ui.tsx'
import { api, uploadFile, assetThumb, downloadPost, type Rec } from '../api.ts'
import { Icon } from '../icons.tsx'
import { ImagePreview } from '../image.tsx'

const KINDS = [
  ['character', '角色'], ['branch', '分支'], ['artist', '画师'], ['blend', '混合'], ['preset', '预设'],
] as const

export function LibraryPanel({ state }: { state: WorkbenchState }): Rec {
  const r = R()
  const [kind, setKind] = r.useState<string>('character')
  const [query, setQuery] = r.useState('')
  const [rows, setRows] = r.useState<Rec[]>([])
  const [allCharacters, setAllCharacters] = r.useState<Rec[]>([])
  const [allBranches, setAllBranches] = r.useState<Rec[]>([])
  const [editing, setEditing] = r.useState<Rec | null>(null)
  const [error, setError] = r.useState<string | null>(null)
  const [busy, setBusy] = r.useState(false)
  const [importOpen, setImportOpen] = r.useState(false)
  const loadVersion = r.useRef(0)
  r.useEffect(() => {
    if (!state.librarySeed) return
    setKind(String(state.librarySeed['kind'] ?? 'preset'))
    setEditing(structuredClone(state.librarySeed))
    state.clearLibrarySeed?.()
  }, [state.librarySeed])

  const load = async (): Promise<void> => {
    const version = ++loadVersion.current
    setBusy(true)
    try {
      const [resRows, resAll] = await Promise.all([
        api<Rec[]>(`/library?kind=${kind}&query=${encodeURIComponent(query)}`),
        api<Rec[]>('/library'),
      ])
      if (version !== loadVersion.current) return
      setRows(resRows)
      setAllCharacters(resAll.filter((e) => e['kind'] === 'character'))
      setAllBranches(resAll.filter((e) => e['kind'] === 'branch'))
      setError(null)
    } catch (e) { if (version === loadVersion.current) setError((e as Error).message) } finally { if (version === loadVersion.current) setBusy(false) }
  }
  R().useEffect(() => { void load() }, [kind, query])

  const remove = async (entry: Rec): Promise<void> => {
    if (!confirm(`删除「${String(entry['name'])}」？`)) return
    try {
      await api(`/library/${encodeURIComponent(String(entry['id']))}?revision=${String(entry['revision'])}`, 'DELETE')
      await load()
    } catch (e) { setError((e as Error).message) }
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
      req['prompt'] = [req['prompt'], p].filter(Boolean).join(', ')
      if (np) req['negative_prompt'] = [req['negative_prompt'], np].filter(Boolean).join(', ')
    }
    const refs = ((draft['library_refs'] ?? []) as Rec[]).slice()
    refs.push({ id: entry['id'], revision: preview['entry']?.['revision'] ?? entry['revision'], name: entry['name'], parent_id: entry['parent_id'] ?? entry['id'], prompt_set: promptSet, ...(slot !== null ? { slot } : {}) })
    await state.patchDraft({ id: draft['id'], request: req, library_refs: refs }, Number(draft['revision']))
  }

  return Card({ title: '资料库' },
    h('div', { className: 'nai-toolbar' },
      Select({ value: kind, onChange: setKind, options: KINDS.map(([v, l]) => ({ value: v, label: l })) }),
      h('div', { className: 'nai-search' }, h(Icon, { name: 'search' }), h('input', {
        'aria-label': '搜索资料', placeholder: '搜索名称或内容…', value: query,
        onChange: (e: Rec) => setQuery((e.target as HTMLInputElement).value),
      })),
      Button({ onClick: () => setEditing({ kind, name: '', data: { prompt: '', negative_prompt: '', prompt_sets: [], examples: [], notes: '' } }) }, '＋ 新建'),
      h('span', { style: { flex: 1 } }),
      Button({ small: true, onClick: () => { void downloadPost('/library/export', {}, 'atelier-library.zip').catch((e) => setError((e as Error).message)) } }, '导出全部'),
      Button({ small: true, onClick: () => setImportOpen(true) }, '导入'),
    ),
    ErrorBox({ error }),
    busy && !rows.length ? Empty({ text: '加载中 ' + '' }) : null,
    !busy && !rows.length ? Empty({ text: query ? '没有匹配的资料' : '暂无资料' }) : null,
    h('div', { className: 'nai-lib-grid' }, rows.map((entry) => {
      const examples = ((entry['data'] as Rec)?.['examples'] ?? []) as string[]
      const p = String((entry['data'] as Rec)?.['prompt'] ?? '')
      const np = String((entry['data'] as Rec)?.['negative_prompt'] ?? '')
      const id = String(entry['id'])
      const isBranch = entry['kind'] === 'branch'
      const isCharacter = entry['kind'] === 'character'
      const parentEntry = isBranch ? allCharacters.find((c) => c['id'] === entry['parent_id']) : null
      const parentName = isBranch ? String(entry['parent_name'] ?? parentEntry?.['name'] ?? '') : ''
      const displayName = isBranch && parentName ? `${parentName} - ${String(entry['name'])}` : String(entry['name'])
      const childBranches = isCharacter ? allBranches.filter((b) => b['parent_id'] === id) : []
      return h('div', {
        className: 'nai-lib-card', key: id, role: 'group', tabIndex: 0,
        'aria-label': displayName, onKeyDown: keyboardActivate(() => setEditing(structuredClone(entry))),
        onClick: () => setEditing(structuredClone(entry)),
      },
        h('div', { className: 'preview-box' },
          examples.length
            ? h(ImagePreview, { alt: displayName, src: assetThumb(String(examples[0])) })
            : h('div', { className: 'preview-empty' },
                h(Icon, { name: entry['kind'] === 'artist' ? 'brush' : entry['kind'] === 'blend' ? 'layers' : 'users', size: 28 }),
                h('span', { style: { fontSize: 11, color: 'var(--nai-faint)' } }, '暂无例图')),
          h('div', { style: { position: 'absolute', top: 8, left: 8, display: 'flex', gap: 4 } },
            h('span', { className: 'nai-pill', style: { padding: '2px 8px', fontSize: 10, background: 'rgba(24,26,29,0.88)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)' } },
              isBranch && parentName ? `${parentName} · 分支` : (KINDS.find(([k]) => k === entry['kind'])?.[1] ?? String(entry['kind']))),
          ),
          examples.length > 1 ? h('div', { style: { position: 'absolute', bottom: 8, right: 8 } },
            h('span', { className: 'nai-pill', style: { padding: '1px 6px', fontSize: 10, background: 'rgba(0,0,0,0.7)', color: '#fff' } }, h(Icon, { name: 'image', size: 12 }), `${examples.length} 张例图`)) : null,
        ),
        h('div', { className: 'content' },
          h('div', { className: 'header-row' },
            h('div', { className: 'name', title: displayName }, displayName),
            h('span', { className: 'nai-pill', style: { fontSize: 10, padding: '1px 5px' } }, `v${String(entry['revision'])}`),
          ),
          h('div', { className: 'prompt-preview', title: p || '无提示词' },
            p || h('span', { style: { color: 'var(--nai-faint)' } }, '（未设置主提示词）')),
          isCharacter && childBranches.length > 0 ? h('div', {
            style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', margin: '4px 0 2px' }
          },
            h('span', { style: { fontSize: 10, color: 'var(--nai-faint)' } }, '分支:'),
            childBranches.map((b) => h('button', {
              type: 'button',
              key: String(b['id']),
              className: 'nai-pill',
              title: `点击跳转编辑「${String(b['name'])}」`,
              style: {
                cursor: 'pointer', padding: '1px 6px', fontSize: 10,
                background: 'var(--nai-panel-2)',
                border: '1px solid var(--nai-border-soft)',
                color: 'var(--nai-accent)',
              },
              onClick: (e: Rec) => {
                e.stopPropagation()
                setEditing(structuredClone(b))
              },
            }, h(Icon, { name: 'layers', size: 12 }), String(b['name']))),
          ) : null,
          h('div', { className: 'actions' },
            Button({
              small: true, kind: 'primary',
              onClick: (e: Rec) => { e.stopPropagation(); void applyToDraft(entry).then(() => state.go('create')).catch((error) => setError((error as Error).message)) },
              title: '将该资料填入当前创作草稿并切换至创作页',
            }, '⤵ 填入草稿'),
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              isBranch && parentEntry ? Button({
                small: true, kind: 'ghost',
                onClick: (e: Rec) => { e.stopPropagation(); setEditing(structuredClone(parentEntry)) },
                title: `跳转到角色「${parentName}」本体`,
              }, '👤 本体') : null,
              isCharacter ? Button({
                small: true, kind: 'ghost',
                onClick: (e: Rec) => {
                  e.stopPropagation()
                  setEditing({ kind: 'branch', parent_id: id, name: '', data: { prompt: '', negative_prompt: '', prompt_sets: [], examples: [], notes: '' } })
                },
                title: '为此角色新建分支',
              }, '＋ 分支') : null,
              Button({
                small: true, kind: 'ghost',
                onClick: (e: Rec) => { e.stopPropagation(); setEditing(structuredClone(entry)) },
              }, '✎ 编辑'),
              h('button', {
                type: 'button', className: 'nai-icon-btn', 'aria-label': '删除资料',
                onClick: (e: Rec) => { e.stopPropagation(); void remove(entry) },
                title: '删除此资料',
                style: { cursor: 'pointer', color: 'var(--nai-danger)', padding: '2px 6px', fontSize: 13 },
              }, h(Icon, { name: 'trash' })),
            ),
          ),
        ),
      )
    })),
    editing ? h(EntryEditor, {
      entry: editing,
      allCharacters,
      allBranches,
      onClose: () => setEditing(null),
      onSaved: () => { setEditing(null); void load() },
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
        await load()
      },
      fail: (e: unknown) => setError((e as Error).message),
    }) : null,
  )
}

function EntryEditor({
  entry, allCharacters, allBranches, onClose, onSaved, onApplyToDraft, onSwitchEntry, fail, guardNavigation, onApplied
}: {
  entry: Rec
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
      ErrorBox({ error }),
      promptSets.length ? Field({ label: '应用词组' }, Select({ value: String(promptSet), onChange: (selected: string) => setPromptSet(Number(selected)), options: [{ value: '-1', label: '主提示词' }, ...promptSets.map((group, index) => ({ value: String(index), label: String(group['name'] ?? `组 ${index + 1}`) }))] })) : null,
      onApplyToDraft ? Button({ kind: 'ghost', disabled: saving || uploadCount > 0, onClick: () => void save(true), title: '保存编辑后填入当前创作草稿' }, '保存并填入草稿') : null,
      Button({ onClick: close, disabled: saving }, '取消'),
      Button({ kind: 'primary', disabled: saving || uploadCount > 0, onClick: () => void save() }, '保存')),
  },
    h('fieldset', { disabled: saving, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } },
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
            small: true, kind: 'ghost',
            onClick: () => switchTarget(parentEntry),
            title: `快速跳转到角色「${parentName}」本体`,
          }, '👤 角色本体') : null,
        ),
      ) : null,
    ),
    h('div', { style: { height: 8 } }),
    h('div', { className: 'nai-grid', style: { gridTemplateColumns: '1fr 1fr' } },
      Field({
        label: '主提示词',
        hint: ['character', 'branch'].includes(String(value['kind'])) ? '定义角色专属的发型、瞳色、服装等身份特征' : undefined
      }, h('textarea', { value: String(data['prompt'] ?? ''), style: { minHeight: 70 }, onChange: (e: Rec) => { data['prompt'] = (e.target as HTMLTextAreaElement).value; setValue({ ...value }) } })),
      Field({ label: '主负面' }, h('textarea', { value: String(data['negative_prompt'] ?? ''), style: { minHeight: 70 }, onChange: (e: Rec) => { data['negative_prompt'] = (e.target as HTMLTextAreaElement).value; setValue({ ...value }) } })),
    ),
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
          small: true, kind: 'primary',
          onClick: () => {
            switchTarget({
              kind: 'branch',
              parent_id: value['id'],
              name: '',
              data: { prompt: '', negative_prompt: '', prompt_sets: [], examples: [], notes: '' },
            })
          },
          title: '为此角色创建新分支（如默认服装、泳装、战斗形态等）',
        }, '＋ 新建分支') : null,
      ),
      myBranches.length === 0
        ? h('div', { style: { color: 'var(--nai-faint)', fontSize: 12, padding: '2px 0' } },
            isNew ? '保存角色后可为此角色创建分支' : '该角色暂无分支（可点击右上角「＋ 新建分支」添加，如「默认服装」或「泳装」）'
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
                  small: true, kind: 'ghost',
                  onClick: () => switchTarget(b),
                  title: `跳转编辑分支「${String(b['name'])}」`,
                }, '✎ 编辑此分支'),
              )
            }),
          ),
    ) : null,
    h('div', { style: { marginTop: 10 } },
      h('div', { className: 'nai-row' },
        h('strong', { style: { fontSize: 12 } }, '提示词组（同一身份的不同形态/服装）'),
        h('span', { style: { flex: 1 } }),
        Button({ small: true, onClick: () => { promptSets.push({ name: `组 ${promptSets.length + 1}`, prompt: '', negative_prompt: '' }); setValue({ ...value }) } }, '＋ 添加词组')),
      promptSets.map((set, i) => h('div', { className: 'nai-card', key: i, style: { padding: 8, marginTop: 6 } },
        h('div', { className: 'nai-row' },
          h('input', { value: String(set['name'] ?? ''), style: { width: 140 }, onChange: (e: Rec) => { set['name'] = (e.target as HTMLInputElement).value; setValue({ ...value }) } }),
          h('span', { style: { flex: 1 } }),
          Button({ small: true, kind: 'danger', onClick: () => { promptSets.splice(i, 1); setValue({ ...value }) } }, '删除')),
        h('textarea', { value: String(set['prompt'] ?? ''), placeholder: '词组提示词', style: { minHeight: 40, width: '100%', marginTop: 4 }, onChange: (e: Rec) => { set['prompt'] = (e.target as HTMLTextAreaElement).value; setValue({ ...value }) } }),
      ))),
    h('div', { style: { marginTop: 10 } },
      h('div', { className: 'nai-row' },
        h('strong', { style: { fontSize: 12 } }, '例图'),
        h('span', { style: { flex: 1 } }),
        h('label', { className: 'nai-btn small' }, '＋ 上传例图',
          h('input', {
            type: 'file', accept: 'image/*', className: 'nai-file-input',
            onChange: (e: Rec) => {
              const file = (e.target as HTMLInputElement).files?.[0]
              if (file) void addExample(file)
            },
          }))),
      h('div', { className: 'nai-row', style: { marginTop: 8, gap: 10, flexWrap: 'wrap' } },
        examples.map((id) =>
          h('span', { key: id, style: { position: 'relative', display: 'inline-block' } },
            h('img', { alt: '资料例图',
              src: assetThumb(id),
              style: {
                width: 120, height: 160, borderRadius: 8, objectFit: 'contain',
                background: 'var(--nai-panel-2)', border: '1px solid var(--nai-border-soft)',
                display: 'block',
              },
            }),
            h('button', {
              type: 'button', 'aria-label': '移除此例图',
              onClick: () => { const idx = examples.indexOf(id); if (idx >= 0) { examples.splice(idx, 1); setValue({ ...value }) } },
              title: '移除此例图',
              style: {
                position: 'absolute', top: -6, right: -6, cursor: 'pointer', border: 0, padding: 0,
                background: 'var(--nai-danger)', color: '#fff', borderRadius: 999,
                width: 20, height: 20, fontSize: 11, display: 'inline-flex',
                alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
              },
            }, '✕'),
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
