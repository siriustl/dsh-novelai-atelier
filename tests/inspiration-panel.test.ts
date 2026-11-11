import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, API_BASE, type Rec } from '../client/api.ts'
import { InspirationPanel } from '../client/panels/inspiration.tsx'
import { setReact, type ReactLike } from '../client/ui.tsx'

vi.mock('../client/api.ts', async (original) => ({ ...await original<object>(), api: vi.fn() }))
vi.mock('../client/draft-cache.ts', () => ({ clearPendingDraft: vi.fn() }))
function harness() {
  let cursor = 0
  const slots: any[] = [], effects: Array<() => void> = [], cleanups = new Map<number, () => void>()
  const runtime = {
    createElement: (type: any, props: Rec | null, ...children: unknown[]) => ({ $$typeof: Symbol.for('react.element'), type, props: { ...props, ...(children.length ? { children } : {}) } }),
    useState(initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial } },
    useMemo(fn: () => unknown) { cursor++; return fn() },
    useCallback(fn: any) { cursor++; return fn },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const index = cursor++, previous = slots[index]
      if (!previous || !deps || deps.some((value, i) => value !== previous[i])) {
        slots[index] = deps
        effects.push(() => { cleanups.get(index)?.(); cleanups.delete(index); const cleanup = fn(); if (cleanup) cleanups.set(index, cleanup) })
      }
    },
  } as ReactLike
  return {
    render(state: Rec): Rec { setReact(runtime); cursor = 0; return InspirationPanel({ state: state as any }) },
    effects() { for (const effect of effects.splice(0)) effect() },
    cleanup() { for (const cleanup of cleanups.values()) cleanup() },
  }
}
const nodes = (value: any): Rec[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : []
const text = (value: any): string => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')
const button = (tree: Rec, label: string): Rec => { const node = nodes(tree).find((n) => n.type === 'button' && (text(n) === label || n.props.title === label)); if (!node) throw new Error(`Missing button ${label}`); return node }
const component = (tree: Rec, name: string) => nodes(tree).find((node) => typeof node.type === 'function' && node.type.name === name)!
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve() }
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const artwork = (id: string, extra: Rec = {}): Rec => ({ id, source: 'pixiv', title: id, prompt: 'forest', promptKind: 'tags', previewUrl: 'https://i.pximg.net/a.jpg', ...extra })
const response = (items: Rec[], hasMore = false, errors: Rec[] = []) => ({ items, hasMore, errors })
const panels: ReturnType<typeof harness>[] = []
const setup = () => { const panel = harness(); panels.push(panel); const state = { draft: { id: 'main', revision: 3, request: { prompt: 'old', negative_prompt: 'old negative', characters: [{ prompt: 'old person' }], width: 832 } }, patchDraft: vi.fn(async () => {}), go: vi.fn() }; return { panel, state } }
const open = (panel: ReturnType<typeof harness>, state: Rec, index = 0): Rec => { const masonry = component(panel.render(state), 'ShortestColumnMasonry'); const card = masonry.props.renderItem(masonry.props.items[index]); card.props.onClick(); return card }

beforeEach(() => { vi.mocked(api).mockReset() })
afterEach(() => { for (const panel of panels.splice(0)) panel.cleanup(); vi.unstubAllGlobals() })

