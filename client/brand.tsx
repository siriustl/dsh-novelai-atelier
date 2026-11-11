/** The Atelier mark: a brush stroke and a spark, drawn in the current text colour. */
import { h } from './ui.tsx'
import type { Rec } from './api.ts'

const BRUSH_PATH = 'M4.4 19.6c3.1.2 5.5-1 7.4-3.1l7.3-7.3a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0l-7.3 7.3c-2.1 1.9-3.3 4.3-3.4 7.1Z'
const SPARK_PATH = 'M18.7 2.6l.55 1.7 1.7.55-1.7.55-.55 1.7-.55-1.7-1.7-.55 1.7-.55.55-1.7Z'

export function AtelierGlyph({ size = 20, className = '' }: { size?: number; className?: string }): Rec {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    className: `nai-atelier-glyph ${className}`.trim(),
    'aria-hidden': true, focusable: false,
  },
    h('path', {
      d: BRUSH_PATH,
      stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
    }),
    h('path', { d: 'M13.6 6.6l4.1 4.1', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
    h('path', { d: SPARK_PATH, fill: 'currentColor' }),
  )
}

/**
 * Guide-card icon: flat, two-tone line art. The host guide uses colourful
 * single-glyph entries, so a full gradient tile would read as a button rather
 * than a door; this keeps the brush identity without its own background.
 */
export function AtelierGuideIcon({ size = 24 }: { size?: number; className?: string }): Rec {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    className: 'nai-guide-glyph', 'aria-hidden': true, focusable: false,
  },
    h('path', {
      d: BRUSH_PATH, stroke: '#da8bb2', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
    }),
    h('path', { d: 'M13.6 6.6l4.1 4.1', stroke: '#da8bb2', strokeWidth: 1.7, strokeLinecap: 'round' }),
    h('path', { d: SPARK_PATH, fill: '#e6b45f' }),
  )
}
