import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GalleryPanel } from '../client/panels/gallery.tsx'
import { ImagePreview } from '../client/image.tsx'
import { ImageInspector } from '../client/image-inspector.tsx'
import { commandPresentation } from '../client/icons.tsx'
import { api, downloadUrl, type Rec } from '../client/api.ts'
import { setReact, type ReactLike } from '../client/ui.tsx'
import type { WorkbenchState } from '../client/shell.tsx'

vi.mock('../client/api.ts', async (original) => ({ ...await original<object>(), api: vi.fn(), downloadUrl: vi.fn() }))

function harness() {
  let cursor = 0
  const slots: any[] = []
  const effects: Array<() => void | (() => void)> = []
  const cleanups: Array<() => void> = []
  const runtime = {
    createElement: (type: any, props: Rec | null, ...children: unknown[]) => ({ $$typeof: Symbol.for('react.element'), type, props: { ...props, ...(children.length ? { children } : {}) } }),
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial } },
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
function nodes(value: any): Rec[] { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [] }
function text(value: any): string { return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '') }
function button(tree: Rec, label: string): Rec { const node = nodes(tree).find((n) => n.type === 'button' && text(n) === label); if (!node) throw new Error(`Missing button: ${label}`); return node }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

beforeEach(() => { vi.useFakeTimers(); vi.mocked(api).mockReset(); vi.mocked(downloadUrl).mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

async function preview(reveal: () => Promise<unknown>, draftRequest: Rec = {}, sourceRefs: Rec[] = []) {
  const job = { id: 'job-1', operation: 'generate', status: 'completed', request: { prompt: 'test image' }, library_refs: sourceRefs, assets: [{ id: 'asset-1', path: '/image.png', mime: 'image/png' }] }
  vi.mocked(api).mockImplementation(async (path) => path.startsWith('/gallery?') ? { items: [job], total: 1 } as any : await reveal() as any)
  const state = { draft: { id: 'main', revision: 1, operation: 'generate', request: draftRequest }, refresh: vi.fn(), go: vi.fn() } as unknown as WorkbenchState
  const ui = harness()
  ui.render(GalleryPanel, { state }); ui.effects(); await settle()
  nodes(ui.render(GalleryPanel, { state })).find((n) => n.props?.className === 'cell')!.props.onClick()
  const component = nodes(ui.render(GalleryPanel, { state })).find((n) => typeof n.type === 'function' && n.type.name === 'JobPreview')!
  const dialog = harness()
  return { render: () => dialog.render(component.type, component.props), cleanup: () => ui.cleanup() }
}

describe('gallery filters and preferences', () => {
  it('sends model and local date boundaries to the existing gallery endpoint', async () => {
    const requests: string[] = []
    vi.mocked(api).mockImplementation(async (path) => {
      if (path.startsWith('/gallery?')) { requests.push(path); return { items: [], total: 0 } as any }
      return [] as any
    })
    const state = { draft: { id: 'main', revision: 1, request: {} }, refresh: vi.fn(), go: vi.fn() } as unknown as WorkbenchState
    const ui = harness()
    ui.render(GalleryPanel, { state }); ui.effects(); await settle()
    const tree = ui.render(GalleryPanel, { state })
    const selects = nodes(tree).filter((node) => node.type === 'select')
    const model = selects[1]!
    model.props.onChange({ target: { value: 'nai-diffusion-5-full' } })
    const from = nodes(tree).find((node) => node.type === 'input' && node.props?.type === 'date')!
    from.props.onChange({ target: { value: '2025-03-09' } })
    ui.render(GalleryPanel, { state }); ui.effects(); await settle()
    const query = new URLSearchParams(requests.at(-1)!.split('?')[1])
    expect(query.get('model')).toBe('nai-diffusion-5-full')
    expect(new Date(query.get('after')!).getTime()).toBe(new Date('2025-03-09T00:00:00').getTime())
    ui.cleanup()
  })

  it('renders shortest-column masonry in API order and no retired density switch', async () => {
    const artwork = (id: string, width: number, height: number, model: string): Rec => ({
      id, operation: 'generate', status: 'completed',
      request: { prompt: id, width, height, model },
      assets: [{ id: `asset-${id}`, path: `/images/${id}.png`, mime: 'image/png' }],
    })
    vi.mocked(api).mockImplementation(async (path) => path.startsWith('/gallery?')
      ? { items: [artwork('tall', 832, 1216, 'nai-diffusion-5-full'), artwork('wide', 1216, 832, 'nai-diffusion-4-5-full')], total: 2 } as any
      : [] as any)
    const state = { draft: { id: 'main', revision: 1, request: {} }, refresh: vi.fn(), go: vi.fn() } as unknown as WorkbenchState
    const ui = harness()
    ui.render(GalleryPanel, { state }); ui.effects(); await settle()
    const tree = ui.render(GalleryPanel, { state })
    // The masonry container must own the cards: absolutely positioned badges and
    // hover actions anchor to the card, not to the whole panel.
    const grid = nodes(tree).find((node) => node.props?.className === 'nai-gallery')!
    expect(grid.props['data-layout']).toBe('columns')
    const columns = nodes(grid.props.children).filter((node) => node.props?.className === 'nai-gallery-column')
    const columnCards = columns.map((column) => nodes(column).filter((node) => node.props?.className === 'cell'))
    // Two works fill the first row left to right, newest first; CSS columns would
    // have stacked both in one column.
    expect(columnCards.map((cards) => cards.map((card) => card.props['aria-label']))).toHaveLength(2)
    expect(columnCards[0]![0]!.props['aria-label']).toContain('tall')
    expect(columnCards[1]![0]!.props['aria-label']).toContain('wide')
    const cards = columnCards.flat()
    const wraps = cards.map((card) => nodes(card).find((node) => node.props?.className === 'img-wrap')!)
    expect(wraps.map((wrap) => wrap.props.style?.aspectRatio)).toEqual(['832 / 1216', '1216 / 832'])
    expect(nodes(tree).some((node) => node.props?.title === '紧凑网格')).toBe(false)
    expect(nodes(tree).some((node) => node.props?.title === '标准网格')).toBe(false)
    ui.cleanup()
  })
})

describe('gallery image reuse semantics', () => {
  it('replaces only the base image and preserves the current creative request', async () => {
    const current = { prompt: 'keep this prompt', negative_prompt: 'keep this negative', model: 'nai-diffusion-5-full', steps: 19 }
    const view = await preview(async () => ({ opened: true }), current)
    button(view.render(), '仅更换底图').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/draft', 'PATCH', {
      id: 'main', base_revision: 1, operation: 'img2img', request: { ...current, image_path: '/image.png' },
    })
    view.cleanup()
  })
  it('requires a separate confirmation to replace the current draft with the full source recipe', async () => {
    const view = await preview(async () => ({ opened: true }), { prompt: 'keep current draft' })
    const confirmation = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmation)
    button(view.render(), '覆盖草稿（完整配方）').props.onClick(); await settle()
    expect(confirmation).toHaveBeenCalledOnce()
    expect(api).not.toHaveBeenCalledWith('/draft', 'PATCH', expect.anything())
    confirmation.mockReturnValue(true)
    button(view.render(), '覆盖草稿（完整配方）').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/draft', 'PATCH', {
      id: 'main', base_revision: 1, operation: 'generate', request: { prompt: 'test image' }, library_refs: [],
    })
    view.cleanup()
  })
  it('restores source library references for full recipes, including new drafts', async () => {
    vi.stubGlobal('confirm', () => true)
    const sourceRefs = [{ id: 'source-character', revision: 4, slot: 0 }]
    const view = await preview(async () => ({}), { prompt: 'current recipe' }, sourceRefs)
    button(view.render(), '覆盖草稿（完整配方）').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/draft', 'PATCH', expect.objectContaining({ library_refs: sourceRefs }))
    const patch = vi.mocked(api).mock.calls.find(([path]) => path === '/draft')![2] as Rec
    expect(patch['library_refs']).not.toBe(sourceRefs)
    button(view.render(), '新草稿（完整配方）').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/drafts', 'POST', { draft: expect.objectContaining({ library_refs: sourceRefs }) })
    view.cleanup()
  })
})