describe('inspiration panel behavior', () => {
  it('displays partial-source failures with genuine works and the correct API image proxy', async () => {
    vi.mocked(api).mockResolvedValue(response([artwork('pixiv_1')], true, [{ source: 'danbooru', message: 'HTTP 403' }]) as any)
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle()
    const tree = panel.render(state)
    expect(text(tree)).toContain('DANBOORU: HTTP 403')
    expect(text(tree)).not.toContain('没有匹配作品')
    const masonry = component(tree, 'ShortestColumnMasonry')
    const card = masonry.props.renderItem(masonry.props.items[0])
    expect(component(card, 'ImagePreview').props.src).toBe(`${API_BASE}/inspiration/image?url=${encodeURIComponent('https://i.pximg.net/a.jpg')}`)
  })

  it('paginates with page parameters, resets on source switch, and permits repeating the same search', async () => {
    vi.mocked(api).mockImplementation(async () => response([artwork('pixiv_1')], true) as any)
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle()
    button(panel.render(state), '下一页').props.onClick(); panel.render(state); panel.effects(); await settle()
    expect(vi.mocked(api).mock.calls.at(-1)?.[0]).toContain('page=2')
    const select = nodes(panel.render(state)).find((node) => node.type === 'select')!
    select.props.onChange({ target: { value: 'aitag' } }); panel.render(state); panel.effects(); await settle()
    expect(vi.mocked(api).mock.calls.at(-1)?.[0]).toContain('source=aitag&limit=24&page=1')
    const before = vi.mocked(api).mock.calls.length
    button(panel.render(state), '搜索').props.onClick(); await settle()
    expect(vi.mocked(api).mock.calls.length).toBe(before + 1)
  })

  it('resets to page one when Pixiv exclusion changes and does not leak the filter to AITag', async () => {
    vi.mocked(api).mockImplementation(async () => response([artwork('pixiv_1')], true) as any)
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle()
    button(panel.render(state), '下一页').props.onClick(); panel.render(state); panel.effects(); await settle()
    const filter = nodes(panel.render(state)).filter((node) => node.type === 'select')[1]!
    expect(text(filter)).toContain('排除 AI 标记')
    filter.props.onChange({ target: { value: 'exclude' } }); panel.render(state); panel.effects(); await settle()
    expect(vi.mocked(api).mock.calls.at(-1)?.[0]).toContain('page=1&pixivAi=exclude')
    const source = nodes(panel.render(state)).find((node) => node.type === 'select')!
    source.props.onChange({ target: { value: 'aitag' } }); panel.render(state); panel.effects(); await settle()
    expect(vi.mocked(api).mock.calls.at(-1)?.[0]).not.toContain('pixivAi')
    expect(nodes(panel.render(state)).filter((node) => node.type === 'select')).toHaveLength(1)
  })

  it('keeps next available on an empty sparse slice instead of claiming the search has no works', async () => {
    vi.mocked(api).mockResolvedValue(response([], true) as any)
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle()
    const tree = panel.render(state)
    expect(text(tree)).toContain('本页没有可显示作品')
    expect(text(tree)).not.toContain('没有匹配作品')
    expect(button(tree, '下一页').props.disabled).toBe(false)
  })

  it('does not send a missing-keyword filter error to network settings', async () => {
    vi.mocked(api).mockResolvedValue(response([], false, [{ source: 'pixiv', code: 'FILTER_REQUIRES_QUERY', message: 'AI 标记筛选需要搜索词' }]) as any)
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle()
    const tree = panel.render(state)
    expect(text(tree)).toContain('AI 标记筛选需要搜索词')
    expect(text(tree)).not.toContain('网络设置')
  })

  it('reports native-tag copy failures without changing the draft', async () => {
    vi.mocked(api).mockResolvedValue(response([artwork('pixiv_1', { tags: ['forest'] })]) as any)
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('Clipboard denied') }) } })
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle(); open(panel, state); panel.render(state); panel.effects()
    button(component(panel.render(state), 'Modal').props.children, '复制原生标签').props.onClick(); await settle()
    expect(text(component(panel.render(state), 'Modal').props.children)).toContain('Clipboard denied')
    expect(state.patchDraft).not.toHaveBeenCalled()
  })

  it('cancels stale searches and refuses to let late results replace current works', async () => {
    const first = deferred<any>(), second = deferred<any>()
    vi.mocked(api).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { panel, state } = setup(); panel.render(state); panel.effects()
    const signal = vi.mocked(api).mock.calls[0]?.[4]!
    const input = nodes(panel.render(state)).find((node) => node.type === 'input')!
    input.props.onChange({ target: { value: 'forest' } }); button(panel.render(state), '搜索').props.onClick(); panel.render(state); panel.effects()
    expect(signal.aborted).toBe(true)
    second.resolve(response([artwork('pixiv_new')])); await settle()
    first.resolve(response([artwork('pixiv_old')])); await settle()
    expect(component(panel.render(state), 'ShortestColumnMasonry').props.items[0].id).toBe('pixiv_new')
  })

  it('keeps import disabled until authentic detail arrives, then imports negative and character slots', async () => {
    const detail = deferred<any>()
    vi.mocked(api).mockResolvedValueOnce(response([artwork('aitag_1', { source: 'aitag', needsDetail: true, prompt: '', promptKind: 'original' })]) as any).mockReturnValueOnce(detail.promise)
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle(); open(panel, state); panel.render(state); panel.effects()
    let modal = component(panel.render(state), 'Modal').props.children
    expect(button(modal, '导入生图工作台').props.disabled).toBe(true)
    detail.resolve(artwork('aitag_1', { source: 'aitag', promptKind: 'original', negativePrompt: 'blur', needsDetail: false, characters: [{ prompt: 'traveler', negative_prompt: 'bad hands', x: 0.3, y: 0.6 }] })); await settle()
    modal = component(panel.render(state), 'Modal').props.children
    expect(button(modal, '导入生图工作台').props.disabled).toBe(false)
    button(modal, '导入生图工作台').props.onClick(); await settle()
    expect(state.patchDraft).toHaveBeenCalledWith({ id: 'main', operation: 'generate', request: { prompt: 'forest', negative_prompt: 'blur', characters: [{ prompt: 'traveler', negative_prompt: 'bad hands', x: 0.3, y: 0.6 }], width: 832 } }, 3)
    expect(state.go).toHaveBeenCalledWith('create')
  })

  it.each([
    { prompt: 'traveler' },
    { prompt: 'traveler', x: 0.3 },
    { prompt: 'traveler', x: Number.NaN, y: 0.6 },
    { prompt: 'traveler', x: 2, y: 0.6 },
  ])('does not invent coordinates when importing an unpositioned character (%j)', async (character) => {
    vi.mocked(api).mockResolvedValue(response([artwork('aitag_1', { source: 'aitag', promptKind: 'original', characters: [character] })]) as any)
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle(); open(panel, state); panel.render(state); panel.effects()
    button(component(panel.render(state), 'Modal').props.children, '导入生图工作台').props.onClick(); await settle()
    expect(state.patchDraft.mock.calls[0]?.[0]).toMatchObject({ request: { characters: [{ prompt: 'traveler', negative_prompt: '' }] } })
    expect((state.patchDraft.mock.calls[0]?.[0] as any).request.characters[0]).not.toHaveProperty('x')
    expect((state.patchDraft.mock.calls[0]?.[0] as any).request.characters[0]).not.toHaveProperty('y')
  })

  it('keeps Pixiv native tags reference-only even if a stale item includes a prompt', async () => {
    vi.mocked(api).mockResolvedValue(response([artwork('pixiv_1', { tags: ['風景', 'forest'], aiMark: 'not-ai' })]) as any)
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle(); open(panel, state); panel.render(state); panel.effects()
    const modal = component(panel.render(state), 'Modal').props.children
    expect(text(modal)).toContain('Pixiv 原生标签（非 Danbooru）')
    expect(text(modal)).toContain('風景, forest')
    expect(text(modal)).toContain('未标记为 AI（不认证作者身份）')
    expect(text(modal)).not.toContain('导入生图工作台')
    expect(text(modal)).not.toContain('保存到资料库预设')
    expect(text(modal)).not.toContain('将标签填入草稿')
    button(modal, '复制原生标签').props.onClick(); await settle()
    expect(writeText).toHaveBeenCalledWith('風景, forest')
    expect(state.patchDraft).not.toHaveBeenCalled()
    expect(vi.mocked(api).mock.calls.every(([path]) => path !== '/library' && !String(path).includes('generate'))).toBe(true)
  })

  it('imports Danbooru tags as tags without pretending to recover an original recipe', async () => {
    vi.mocked(api).mockResolvedValue(response([artwork('danbooru_1', { source: 'danbooru' })]) as any)
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle(); open(panel, state); panel.render(state); panel.effects()
    const modal = component(panel.render(state), 'Modal').props.children
    expect(text(modal)).toContain('Danbooru 作品标签（非原始配方）')
    button(modal, '将标签填入草稿').props.onClick(); await settle()
    expect(state.patchDraft.mock.calls[0]?.[0]).toMatchObject({ request: { negative_prompt: '', characters: [] } })
    expect(vi.mocked(api).mock.calls.every(([path]) => !String(path).includes('generate'))).toBe(true)
  })

  it('does not let a late detail response overwrite a newly selected work', async () => {
    const detail = deferred<any>()
    vi.mocked(api).mockResolvedValueOnce(response([artwork('aitag_1', { source: 'aitag', needsDetail: true, prompt: '', promptKind: 'original' }), artwork('pixiv_2')]) as any).mockReturnValueOnce(detail.promise)
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle(); open(panel, state); panel.render(state); panel.effects()
    const signal = vi.mocked(api).mock.calls[1]?.[4]!
    component(panel.render(state), 'Modal').props.onClose(); panel.render(state); panel.effects(); open(panel, state, 1); panel.render(state); panel.effects()
    expect(signal.aborted).toBe(true)
    detail.resolve(artwork('aitag_1', { source: 'aitag', prompt: 'old detail' })); await settle()
    expect(component(panel.render(state), 'Modal').props.title).toBe('pixiv_2')
  })

  it('shows a failed detail with retry and never offers an empty placeholder as a recipe', async () => {
    vi.mocked(api).mockResolvedValueOnce(response([artwork('aitag_1', { source: 'aitag', needsDetail: true, prompt: '', promptKind: 'original' })]) as any).mockRejectedValueOnce(new Error('HTTP 403'))
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle(); open(panel, state); panel.render(state); panel.effects(); await settle()
    const modal = component(panel.render(state), 'Modal').props.children
    expect(text(modal)).toContain('HTTP 403')
    expect(button(modal, '重试详情')).toBeTruthy()
    expect(button(modal, '导入生图工作台').props.disabled).toBe(true)
  })

  it('serializes repeated save clicks so one click burst cannot create duplicate presets', async () => {
    const save = deferred<any>()
    vi.mocked(api).mockResolvedValueOnce(response([artwork('aitag_1', { source: 'aitag', promptKind: 'original' })]) as any).mockReturnValueOnce(save.promise)
    const { panel, state } = setup(); panel.render(state); panel.effects(); await settle(); open(panel, state); panel.render(state); panel.effects()
    const action = button(component(panel.render(state), 'Modal').props.children, '保存到资料库预设')
    action.props.onClick(); action.props.onClick()
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/library')).toHaveLength(1)
    save.resolve({ id: 'saved' }); await settle()
    expect(text(component(panel.render(state), 'Modal').props.children)).toContain('已保存到资料库预设')
  })
})
