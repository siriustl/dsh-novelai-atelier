/** Shortest-column masonry layout for smooth, gap-free artwork grids.
 * Avoids CSS column-count gaps by assigning each card to the current shortest column. */
import { R, h } from './ui.tsx'
import type { Rec } from './api.ts'

export interface MasonryProps<T> {
  items: readonly T[]
  columns?: number
  getItemKey: (item: T, index: number) => string
  estimateHeight?: (item: T) => number
  renderItem: (item: T, index: number) => Rec
  gap?: number
}

export function computeShortestColumns<T>(
  items: readonly T[],
  columnCount: number,
  estimateHeight: (item: T) => number,
): T[][] {
  const count = Math.max(1, Math.min(columnCount, items.length || 1))
  const columns: T[][] = Array.from({ length: count }, () => [])
  const heights = new Array<number>(count).fill(0)

  for (const item of items) {
    let shortest = 0
    for (let i = 1; i < count; i++) {
      if (heights[i]! < heights[shortest]!) shortest = i
    }
    columns[shortest]!.push(item)
    heights[shortest] += estimateHeight(item)
  }
  return columns
}

export function ShortestColumnMasonry<T>(props: MasonryProps<T>): Rec {
  const r = R()
  const containerRef = r.useRef<HTMLDivElement | null>(null)
  const [autoColumns, setAutoColumns] = r.useState(3)
  const gap = props.gap ?? 12

  r.useEffect(() => {
    if (props.columns) return
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return

    const update = (w: number) => {
      if (w <= 0) return
      if (w < 540) setAutoColumns(2)
      else if (w < 840) setAutoColumns(3)
      else if (w < 1140) setAutoColumns(4)
      else setAutoColumns(5)
    }

    update(el.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) update(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [props.columns])

  const colCount = props.columns ?? autoColumns
  const estimate = props.estimateHeight ?? (() => 1)

  const columns = r.useMemo(() => {
    return computeShortestColumns(props.items, colCount, estimate)
  }, [props.items, colCount, props.estimateHeight])

  return h(
    'div',
    {
      ref: containerRef,
      style: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: `${gap}px`,
        width: '100%',
        boxSizing: 'border-box',
      },
    },
    columns.map((colItems, colIdx) =>
      h(
        'div',
        {
          key: `col_${colIdx}`,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: `${gap}px`,
            flex: 1,
            maxWidth: 320,
            minWidth: 0,
          },
        },
        colItems.map((item, itemIdx) => props.renderItem(item, itemIdx)),
      ),
    ),
  )
}
