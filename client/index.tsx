/** NovelAI Atelier client module: registers the workbench as a right-sidebar tab. */
import { STYLES } from './styles.ts'
import { setReact, h, type ReactLike } from './ui.tsx'
import { Shell } from './shell.tsx'
import { Icon } from './icons.tsx'
import type { Rec } from './api.ts'

// The esbuild banner wraps this bundle in the DSH lazy-CJS factory whose
// `require` resolves the shared platform module table (React et al.).
declare const require: (id: string) => unknown
setReact(require('react') as unknown as ReactLike)

interface ClientContext {
  effect(fn: () => () => void, name?: string): void
  sidebarRightTabs?: {
    register(definition: Rec): () => void
  }
  slots?: {
    inject(name: string, register: () => unknown): unknown
    register(spec: Rec, component: unknown): unknown
  }
}

export const inject = ['sidebarRightTabs', 'slots']

const TAB_ID = 'dsh-novelai-atelier'
const LEGACY_TAB_ID = 'nai-atelier'
const KIND = 'dsh-novelai-atelier'

function WorkbenchTab(): Rec {
  // Shell is a hook-using component: it MUST be rendered as an element (its own
  // fiber), never invoked as a plain function — inline hooks on this component's
  // fiber change count across renders and crash React with error #310.
  return h('div', { style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    h(Shell, null))
}

function WorkbenchTabTitle(): Rec {
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
    h(Icon, { name: 'brush', size: 14, className: 'nai-tab-icon' }),
    'NovelAI 生图工作台')
}

function apply(ctx: ClientContext): void {
  // Inject the design system once on materialization.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['dshNovelaiAtelier'] = 'styles'
    style.textContent = STYLES
    document.head.appendChild(style)
    return () => style.remove()
  }, 'dsh-novelai-atelier styles')

  // Guarded registration: a malformed contribution must degrade to a console
  // error instead of failing the host's whole plugin boot.
  const guard = (name: string, fn: () => () => void): void => {
    try {
      ctx.effect(fn, name)
    } catch (error) {
      console.error(`[dsh-novelai-atelier] ${name} 注册失败（工作台面板不可用，其余功能不受影响）：`, error)
    }
  }
  const asDispose = (value: unknown): (() => void) => () => {
    if (typeof value === 'function') (value as () => void)()
  }

  guard('dsh-novelai-atelier tab type', () => {
    const dispose = ctx.sidebarRightTabs!.register({
      id: TAB_ID,
      kind: KIND,
      title: () => 'NovelAI 生图工作台',
      guide: [{
        order: 30,
        title: () => 'NovelAI 生图工作台',
        description: () => 'NovelAI V5/V4.5 生图工作台：提示词、参考、队列、画廊、资料库与定时任务；生图协作请在 DSH 对话中使用 nai_* 工具。',
      }],
    })
    return asDispose(dispose)
  })

  guard('dsh-novelai-atelier tab body', () => {
    const injected = ctx.slots!.inject('sidebar.right.pane.tab', () => {
      const d1 = ctx.slots!.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, WorkbenchTab)
      const d2 = ctx.slots!.register({ name: 'sidebar.right.pane.tab', key: LEGACY_TAB_ID }, WorkbenchTab)
      return () => {
        if (typeof d1 === 'function') (d1 as () => void)()
        if (typeof d2 === 'function') (d2 as () => void)()
      }
    })
    return asDispose(injected)
  })

  guard('dsh-novelai-atelier tab title', () => {
    const injected = ctx.slots!.inject('sidebar.right.pane.tab.title', () => {
      const d1 = ctx.slots!.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, WorkbenchTabTitle)
      const d2 = ctx.slots!.register({ name: 'sidebar.right.pane.tab.title', key: LEGACY_TAB_ID }, WorkbenchTabTitle)
      return () => {
        if (typeof d1 === 'function') (d1 as () => void)()
        if (typeof d2 === 'function') (d2 as () => void)()
      }
    })
    return asDispose(injected)
  })
}

// The esbuild banner wraps this module in the DSH lazy-CJS factory.
export default { apply, inject }