describe('gallery folder reveal', () => {
  it('reveals the registered image once and never downloads when clicked twice', async () => {
    let resolve!: (value: unknown) => void
    const pending = new Promise((done) => { resolve = done })
    const view = await preview(() => pending)
    const control = button(view.render(), '打开所在文件夹')
    control.props.onClick(); control.props.onClick()
    expect(api).toHaveBeenCalledWith('/gallery/reveal', 'POST', { job_id: 'job-1', asset_id: 'asset-1', select: true })
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/gallery/reveal')).toHaveLength(1)
    expect(button(view.render(), '正在打开…').props.disabled).toBe(true)
    expect(downloadUrl).not.toHaveBeenCalled()
    resolve({ opened: true }); await settle()
    expect(button(view.render(), '打开所在文件夹').props.disabled).toBe(false)
    expect(nodes(view.render()).some((n) => n.props?.role === 'status' && text(n).includes('已请求打开文件夹'))).toBe(true)
    view.cleanup()
  })
  it('does not report success for an unacknowledged launcher response', async () => {
    const reveal = vi.fn().mockResolvedValueOnce({ opened: false }).mockResolvedValueOnce({ opened: true, directory: 'C:/registered/images' })
    const view = await preview(reveal)
    button(view.render(), '打开所在文件夹').props.onClick(); await settle()
    expect(nodes(view.render()).some((n) => n.props?.role === 'alert' && text(n).includes('未确认启动'))).toBe(true)
    expect(nodes(view.render()).some((n) => n.props?.role === 'status' && text(n).includes('已请求打开'))).toBe(false)
    button(view.render(), '打开所在文件夹').props.onClick(); await settle()
    expect(nodes(view.render()).some((n) => n.props?.role === 'alert')).toBe(false)
    expect(nodes(view.render()).some((n) => n.props?.role === 'status' && text(n).includes('C:/registered/images'))).toBe(true)
    view.cleanup()
  })
  it('keeps a reveal failure visible inside the preview and allows retry', async () => {
    const reveal = vi.fn().mockRejectedValueOnce(new Error('输出文件已移动')).mockResolvedValueOnce({ opened: true })
    const view = await preview(reveal)
    button(view.render(), '打开所在文件夹').props.onClick(); await settle()
    expect(nodes(view.render()).some((n) => n.props?.role === 'alert' && text(n).includes('输出文件已移动'))).toBe(true)
    button(view.render(), '打开所在文件夹').props.onClick(); await settle()
    expect(reveal).toHaveBeenCalledTimes(2)
    expect(nodes(view.render()).some((n) => n.props?.role === 'alert')).toBe(false)
    view.cleanup()
  })
})

