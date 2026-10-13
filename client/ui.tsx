/** UI primitives for the workbench (React via the platform module table). */
import type { Rec } from './api.ts'
import { Icon, commandPresentation, type IconName } from './icons.tsx'

export interface ReactLike {
  useState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void]
  useEffect(fn: () => void | (() => void), deps?: unknown[]): void
  useMemo<T>(fn: () => T, deps: unknown[]): T
  useCallback<T>(fn: T, deps: unknown[]): T
  useRef<T>(initial: T): { current: T }
  createElement(type: string, props?: Rec | null, ...children: unknown[]): Rec
  cloneElement?(element: Rec, props: Rec): Rec
}

let react: ReactLike | null = null

/** Injected by the module factory wrapper so panels can share one import. */
export function setReact(instance: ReactLike): void {
  react = instance
}

export function R(): ReactLike {
  if (!react) throw new Error('React not injected')
  return react
}

export function h(type: string | ((props: never) => unknown), ...args: unknown[]): Rec {
  const runtime = R()
  const keyed = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((child, index) => keyed(child, `${path}:${index}`))
    if (value && typeof value === 'object' && (value as Rec)['$$typeof'] && (value as Rec)['key'] == null) {
      return runtime.cloneElement ? runtime.cloneElement(value as Rec, { key: path }) : { ...value as Rec, key: path }
    }
    return value
  }
  return runtime.createElement(type as never, (args[0] ?? null) as Rec | null, ...args.slice(1).map((value, index) => Array.isArray(value) ? keyed(value, String(index)) : value))
}

type BtnProps = {
  children?: unknown; onClick?: (event: Rec) => void; kind?: 'primary' | 'danger' | 'ghost'
  disabled?: boolean; title?: string; small?: boolean; className?: string; icon?: IconName; iconOnly?: boolean; ghost?: boolean
} & Rec

export function Button(props: BtnProps, ...rest: unknown[]): Rec {
  const { children: own, onClick, kind, small, className, icon, iconOnly, ghost, ...restProps } = props as Rec
  const kids = childList(props.children, rest)
  const presentation = typeof kids[0] === 'string' ? commandPresentation(kids[0]) : null
  const symbol = icon ?? presentation?.icon
  if (presentation) kids[0] = presentation.label
  const label = presentation?.label ?? props.title
  const cls = ['nai-btn', kind ?? (ghost ? 'ghost' : ''), small ? 'small' : '', iconOnly ? 'icon-only' : '', className ?? ''].filter(Boolean).join(' ')
  return h('button', {
    type: 'button', className: cls, onClick,
    ...(iconOnly ? { 'aria-label': restProps['aria-label'] ?? props.title ?? label, title: props.title ?? label } : {}), ...restProps,
  }, symbol ? h(Icon, { name: symbol }) : null, ...(iconOnly ? [] : kids))
}

/**
 * The host's React-like runtime invokes function components as fn(props, extra)
 * — the extra second argument (a plain {} without $$typeof) leaks into any
 * component that consumes rest-children and crashes React (#31 "object with
 * keys {}"). Components must prefer props.children and filter artifacts.
 */
function childList(propsChildren: unknown, rest: unknown[]): unknown[] {
  const clean = (list: unknown[]): unknown[] =>
    list.filter((c) => c == null || typeof c !== 'object' || Array.isArray(c) || Boolean((c as Rec)['$$typeof']))
  if (propsChildren !== undefined) return clean(Array.isArray(propsChildren) ? propsChildren : [propsChildren])
  return clean(rest)
}

let fieldId = 0

export function Field(props: { label: string; children?: unknown; hint?: string }, ...rest: unknown[]): Rec {
  const kids = childList(props.children, rest)
  const control = kids[0] as Rec | undefined
  const labelled = control && ['input', 'select', 'textarea'].includes(String(control['type']))
  const id = labelled ? String(control['props']?.['id'] ?? `nai-field-${++fieldId}`) : undefined
  if (labelled) {
    const attributes = { id, ...(props.hint ? { 'aria-describedby': `${id}-hint` } : {}) }
    // React 18 keeps ref outside props; recreating the input drops its DOM ref.
    kids[0] = R().cloneElement
      ? R().cloneElement!(control, attributes)
      : h(control['type'], { ...control['props'], ...attributes, ref: control['props']?.['ref'] ?? control['ref'], key: control['key'] })
  }
  return h('div', { className: 'nai-field' },
    h('label', { htmlFor: id }, props.label),
    ...kids,
    props.hint ? h('span', { className: 'hint', id: `${id}-hint` }, props.hint) : null)
}

export function Card(props: { title?: string; children?: unknown; style?: Rec; className?: string }, ...rest: unknown[]): Rec {
  return h('section', { className: `nai-card ${props.className ?? ''}`.trim(), style: props.style },
    props.title ? h('h2', { className: 'nai-section-title' }, props.title) : null,
    ...childList(props.children, rest))
}

