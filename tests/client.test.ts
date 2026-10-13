import { Store } from '../src/workbench/store.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button, Field, Modal, ErrorBox, OkBox, setReact, type ReactLike } from '../client/ui.tsx'
import { DraftSaveQueue } from '../client/draft-save.ts'
import { api, downloadUrl, downloadPost, saveBlob, type Rec } from '../client/api.ts'
import { Icon } from '../client/icons.tsx'
import { ImagePreview } from '../client/image.tsx'
import { modelLabel, dateTimeLabel } from '../client/format.ts'
import { cachePendingDraft, readPendingDraft } from '../client/draft-cache.ts'
import { LibraryPanel } from '../client/panels/library.tsx'
import { SchedulesPanel } from '../client/panels/schedules.tsx'
import { DraftsPanel } from '../client/panels/drafts.tsx'
import { GalleryPanel } from '../client/panels/gallery.tsx'
import { WorkspacePanel } from '../client/panels/workspace.tsx'
import { SettingsPanel } from '../client/panels/settings.tsx'
import { keyboardActivate } from '../client/ui.tsx'
import { Shell, type WorkbenchState } from '../client/shell.tsx'

vi.mock('../client/api.ts', async (original) => ({ ...await original<object>(), api: vi.fn(), downloadUrl: vi.fn(async () => {}), downloadPost: vi.fn(async () => {}), saveBlob: vi.fn() }))

function harness() {
  let cursor = 0
  const slots: any[] = []
  const effects: Array<() => void | (() => void)> = []
  const cleanups: Array<() => void> = []
  const runtime = {
    createElement(type: any, props: Rec | null, ...children: unknown[]) {
      return { $$typeof: Symbol.for('react.element'), type, props: { ...props, ...(children.length ? { children } : {}) } }
    },
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial } },
    useMemo(fn: () => unknown) { cursor++; return fn() },
    useCallback(fn: any) { cursor++; return fn },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || !deps || deps.some((value, i) => value !== previous[i])) { slots[index] = deps; effects.push(fn) }
    },
  } as ReactLike
  setReact(runtime)
  return {
    render(component: (props: any) => Rec, props: any): Rec { setReact(runtime); cursor = 0; return component(props) },
    effects() { for (const fn of effects.splice(0)) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) } },
    cleanup() { for (const fn of cleanups) fn() },
  }
}

