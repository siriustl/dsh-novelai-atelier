/** Load and cache the packaged NovelAI model spec catalog (assets/model-specs.json). */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export interface PresetEntry { id: string; label?: string; suffix?: string; prefix?: string; default?: boolean }
export interface ModelSpec {
  label?: string
  defaults: Record<string, unknown>
  quality_presets: PresetEntry[]
  uc_presets: PresetEntry[]
  [key: string]: unknown
}
export interface SpecCatalog { models: Record<string, ModelSpec>; retrieved_at: string; source: string }

let cached: SpecCatalog | undefined

export function specCatalog(): SpecCatalog {
  if (cached) return cached
  const here = dirname(fileURLToPath(import.meta.url))
  // here = <package>/lib/*.js — assets live at <package>/assets.
  for (const base of [resolve(here, '../assets/model-specs.json'), resolve(here, '../../assets/model-specs.json'), resolve(process.cwd(), 'assets/model-specs.json')]) {
    try {
      cached = JSON.parse(readFileSync(base, 'utf8')) as SpecCatalog
      return cached
    } catch { /* try next candidate */ }
  }
  throw new Error('model-specs.json not found next to the package (assets/)')
}

export function modelSpec(model: string): ModelSpec {
  const spec = specCatalog().models[model]
  if (!spec) throw new Error(`Unknown model: ${model}`)
  return spec
}
