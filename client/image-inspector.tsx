import { R, h, Button, Modal, Spinner } from './ui.tsx'
import type { Rec } from './api.ts'

export interface InspectionImage { src: string; alt: string; label: string }

export function ImageInspector({ images, index, onIndex, onClose }: {
  images: InspectionImage[]; index: number; onIndex: (index: number) => void; onClose: () => void
}): Rec {
  const r = R()
  const image = images[index]
  const [zoom, setZoom] = r.useState(1)
  const [pan, setPan] = r.useState({ x: 0, y: 0 })
  const [snapshot, setSnapshot] = r.useState({ src: image?.src ?? '', width: 1, height: 1, loaded: false, failed: false, retry: 0 })
  const load = snapshot.src === image?.src ? snapshot : { src: image?.src ?? '', width: 1, height: 1, loaded: false, failed: false, retry: 0 }
  const natural = { width: load.width, height: load.height }
  const imageKey = `${load.src}:${load.retry}`
  const currentImage = r.useRef(imageKey)
  currentImage.current = imageKey
  const [box, setBox] = r.useState({ width: 1, height: 1 })
  const [stage, setStage] = r.useState<HTMLElement | null>(null)
  const drag = r.useRef<{ pointer: number; x: number; y: number; panX: number; panY: number } | null>(null)
  const fit = Math.min(box.width / natural.width, box.height / natural.height, 1)
  const actualZoom = 1 / fit
  const maxZoom = Math.max(8, actualZoom)
  const scale = fit * zoom
  const viewport = r.useRef({ natural, box, zoom, pan, fit })
  viewport.current = { natural, box, zoom, pan, fit }
  const clamp = (nextZoom: number, nextPan: { x: number; y: number }) => {
    const maxX = Math.max(0, (natural.width * fit * nextZoom - box.width) / 2)
    const maxY = Math.max(0, (natural.height * fit * nextZoom - box.height) / 2)
    setZoom(nextZoom)
    setPan({ x: Math.max(-maxX, Math.min(maxX, nextPan.x)), y: Math.max(-maxY, Math.min(maxY, nextPan.y)) })
  }
  const setFit = (): void => { setZoom(1); setPan({ x: 0, y: 0 }) }
  const setActual = (): void => { clamp(actualZoom, pan) }
  const changeZoom = (factor: number): void => { clamp(Math.max(1, Math.min(maxZoom, zoom * factor)), pan) }
  const wheel = r.useRef<(event: WheelEvent) => void>(() => {})
  wheel.current = (event) => {
    event.preventDefault()
    if (load.loaded) changeZoom(Math.exp(-event.deltaY * 0.002))
  }

  r.useEffect(() => {
    setFit()
    drag.current = null
  }, [image?.src])
  r.useEffect(() => {
    if (!stage) return
    const measure = (): void => {
      const rect = stage.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const current = viewport.current
      if (rect.width === current.box.width && rect.height === current.box.height) return
      const nextFit = Math.min(rect.width / current.natural.width, rect.height / current.natural.height, 1)
      const nextZoom = current.zoom === 1 ? 1 : Math.max(1, Math.min(Math.max(8, 1 / nextFit), current.fit * current.zoom / nextFit))
      const maxX = Math.max(0, (current.natural.width * nextFit * nextZoom - rect.width) / 2)
      const maxY = Math.max(0, (current.natural.height * nextFit * nextZoom - rect.height) / 2)
      setBox({ width: rect.width, height: rect.height })
      setZoom(nextZoom)
      setPan({ x: Math.max(-maxX, Math.min(maxX, current.pan.x)), y: Math.max(-maxY, Math.min(maxY, current.pan.y)) })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    measure()
    // React delegates wheel listeners passively, so cancellation must be native.
    const onWheel = (event: WheelEvent): void => wheel.current(event)
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => { observer.disconnect(); stage.removeEventListener('wheel', onWheel) }
  }, [stage])
  r.useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); onIndex(index - 1) }
      if (event.key === 'ArrowRight' && index < images.length - 1) { event.preventDefault(); onIndex(index + 1) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [index, images.length, onIndex])

  const startDrag = (event: Rec): void => {
    if (!load.loaded || event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return
    if (zoom <= 1 && scale <= 1) return
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const moveDrag = (event: Rec): void => {
    const current = drag.current
    if (!current || current.pointer !== event.pointerId) return
    clamp(zoom, { x: current.panX + event.clientX - current.x, y: current.panY + event.clientY - current.y })
  }
  const endDrag = (event: Rec): void => { if (drag.current?.pointer === event.pointerId) drag.current = null }
  const panKey = (event: Rec): void => {
    if (event.target !== event.currentTarget || !load.loaded) return
    const delta: Record<string, { x: number; y: number }> = { ArrowLeft: { x: 40, y: 0 }, ArrowRight: { x: -40, y: 0 }, ArrowUp: { x: 0, y: 40 }, ArrowDown: { x: 0, y: -40 } }
    const move = delta[event.key]
    if (!move || (natural.width * scale <= box.width && natural.height * scale <= box.height)) return
    event.preventDefault()
    clamp(zoom, { x: pan.x + move.x, y: pan.y + move.y })
  }

  return h(Modal, {
    title: `${image?.label ?? '图片'} · ${index + 1} / ${images.length}`,
    onClose, wide: true,
    footer: h('div', { className: 'nai-image-inspector-controls' },
      Button({ icon: 'previous', iconOnly: true, title: '上一张', disabled: index <= 0, onClick: () => onIndex(index - 1) }),
      Button({ icon: 'minus', iconOnly: true, title: '缩小', disabled: !load.loaded || zoom <= 1, onClick: () => changeZoom(1 / 1.25) }),
      h('span', { className: 'nai-pill', 'aria-live': 'polite' }, load.loaded ? `${Math.round(fit * zoom * 100)}%` : '...'),
      Button({ icon: 'plus', iconOnly: true, title: '放大', disabled: !load.loaded || zoom >= maxZoom, onClick: () => changeZoom(1.25) }),
      Button({ icon: 'expand', title: '适应窗口', disabled: !load.loaded, 'aria-pressed': zoom === 1, onClick: setFit }, '适应窗口'),
      Button({ icon: 'scan', title: '原始像素 100%', disabled: !load.loaded, 'aria-pressed': load.loaded && Math.abs(zoom - actualZoom) < 0.01, onClick: setActual }, '100%'),
      Button({ icon: 'next', iconOnly: true, title: '下一张', disabled: index >= images.length - 1, onClick: () => onIndex(index + 1) })),
    children: h('div', { className: 'nai-image-inspector-stage', ref: setStage,
      onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: endDrag,
      onKeyDown: panKey, tabIndex: 0,
      onDoubleClick: () => { if (load.loaded) zoom === 1 ? setActual() : setFit() }, role: 'group', 'aria-label': '图片检查器，可拖移、方向键平移并滚轮缩放', 'aria-busy': !load.loaded && !load.failed },
      image && !load.failed ? h('img', { key: imageKey, src: image.src, alt: image.alt, draggable: false,
        onLoad: (event: Rec) => {
          const img = event.currentTarget as HTMLImageElement
          if (currentImage.current === imageKey && img.naturalWidth && img.naturalHeight) { setSnapshot({ ...load, width: img.naturalWidth, height: img.naturalHeight, loaded: true }); setFit() }
        },
        onError: () => { if (currentImage.current === imageKey) setSnapshot({ ...load, failed: true, loaded: false }) },
        style: { position: 'absolute', left: '50%', top: '50%', width: natural.width, height: natural.height, maxWidth: 'none', maxHeight: 'none', visibility: load.loaded ? 'visible' : 'hidden', transformOrigin: 'center', transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`, userSelect: 'none', cursor: zoom > 1 ? drag.current ? 'grabbing' : 'grab' : 'zoom-in' },
      }) : null,
      !load.loaded && !load.failed ? h('span', { className: 'nai-image-loading', role: 'status', 'aria-label': '正在加载原图' }, h(Spinner, null)) : null,
      load.failed ? h('div', { className: 'nai-image-error', role: 'status' },
        h('span', null, '原图不可用'), Button({ small: true, icon: 'refresh', onClick: () => setSnapshot({ ...load, failed: false, loaded: false, retry: load.retry + 1 }) }, '重试原图')) : null),
  })
}