function nodes(value: any): Rec[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object') return []
  return [value, ...nodes(value.props?.children)]
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join('')
  return value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')
}
function button(tree: Rec, label: string): Rec {
  const found = nodes(tree).find((node) => node.type === 'button' && text(node) === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function state(): WorkbenchState {
  return { bootstrap: {}, draft: { id: 'main', revision: 7, name: 'Draft', operation: 'generate', request: { model: 'nai-diffusion-5-full', prompt: '', width: 832, height: 1216 } }, settings: { token_configured: true }, assets: [], paused: false, error: null, refresh: vi.fn(async () => {}), patchDraft: vi.fn(async () => ({ revision: 8 })), fail: vi.fn(), go: vi.fn() }
}

beforeEach(() => { vi.useFakeTimers(); vi.mocked(api).mockReset(); vi.stubGlobal('confirm', () => true) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('shared frontend primitives', () => {
  it('keeps a newer polled draft when an older save acknowledgement arrives late', async () => {
    const current = { draft: { id: 'main', revision: 7, name: 'Draft', operation: 'generate', request: { prompt: 'original' } }, settings: { token_configured: false }, jobs: [] }
    const late = deferred<Rec>()
    let boot = current
    vi.mocked(api).mockImplementation(async (path) => path === '/draft' ? late.promise as any : structuredClone(boot) as any)
    const ui = harness()
    try {
      ui.render(Shell, {}); ui.effects(); await settle()
      const getState = () => nodes(ui.render(Shell, {})).find((node) => node.type === WorkspacePanel)!.props.state as WorkbenchState
      const pending = getState().patchDraft({ id: 'main', request: { prompt: 'mine' } }, 7)
      boot = { ...current, draft: { ...current.draft, revision: 9, request: { prompt: 'external-new' } } }
      await getState().refresh()
      expect(getState().draft?.revision).toBe(9)
      late.resolve({ ...current.draft, revision: 8, request: { prompt: 'mine' } }); await pending
      expect(getState().draft).toMatchObject({ revision: 9, request: { prompt: 'external-new' } })
    } finally { ui.cleanup() }
  })
  it('forwards click events and defaults to a non-submit button', () => {
    harness()
    const handler = vi.fn()
    const event = { stopPropagation: vi.fn() }
    const node = Button({ onClick: handler }, 'Edit')
    node.props.onClick(event)
    expect(handler).toHaveBeenCalledWith(event)
    expect(node.props.type).toBe('button')
  })
  it('associates field labels and descriptions with the input', () => {
    const ui = harness()
    const input = ui.render(() => ({ type: 'input', $$typeof: Symbol.for('react.element'), props: { value: 'x' } }), {})
    const tree = Field({ label: 'Prompt', hint: 'Hint' }, input)
    const label = nodes(tree).find((n) => n.type === 'label')!
    const control = nodes(tree).find((n) => n.type === 'input')!
    expect(label.props.htmlFor).toBe(control.props.id)
    expect(control.props['aria-describedby']).toBe(`${control.props.id}-hint`)
    expect(ErrorBox({ error: 'Failed' })?.props.role).toBe('alert')
    expect(OkBox({ text: 'Saved' })?.props.role).toBe('status')
  })
  it('exposes named modal dialog semantics and a viewport-bound width', () => {
    const ui = harness()
    const tree = ui.render(Modal, { title: 'Edit', wide: true, onClose: vi.fn() })
    const dialog = nodes(tree).find((n) => n.props?.role === 'dialog')!
    const title = nodes(dialog).find((n) => n.type === 'h2')!
    expect(dialog.props['aria-modal']).toBe(true)
    expect(dialog.props['aria-labelledby']).toBe(title.props.id)
    expect(dialog.props.style.maxWidth).toContain('100vw')
  })
})

describe('keyboard and error recovery', () => {
  it('traps Tab, closes only the topmost modal, and restores prior focus', () => {
    const ui = harness()
    const close = vi.fn()
    const doc: any = { activeElement: null, querySelectorAll: () => dialogs }
    const outside: any = { isConnected: true, focus: vi.fn(() => { doc.activeElement = outside }) }
    const first: any = { tabIndex: 0, hasAttribute: () => false, getClientRects: () => [1], focus: vi.fn(() => { doc.activeElement = first }) }
    const last: any = { ...first, focus: vi.fn(() => { doc.activeElement = last }) }
    const node: any = { querySelectorAll: () => [first, last], contains: (value: unknown) => value === first || value === last, focus: vi.fn() }
    let dialogs = [node]
    let listener!: (event: any) => void
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { addEventListener: (_: string, fn: any) => { listener = fn }, removeEventListener: vi.fn() })
    doc.activeElement = outside
    const tree = ui.render(Modal, { title: 'Edit', onClose: close })
    nodes(tree).find((n) => n.props?.role === 'dialog')!.props.ref(node)
    ui.effects()
    expect(first.focus).toHaveBeenCalled()
    doc.activeElement = last
    const event = { key: 'Tab', preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }
    listener(event)
    expect(doc.activeElement).toBe(first)
    listener({ ...event, shiftKey: true })
    expect(doc.activeElement).toBe(last)
    dialogs = [node, {} as any]
    listener({ ...event, key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
    dialogs = [node]
    listener({ ...event, key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    ui.cleanup()
    expect(doc.activeElement).toBe(outside)
  })
  it('activates non-native actions by keyboard but ignores keys from nested controls', () => {
    const action = vi.fn()
    const target = {}
    const handler = keyboardActivate(action)
    handler({ key: 'Enter', target, currentTarget: target, preventDefault: vi.fn() })
    handler({ key: ' ', target: {}, currentTarget: target, preventDefault: vi.fn() })
    expect(action).toHaveBeenCalledOnce()
  })
  it('retains a failed credential save for retry and clears it only on success', async () => {
    const current = state()
    current.settings = { token_configured: false, ai: {} }
    vi.mocked(api).mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce({})
    const ui = harness()
    const tree = ui.render(SettingsPanel, { state: current })
    const input = { value: 'pst-secret' }
    nodes(tree).find((n) => n.type === 'input' && n.props?.type === 'password')!.props.ref(input)
    button(tree, '\u4fdd\u5b58\u4ee4\u724c').props.onClick(); await settle()
    expect(input.value).toBe('pst-secret')
    expect(nodes(ui.render(SettingsPanel, { state: current })).some((n) => n.props?.role === 'alert' && text(n).includes('Network unavailable'))).toBe(true)
    button(tree, '\u4fdd\u5b58\u4ee4\u724c').props.onClick(); await settle()
    expect(input.value).toBe('')
  })
  it('does not clear a replacement typed while the earlier credential save is pending', async () => {
    const current = state()
    current.settings = { token_configured: false, ai: {} }
    const pending = deferred<Rec>()
    vi.mocked(api).mockReturnValueOnce(pending.promise)
    const ui = harness()
    const tree = ui.render(SettingsPanel, { state: current })
    const input = { value: 'pst-first' }
    nodes(tree).find((n) => n.type === 'input' && n.props?.type === 'password')!.props.ref(input)
    button(tree, '\u4fdd\u5b58\u4ee4\u724c').props.onClick()
    input.value = 'pst-next'
    pending.resolve({}); await settle()
    expect(input.value).toBe('pst-next')
    expect(api).toHaveBeenCalledWith('/settings', 'PUT', { nai_token: 'pst-first' })
  })
  it('exports backups through the shared download lifecycle', async () => {
    const current = state()
    current.settings = { ai: {} }
    const blob = new Blob(['offline backup'])
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers({ 'Content-Disposition': 'attachment; filename="snapshot.zip"' }), blob: async () => blob })))
    vi.mocked(saveBlob).mockClear()
    const ui = harness()
    button(ui.render(SettingsPanel, { state: current }), '导出备份').props.onClick()
    await settle()
    expect(saveBlob).toHaveBeenCalledWith(blob, 'snapshot.zip')
  })
  it('serializes blur saves while preserving a token click made during autosave', async () => {
    const current = state()
    current.settings = { ai: {}, output_directory: 'C:/old', retry_delay_seconds: 3, retry_max_attempts: 3 }
    const first = deferred<Rec>()
    vi.mocked(api).mockReturnValueOnce(first.promise as any).mockResolvedValue({} as any)
    const ui = harness()
    let tree = ui.render(SettingsPanel, { state: current })
    nodes(tree).find((node) => node.type === 'input' && node.props?.defaultValue === 'C:/old')!.props.onBlur({ target: { value: 'C:/new' } })
    tree = ui.render(SettingsPanel, { state: current })
    const token = { value: 'pst-queued-save' }
    nodes(tree).find((node) => node.type === 'input' && node.props?.type === 'password')!.props.ref(token)
    expect(button(tree, '保存令牌').props.disabled).toBe(false)
    button(tree, '保存令牌').props.onClick()
    nodes(tree).find((node) => node.type === 'input' && node.props?.max === 60)!.props.onBlur({ target: { value: '5' } })
    await settle()
    expect(api).toHaveBeenCalledTimes(1)
    first.resolve({}); await settle()
    expect(vi.mocked(api).mock.calls.map((call) => call[2])).toEqual([{ output_directory: 'C:/new' }, { nai_token: 'pst-queued-save' }, { retry_delay_seconds: 5 }])
    expect(token.value).toBe('')
    expect(nodes(tree).find((node) => node.type === 'input' && node.props?.max === 10)!.props.onChange).toBeUndefined()
  })
  it('uses the host-injected API prefix rather than a hardcoded route', async () => {
    vi.stubGlobal('__NAI_ATELIER_API_PREFIX__', '/custom/atelier/')
    vi.resetModules()
    const actual = await vi.importActual<typeof import('../client/api.ts')>('../client/api.ts')
    expect(actual.API_BASE).toBe('/custom/atelier/api')
    expect(actual.assetThumb('image')).toBe('/custom/atelier/api/assets/image/thumb')
  })
})

describe('library search ordering and encoded Vibe flows', () => {
  it.each(['resolve', 'reject'])('ignores a stale library response that later %ss', async (outcome) => {
    const old = deferred<Rec[]>()
    const newest = { id: 'new', revision: 0, kind: 'character', name: 'Newest entry', data: {} }
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/library') return [] as any
      if (path.endsWith('query=')) return old.promise as any
      return [newest] as any
    })
    const current = state()
    const ui = harness()
    let tree = ui.render(LibraryPanel, { state: current }); ui.effects()
    nodes(tree).find((n) => n.type === 'input' && n.props?.placeholder)!.props.onChange({ target: { value: 'new' } })
    tree = ui.render(LibraryPanel, { state: current }); ui.effects(); await settle()
    expect(text(ui.render(LibraryPanel, { state: current }))).toContain('Newest entry')
    if (outcome === 'resolve') old.resolve([{ id: 'old', kind: 'character', name: 'Obsolete entry', data: {} }])
    else old.reject(new Error('Obsolete failure'))
    await settle()
    tree = ui.render(LibraryPanel, { state: current })
    expect(text(tree)).toContain('Newest entry')
    expect(text(tree)).not.toContain('Obsolete')
    ui.cleanup()
  })

  async function encodedPreview(current: WorkbenchState, mutate?: () => Promise<Rec>) {
    const job = { id: 'encoded-job', operation: 'encode_vibe', request: { model: 'nai-diffusion-4-5-curated', information_extracted: 0.7 }, assets: [{ id: 'vibe', name: 'encoded.vibe', path: '/assets/encoded.vibe', mime: 'application/octet-stream' }] }
    vi.mocked(api).mockImplementation(async (path) => path.startsWith('/gallery?') ? { items: [job], total: 1 } as any : mutate ? await mutate() as any : {} as any)
    const ui = harness()
    ui.render(GalleryPanel, { state: current }); ui.effects(); await settle()
    let tree = ui.render(GalleryPanel, { state: current })
    nodes(tree).find((n) => n.props?.className === 'cell')!.props.onClick()
    tree = ui.render(GalleryPanel, { state: current })
    const preview = nodes(tree).find((n) => typeof n.type === 'function' && n.type.name === 'JobPreview')!
    const previewUi = harness()
    return { tree: previewUi.render(preview.type, preview.props), render: () => previewUi.render(preview.type, preview.props), cleanup: () => ui.cleanup() }
  }

  it('downloads encoded Vibe files directly and reuses the encoding model with a revision guard', async () => {
    vi.mocked(downloadUrl).mockClear()
    const current = state()
    current.draft!.request = { ...current.draft!.request, prompt: 'Preserved prompt', quality_preset: 'light', transparent_background: true }
    const preview = await encodedPreview(current)
    nodes(preview.tree).find((n) => n.type === 'button' && n.props?.title === '\u4e0b\u8f7d\u8f93\u51fa\u6587\u4ef6')!.props.onClick()
    await settle()
    expect(downloadUrl).toHaveBeenCalledWith('/api/nai/api/assets/vibe/file', 'encoded.vibe')
    button(preview.tree, '\u7528\u4f5c Vibe \u53c2\u8003').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/draft', 'PATCH', {
      id: 'main', base_revision: 7, operation: 'reference_generate', request: {
        ...current.draft!.request, model: 'nai-diffusion-4-5-curated', quality_preset: 'standard', transparent_background: false,
        vibes: [{ encoding_path: '/assets/encoded.vibe', strength: 0.6 }], precise_references: [],
      },
    })
    expect(current.go).toHaveBeenCalledWith('create')
    expect(current.draft!.request.model).toBe('nai-diffusion-5-full')
    preview.cleanup()
  })

  it('does not replace existing references when the user declines confirmation', async () => {
    const current = state()
    current.draft!.request.precise_references = [{ image_path: '/existing.png' }]
    vi.stubGlobal('confirm', vi.fn(() => false))
    const preview = await encodedPreview(current)
    button(preview.tree, '\u7528\u4f5c Vibe \u53c2\u8003').props.onClick(); await settle()
    expect(confirm).toHaveBeenCalledOnce()
    expect(api).not.toHaveBeenCalledWith('/draft', 'PATCH', expect.anything())
    expect(current.go).not.toHaveBeenCalled()
    preview.cleanup()
  })

  it('keeps revision conflicts visible and does not navigate away from the encoded output', async () => {
    const current = state()
    const preview = await encodedPreview(current, async () => { throw new Error('Draft revision conflict') })
    button(preview.tree, '\u7528\u4f5c Vibe \u53c2\u8003').props.onClick(); await settle()
    expect(current.go).not.toHaveBeenCalled()
    expect(nodes(preview.render()).some((n) => n.props?.role === 'alert' && text(n).includes('Draft revision conflict'))).toBe(true)
    preview.cleanup()
  })
})

