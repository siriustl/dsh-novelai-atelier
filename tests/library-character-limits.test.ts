import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyLibrary } from '../src/workbench/library.ts'
import { LibraryPanel } from '../client/panels/library.tsx'
import { WorkspacePanel } from '../client/panels/workspace.tsx'
import { api, type Rec } from '../client/api.ts'
import { setReact, type ReactLike } from '../client/ui.tsx'

vi.mock('../client/api.ts', async (original) => ({ ...await original<object>(), api: vi.fn() }))
const models = [
  ['nai-diffusion-4-5-full', 6], ['nai-diffusion-4-5-curated', 6],
  ['nai-diffusion-5-full', 22], ['nai-diffusion-5-curated', 22],
] as const
const entry = { id: 'fixture', name: 'Fixture', revision: 1, kind: 'character', data: { prompt: 'geometric figure', negative_prompt: '', examples: [] } }
const draft = (model: string, count: number) => ({ id: 'main', revision: 1, operation: 'generate', request: { model, prompt: 'geometric arrangement', characters: Array.from({ length: count }, () => ({ prompt: 'figure' })) }, library_refs: [] })

describe('preset character round trips', () => {
  const preset = { ...entry, kind: 'preset', data: { prompt: 'forest', negative_prompt: 'blur', characters: [{ prompt: 'traveler', negative_prompt: '', x: 0.2, y: 0.7 }] } }
  it('restores preset slots without changing source data or adding coordinates', () => {
    const original = draft('nai-diffusion-5-full', 0)
    const result = applyLibrary(original, preset, [preset])
    expect((result.request as Rec).characters).toEqual(preset.data.characters)
    expect(original.request.characters).toEqual([])
    expect((result.request as Rec).characters).not.toBe(preset.data.characters)
    const unpositioned = { ...preset, data: { ...preset.data, characters: [{ prompt: 'traveler' }] } }
    expect(((applyLibrary(original, unpositioned, [unpositioned]).request as Rec).characters[0])).toEqual({ prompt: 'traveler' })
  })
  it('rejects a preset exceeding the model limit without modifying the draft', () => {
    const original = draft('nai-diffusion-4-5-full', 6)
    expect(() => applyLibrary(original, preset, [preset])).toThrow('模型角色数量上限')
    expect(original.request.characters).toHaveLength(6)
  })
  it('preserves Text: content when appending preset scene tags', () => {
    const original = { ...draft('nai-diffusion-5-full', 0), request: { model: 'nai-diffusion-5-full', prompt: 'sign\nText: OPEN', characters: [] } }
    const result = applyLibrary(original, preset, [preset])
    expect((result.request as Rec).prompt).toBe('sign, forest\nText: OPEN')
  })
  it('rejects conflicting Text blocks and accepts a preset-only Text block', () => {
    const original = { ...draft('nai-diffusion-5-full', 0), request: { model: 'nai-diffusion-5-full', prompt: 'sign\nText: OPEN', characters: [] } }
    const lettering = { ...preset, data: { ...preset.data, prompt: 'poster\nText: CLOSED' } }
    expect(() => applyLibrary(original, lettering, [lettering])).toThrow('Text:')
    const emptyText = { ...original, request: { ...original.request, prompt: 'street' } }
    expect((applyLibrary(emptyText, lettering, [lettering]).request as Rec).prompt).toBe('street, poster\nText: CLOSED')
  })
  it('restores preset slots through the actual library panel', async () => {
    const view = harness()
    const state = { draft: draft('nai-diffusion-5-full', 0), bootstrap: {}, settings: {}, assets: [], paused: false, patchDraft: vi.fn(async () => ({ revision: 2 })), go: vi.fn(), fail: vi.fn(), refresh: vi.fn() }
    const row = { ...preset, prompt_preview: preset.data.prompt, tags: [], favorite: false, prompt_set_count: 0, example_count: 0, cover_asset_id: null, branches: [] }
    vi.mocked(api).mockImplementation(async (path) => (path === '/library/preview' ? { prompt: preset.data.prompt, negative_prompt: preset.data.negative_prompt, entry: preset }
      : String(path).startsWith('/library/query') ? { items: [row], total: 1, next_offset: null, facets: { all: 1, kinds: { preset: 1 }, favorites: 0, tags: [] } }
        : path === '/library' || String(path).startsWith('/library?') ? [preset] : []) as any)
    try {
      view.render(LibraryPanel, { state }); view.effects(); await settle()
      nodes(view.render(LibraryPanel, { state })).find(n => n.type === 'button' && text(n).includes('填入草稿'))!.props.onClick({ stopPropagation: vi.fn() })
      await settle()
      expect(state.patchDraft).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ characters: preset.data.characters }) }), 1)
    } finally { view.cleanup() }
  })
})