describe('gallery inspector image identity', () => {
  const job = (id: string) => ({ id, request: { prompt: id }, assets: [{ id: `asset-${id}`, mime: 'image/png' }] })
  const find = (tree: Rec, name: string) => nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === name)!

  it('opens a focused job that is not in the current gallery page', async () => {
    vi.mocked(api).mockImplementation(async (path) => path.startsWith('/gallery?') ? { items: [job('recent')], total: 60 } as any : job('older') as any)
    const state = { draft: { id: 'main' }, focusJobId: 'older' } as unknown as WorkbenchState
    const ui = harness()
    ui.render(GalleryPanel, { state }); ui.effects(); await settle()
    find(ui.render(GalleryPanel, { state }), 'JobPreview').props.openInspector(job('older').assets[0])
    const inspector = find(ui.render(GalleryPanel, { state }), 'ImageInspector')
    expect(inspector.props.images[inspector.props.index].src).toContain('asset-older')
    ui.cleanup()
  })

  it('keeps the inspected source and neighbors stable when polling inserts or removes jobs', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible' })
    let jobs = [job('one'), job('two')]
    vi.mocked(api).mockImplementation(async () => ({ items: jobs, total: jobs.length }) as any)
    const state = { draft: { id: 'main' } } as unknown as WorkbenchState
    const ui = harness()
    ui.render(GalleryPanel, { state }); ui.effects(); await settle()
    nodes(ui.render(GalleryPanel, { state })).find((node) => node.props?.className === 'cell')!.props.onClick()
    find(ui.render(GalleryPanel, { state }), 'JobPreview').props.openInspector(jobs[0]!.assets[0])
    const initial = find(ui.render(GalleryPanel, { state }), 'ImageInspector').props.images
    jobs = [job('new'), ...jobs]
    await vi.advanceTimersByTimeAsync(6000)
    let inspector = find(ui.render(GalleryPanel, { state }), 'ImageInspector')
    expect(inspector.props.images).toBe(initial)
    expect(inspector.props.images[inspector.props.index].src).toContain('asset-one')
    jobs = []
    await vi.advanceTimersByTimeAsync(6000)
    inspector = find(ui.render(GalleryPanel, { state }), 'ImageInspector')
    expect(inspector.props.images).toBe(initial)
    expect(inspector.props.images).toHaveLength(2)
    ui.cleanup()
  })
})