describe('draft navigation and local saves', () => {
  it('syncs repeated mode switches to one real stored draft without creating history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nai-editor-switch-'))
    const store = new Store(root)
    const current = state()
    current.draft = store.getDraft()
    current.patchDraft = vi.fn(async (patch, revision) => {
      const saved = store.saveDraft(patch, revision)
      current.draft = saved
      return saved
    })
    store.saveVersion('main', 'Explicit checkpoint', 0)
    const ui = harness()
    try {
      const tree = ui.render(WorkspacePanel, { state: current }); ui.effects()
      for (let i = 0; i < 20; i++) {
        button(tree, i % 2 ? '文生图' : '图生图').props.onClick()
        await vi.advanceTimersByTimeAsync(250)
      }
      expect(store.listDrafts()).toHaveLength(1)
      expect(store.data.draft_versions).toHaveLength(1)
      expect(store.getDraft()).toMatchObject({ id: 'main', operation: 'generate', revision: 20 })
      expect(new Store(root).getDraft()).toEqual(store.getDraft())
      expect(api).not.toHaveBeenCalled()
      const synced = ui.render(WorkspacePanel, { state: current })
      expect(text(synced)).toContain('已同步')
      expect(nodes(synced).some(node => node.props?.className === 'nai-revision')).toBe(false)
    } finally { ui.cleanup(); rmSync(root, { recursive: true, force: true }) }
  })
  it('exposes deletion for the default main draft and uses its current revision', async () => {
    const current = state()
    vi.mocked(api).mockImplementation(async (path) => path === '/drafts' ? [current.draft] as any : [] as any)
    const ui = harness()
    ui.render(DraftsPanel, { state: current }); ui.effects(); await settle()
    const tree = ui.render(DraftsPanel, { state: current })
    nodes(tree).find((node) => node.props?.['aria-label'] === '删除草稿')!.props.onClick({ stopPropagation: vi.fn() })
    await settle()
    expect(api).toHaveBeenCalledWith('/drafts/main?revision=7', 'DELETE')
    expect(current.refresh).toHaveBeenCalledOnce()
    ui.cleanup()
  })

  it('does not let old version loads replace the newly selected draft versions', async () => {
    const stale = deferred<Rec[]>()
    const current = state()
    vi.mocked(api).mockImplementation(async (path) => path === '/drafts/main/versions' ? stale.promise as any : path === '/drafts/other/versions' ? [{ id: 'new-version', draft_id: 'other', name: 'Newest version', data: {} }] as any : [] as any)
    const ui = harness()
    ui.render(DraftsPanel, { state: current }); ui.effects(); await settle()
    current.draft = { ...current.draft, id: 'other', revision: 0 }
    ui.render(DraftsPanel, { state: current }); ui.effects(); await settle()
    stale.resolve([{ id: 'old-version', draft_id: 'main', name: 'Obsolete version', data: {} }]); await settle()
    const tree = ui.render(DraftsPanel, { state: current })
    expect(text(tree)).toContain('Newest version')
    expect(text(tree)).not.toContain('Obsolete version')
    ui.cleanup()
  })

  it('keeps restore conflicts visible instead of reporting success or clearing local content', async () => {
    const current = state()
    current.patchDraft = vi.fn(async () => { throw new Error('Revision conflict') })
    const remove = vi.fn()
    vi.stubGlobal('sessionStorage', { getItem: () => null, removeItem: remove })
    vi.mocked(api).mockImplementation(async (path) => path.endsWith('/versions') ? [{ id: 'v', draft_id: 'main', name: 'Named', data: current.draft }] as any : [] as any)
    const ui = harness()
    ui.render(DraftsPanel, { state: current }); ui.effects(); await settle()
    button(ui.render(DraftsPanel, { state: current }), '恢复此版本').props.onClick(); await settle()
    const tree = ui.render(DraftsPanel, { state: current })
    expect(text(tree)).toContain('Revision conflict')
    expect(text(tree)).not.toContain('已恢复命名版本')
    expect(remove).not.toHaveBeenCalled()
    ui.cleanup()
  })

  it('caches the newest edit immediately while an earlier save is still in flight', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
    const first = deferred<Rec>()
    const current = state()
    current.patchDraft = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ revision: 9 })
    const ui = harness()
    const tree = ui.render(WorkspacePanel, { state: current }); ui.effects()
    const prompt = nodes(tree).find((node) => node.props?.id === 'nai-prompt')!
    prompt.props.onChange({ target: { value: 'first' } })
    await vi.advanceTimersByTimeAsync(250)
    prompt.props.onChange({ target: { value: 'latest unsaved' } })
    expect(readPendingDraft('main')?.request.prompt).toBe('latest unsaved')
    first.resolve({ revision: 8 }); await settle()
    expect(current.patchDraft).toHaveBeenLastCalledWith(expect.objectContaining({ request: expect.objectContaining({ prompt: 'latest unsaved' }) }), 8)
    expect(readPendingDraft('main')).toBeNull()
    ui.cleanup()
  })

  it('ignores the selected mode and identical input, then coalesces switching with typing', async () => {
    const current = state()
    const ui = harness()
    const tree = ui.render(WorkspacePanel, { state: current }); ui.effects()
    button(tree, '文生图').props.onClick()
    nodes(tree).find((node) => node.props?.id === 'nai-prompt')!.props.onChange({ target: { value: '' } })
    await vi.advanceTimersByTimeAsync(300)
    expect(current.patchDraft).not.toHaveBeenCalled()
    for (let i = 0; i < 100; i++) nodes(tree).find((node) => node.props?.id === 'nai-prompt')!.props.onChange({ target: { value: `edit ${i}` } })
    button(tree, '图生图').props.onClick()
    await vi.advanceTimersByTimeAsync(250)
    expect(current.patchDraft).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'main', operation: 'img2img', request: expect.objectContaining({ prompt: 'edit 99' }) }), 7)
    expect(api).not.toHaveBeenCalled()
    ui.cleanup()
  })
})

