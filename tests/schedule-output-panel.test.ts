import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Rec } from '../client/api.ts'
import { SchedulesPanel } from '../client/panels/schedules.tsx'
import { setReact, type ReactLike } from '../client/ui.tsx'

vi.mock('../client/api.ts', async (original) => ({ ...await original<object>(), api: vi.fn() }))
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
function nodes(value: any): any[] { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children), ...nodes(value.props?.footer)] : [] }
function text(value: any): string { return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '') }
function button(tree: Rec, label: string): any { return nodes(tree).find((n) => n.type === 'button' && text(n) === label)! }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const state = { paused: false }
const panels: ReturnType<typeof harness>[] = []
async function editor(plan: Rec) {
  vi.mocked(api).mockImplementation(async (path) => path === '/schedules' ? [plan] as any : [] as any)
  const panel = harness(); panels.push(panel)
  panel.render(SchedulesPanel, { state }); panel.effects(); await settle()
  nodes(panel.render(SchedulesPanel, { state })).find((node) => node.props?.className === 'nai-sched-card')!.props.onClick()
  const component = nodes(panel.render(SchedulesPanel, { state })).find((node) => typeof node.type === 'function' && node.type.name === 'PlanEditor')!
  const view = harness(); panels.push(view)
  return () => view.render(component.type, component.props)
}
const directoryInput = (tree: Rec) => nodes(nodes(tree).find((node) => node.props?.label === '分类子目录')).find((node) => node.type === 'input')!

beforeEach(() => { vi.useFakeTimers(); vi.mocked(api).mockReset() })
afterEach(() => { panels.splice(0).forEach((panel) => panel.cleanup()); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('schedule output directory editor', () => {
  it.each(['fixed', 'ai'])('preserves existing request fields and submits the explicit directory in %s mode', async (execution_mode) => {
    const plan = { id: 'existing', revision: 3, name: 'men', execution_mode, request: { prompt: '1boy', seed: 42, output_subdir: 'legacy.v1' }, ai_recipe: { instruction: 'A male portrait', locked_fields: ['request.seed'] } }
    const render = await editor(plan)
    expect(directoryInput(render()).props.value).toBe('legacy.v1')
    directoryInput(render()).props.onChange({ target: { value: 'portraits.v2' } })
    button(render(), '保存').props.onClick(); await settle()
    expect(api).toHaveBeenCalledWith('/schedules/existing', 'PUT', { ...plan, output_subdir: 'portraits.v2', expected_revision: 3 })
  })

  it('submits null for explicit clearing rather than falling back to a legacy request directory', async () => {
    const render = await editor({ id: 'existing', revision: 3, name: 'men', execution_mode: 'fixed', output_subdir: 'old', request: { prompt: '1boy', output_subdir: 'old' } })
    directoryInput(render()).props.onChange({ target: { value: '' } })
    expect(directoryInput(render()).props.value).toBe('')
    button(render(), '保存').props.onClick(); await settle()
    expect(vi.mocked(api).mock.calls.find((call) => call[1] === 'PUT')?.[2]).toMatchObject({ output_subdir: null })
  })

  it('keeps an invalid directory visible after a failed save without losing other fields', async () => {
    const render = await editor({ id: 'existing', revision: 3, name: 'men', execution_mode: 'fixed', request: { prompt: '1boy' } })
    directoryInput(render()).props.onChange({ target: { value: '../escape' } })
    vi.mocked(api).mockRejectedValue(new Error('Invalid output directory'))
    button(render(), '保存').props.onClick(); await settle()
    expect(directoryInput(render()).props.value).toBe('../escape')
    expect(nodes(render()).some((node) => node.props?.role === 'alert' && text(node).includes('Invalid output directory'))).toBe(true)
  })
})
