/** Draft management: list, switch, create/copy/delete, and explicit named versions. */
import type { WorkbenchState } from '../shell.tsx'
import { R, h, Button, Card, Field, Modal, ErrorBox, OkBox, Empty, keyboardActivate } from '../ui.tsx'
import { api, type Rec } from '../api.ts'
import { clearPendingDraft } from '../draft-cache.ts'

export function DraftsPanel({ state }: { state: WorkbenchState }): Rec {
  const r = R()
  const [drafts, setDrafts] = r.useState<Rec[]>([])
  const [versions, setVersions] = r.useState<{ id: string; items: Rec[] }>({ id: '', items: [] })
  const [versionOpen, setVersionOpen] = r.useState(false)
  const [versionName, setVersionName] = r.useState('')
  const [error, setError] = r.useState<string | null>(null)
  const [message, setMessage] = r.useState<string | null>(null)
  const [busy, setBusy] = r.useState(false)
  const pending = r.useRef(false)
  const generation = r.useRef(0)
  const activeId = String(state.draft?.['id'] ?? 'main')
  const activeRef = r.useRef(activeId)
  activeRef.current = activeId
  const path = (id: string): string => `/drafts/${encodeURIComponent(id)}`

  const load = async (): Promise<void> => {
    const sequence = ++generation.current
    const id = activeId
    try {
      const [rows, history] = await Promise.all([api<Rec[]>('/drafts'), api<Rec[]>(`${path(id)}/versions`)])
      if (sequence !== generation.current || id !== activeRef.current) return
      setDrafts(rows)
      setVersions({ id, items: history.filter((version) => String(version['name'] ?? '').trim()) })
    } catch (e) { if (sequence === generation.current && id === activeRef.current) setError((e as Error).message) }
  }
  r.useEffect(() => {
    void load()
    return () => { generation.current++ }
  }, [activeId, state.draft?.['revision']])

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true); setError(null); setMessage(null)
    try { await action() } catch (e) { setError((e as Error).message) }
    finally { pending.current = false; setBusy(false) }
  }
  const activate = (id: string): Promise<void> => run(async () => {
    if (id === activeRef.current) return
    await api(`${path(id)}/activate`, 'POST', {})
    // The new active-id effect loads its versions; never reload the old id here.
    await state.refresh()
  })
  const create = (): Promise<void> => run(async () => {
    await api('/drafts', 'POST', { draft: { name: `新草稿 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` } })
    await state.refresh()
  })
  const copy = (draft: Rec): Promise<void> => run(async () => {
    await api('/drafts', 'POST', { draft: { ...draft, name: `${String(draft['name'])} · 副本` }, activate: false })
    await load()
  })
  const remove = (draft: Rec): Promise<void> => run(async () => {
    if (!confirm(`删除草稿「${String(draft['name'])}」？${drafts.length === 1 ? '删除后将打开一份空白草稿。' : ''}`)) return
    const id = String(draft['id'])
    await api(`${path(id)}?revision=${String(draft['revision'])}`, 'DELETE')
    clearPendingDraft(id)
    await state.refresh()
    if (id !== activeId) await load()
  })
  const rename = (draft: Rec): Promise<void> => run(async () => {
    const name = prompt('新名称', String(draft['name']))
    if (!name?.trim() || name === draft['name']) return
    await api(path(String(draft['id'])), 'PUT', { name: name.trim(), revision: draft['revision'] })
    await state.refresh()
    await load()
  })
  const saveVersion = (): Promise<void> => run(async () => {
    await api(`${path(activeId)}/versions`, 'POST', { name: versionName, revision: state.draft?.['revision'] })
    setVersionOpen(false); setVersionName('')
    await load()
    setMessage('命名版本已保存')
  })
  const restoreVersion = (version: Rec): Promise<void> => run(async () => {
    if (versions.id !== activeRef.current || (version['draft_id'] && version['draft_id'] !== activeRef.current)) throw new Error('草稿已切换，请重新选择命名版本')
    const data = version['data'] as Rec
    await state.patchDraft({ ...data, id: activeId }, Number(state.draft?.['revision']))
    clearPendingDraft(activeId)
    await state.refresh()
    setMessage(`已恢复命名版本「${String(version['name'])}」`)
  })
  const items = versions.id === activeId ? versions.items : []

  return Card({ title: '草稿' },
    ErrorBox({ error }), OkBox({ text: message }),
    h('div', { className: 'nai-row', style: { marginBottom: 10 } },
      Button({ disabled: busy, onClick: () => void create() }, '＋ 新建草稿'),
      Button({ disabled: busy, onClick: () => void copy(state.draft!) }, '复制当前'),
      Button({ disabled: busy, onClick: () => void rename(state.draft!) }, '重命名当前'),
      Button({ disabled: busy, onClick: () => setVersionOpen(true) }, '保存命名版本'),
      Button({ kind: 'danger', small: true, disabled: busy, onClick: () => void run(async () => {
        if (!confirm('清空当前草稿的全部参数？如需保留当前内容，请先保存命名版本。')) return
        await api('/draft/reset', 'POST', { revision: state.draft?.['revision'], draft_id: activeId })
        clearPendingDraft(activeId)
        await state.refresh()
      }) }, '重置当前'),
    ),
    h('div', { className: 'nai-list' }, drafts.map((draft) =>
      h('div', {
        className: 'item' + (String(draft['id']) === activeId ? ' selected' : ''),
        key: String(draft['id']), role: 'button', tabIndex: 0, 'aria-disabled': busy,
        onKeyDown: keyboardActivate(() => void activate(String(draft['id']))),
        onClick: () => void activate(String(draft['id'])),
      },
        h('div', { className: 'grow' },
          h('div', null, h('strong', null, String(draft['name'])), String(draft['id']) === activeId ? h('span', { className: 'nai-tag', style: { marginLeft: 6 } }, '当前') : null),
          h('div', { className: 'sub' }, `${String((draft['request'] as Rec)?.['model'] ?? '')} · ${String((draft['request'] as Rec)?.['prompt'] ?? '').slice(0, 60)}`)),
        h('button', { type: 'button', disabled: busy, className: 'nai-icon-btn', 'aria-label': '复制草稿', onClick: (e: Rec) => { e.stopPropagation(); void copy(draft) }, title: '复制', style: { cursor: 'pointer', color: 'var(--nai-dim)' } }, '⧉'),
        h('button', { type: 'button', disabled: busy, className: 'nai-icon-btn', 'aria-label': '删除草稿', onClick: (e: Rec) => { e.stopPropagation(); void remove(draft) }, title: '删除', style: { cursor: 'pointer', color: 'var(--nai-danger)' } }, '✕'),
      ))),
    h('h3', { style: { margin: '14px 0 8px', fontSize: 12, color: 'var(--nai-faint)' } }, '命名版本'),
    items.length ? h('div', { className: 'nai-list' }, items.map((version) =>
      h('div', { className: 'item', key: String(version['id']) },
        h('div', { className: 'grow' },
          h('div', null, String(version['name'])),
          h('div', { className: 'sub' }, `rev ${String(version['revision'])} · ${new Date(String(version['created_at'])).toLocaleString('zh-CN')}`)),
        Button({ small: true, disabled: busy, onClick: () => void restoreVersion(version) }, '恢复此版本'),
      ))) : Empty({ text: '暂无命名版本；编辑会原地自动保存，不生成历史快照。' }),
    versionOpen ? h(Modal, {
      title: '保存命名版本', onClose: () => setVersionOpen(false),
      footer: h('div', { className: 'modal-actions' },
        Button({ onClick: () => setVersionOpen(false) }, '取消'),
        Button({ kind: 'primary', disabled: busy || !versionName.trim(), onClick: () => void saveVersion() }, '保存')),
    }, Field({ label: '版本名称（1–200 字）' },
      h('input', { value: versionName, onChange: (e: Rec) => setVersionName((e.target as HTMLInputElement).value) }))) : null,
  )
}
