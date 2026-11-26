import { R, h, Button, Spinner } from './ui.tsx'
import { Icon } from './icons.tsx'
import type { Rec } from './api.ts'

export function ImagePreview({ src, alt, className = '', style, ...props }: { src: string; alt: string; className?: string; style?: Rec; [key: string]: unknown }): Rec {
  const r = R()
  const [snapshot, setSnapshot] = r.useState({ src, failed: false, loaded: false, retry: 0 })
  const currentSrc = r.useRef(src)
  currentSrc.current = src
  const state = snapshot.src === src ? snapshot : { src, failed: false, loaded: false, retry: 0 }
  return h('span', { className: `nai-image ${className}`, style },
    !state.failed ? h('img', { ...props, key: `${src}:${state.retry}`, src, alt, loading: props['loading'] ?? 'lazy', decoding: 'async', onLoad: () => { if (currentSrc.current === src) setSnapshot({ ...state, loaded: true }) }, onError: () => { if (currentSrc.current === src) setSnapshot({ ...state, failed: true, loaded: false }) } }) : null,
    !state.failed && !state.loaded ? h('span', { className: 'nai-image-loading', 'aria-label': '正在加载预览' }, h(Spinner, null)) : null,
    state.failed ? h('span', { className: 'nai-image-error', role: 'status' },
      h(Icon, { name: 'image', size: 24 }), h('span', null, '预览不可用'),
      Button({ small: true, icon: 'refresh', kind: 'ghost', onClick: (event: Rec) => { event.preventDefault?.(); event.stopPropagation(); setSnapshot({ src, failed: false, loaded: false, retry: state.retry + 1 }) } }, '重试预览')) : null)
}
