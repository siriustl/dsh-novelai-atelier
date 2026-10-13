import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, uploadFile, type Rec } from '../client/api.ts'
import { LibraryPanel } from '../client/panels/library.tsx'
import { SchedulesPanel } from '../client/panels/schedules.tsx'
import { GalleryPanel } from '../client/panels/gallery.tsx'
import { WorkspacePanel } from '../client/panels/workspace.tsx'
import { MaskEditor } from '../client/panels/mask.tsx'
import { setReact, type ReactLike } from '../client/ui.tsx'

vi.mock('../client/api.ts', async (original) => ({ ...await original<object>(), api: vi.fn(), uploadFile: vi.fn() }))

function harness() {
  let cursor = 0
  const slots: any[] = [], effects: Array<() => void | (() => void)> = [], cleanups: Array<() => void> = []
  const runtime = {
    createElement: (type: any, props: Rec | null, ...children: unknown[]) => ({ $$typeof: Symbol.for('react.element'), type, props: { ...props, children } }),
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

beforeEach(() => { vi.useFakeTimers(); vi.mocked(api).mockReset(); vi.mocked(uploadFile).mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

async function libraryEditor(newEntry = false) {
  vi.mocked(api).mockResolvedValue([entry()] as any)
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
