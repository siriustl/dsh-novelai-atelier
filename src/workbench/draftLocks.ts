/** Shared field-diff and lock-path helpers for draft locked-field enforcement. */
type Rec = Record<string, unknown>

export function lockPath(value: string): string {
  const normalized = value.trim().replace(/^\//u, '').replace(/\//gu, '.').replace(/\[(\d+)\]/gu, '.$1')
  return normalized === 'operation' || normalized === 'request' || normalized.startsWith('request.')
    ? normalized
    : 'request.' + normalized
}

/** Field differences between two JSON values. */
export function differences(left: unknown, right: unknown, prefix0 = ''): Array<{ field: string }> {
  const out: Array<{ field: string }> = []
  const walk = (a: unknown, b: unknown, p: string): void => {
    if (a instanceof Object && b instanceof Object && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const name = p ? `${p}.${key}` : key
        if (!(key in (a as Rec)) || !(key in (b as Rec))) out.push({ field: name })
        else walk((a as Rec)[key], (b as Rec)[key], name)
      }
      return
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const name = `${p}.${i}`
        if (i >= a.length || i >= b.length) out.push({ field: name })
        else walk(a[i], b[i], name)
      }
      return
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: p })
  }
  walk(left, right, prefix0)
  return out
}
