import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, uploadFile, downloadPost, type Rec } from '../client/api.ts'
import { LibraryPanel } from '../client/panels/library.tsx'
import { SchedulesPanel } from '../client/panels/schedules.tsx'
import { GalleryPanel } from '../client/panels/gallery.tsx'
import { WorkspacePanel } from '../client/panels/workspace.tsx'
import { MaskEditor } from '../client/panels/mask.tsx'
import { setReact, type ReactLike } from '../client/ui.tsx'

vi.mock('../client/api.ts', async (original) => ({ ...await original<object>(), api: vi.fn(), uploadFile: vi.fn(), downloadPost: vi.fn() }))

function harness() {
  let cursor = 0
  const slots: any[] = [], effects: Array<() => void | (() => void)> = [], cleanups: Array<() => void> = []
  const runtime = {
    createElement: (type: any, props: Rec | null, ...children: unknown[]) => ({ $$typeof: Symbol.for('react.element'), type, props: { ...props, children } }),
    cloneElement: (element: Rec, props: Rec) => ({ ...element, props: { ...element.props, ...props } }),
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial } },
    useMemo(fn: () => unknown) { cursor++; return fn() },
    useCallback(fn: any) { cursor++; return fn },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const index = cursor++, previous = slots[index]
      if (!previous || !deps || deps.some((value, i) => value !== previous[i])) { slots[index] = deps; effects.push(fn) }
    },
  } as ReactLike
  return {
    render(component: any, props: Rec) { setReact(runtime); cursor = 0; return component(props) as Rec },
    effects() { for (const fn of effects.splice(0)) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) } },
    cleanup() { cleanups.forEach((fn) => fn()) },
  }
}
function nodes(value: any): Rec[] { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children), ...nodes(value.props?.footer)] : [] }
function text(value: any): string { return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '') }
function button(tree: Rec, label: string): Rec { const node = nodes(tree).find((n) => n.type === 'button' && text(n) === label); if (!node) throw new Error(`Missing button: ${label}`); return node }
function component(tree: Rec, name: string): Rec { return nodes(tree).find((n) => typeof n.type === 'function' && n.type.name === name)! }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const entry = (id = 'entry'): Rec => ({ id, revision: 1, name: id, kind: 'character', data: { prompt: '', examples: [] } })
const plan = (id = 'plan'): Rec => ({ id, revision: 1, name: id, execution_mode: 'fixed', kind: 'daily', request: { prompt: 'scene' }, ai_recipe: { library_refs: [] } })
const state = { draft: { id: 'main', revision: 1, request: {} }, paused: false }
const entryRow = (item: Rec): Rec => ({
  ...item,
  prompt_preview: String((item['data'] as Rec | undefined)?.['prompt'] ?? ''),
  tags: (item['data'] as Rec | undefined)?.['tags'] ?? [],
  favorite: (item['data'] as Rec | undefined)?.['favorite'] === true,
  use_count: 0, last_used_at: null,
  prompt_set_count: ((item['data'] as Rec | undefined)?.['prompt_sets'] as unknown[] | undefined)?.length ?? 0,
  example_count: ((item['data'] as Rec | undefined)?.['examples'] as unknown[] | undefined)?.length ?? 0,
  cover_asset_id: ((item['data'] as Rec | undefined)?.['examples'] as string[] | undefined)?.[0] ?? null,
  branches: [],
})
const libraryPage = (entries: Rec[]): Rec => ({
  items: entries.map(entryRow), total: entries.length, next_offset: null,
  facets: {
    all: entries.length,
    kinds: Object.fromEntries(['character', 'branch', 'artist', 'blend', 'preset'].map((kind) => [kind, entries.filter((item) => item['kind'] === kind).length])),
    favorites: entries.filter((item) => (item['data'] as Rec | undefined)?.['favorite'] === true).length,
    tags: [],
  },
})
function mockLibrary(entries: Rec[]): void {
  vi.mocked(api).mockImplementation(async (path) => {
    if (String(path).startsWith('/library/query')) return libraryPage(entries) as any
    if (path === '/library') return entries as any
    return {} as any
  })
}