describe('serialized optimistic draft saves', () => {
  it('coalesces rapid edits and uses each returned revision', async () => {
    const first = deferred<Rec>()
    const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ revision: 9 })
    const queue = new DraftSaveQueue(7, send)
    const wait = queue.enqueue({ request: { prompt: 'a' } })
    void queue.enqueue({ request: { prompt: 'ab' }, operation: 'generate' })
    void queue.enqueue({ request: { prompt: 'abc', scale: 5 } })
    expect(send).toHaveBeenCalledTimes(1)
    first.resolve({ revision: 8 })
    await wait
    await queue.flush()
    expect(send.mock.calls[1]).toEqual([{ request: { prompt: 'abc', scale: 5 }, operation: 'generate' }, 8])
    expect(queue.revision).toBe(9)
  })
  it('retains a conflict and prevents submission until the conflict is resolved', async () => {
    const error = new Error('Conflict')
    const queue = new DraftSaveQueue(7, vi.fn().mockRejectedValue(error))
    await expect(queue.enqueue({ request: { prompt: 'unsaved' } })).rejects.toThrow('Conflict')
    expect(queue.failed).toBe(true)
    await expect(queue.flush()).rejects.toThrow('Conflict')
    expect(queue.revision).toBe(7)
  })
})

describe('frontend route and revision flows', () => {
  it('applies composed library prompts with a revision and uses the real delete route', async () => {
    const entry = { id: 'branch', revision: 2, kind: 'branch', name: 'Branch', data: { prompt: 'clothes' } }
    vi.mocked(api).mockImplementation(async (path) => path === '/library/preview' ? { prompt: 'identity, clothes', negative_prompt: 'wrong identity' } as any : path.startsWith('/library?') || path === '/library' ? [entry] as any : {} as any)
    const current = state()
    const ui = harness()
    ui.render(LibraryPanel, { state: current }); ui.effects(); await settle()
    const tree = ui.render(LibraryPanel, { state: current })
    const event = { stopPropagation: vi.fn() }
    button(tree, '\u586b\u5165\u8349\u7a3f').props.onClick(event)
    await settle()
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(current.patchDraft).toHaveBeenCalledWith({ id: 'main', request: { ...current.draft!.request, characters: [{ prompt: 'identity, clothes', negative_prompt: 'wrong identity' }] }, library_refs: [{ id: 'branch', revision: 2, name: 'Branch', parent_id: 'branch', prompt_set: -1, slot: 0 }] }, 7)
    const remove = nodes(tree).find((n) => n.props?.title === '\u5220\u9664\u6b64\u8d44\u6599')!
    remove.props.onClick(event); await settle()
    expect(api).toHaveBeenCalledWith('/library/branch?revision=2', 'DELETE')
    ui.cleanup()
  })
  it('uses checked schedule actions and the supported delete route', async () => {
    const plan = { id: 'plan', revision: 3, name: 'Plan', enabled: true, request: {}, ai_recipe: {}, kind: 'daily' }
    vi.mocked(api).mockImplementation(async (path) => path === '/schedules' ? [plan] as any : {} as any)
    const ui = harness()
    ui.render(SchedulesPanel, { state: state() }); ui.effects(); await settle()
    const tree = ui.render(SchedulesPanel, { state: state() })
    const event = { stopPropagation: vi.fn() }
    button(tree, '\u6682\u505c').props.onClick(event); await settle()
    expect(api).toHaveBeenCalledWith('/schedules/plan', 'PUT', expect.objectContaining({ enabled: false, expected_revision: 3 }))
    nodes(tree).find((n) => n.props?.title === '\u5220\u9664\u4efb\u52a1')!.props.onClick(event); await settle()
    expect(api).toHaveBeenCalledWith('/schedules/plan?revision=3', 'DELETE')
    ui.cleanup()
  })
  it('restores historical content using the current active draft revision', async () => {
    const version = { id: 'v1', revision: 1, data: { id: 'main', revision: 1, request: { prompt: 'old' } }, name: 'Saved' }
    vi.mocked(api).mockImplementation(async (path) => path.endsWith('/versions') ? [version] as any : [] as any)
    const current = state()
    const ui = harness()
    ui.render(DraftsPanel, { state: current }); ui.effects(); await settle()
    const tree = ui.render(DraftsPanel, { state: current })
    button(tree, '恢复此版本').props.onClick(); await settle()
    expect(current.patchDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'main', revision: 1, request: { prompt: 'old' } }), 7)
    expect(text(ui.render(DraftsPanel, { state: current }))).toContain('已恢复命名版本')
    ui.cleanup()
  })
  it('guards gallery transfer revisions and removes incompatible inpaint masks', async () => {
    const job = { id: 'job', operation: 'generate', request: { model: 'nai-diffusion-5-curated', mask_path: 'old-mask' }, assets: [{ id: 'image', path: '/image.png', mime: 'image/png' }] }
    vi.mocked(api).mockImplementation(async (path) => path.startsWith('/gallery?') ? { items: [job], total: 1 } as any : {} as any)
    const current = state()
    const ui = harness()
    ui.render(GalleryPanel, { state: current }); ui.effects(); await settle()
    let tree = ui.render(GalleryPanel, { state: current })
    nodes(tree).find((n) => n.props?.className === 'cell')!.props.onClick()
    tree = ui.render(GalleryPanel, { state: current })
    const preview = nodes(tree).find((n) => typeof n.type === 'function' && n.type.name === 'JobPreview')!
    const previewUi = harness()
    const previewTree = previewUi.render(preview.type, preview.props)
    const transfer = nodes(previewTree).find((n) => n.type === 'button' && n.props?.title?.includes('Inpaint'))!
    transfer.props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/draft', 'PATCH', { id: 'main', base_revision: 7, operation: 'inpaint', request: { model: 'nai-diffusion-5-full', image_path: '/image.png' } })
    ui.cleanup()
  })
  it('keeps typing local and waits for all saves before a revision-guarded submit', async () => {
    const first = deferred<Rec>()
    const second = deferred<Rec>()
    const current = state()
    current.patchDraft = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.mocked(api).mockImplementation(async (path) => path === '/jobs' ? { jobs: [{ id: 'job' }] } as any : {} as any)
    const ui = harness()
    let tree = ui.render(WorkspacePanel, { state: current })
    const prompt = nodes(tree).find((n) => n.type === 'textarea' && n.props?.placeholder?.includes('tag'))!
    prompt.props.onChange({ target: { value: 'a' } })
    await vi.advanceTimersByTimeAsync(250)
    prompt.props.onChange({ target: { value: 'ab' } })
    expect(current.draft!.request.prompt).toBe('')
    tree = ui.render(WorkspacePanel, { state: current })
    expect(nodes(tree).find((n) => n.type === 'textarea' && n.props?.placeholder?.includes('tag'))!.props.value).toBe('ab')
    button(tree, '\u751f\u6210').props.onClick()
    expect(api).not.toHaveBeenCalledWith('/jobs', 'POST', expect.anything(), expect.anything())
    first.resolve({ revision: 8 }); await settle()
    expect(current.patchDraft).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'main', request: expect.objectContaining({ prompt: 'ab' }) }), 8)
    second.resolve({ revision: 9 }); await settle()
    expect(api).toHaveBeenCalledWith('/jobs', 'POST', expect.objectContaining({ draft_id: 'main', draft_revision: 9, request: expect.objectContaining({ prompt: 'ab' }) }), expect.objectContaining({ 'Idempotency-Key': expect.any(String) }))
  })
})