describe('library model character limits', () => {
  it.each(models)('%s accepts exactly %i slots and rejects append beyond the limit', (model, limit) => {
    const before = draft(model, limit - 1)
    const full = applyLibrary(before, entry, [entry])
    expect((full.request as Rec).characters).toHaveLength(limit)
    expect(before.request.characters).toHaveLength(limit - 1)
    expect(() => applyLibrary(full, entry, [entry])).toThrow(/模型角色数量上限/u)
    expect(() => applyLibrary(full, entry, [entry], { target_slot: limit })).toThrow(/模型角色数量上限/u)
    const replaced = applyLibrary(full, entry, [entry], { target_slot: limit - 1 })
    expect((replaced.request as Rec).characters).toHaveLength(limit)
  })

  it.each(models)('%s applies the same limit to inherited character branches', (model, limit) => {
    const branch = { ...entry, id: 'branch', kind: 'branch', parent_id: entry.id }
    expect(() => applyLibrary(draft(model, limit), branch, [entry, branch])).toThrow(/模型角色数量上限/u)
    const result = applyLibrary(draft(model, limit - 1), branch, [entry, branch])
    expect((result.request as Rec).characters).toHaveLength(limit)
  })
})

function harness() {
  let cursor = 0
  const slots: any[] = [], effects: Array<() => void | (() => void)> = [], cleanups: Array<() => void> = []
  const runtime = {
    createElement: (type: any, props: Rec | null, ...children: unknown[]) => ({ $$typeof: Symbol.for('react.element'), type, props: { ...props, children } }),
    useState(initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial } },
    useMemo(fn: () => unknown) { cursor++; return fn() },
    useCallback(fn: any) { cursor++; return fn },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) { const index = cursor++, previous = slots[index]; if (!previous || !deps || deps.some((value, i) => value !== previous[i])) { slots[index] = deps; effects.push(fn) } },
  } as ReactLike
  return {
    render(component: any, props: Rec) { setReact(runtime); cursor = 0; return component(props) as Rec },
    effects() { for (const fn of effects.splice(0)) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup) } },
    cleanup() { cleanups.forEach(fn => fn()) },
  }
}
function nodes(value: any): Rec[] { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [] }
function text(value: any): string { return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '') }
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
afterEach(() => { vi.mocked(api).mockReset() })

describe.each([['library', LibraryPanel], ['workspace', WorkspacePanel]] as const)('%s character library application', (panelName, Panel) => {
  it.each(models)('%s rejects an appended slot after %i without saving the draft', async (model, limit) => {
    const view = harness()
    const state = { draft: draft(model, limit), bootstrap: {}, settings: {}, assets: [], paused: false, patchDraft: vi.fn(async () => ({ revision: 2 })), go: vi.fn(), fail: vi.fn(), refresh: vi.fn() }
    const row = { ...entry, prompt_preview: entry.data.prompt, tags: [], favorite: false, prompt_set_count: 0, example_count: 0, cover_asset_id: null, branches: [] }
    vi.mocked(api).mockImplementation(async (path) => (path === '/library/preview' ? { prompt: entry.data.prompt, negative_prompt: '', entry }
      : String(path).startsWith('/library/query') ? { items: [row], total: 1, next_offset: null, facets: { all: 1, kinds: { character: 1 }, favorites: 0, tags: [] } }
        : path === '/library' || String(path).startsWith('/library?') ? [entry] : []) as any)
    try {
      view.render(Panel, { state }); view.effects(); await settle()
      if (panelName === 'library') {
        const button = nodes(view.render(Panel, { state })).find(n => n.type === 'button' && text(n).includes('填入草稿'))!
        button.props.onClick({ stopPropagation: vi.fn() })
      } else {
        const button = nodes(view.render(Panel, { state })).find(n => n.type === 'button' && text(n).includes('从资料库选角色'))!
        await button.props.onClick(); await settle()
        const item = nodes(view.render(Panel, { state })).find(n => n.props?.className === 'nai-list item')!
        item.props.onClick()
      }
      await settle()
      expect(state.patchDraft).not.toHaveBeenCalled()
      expect(text(view.render(Panel, { state }))).toContain(`已达模型角色上限 ${limit}`)
    } finally { view.cleanup() }
  })
})
