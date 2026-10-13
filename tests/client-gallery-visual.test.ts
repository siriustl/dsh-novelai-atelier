import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GalleryPanel } from '../client/panels/gallery.tsx'
import { ImagePreview } from '../client/image.tsx'
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
    createElement: (type: any, props: Rec | null, ...children: unknown[]) => ({ $$typeof: Symbol.for('react.element'), type, props: { ...props, children } }),
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
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

async function preview(reveal: () => Promise<unknown>) {
  const job = { id: 'job-1', operation: 'generate', status: 'completed', request: { prompt: 'test image' }, assets: [{ id: 'asset-1', path: '/image.png', mime: 'image/png' }] }
  vi.mocked(api).mockImplementation(async (path) => path.startsWith('/gallery?') ? { items: [job], total: 1 } as any : await reveal() as any)
  const state = { draft: { id: 'main', revision: 1, request: {} }, refresh: vi.fn(), go: vi.fn() } as unknown as WorkbenchState
  const ui = harness()
  ui.render(GalleryPanel, { state }); ui.effects(); await settle()
  nodes(ui.render(GalleryPanel, { state })).find((n) => n.props?.className === 'cell')!.props.onClick()
  const component = nodes(ui.render(GalleryPanel, { state })).find((n) => typeof n.type === 'function' && n.type.name === 'JobPreview')!
  const dialog = harness()
  return { render: () => dialog.render(component.type, component.props), cleanup: () => ui.cleanup() }
}

describe('gallery folder reveal', () => {
  it('reveals the registered image once and never downloads when clicked twice', async () => {
    let resolve!: (value: unknown) => void
    const pending = new Promise((done) => { resolve = done })
    const view = await preview(() => pending)
    const control = button(view.render(), '打开所在文件夹')
    control.props.onClick(); control.props.onClick()
    expect(api).toHaveBeenCalledWith('/gallery/reveal', 'POST', { job_id: 'job-1', asset_id: 'asset-1' })
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

describe('preview and command presentation', () => {
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