describe('workbench refinement regressions', () => {
  function browserStorage() {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
    return values
  }

  it('renders icon-only controls with names and strips non-DOM properties', () => {
    harness()
    const control = Button({ ghost: true, icon: 'trash', iconOnly: true, title: 'Delete' })
    expect(control.props['aria-label']).toBe('Delete')
    expect(control.props.className).toContain('ghost')
    expect(control.props).not.toHaveProperty('icon')
    expect(control.props).not.toHaveProperty('ghost')
    expect(nodes(control).some((node) => node.type === Icon)).toBe(true)
  })

  it('publishes save status, retains edits after failure, and retries only explicitly', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('Conflict')).mockResolvedValueOnce({ revision: 8 })
    const queue = new DraftSaveQueue(7, send)
    const states: string[] = []
    const remove = queue.subscribe(() => states.push(queue.status))
    await expect(queue.enqueue({ request: { prompt: 'first' } })).rejects.toThrow('Conflict')
    await expect(queue.enqueue({ request: { prompt: 'preserved' } })).rejects.toThrow('Conflict')
    expect(send).toHaveBeenCalledOnce()
    await queue.retry()
    expect(send).toHaveBeenLastCalledWith({ request: { prompt: 'preserved' } }, 7)
    expect(queue.status).toBe('saved')
    expect(states).toContain('saving')
    expect(states).toContain('failed')
    remove()
  })

  it('does not acknowledge malformed save revisions', async () => {
    const queue = new DraftSaveQueue(7, vi.fn(async () => ({ revision: 7 })))
    await expect(queue.enqueue({ request: {} })).rejects.toThrow()
    expect(queue.failed).toBe(true)
    expect(queue.revision).toBe(7)
  })

  it('restores a pending snapshot without network work or an implicit rebase', async () => {
    const send = vi.fn(async () => ({ revision: 9 }))
    const queue = new DraftSaveQueue(8, send)
    queue.restore({ request: { prompt: 'unsaved' } }, 7)
    expect(queue.status).toBe('failed')
    expect(send).not.toHaveBeenCalled()
    await queue.retry()
    expect(send).toHaveBeenCalledWith({ request: { prompt: 'unsaved' } }, 7)
  })

  it('keeps observer errors from changing an acknowledged save', async () => {
    const queue = new DraftSaveQueue(7, vi.fn(async () => ({ revision: 8 })))
    queue.subscribe(() => { throw new Error('Observer failed') })
    await queue.enqueue({ request: {} })
    expect(queue.revision).toBe(8)
    expect(queue.failed).toBe(false)
  })

  it('submits a single-image edit without a budget-control workflow', async () => {
    const current = state()
    current.draft!.operation = 'upscale'
    current.draft!.request = { image_path: '/source.png', max_anlas: 5 }
    vi.mocked(api).mockResolvedValue({ jobs: [{ id: 'job' }] } as any)
    const ui = harness()
    const tree = ui.render(WorkspacePanel, { state: current })
    button(tree, '开始放大').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/jobs', 'POST', expect.objectContaining({ operation: 'upscale', count: 1, request: { image_path: '/source.png', max_anlas: 5 } }), expect.anything())
    expect((vi.mocked(api).mock.calls.find(([path]) => path === '/jobs')![2] as Rec)).not.toHaveProperty('max_total_anlas')
    expect(text(tree)).not.toMatch(/预算|费用预估|仅免费/u)
  })

  it('reuses the idempotency key when a batch response was not confirmed', async () => {
    const current = state()
    vi.mocked(api).mockRejectedValueOnce(new Error('Response not confirmed')).mockResolvedValueOnce({ jobs: [{ id: 'job' }] } as any)
    const ui = harness()
    let tree = ui.render(WorkspacePanel, { state: current })
    button(tree, '生成').props.onClick(); await settle()
    tree = ui.render(WorkspacePanel, { state: current })
    button(tree, '生成').props.onClick(); await settle()
    const calls = vi.mocked(api).mock.calls.filter((call) => call[0] === '/jobs')
    expect(calls).toHaveLength(2)
    expect(calls[0]![3]?.['Idempotency-Key']).toBe(calls[1]![3]?.['Idempotency-Key'])
  })

  it('recovers local editor content and saves a copy rather than overwriting the remote draft', async () => {
    browserStorage()
    const current = state()
    cachePendingDraft('main', 6, 'generate', { ...current.draft!.request, prompt: 'Local unsaved prompt' })
    vi.mocked(api).mockResolvedValue({ id: 'copy' } as any)
    const ui = harness()
    const tree = ui.render(WorkspacePanel, { state: current })
    expect(nodes(tree).find((node) => node.props?.id === 'nai-prompt')!.props.value).toBe('Local unsaved prompt')
    expect(text(tree)).toContain('未保存')
    expect(current.patchDraft).not.toHaveBeenCalled()
    button(tree, '另存副本').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/drafts', 'POST', expect.objectContaining({ activate: true, draft: expect.objectContaining({ request: expect.objectContaining({ prompt: 'Local unsaved prompt' }) }) }))
    expect(readPendingDraft('main')).toBeNull()
  })

  it('blocks navigation away from a failed save while preserving browser-local content', async () => {
    browserStorage()
    const current = state()
    current.patchDraft = vi.fn(async () => { throw new Error('Conflict') })
    let guard!: () => Promise<boolean>
    current.guardNavigation = (value) => { guard = value; return () => {} }
    const ui = harness()
    const tree = ui.render(WorkspacePanel, { state: current }); ui.effects()
    nodes(tree).find((node) => node.props?.id === 'nai-prompt')!.props.onChange({ target: { value: 'Local retained' } })
    await settle()
    expect(await guard()).toBe(false)
    expect(readPendingDraft('main')!['request']['prompt']).toBe('Local retained')
    ui.cleanup()
  })

  it('does not apply a stale validation response over newer typing', async () => {
    const pending = deferred<Rec>()
    const current = state()
    vi.mocked(api).mockReturnValue(pending.promise as any)
    const ui = harness()
    const tree = ui.render(WorkspacePanel, { state: current })
    button(tree, '校验参数').props.onClick(); await settle()
    nodes(tree).find((node) => node.props?.id === 'nai-prompt')!.props.onChange({ target: { value: 'Newer text' } }); await vi.advanceTimersByTimeAsync(250)
    pending.resolve({ warnings: [], resolved_request: { ...current.draft!.request, prompt: 'Old text', seed: 123 } }); await settle()
    expect(nodes(ui.render(WorkspacePanel, { state: current })).find((node) => node.props?.id === 'nai-prompt')!.props.value).toBe('Newer text')
    expect(current.patchDraft).toHaveBeenCalledOnce()
  })

  it('keeps a completed cached-image load and ignores events from an old source', () => {
    const ui = harness()
    let tree = ui.render(ImagePreview, { src: '/one.png', alt: 'One' })
    const oldImage = nodes(tree).find((node) => node.type === 'img')!
    oldImage.props.onLoad()
    tree = ui.render(ImagePreview, { src: '/one.png', alt: 'One' }); ui.effects()
    expect(nodes(tree).some((node) => node.props?.className === 'nai-image-loading')).toBe(false)
    tree = ui.render(ImagePreview, { src: '/two.png', alt: 'Two' })
    nodes(tree).find((node) => node.type === 'img')!.props.onLoad()
    oldImage.props.onError()
    tree = ui.render(ImagePreview, { src: '/two.png', alt: 'Two' })
    expect(text(tree)).not.toContain('预览不可用')
    expect(nodes(tree).some((node) => node.props?.className === 'nai-image-loading')).toBe(false)
  })

  it('offers an image retry without triggering the enclosing preview action', () => {
    const ui = harness()
    let tree = ui.render(ImagePreview, { src: '/broken.png', alt: 'Broken' })
    nodes(tree).find((node) => node.type === 'img')!.props.onError()
    tree = ui.render(ImagePreview, { src: '/broken.png', alt: 'Broken' })
    const event = { stopPropagation: vi.fn() }
    button(tree, '重试预览').props.onClick(event)
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(nodes(ui.render(ImagePreview, { src: '/broken.png', alt: 'Broken' })).some((node) => node.type === 'img')).toBe(true)
  })

  it('curates only explicitly selected gallery ids', async () => {
    const items = ['one', 'two'].map((id) => ({ id, status: 'completed', request: {}, assets: [] }))
    vi.mocked(api).mockImplementation(async (path) => path.startsWith('/gallery?') ? { items, total: 2 } as any : {} as any)
    const ui = harness()
    ui.render(GalleryPanel, { state: state() }); ui.effects(); await settle()
    let tree = ui.render(GalleryPanel, { state: state() })
    nodes(tree).find((node) => node.props?.['aria-label'] === '选择作品 one')!.props.onChange({ target: { checked: true } })
    tree = ui.render(GalleryPanel, { state: state() })
    button(tree, '收藏所选').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/gallery/curate', 'POST', { ids: ['one'], favorite: true })
    ui.cleanup()
  })

  it('exports a selected gallery batch without opening a job preview', async () => {
    vi.mocked(downloadPost).mockClear()
    vi.mocked(api).mockResolvedValue({ items: [{ id: 'one', status: 'completed', request: {}, assets: [] }], total: 1 } as any)
    const ui = harness()
    ui.render(GalleryPanel, { state: state() }); ui.effects(); await settle()
    let tree = ui.render(GalleryPanel, { state: state() })
    button(tree, '选择本页').props.onClick()
    tree = ui.render(GalleryPanel, { state: state() })
    button(tree, '导出所选').props.onClick(); await settle()
    expect(downloadPost).toHaveBeenCalledWith('/gallery/export', { ids: ['one'] }, 'atelier-artworks.zip')
    ui.cleanup()
  })

  it('loads an exact job even when it is outside the filtered gallery page', async () => {
    const current = state(); current.focusJobId = 'older-job'
    vi.mocked(api).mockImplementation(async (path) => path.startsWith('/gallery?') ? { items: [], total: 0 } as any : { id: 'older-job', request: {}, assets: [] } as any)
    const ui = harness()
    ui.render(GalleryPanel, { state: current }); ui.effects(); await settle()
    const preview = nodes(ui.render(GalleryPanel, { state: current })).find((node) => typeof node.type === 'function' && node.type.name === 'JobPreview')!
    expect(preview.props.job.id).toBe('older-job')
    ui.cleanup()
  })

  it('keeps user-owned button names unchanged instead of stripping their symbols', () => {
    harness()
    expect(text(Button({}, '＋ Alice'))).toBe('＋ Alice')
  })

  it('renders defaults for a partial generation draft without undefined values', () => {
    const current = state(); current.draft!.request = { prompt: 'Partial draft' }
    const ui = harness()
    const tree = ui.render(WorkspacePanel, { state: current })
    expect(nodes(tree).some((node) => node.type === 'select' && node.props.value === 'nai-diffusion-5-full')).toBe(true)
    expect(nodes(tree).some((node) => node.type === 'select' && node.props.value === '832x1216')).toBe(true)
    expect(nodes(tree).some((node) => node.type === 'select' && node.props.value === 'k_euler_ancestral')).toBe(true)
    expect(text(tree)).not.toContain('undefined')
  })

  it('uses luminance for brush-exported opaque masks even if an old external mask used alpha', async () => {
    const current = state(); current.draft!.operation = 'inpaint'
    current.draft!.request = { ...current.draft!.request, image_path: '/source.png', mask_mode: 'alpha' }
    const ui = harness()
    let tree = ui.render(WorkspacePanel, { state: current })
    button(tree, '绘制遮罩').props.onClick()
    tree = ui.render(WorkspacePanel, { state: current })
    const editor = nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === 'MaskEditor')!
    editor.props.onSaved('/opaque-black-white.png'); await vi.advanceTimersByTimeAsync(250)
    expect(current.patchDraft).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ mask_path: '/opaque-black-white.png', mask_mode: 'luminance' }) }), 7)
  })

  it('formats model names and seconds-based subscription expiration accurately', () => {
    expect(modelLabel('nai-diffusion-4-5-full')).toBe('V4.5 Full')
    expect(dateTimeLabel(1893456000)).toBe(new Date(1893456000 * 1000).toLocaleString('zh-CN'))
    expect(dateTimeLabel('1893456000')).toBe(dateTimeLabel(1893456000))
    expect(dateTimeLabel('broken')).toBe('—')
  })
})
