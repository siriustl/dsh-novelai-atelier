/** Binary mask brush editor for inpaint: paint white over the source image,
 * export a same-size black/white PNG (white repaints, black preserves). */
import { R, h, Button, ErrorBox, Modal } from '../ui.tsx'
import { uploadFile, fileUrl, type Rec } from '../api.ts'

export function MaskEditor({ imagePath, onClose, onSaved }: { imagePath: string; onClose: () => void; onSaved: (maskPath: string) => void }): Rec {
  const r = R()
  const [error, setError] = r.useState<string | null>(null)
  const [tool, setTool] = r.useState<'brush' | 'eraser'>('brush')
  const [size, setSize] = r.useState<number>(36)
  const [busy, setBusy] = r.useState(false)
  const [readyFor, setReadyFor] = r.useState<number | null>(null)
  const latestPath = r.useRef(imagePath)
  const sourceGeneration = r.useRef(0)
  const alive = r.useRef(true)
  const savePending = r.useRef(false)
  const saveVersion = r.useRef(0)
  r.useEffect(() => {
    alive.current = true
    return () => { alive.current = false; saveVersion.current++; sourceGeneration.current++ }
  }, [])
  const close = (): void => { saveVersion.current++; sourceGeneration.current++; onClose() }
  const [undoCount, setUndoCount] = r.useState(0)

  const canvasRef = r.useRef<HTMLCanvasElement | null>(null)
  const undoStack = r.useRef<ImageData[]>([])
  const painting = r.useRef(false)
  const lastPoint = r.useRef<{ x: number; y: number } | null>(null)
  if (latestPath.current !== imagePath) {
    latestPath.current = imagePath
    sourceGeneration.current++
    saveVersion.current++
    painting.current = false
    lastPoint.current = null
    undoStack.current = []
    setUndoCount(0)
  }
  const generation = sourceGeneration.current
  const ready = readyFor === generation
  const isCurrentSource = (): boolean => alive.current && generation === sourceGeneration.current && latestPath.current === imagePath

  const ctx = (): CanvasRenderingContext2D | null => {
    const canvas = canvasRef.current
    return canvas ? canvas.getContext('2d') : null
  }

  const pushUndo = (): void => {
    const c = ctx()
    if (!c) return
    const bytes = c.canvas.width * c.canvas.height * 4
    const limit = Math.max(1, Math.min(12, Math.floor(64 * 1024 * 1024 / bytes)))
    while (undoStack.current.length >= limit) undoStack.current.shift()
    undoStack.current.push(c.getImageData(0, 0, c.canvas.width, c.canvas.height))
    setUndoCount(undoStack.current.length)
  }

  const initCanvas = (img: HTMLImageElement): void => {
    const canvas = canvasRef.current
    if (!canvas || !isCurrentSource()) return
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 16 * 1024 * 1024) { setError('源图超过 16MP，请先缩小画布'); setReadyFor(null); return }
    undoStack.current = []
    setUndoCount(0)
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const c = canvas.getContext('2d')
    if (!c) return
    c.fillStyle = '#000'
    c.fillRect(0, 0, canvas.width, canvas.height)
    setError(null)
    setReadyFor(generation)
  }

  const strokeTo = (x: number, y: number): void => {
    const c = ctx()
    if (!c) return
    // Paint opaque color along the stroke: white = repaint region, black = keep.
    // (destination-out erased to transparency, which showed the base image
    // through the canvas instead of the black keep-region — the eraser was broken.)
    c.globalCompositeOperation = 'source-over'
    c.strokeStyle = tool === 'brush' ? '#fff' : '#000'
    c.fillStyle = tool === 'brush' ? '#fff' : '#000'
    c.lineWidth = size
    c.lineCap = 'round'
    c.lineJoin = 'round'
    const from = lastPoint.current ?? { x, y }
    c.beginPath()
    c.moveTo(from.x, from.y)
    c.lineTo(x, y)
    c.stroke()
    // Single dots need a fill (zero-length strokes draw nothing).
    if (from.x === x && from.y === y) {
      c.beginPath()
      c.arc(x, y, size / 2, 0, Math.PI * 2)
      c.fill()
    }
    lastPoint.current = { x, y }
  }

  const canvasPoint = (e: PointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    }
  }

  const undo = (): void => {
    const c = ctx()
    const snap = undoStack.current.pop()
    if (!c || !snap) return
    c.globalCompositeOperation = 'source-over'
    c.putImageData(snap, 0, 0)
    setUndoCount(undoStack.current.length)
  }

  const clear = (): void => {
    const c = ctx()
    const canvas = canvasRef.current
    if (!c || !canvas) return
    pushUndo()
    c.globalCompositeOperation = 'source-over'
    c.fillStyle = '#000'
    c.fillRect(0, 0, canvas.width, canvas.height)
  }

  const save = async (): Promise<void> => {
    const canvas = canvasRef.current
    if (!canvas || !ready || !isCurrentSource() || savePending.current) return
    const source = imagePath
    const version = ++saveVersion.current
    savePending.current = true
    painting.current = false
    lastPoint.current = null
    setBusy(true); setError(null)
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
      if (!blob) throw new Error('遮罩导出失败')
      if (!alive.current || latestPath.current !== source || version !== saveVersion.current) return
      const asset = await uploadFile(blob, 'mask.png')
      if (!alive.current || latestPath.current !== source || version !== saveVersion.current) return
      onSaved(String(asset['path']))
      close()
    } catch (e) { if (alive.current && latestPath.current === source && version === saveVersion.current) setError((e as Error).message) }
    finally { savePending.current = false; if (alive.current) setBusy(false) }
  }

  return h(Modal, {
    title: '遮罩编辑 · 白色重绘 / 黑色保留', onClose: close, wide: true,
    footer: h('div', { className: 'modal-actions' },
      ErrorBox({ error }),
      Button({ small: true, icon: 'undo', onClick: undo, disabled: busy || undoCount === 0 }, '撤销'),
      Button({ small: true, onClick: clear, disabled: busy || !ready }, '清空'),
      h('span', { style: { flex: 1 } }),
      Button({ onClick: close, disabled: busy }, '取消'),
      Button({ kind: 'primary', onClick: () => void save(), disabled: busy || !ready }, busy ? '保存中…' : '保存遮罩')),
  },
    h('div', { className: 'nai-row', style: { marginBottom: 8 } },
      Button({ small: true, icon: 'brush', 'aria-pressed': tool === 'brush', kind: tool === 'brush' ? 'primary' : 'ghost', disabled: busy, onClick: () => setTool('brush') }, '画笔'),
      Button({ small: true, icon: 'eraser', 'aria-pressed': tool === 'eraser', kind: tool === 'eraser' ? 'primary' : 'ghost', disabled: busy, onClick: () => setTool('eraser') }, '橡皮'),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--nai-dim)' } },
        '笔刷',
        h('input', { type: 'range', min: 4, max: 160, value: size, style: { width: 140 }, onInput: (e: Rec) => setSize(Number((e.target as HTMLInputElement).value)) }),
        h('span', { style: { width: 28 } }, String(size))),
    ),
    h('div', { style: { position: 'relative', display: 'inline-block', maxWidth: '100%' } },
      h('img', { key: `source:${generation}`, alt: '遮罩编辑源图',
        onError: () => {
          if (!isCurrentSource()) return
          setReadyFor(null); setError('源图无法加载，请关闭编辑器并重新选择源图')
        },
        src: fileUrl(imagePath), style: { maxWidth: '100%', display: 'block', borderRadius: 8 },
        onLoad: (e: Rec) => initCanvas(e.target as HTMLImageElement),
      }),
      h('canvas', {
        className: 'nai-mask-canvas', tabIndex: 0, role: 'img', 'aria-label': '重绘遮罩',
        onKeyDown: (event: Rec) => { if (!busy && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo() } },
        ref: (node: HTMLCanvasElement | null): void => { canvasRef.current = node },
        style: {
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          display: ready ? 'block' : 'none', cursor: 'crosshair', touchAction: 'none', opacity: 0.62,
        },
        onPointerDown: (e: Rec) => {
          const pe = e as unknown as PointerEvent
          if (busy || !ready || !isCurrentSource() || pe.button !== 0 || pe.isPrimary === false) return
          pe.preventDefault()
          ;(pe.target as HTMLCanvasElement).setPointerCapture(pe.pointerId)
          pushUndo()
          painting.current = true
          lastPoint.current = null
          const p = canvasPoint(pe)
          if (p) strokeTo(p.x, p.y)
        },
        onPointerMove: (e: Rec) => {
          if (busy || !ready || !isCurrentSource() || !painting.current) return
          const p = canvasPoint(e as unknown as PointerEvent)
          if (p) strokeTo(p.x, p.y)
        },
        onPointerUp: () => { painting.current = false; lastPoint.current = null },
        onPointerCancel: () => { painting.current = false; lastPoint.current = null },
        onLostPointerCapture: () => { painting.current = false; lastPoint.current = null },
      }),
    ),
    h('div', { style: { marginTop: 6, fontSize: 11, color: 'var(--nai-faint)' } },
      ready ? `${canvasRef.current?.width} × ${canvasRef.current?.height} px` : '源图加载中'),
  )
}