describe('inspector interaction and image lifecycle', () => {
  const images = [{ src: '/one.png', alt: 'one', label: 'one' }, { src: '/two.png', alt: 'two', label: 'two' }]
  const surface = (tree: Rec) => nodes(tree).find((node) => node.props?.className === 'nai-image-inspector-stage')!
  const image = (tree: Rec) => nodes(tree).find((node) => node.type === 'img')!
  const footerButton = (tree: Rec, title: string) => nodes(tree.props.footer).find((node) => node.props?.title === title)!
  const mount = () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const disconnect = vi.fn()
    let measure = () => {}
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { measure = callback } observe() {} disconnect = disconnect })
    const dimensions = { width: 400, height: 300 }
    const stage = { getBoundingClientRect: () => dimensions, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const ui = harness(), onIndex = vi.fn(), onClose = vi.fn()
    const render = (index = 0) => ui.render(ImageInspector, { images, index, onIndex, onClose })
    surface(render()).props.ref(stage)
    render(); ui.effects()
    image(render()).props.onLoad({ currentTarget: { naturalWidth: 1000, naturalHeight: 800 } })
    return { ui, render, stage, disconnect, resize: (width: number, height: number) => { Object.assign(dimensions, { width, height }); measure() } }
  }

  it('preserves 100% pixels and reclamps panning when the viewport expands or shrinks', () => {
    const view = mount()
    footerButton(view.render(), '原始像素 100%').props.onClick()
    const current = surface(view.render())
    current.props.onPointerDown({ pointerId: 1, button: 0, clientX: 0, clientY: 0, currentTarget: {} })
    current.props.onPointerMove({ pointerId: 1, clientX: 300, clientY: 0 })
    expect(image(view.render()).props.style.transform).toContain('translate(300px, 0px) scale(1)')
    view.resize(600, 500)
    expect(image(view.render()).props.style.transform).toContain('translate(200px, 0px) scale(1)')
    expect(footerButton(view.render(), '原始像素 100%').props['aria-pressed']).toBe(true)
    view.resize(200, 150)
    expect(image(view.render()).props.style.transform).toContain('translate(200px, 0px) scale(1)')
    view.ui.cleanup()
  })

  it('cancels native wheel scrolling, zooms, and removes its listener on unmount', () => {
    const view = mount()
    expect(view.stage.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false })
    const listener = view.stage.addEventListener.mock.calls[0]![1] as (event: Rec) => void
    const event = { deltaY: -200, preventDefault: vi.fn() }
    view.render()
    listener(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(footerButton(view.render(), '缩小').props.disabled).toBe(false)
    expect(surface(view.render()).props.onWheel).toBeUndefined()
    view.ui.cleanup()
    expect(view.stage.removeEventListener).toHaveBeenCalledWith('wheel', listener)
    expect(view.disconnect).toHaveBeenCalledOnce()
  })

  it('supports keyboard pan and does not let a secondary touch steal the drag', () => {
    const view = mount()
    footerButton(view.render(), '原始像素 100%').props.onClick()
    const stage = surface(view.render())
    const key = { target: view.stage, currentTarget: view.stage, key: 'ArrowRight', preventDefault: vi.fn() }
    stage.props.onKeyDown(key)
    expect(key.preventDefault).toHaveBeenCalledOnce()
    expect(image(view.render()).props.style.transform).toContain('translate(-40px, 0px)')
    const current = surface(view.render())
    current.props.onPointerDown({ pointerId: 1, isPrimary: true, button: 0, clientX: 0, clientY: 0, currentTarget: {} })
    current.props.onPointerDown({ pointerId: 2, isPrimary: false, button: 0, clientX: 0, clientY: 0, currentTarget: {} })
    current.props.onPointerMove({ pointerId: 1, clientX: 20, clientY: 0 })
    expect(image(view.render()).props.style.transform).toContain('translate(-20px, 0px)')
    view.ui.cleanup()
  })

  it('rejects stale image events and recovers from failed originals with retry', () => {
    const ui = harness()
    const render = (index: number) => ui.render(ImageInspector, { images, index, onIndex: vi.fn(), onClose: vi.fn() })
    const first = image(render(0))
    const second = image(render(1))
    first.props.onLoad({ currentTarget: { naturalWidth: 2000, naturalHeight: 1500 } })
    first.props.onError()
    expect(image(render(1)).props.style.visibility).toBe('hidden')
    expect(surface(render(1)).props['aria-busy']).toBe(true)
    second.props.onError()
    expect(nodes(render(1)).some((node) => node.props?.role === 'status' && text(node).includes('原图不可用'))).toBe(true)
    expect(footerButton(render(1), '原始像素 100%').props.disabled).toBe(true)
    button(render(1), '重试原图').props.onClick()
    const retried = image(render(1))
    expect(retried.props.key).toBe('/two.png:1')
    second.props.onError()
    expect(surface(render(1)).props['aria-busy']).toBe(true)
    retried.props.onLoad({ currentTarget: { naturalWidth: 900, naturalHeight: 600 } })
    expect(image(render(1)).props.style.width).toBe(900)
    expect(footerButton(render(1), '原始像素 100%').props.disabled).toBe(false)
    ui.cleanup()
  })
})