beforeEach(() => { vi.useFakeTimers(); vi.mocked(api).mockReset(); vi.mocked(uploadFile).mockReset(); vi.mocked(downloadPost).mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

async function libraryEditor(newEntry = false, entries = [entry()]) {
  mockLibrary(entries)
  const panel = harness()
  panel.render(LibraryPanel, { state }); panel.effects(); await settle()
  const tree = panel.render(LibraryPanel, { state })
  if (newEntry) button(tree, '新建').props.onClick()
  else nodes(tree).find((node) => node.props?.className === 'nai-lib-card')!.props.onClick()
  const editor = component(panel.render(LibraryPanel, { state }), 'EntryEditor'), view = harness()
  view.render(editor.type, editor.props); view.effects()
  return { editor, view, render: () => view.render(editor.type, editor.props), cleanup: () => panel.cleanup() }
}

async function scheduleEditor() {
  vi.mocked(api).mockImplementation(async (path) => path === '/schedules' ? [plan()] as any : [] as any)
  const panel = harness()
  panel.render(SchedulesPanel, { state }); panel.effects(); await settle()
  nodes(panel.render(SchedulesPanel, { state })).find((node) => node.props?.className === 'nai-sched-card')!.props.onClick()
  const editor = component(panel.render(SchedulesPanel, { state }), 'PlanEditor'), view = harness()
  view.render(editor.type, editor.props)
  return { editor, view, render: () => view.render(editor.type, editor.props), cleanup: () => panel.cleanup() }
}

describe('library editor async ownership', () => {
  it('preserves newer form edits when an example upload finishes', async () => {
    const pending = deferred<Rec>(), dialog = await libraryEditor()
    vi.mocked(uploadFile).mockReturnValue(pending.promise)
    const tree = dialog.render()
    nodes(tree).find((n) => n.type === 'input' && n.props?.type === 'file')!.props.onChange({ target: { files: [{}] } })
    nodes(tree).find((n) => n.type === 'input' && n.props?.value === 'entry')!.props.onChange({ target: { value: 'new name' } })
    pending.resolve({ id: 'uploaded' }); await settle()
    const result = dialog.render()
    expect(nodes(result).some((n) => n.type === 'input' && n.props?.value === 'new name')).toBe(true)
    expect(nodes(result).some((n) => n.type === 'img' && n.props?.src?.includes('/uploaded/'))).toBe(true)
    dialog.cleanup()
  })

  it('does not resurrect a different entry when an old example upload finishes', async () => {
    const pending = deferred<Rec>(), dialog = await libraryEditor()
    vi.mocked(uploadFile).mockReturnValue(pending.promise)
    nodes(dialog.render()).find((n) => n.type === 'input' && n.props?.type === 'file')!.props.onChange({ target: { files: [{}] } })
    dialog.editor.props.entry = entry('other')
    dialog.render(); dialog.view.effects()
    pending.resolve({ id: 'uploaded' }); await settle()
    const tree = dialog.render()
    expect(nodes(tree).some((n) => n.type === 'input' && n.props?.value === 'other')).toBe(true)
    expect(nodes(tree).some((n) => n.type === 'img' && n.props?.src?.includes('/uploaded/'))).toBe(false)
    dialog.cleanup()
  })

  it('submits a new entry once even when save is clicked twice before rerender', async () => {
    const pending = deferred<Rec>(), dialog = await libraryEditor(true)
    vi.mocked(api).mockReturnValue(pending.promise as any)
    const save = button(dialog.render(), '保存')
    save.props.onClick(); save.props.onClick()
    expect(vi.mocked(api).mock.calls.filter(([path, method]) => path === '/library' && method === 'POST')).toHaveLength(1)
    pending.resolve({}); await settle()
    dialog.cleanup()
  })

  it('saves edited content before applying it and keeps failed application recoverable', async () => {
    const dialog = await libraryEditor()
    const applied = vi.fn().mockRejectedValueOnce(new Error('Draft update failed')).mockResolvedValueOnce(undefined)
    const closed = vi.fn()
    dialog.editor.props.onApplyToDraft = applied
    dialog.editor.props.onSaved = closed
    const saved = { ...entry(), revision: 2, data: { prompt: 'latest edited prompt', examples: [] } }
    vi.mocked(api).mockResolvedValue(saved as any)
    nodes(dialog.render()).find((n) => n.type === 'textarea')!.props.onChange({ target: { value: 'latest edited prompt' } })
    button(dialog.render(), '保存并填入草稿').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/library/entry', 'PUT', expect.objectContaining({ data: expect.objectContaining({ prompt: 'latest edited prompt' }) }))
    expect(applied).toHaveBeenCalledWith(saved, -1)
    expect(closed).not.toHaveBeenCalled()
    expect(nodes(dialog.render()).filter((node) => node.props?.role === 'alert').map(text).join('')).toContain('Draft update failed')
    button(dialog.render(), '保存并填入草稿').props.onClick(); await settle()
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/library/entry')).toHaveLength(1)
    expect(applied).toHaveBeenCalledTimes(2)
    expect(closed).toHaveBeenCalledOnce()
    dialog.cleanup()
  })

  it('blocks navigation during library saves and asks before discarding dirty edits', async () => {
    const dialog = await libraryEditor()
    let guard!: () => Promise<boolean>
    dialog.editor.props.guardNavigation = (next: () => Promise<boolean>) => { guard = next; return () => {} }
    dialog.render(); dialog.view.effects()
    expect(await guard()).toBe(true)
    nodes(dialog.render()).find((n) => n.type === 'textarea')!.props.onChange({ target: { value: 'unsaved words' } })
    vi.stubGlobal('confirm', vi.fn(() => false))
    dialog.render()
    expect(await guard()).toBe(false)
    const pending = deferred<Rec>()
    vi.mocked(api).mockReturnValue(pending.promise as any)
    button(dialog.render(), '保存').props.onClick()
    expect(await guard()).toBe(false)
    pending.resolve(entry()); await settle()
    dialog.cleanup()
  })

  it('ties import previews to the selected file and ignores out-of-order responses', async () => {
    const first = deferred<Rec>(), second = deferred<Rec>()
    const panel = harness()
    vi.mocked(api).mockImplementation(async (path, method, body) => {
      if (path === '/library/import-preview') return (body as FormData).get('file') && String(((body as FormData).get('file') as File).name) === 'one.zip' ? first.promise as any : second.promise as any
      return [] as any
    })
    button(panel.render(LibraryPanel, { state }), '导入').props.onClick()
    const dialog = component(panel.render(LibraryPanel, { state }), 'ImportDialog'), view = harness()
    const render = () => { dialog.props = component(panel.render(LibraryPanel, { state }), 'ImportDialog').props; return view.render(dialog.type, dialog.props) }
    const choose = nodes(render()).find((n) => n.type === 'input' && n.props?.type === 'file')!
    choose.props.onChange({ target: { files: [new File(['one'], 'one.zip')] } })
    choose.props.onChange({ target: { files: [new File(['two'], 'two.zip')] } })
    second.resolve({ entries: [{ entry: entry('two'), existing: null }] }); await settle()
    first.resolve({ entries: [{ entry: entry('one'), existing: null }] }); await settle()
    expect(text(render())).toContain('two')
    expect(text(render())).not.toContain('one')
    panel.cleanup()
  })
})

describe('gallery tag filters', () => {
  it('offers character and artist entries in separate boxes and filters by their tag text', async () => {
    const character = { id: 'mira', revision: 1, kind: 'character', name: 'Mira', data: { prompt: 'shinonome akito, silver hair' } }
    const artist = { id: 'wlop', revision: 1, kind: 'artist', name: 'WLOP', data: { prompt: 'wlop' } }
    const branch = { id: 'winter', revision: 1, kind: 'branch', name: '冬装', parent_name: 'Mira', data: { prompt: 'winter coat' } }
    const job = { id: 'job-1', operation: 'generate', status: 'completed', created_at: new Date().toISOString(), request: { prompt: 'portrait, wlop', width: 832, height: 1216 }, assets: [{ id: 'asset-1', path: '/image.png', mime: 'image/png' }] }
    vi.mocked(api).mockImplementation(async (path) => {
      if (String(path).startsWith('/gallery?')) return { items: [job], total: 1 } as any
      if (path === '/library') return [character, artist, branch] as any
      if (path === '/schedules') return [] as any
      return {} as any
    })
    const panel = harness()
    panel.render(GalleryPanel, { state }); panel.effects(); await settle()
    let tree = panel.render(GalleryPanel, { state })
    expect(text(tree)).not.toContain('内容匹配')
    expect(text(tree)).not.toContain('资料匹配')
    const select = (label: string) => nodes(panel.render(GalleryPanel, { state })).find((node) => node.type === 'select' && node.props?.['aria-label'] === label)!
    select('角色').props.onFocus(); select('画师').props.onFocus(); await settle()
    panel.render(GalleryPanel, { state }); panel.effects(); await settle()
    const options = (node: Rec) => (node.props.children as unknown[]).flatMap((child) => Array.isArray(child) ? child : [child]) as Rec[]
    expect(options(select('角色')).map(text)).toEqual(['全部角色', 'Mira'])
    expect(options(select('画师')).map(text)).toEqual(['全部画师', 'WLOP'])

    select('角色').props.onChange({ target: { value: 'mira' } }); panel.render(GalleryPanel, { state }); panel.effects(); await settle()
    expect(api).toHaveBeenCalledWith(expect.stringContaining('character_id=mira'))
    select('画师').props.onChange({ target: { value: 'wlop' } }); panel.render(GalleryPanel, { state }); panel.effects(); await settle()
    expect(api).toHaveBeenCalledWith(expect.stringContaining('artist_id=wlop'))
    panel.cleanup()
  })
})

describe('library bulk export', () => {
  it('waits for a pause in typing before requesting another library search', async () => {
    const panel = harness()
    mockLibrary([])
    panel.render(LibraryPanel, { state }); panel.effects(); await settle()
    vi.mocked(api).mockClear()
    nodes(panel.render(LibraryPanel, { state })).find((node) => node.type === 'input' && node.props?.['aria-label'] === '搜索资料')!.props.onChange({ target: { value: 'forest' } })
    panel.render(LibraryPanel, { state }); panel.effects()
    vi.advanceTimersByTime(299)
    panel.render(LibraryPanel, { state }); panel.effects(); await settle()
    expect(api).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    panel.render(LibraryPanel, { state }); panel.effects(); await settle()
    expect(api).toHaveBeenCalledWith('/library/query?kind=all&query=forest&favorite=false&sort=updated&offset=0&limit=48')
    panel.cleanup()
  })

  it('exports the current selection once and can recover from a failed download', async () => {
    const pending = deferred<void>(), panel = harness()
    mockLibrary([entry('one'), entry('two')])
    vi.mocked(downloadPost).mockReturnValue(pending.promise)
    panel.render(LibraryPanel, { state }); panel.effects(); await settle()
    button(panel.render(LibraryPanel, { state }), '选择当前结果').props.onClick()
    const exportButton = button(panel.render(LibraryPanel, { state }), '导出所选 (2)')
    exportButton.props.onClick(); exportButton.props.onClick()
    button(panel.render(LibraryPanel, { state }), '导出全部').props.onClick()
    expect(downloadPost).toHaveBeenCalledExactlyOnceWith('/library/export', { ids: ['one', 'two'] }, 'atelier-library-selection.zip')
    expect(button(panel.render(LibraryPanel, { state }), '导出全部').props.disabled).toBe(true)
    pending.reject(new Error('Export failed')); await settle()
    expect(text(panel.render(LibraryPanel, { state }))).toContain('Export failed')
    vi.mocked(downloadPost).mockResolvedValue(undefined)
    button(panel.render(LibraryPanel, { state }), '导出所选 (2)').props.onClick(); await settle()
    expect(downloadPost).toHaveBeenCalledTimes(2)
    expect(text(panel.render(LibraryPanel, { state }))).not.toContain('Export failed')
    expect(button(panel.render(LibraryPanel, { state }), '导出全部').props.disabled).toBe(false)
    panel.cleanup()
  })

  it('prunes removed entries from the selection when rows are reloaded', async () => {
    const panel = harness()
    let entries = [entry('one'), entry('two')]
    vi.mocked(api).mockImplementation(async (path, method) => {
      if (method === 'DELETE') { entries = entries.filter((item) => item['id'] !== 'one'); return { deleted: true } as any }
      if (String(path).startsWith('/library/query')) return libraryPage(entries) as any
      if (path === '/library') return entries as any
      return {} as any
    })
    vi.stubGlobal('confirm', vi.fn(() => true))
    panel.render(LibraryPanel, { state }); panel.effects(); await settle()
    button(panel.render(LibraryPanel, { state }), '选择当前结果').props.onClick()
    nodes(panel.render(LibraryPanel, { state })).find((node) => node.type === 'button' && node.props?.title === '删除此资料')!.props.onClick({ stopPropagation() {} }); await settle()
    expect(button(panel.render(LibraryPanel, { state }), '导出所选 (1)')).toBeTruthy()
    button(panel.render(LibraryPanel, { state }), '导出所选 (1)').props.onClick(); await settle()
    expect(downloadPost).toHaveBeenCalledWith('/library/export', { ids: ['two'] }, 'atelier-library-selection.zip')
    panel.cleanup()
  })
})

describe('library composition editing', () => {
  const readOnlyValues = (tree: Rec) => nodes(tree).filter((node) => node.type === 'textarea' && node.props?.readOnly).map((node) => node.props.value)

  it('previews unsaved branch inheritance and lets the user opt out without changing the parent', async () => {
    const parent = { ...entry('parent'), data: { prompt: 'identity', negative_prompt: 'parent negative', examples: [] } }
    const branch = { ...entry('branch'), kind: 'branch', parent_id: 'parent', data: { prompt: 'coat', negative_prompt: 'branch negative', examples: [] } }
    const dialog = await libraryEditor(false, [branch, parent])
    expect(readOnlyValues(dialog.render())).toEqual(['identity, coat', 'parent negative, branch negative'])
    nodes(dialog.render()).find((node) => node.type === 'textarea' && node.props?.id === 'nai-lib-entry-prompt')!.props.onChange({ target: { value: 'cape' } })
    expect(readOnlyValues(dialog.render())).toEqual(['identity, cape', 'parent negative, branch negative'])
    component(dialog.render(), 'Toggle').props.onChange(false)
    expect(readOnlyValues(dialog.render())).toEqual(['cape', 'branch negative'])
    vi.mocked(api).mockClear()
    button(dialog.render(), '保存').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/library/branch', 'PUT', expect.objectContaining({ data: expect.objectContaining({ replace_identity: true, prompt: 'cape' }) }))
    expect(parent.data.prompt).toBe('identity')
    dialog.cleanup()
  })

  it('edits group negatives and previews the selected group with inherited identity', async () => {
    const parent = { ...entry('parent'), data: { prompt: 'identity', negative_prompt: 'parent negative', examples: [] } }
    const branch = { ...entry('branch'), kind: 'branch', parent_id: 'parent', data: { prompt: 'coat', prompt_sets: [{ name: 'Rain', prompt: 'raincoat', negative_prompt: 'old negative' }], examples: [] } }
    const dialog = await libraryEditor(false, [branch, parent])
    nodes(dialog.render()).find((node) => node.type === 'textarea' && node.props?.['aria-label'] === '词组 1 负面提示词')!.props.onChange({ target: { value: 'new negative' } })
    nodes(dialog.render()).find((node) => node.type === 'select' && node.props?.value === '-1')!.props.onChange({ target: { value: '0' } })
    expect(readOnlyValues(dialog.render())).toEqual(['identity, raincoat', 'parent negative, new negative'])
    button(dialog.render(), '保存').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/library/branch', 'PUT', expect.objectContaining({ data: expect.objectContaining({ prompt_sets: [{ name: 'Rain', prompt: 'raincoat', negative_prompt: 'new negative' }] }) }))
    dialog.cleanup()
  })

  it('resets application to the main prompt when the selected group is deleted', async () => {
    const grouped = { ...entry(), data: { prompt: 'main', prompt_sets: [{ name: 'Group', prompt: 'group' }], examples: [] } }
    const dialog = await libraryEditor(false, [grouped])
    nodes(dialog.render()).find((node) => node.type === 'select' && node.props?.value === '-1')!.props.onChange({ target: { value: '0' } })
    expect(readOnlyValues(dialog.render())[0]).toBe('group')
    button(dialog.render(), '删除').props.onClick()
    expect(readOnlyValues(dialog.render())[0]).toBe('main')
    const apply = vi.fn().mockResolvedValue(undefined)
    dialog.editor.props.onApplyToDraft = apply
    vi.mocked(api).mockResolvedValue({ ...grouped, revision: 2, data: { prompt: 'main', prompt_sets: [], examples: [] } } as any)
    button(dialog.render(), '保存并填入草稿').props.onClick(); await settle()
    expect(apply).toHaveBeenCalledWith(expect.anything(), -1)
    dialog.cleanup()
  })

  it('uses referenced artist weights in the composed preview', async () => {
    const blend = { ...entry('blend'), kind: 'blend', data: { prompt: '', artists: [{ id: 'artist', weight: 0.7 }], examples: [] } }
    const artist = { ...entry('artist'), kind: 'artist', data: { prompt: 'artist:example', examples: [] } }
    const dialog = await libraryEditor(false, [blend, artist])
    expect(readOnlyValues(dialog.render())[0]).toBe('0.7::artist:example::')
    dialog.cleanup()
  })
})

describe('schedule response ownership', () => {
  it.each(['resolve', 'reject'])('ignores the older %s after another run log is opened', async (outcome) => {
    const old = deferred<Rec[]>(), panel = harness()
    vi.mocked(api).mockImplementation(async (path) => path === '/schedules' ? [plan('one'), plan('two')] as any : path === '/schedules/one/runs' ? old.promise as any : path === '/schedules/two/runs' ? [{ outcome: 'completed', error: 'new log' }] as any : [] as any)
    panel.render(SchedulesPanel, { state }); panel.effects(); await settle()
    const tree = panel.render(SchedulesPanel, { state })
    const controls = nodes(tree).filter((n) => n.type === 'button' && text(n) === '执行记录')
    controls[0]!.props.onClick({ stopPropagation() {} }); controls[1]!.props.onClick({ stopPropagation() {} }); await settle()
    if (outcome === 'resolve') old.resolve([{ outcome: 'failed', error: 'old log' }])
    else old.reject(new Error('old failure'))
    await settle()
    const result = panel.render(SchedulesPanel, { state })
    expect(text(result)).toContain('new log')
    expect(text(result)).not.toContain('old')
    panel.cleanup()
  })

  it.each(['branch', 'blend'])('applies composed fixed %s content instead of its raw fragment', async (kind) => {
    const dialog = await scheduleEditor()
    const selected = { ...entry('ref'), kind, data: { prompt: 'raw' } }
    vi.mocked(api).mockImplementation(async (path) => path === '/library' ? [selected] as any : path === '/library/preview' ? { prompt: 'composed identity or artists', negative_prompt: 'composed negative' } as any : {} as any)
    dialog.view.effects(); await settle()
    button(dialog.render(), kind === 'branch' ? '添加角色' : '添加画师混合').props.onClick()
    // Branches are chosen from the all-kind selector in the picker.
    const select = nodes(dialog.render()).find((n) => n.type === 'select' && ['character', 'blend'].includes(n.props?.value))!
    select.props.onChange({ target: { value: '' } })
    nodes(dialog.render()).find((n) => n.props?.className === 'item')!.props.onClick(); await settle()
    button(dialog.render(), '保存').props.onClick(); await settle()
    const saved = vi.mocked(api).mock.calls.find(([path, method]) => path === '/schedules/plan' && method === 'PUT')![2] as Rec
    if (kind === 'branch') expect(saved.request.characters).toEqual([{ prompt: 'composed identity or artists', negative_prompt: 'composed negative' }])
    else expect(saved.request.prompt).toBe('scene, composed identity or artists')
    expect(saved.ai_recipe.library_refs).toEqual(['ref'])
    dialog.cleanup()
  })
})

describe('image and gallery async boundaries', () => {
  const job = (id: string): Rec => ({ id, status: 'completed', request: {}, assets: [] })
  it('does not reset immediate pagination when the search text has not changed', async () => {
    const panel = harness()
    vi.mocked(api).mockImplementation(async (path) => {
      const offset = Number(new URLSearchParams(path.split('?')[1]).get('offset'))
      return { total: 49, items: [job(offset ? 'last' : 'first')] } as any
    })
    panel.render(GalleryPanel, { state }); panel.effects(); await settle()
    button(panel.render(GalleryPanel, { state }), '下一页').props.onClick()
    panel.render(GalleryPanel, { state }); panel.effects(); await settle()
    await vi.advanceTimersByTimeAsync(300)
    const tree = panel.render(GalleryPanel, { state })
    expect(button(tree, '上一页').props.disabled).toBe(false)
    expect(nodes(tree).some((node) => node.props?.['aria-label'] === '选择作品 last')).toBe(true)
    panel.cleanup()
  })
  it('clamps an emptied last gallery page to the remaining page', async () => {
    const panel = harness()
    let archived = false
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/gallery/curate') { archived = true; return {} as any }
      const offset = Number(new URLSearchParams(path.split('?')[1]).get('offset'))
      return { total: archived ? 48 : 49, items: offset === 0 ? [job('first')] : archived ? [] : [job('last')] } as any
    })
    panel.render(GalleryPanel, { state }); panel.effects(); await settle()
    button(panel.render(GalleryPanel, { state }), '下一页').props.onClick()
    panel.render(GalleryPanel, { state }); panel.effects(); await settle()
    button(panel.render(GalleryPanel, { state }), '选择本页').props.onClick()
    button(panel.render(GalleryPanel, { state }), '归档所选').props.onClick(); await settle()
    panel.render(GalleryPanel, { state }); panel.effects(); await settle()
    expect(nodes(panel.render(GalleryPanel, { state })).some((n) => n.props?.['aria-label'] === '选择作品 first')).toBe(true)
    panel.cleanup()
  })

  it.each(['open', 'close'])('does not reopen an old focused job after a user %s action', async (action) => {
    const late = deferred<Rec>(), panel = harness(), current = { ...state, focusJobId: 'old' }
    vi.mocked(api).mockImplementation(async (path) => path.startsWith('/jobs/') ? late.promise as any : { total: 1, items: [job('new')] } as any)
    panel.render(GalleryPanel, { state: current }); panel.effects(); await settle()
    nodes(panel.render(GalleryPanel, { state: current })).find((n) => n.props?.className === 'cell')!.props.onClick()
    if (action === 'close') component(panel.render(GalleryPanel, { state: current }), 'JobPreview').props.onClose()
    late.resolve(job('old')); await settle()
    const preview = component(panel.render(GalleryPanel, { state: current }), 'JobPreview')
    if (action === 'close') expect(preview).toBeUndefined()
    else expect(preview.props.job.id).toBe('new')
    panel.cleanup()
  })

  it('keeps the newest source selection when two image uploads finish out of order', async () => {
    const first = deferred<Rec>(), second = deferred<Rec>(), panel = harness()
    const current = { ...state, bootstrap: {}, settings: {}, draft: { ...state.draft, name: 'draft', operation: 'img2img', request: {} }, patchDraft: vi.fn(async () => ({ revision: 2 })), fail: vi.fn(), go: vi.fn(), refresh: vi.fn() }
    vi.mocked(uploadFile).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const input = nodes(panel.render(WorkspacePanel, { state: current })).find((n) => n.type === 'input' && n.props?.type === 'file')!
    input.props.onChange({ target: { files: [{}] } }); input.props.onChange({ target: { files: [{}] } })
    second.resolve({ path: '/new.png' }); await settle()
    first.resolve({ path: '/old.png' }); await settle()
    expect(current.patchDraft).toHaveBeenCalledTimes(1)
    expect(current.patchDraft).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ image_path: '/new.png' }) }), 1)
    panel.cleanup()
  })

  it('ignores old mask image loads and uploaded masks after the source changes', async () => {
    const pending = deferred<Rec>(), panel = harness(), onSaved = vi.fn(), onClose = vi.fn()
    const props = { imagePath: '/one.png', onSaved, onClose }
    const context = { fillRect: vi.fn(), fillStyle: '' }
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['mask'])) }
    let tree = panel.render(MaskEditor, props); panel.effects()
    nodes(tree).find((n) => n.type === 'canvas')!.props.ref(canvas)
    const oldLoad = nodes(tree).find((n) => n.type === 'img')!.props.onLoad
    oldLoad({ target: { naturalWidth: 64, naturalHeight: 64 } })
    vi.mocked(uploadFile).mockReturnValue(pending.promise)
    button(panel.render(MaskEditor, props), '保存遮罩').props.onClick(); await settle()
    props.imagePath = '/two.png'
    tree = panel.render(MaskEditor, props); panel.effects()
    expect(button(tree, '保存中…').props.disabled).toBe(true)
    oldLoad({ target: { naturalWidth: 128, naturalHeight: 128 } })
    expect(canvas.width).toBe(64)
    pending.resolve({ path: '/old-mask.png' }); await settle()
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    panel.cleanup()
  })

  it('ignores an old A load after A to B to A and keeps readiness generation-bound', () => {
    const panel = harness(), props = { imagePath: '/a.png', onSaved: vi.fn(), onClose: vi.fn() }
    const context = { fillRect: vi.fn(), fillStyle: '' }, canvas = { width: 0, height: 0, getContext: () => context }
    let tree = panel.render(MaskEditor, props); panel.effects()
    nodes(tree).find((n) => n.type === 'canvas')!.props.ref(canvas)
    const oldLoad = nodes(tree).find((n) => n.type === 'img')!.props.onLoad
    const oldError = nodes(tree).find((n) => n.type === 'img')!.props.onError
    oldLoad({ target: { naturalWidth: 64, naturalHeight: 64 } })
    const oldSave = button(panel.render(MaskEditor, props), '保存遮罩')
    props.imagePath = '/b.png'; panel.render(MaskEditor, props); panel.effects()
    props.imagePath = '/a.png'; tree = panel.render(MaskEditor, props)
    expect(button(tree, '保存遮罩').props.disabled).toBe(true)
    oldSave.props.onClick()
    expect(uploadFile).not.toHaveBeenCalled()
    panel.effects()
    nodes(tree).find((n) => n.type === 'img')!.props.onLoad({ target: { naturalWidth: 128, naturalHeight: 128 } })
    oldLoad({ target: { naturalWidth: 64, naturalHeight: 64 } })
    oldError()
    expect(canvas.width).toBe(128)
    expect(button(panel.render(MaskEditor, props), '保存遮罩').props.disabled).toBe(false)
    panel.cleanup()
  })

  it('does not resurrect an in-flight source upload after a successful draft reset', async () => {
    const pending = deferred<Rec>(), panel = harness()
    vi.stubGlobal('confirm', () => true)
    const current = { ...state, bootstrap: {}, settings: {}, draft: { ...state.draft, name: 'draft', operation: 'img2img', request: {} }, patchDraft: vi.fn(async () => ({ revision: 3 })), fail: vi.fn(), go: vi.fn(), refresh: vi.fn() }
    vi.mocked(uploadFile).mockReturnValue(pending.promise)
    vi.mocked(api).mockResolvedValue({ revision: 2, operation: 'generate', request: { prompt: '' } } as any)
    const tree = panel.render(WorkspacePanel, { state: current })
    nodes(tree).find((n) => n.type === 'input' && n.props?.type === 'file')!.props.onChange({ target: { files: [{}] } })
    nodes(tree).find((n) => n.type === 'button' && n.props?.title === '重置草稿')!.props.onClick(); await settle()
    button(tree, '校验参数').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/validate', 'POST', { operation: 'generate', request: { prompt: '' } })
    pending.resolve({ path: '/obsolete.png' }); await settle()
    expect(current.patchDraft).not.toHaveBeenCalled()
    const result = panel.render(WorkspacePanel, { state: current })
    expect(nodes(result).some((n) => n.type === 'img' && n.props?.src?.includes('obsolete'))).toBe(false)
    expect(button(result, '生成').props.disabled).toBe(true)
    expect(nodes(result).find((n) => n.props?.['aria-label'] === '执行当前操作')!.props.disabled).toBe(true)
    panel.cleanup(); vi.unstubAllGlobals()
  })
})