/**
 * Modal must be rendered as a component (h(Modal, props)) — never invoked as a
 * plain function — so its Esc-key effect owns a stable hook slot on its own fiber.
 * footer semantics: undefined → default 关闭 button; null → no footer at all.
 */
export function Modal(props: { title: string; onClose: () => void; children?: unknown; footer?: unknown; wide?: boolean }): Rec {
  const r = R()
  const dialog = r.useRef<HTMLDivElement | null>(null)
  const close = r.useRef(props.onClose)
  close.current = props.onClose
  const titleId = r.useRef(`nai-dialog-${++fieldId}`)
  r.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const node = dialog.current
    const controls = (): HTMLElement[] => Array.from(node?.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]') ?? [])
      .filter((el) => !el.hasAttribute('disabled') && el.tabIndex >= 0 && el.getClientRects().length > 0)
    const editable = controls().find((el) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
    ;(editable ?? controls()[0] ?? node)?.focus()
    const onKey = (e: KeyboardEvent): void => {
      const dialogs = document.querySelectorAll('.nai-modal[role="dialog"]')
      if (dialogs[dialogs.length - 1] !== node) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close.current() }
      if (e.key === 'Tab') {
        const list = controls()
        const first = list[0]
        const last = list[list.length - 1]
        if (!first) { e.preventDefault(); node?.focus() }
        else if (e.shiftKey && (document.activeElement === first || !node?.contains(document.activeElement))) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && (document.activeElement === last || !node?.contains(document.activeElement))) { e.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); if (previous?.isConnected) previous.focus() }
  }, [])
  const raw = props.children
  const kids = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
  const footer = props.footer === undefined
    ? h('div', { className: 'modal-actions' }, Button({ onClick: props.onClose }, '关闭'))
    : props.footer
  return h('div', {
    className: 'nai-modal-backdrop',
    onClick: (e: Rec) => { if (e.target === e.currentTarget) props.onClose() },
  },
    h('div', { className: 'nai-modal', ref: (node: HTMLDivElement | null) => { dialog.current = node }, role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId.current, tabIndex: -1, style: props.wide ? { width: 'min(920px, calc(100vw - 24px))', maxWidth: 'calc(100vw - 24px)' } : undefined },
      h('header', { className: 'nai-modal-header' },
        h('h2', { id: titleId.current }, props.title),
        Button({ icon: 'close', iconOnly: true, kind: 'ghost', title: '关闭窗口', onClick: props.onClose }, '关闭窗口')),
      h('div', { className: 'nai-modal-body' }, ...kids),
      footer ? h('footer', { className: 'nai-modal-footer' }, footer) : null),
  )
}

export function ErrorBox(props: { error?: string | null }): Rec | null {
  if (!props.error) return null
  return h('div', { className: 'nai-error', role: 'alert' }, props.error)
}

export function WarnBox(props: { warnings?: string[] | null }): Rec | null {
  const list = props.warnings ?? []
  if (!list.length) return null
  return h('div', { className: 'nai-warnings' }, list.map((w, i) => h('div', { className: 'nai-warn', key: i, style: { marginBottom: 4 } }, w)))
}

export function OkBox(props: { text?: string | null }): Rec | null {
  if (!props.text) return null
  return h('div', { className: 'nai-okbox', role: 'status' }, props.text)
}

export function Empty(props: { text: string }): Rec {
  return h('div', { className: 'nai-empty' }, props.text)
}

export function Select(props: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; style?: Rec; disabled?: boolean }): Rec {
  return h('select', {
    value: props.value,
    style: props.style,
    onChange: (e: Rec) => props.onChange((e.target as HTMLSelectElement).value),
    disabled: props.disabled,
  }, props.options.map((o) => h('option', { key: o.value, value: o.value }, o.label)))
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string }): Rec {
  return h('label', { className: 'nai-row', style: { gap: 6, cursor: 'pointer', fontSize: 12, color: 'var(--nai-dim)' } },
    h('input', {
      type: 'checkbox', checked: props.checked,
      onChange: (e: Rec) => props.onChange((e.target as HTMLInputElement).checked),
    }),
    props.label)
}

export function Num(props: { value: number | null; onChange: (v: number | null) => void; min?: number; max?: number; step?: number; style?: Rec; placeholder?: string }): Rec {
  return h('input', {
    type: 'number', value: props.value ?? '', min: props.min, max: props.max, step: props.step,
    placeholder: props.placeholder, style: props.style,
    onChange: (e: Rec) => {
      const raw = (e.target as HTMLInputElement).value
      props.onChange(raw === '' ? null : Number(raw))
    },
  })
}

export function keyboardActivate(action: () => void): (event: Rec) => void {
  return (event) => {
    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      action()
    }
  }
}

export function Spinner(): Rec {
  return h(Icon, { name: 'loader', className: 'nai-spin' })
}