describe('preview and command presentation', () => {
  it('renders fit, actual-pixel, zoom, pan surface and adjacent-image controls', () => {
    const ui = harness(), change = vi.fn()
    const tree = ui.render(ImageInspector, { images: [
      { src: '/one.png', alt: 'one', label: 'one' }, { src: '/two.png', alt: 'two', label: 'two' },
    ], index: 0, onIndex: change, onClose: vi.fn() })
    const modal = nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === 'Modal')!
    expect(modal.props.title).toContain('1 / 2')
    const footer = nodes(modal.props.footer)
    expect(footer.some((node) => node.props?.title === '适应窗口')).toBe(true)
    expect(footer.some((node) => node.props?.title === '原始像素 100%')).toBe(true)
    expect(footer.some((node) => node.props?.title === '放大')).toBe(true)
    expect(footer.some((node) => node.props?.title === '上一张' && node.props.disabled)).toBe(true)
    footer.find((node) => node.props?.title === '下一张')!.props.onClick()
    expect(change).toHaveBeenCalledWith(1)
  })

  it('prevents a retry from following the enclosing original-image link', () => {
    const ui = harness(), props = { src: '/image.png', alt: 'Preview' }
    nodes(ui.render(ImagePreview, props)).find((n) => n.type === 'img')!.props.onError()
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    button(ui.render(ImagePreview, props), '重试预览').props.onClick(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(nodes(ui.render(ImagePreview, props)).some((n) => n.type === 'img')).toBe(true)
  })
  it.each([
    ['📋 应用参数到当前草稿', '应用参数到当前草稿', 'copy'],
    ['🖌️ 发送到局部重绘', '发送到局部重绘', 'brush'],
    ['⚙ 查看参数', '查看参数', 'sliders'],
    ['★ 取消收藏', '取消收藏', 'star'],
    ['打开所在文件夹', '打开所在文件夹', 'folder'],
  ])('renders a consistent SVG command for %s', (source, label, icon) => {
    expect(commandPresentation(source)).toEqual({ label, icon })
  })
  it('retains symbols in user-owned labels', () => {
    expect(commandPresentation('★ Favorite Character').label).toBe('★ Favorite Character')
    expect(commandPresentation('🎨 Painter draft').label).toBe('🎨 Painter draft')
  })
})