describe('library card layout', () => {
  it('lays out entries in the same adaptive masonry as the gallery', async () => {
    mockLibrary([entry('character-a'), entry('character-b')])
    const panel = harness()
    panel.render(LibraryPanel, { state }); panel.effects(); await settle()
    const tree = panel.render(LibraryPanel, { state })
    const grid = nodes(tree).find((node) => node.props?.className === 'nai-lib-grid')!
    expect(grid.props['data-layout']).toBe('masonry')
    const cards = nodes(grid.props.children).filter((node) => node.props?.className === 'nai-lib-card')
    expect(cards).toHaveLength(2)
    panel.cleanup()
  })
})

describe('plan save transaction', () => {
  it('saves once and blocks edits and every close entrance until acknowledgement', async () => {
    const dialog = await scheduleEditor(), view = harness(), pending = deferred<Rec>()
    const props = { ...dialog.editor.props, plan: { ...plan(), id: undefined, enabled: true }, onClose: vi.fn(), onSaved: vi.fn() }
    const render = () => view.render(dialog.editor.type, props)
    const tree = render()
    vi.mocked(api).mockReturnValue(pending.promise as any)
    const save = button(tree, '保存')
    save.props.onClick(); save.props.onClick()
    expect(vi.mocked(api).mock.calls.filter(([path, method]) => path === '/schedules' && method === 'POST')).toHaveLength(1)
    button(tree, '取消').props.onClick()
    component(tree, 'Modal').props.onClose()
    expect(props.onClose).not.toHaveBeenCalled()
    const saving = render()
    expect(nodes(saving).find((n) => n.type === 'fieldset')!.props.disabled).toBe(true)
    nodes(saving).find((n) => n.type === 'input' && n.props?.value === 'plan')!.props.onChange({ target: { value: 'ignored during save' } })
    expect(nodes(render()).some((n) => n.type === 'input' && n.props?.value === 'plan')).toBe(true)
    pending.resolve({}); await settle()
    expect(props.onSaved).toHaveBeenCalledOnce()
    expect(nodes(render()).find((n) => n.type === 'fieldset')!.props.disabled).toBe(false)
    button(render(), '取消').props.onClick()
    expect(props.onClose).toHaveBeenCalledOnce()
    dialog.cleanup()
  })
})
