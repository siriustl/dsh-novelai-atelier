/** Public tool values may omit optional object fields, but must otherwise be
 * lossless JSON. Never stringify/parse here: that silently rewrites invalid
 * numbers, array slots, dates, getters and custom toJSON implementations. */
export function toolOutputValue(value: unknown): unknown {
  const ancestors = new Set<object>()
  const invalid = (path: string): never => { throw new TypeError(`Tool output at ${path} is not lossless JSON`) }
  const visit = (item: unknown, path: string): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number') return Number.isFinite(item) && !Object.is(item, -0) ? item : invalid(path)
    if (typeof item !== 'object') return invalid(path)
    const array = Array.isArray(item)
    const proto = Object.getPrototypeOf(item)
    if (!array && proto !== Object.prototype && proto !== null) return invalid(path)
    if (array && proto !== Array.prototype) return invalid(path)
    if (ancestors.has(item)) return invalid(path)
    ancestors.add(item)
    try {
      const keys = Reflect.ownKeys(item)
      if (array && keys.length !== item.length + 1) return invalid(path)
      const output: Record<string, unknown> | unknown[] = array ? [] : {}
      for (const key of keys) {
        if (typeof key !== 'string') return invalid(path)
        if (array && key === 'length') continue
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!
        if (!descriptor.enumerable || !('value' in descriptor)) return invalid(`${path}.${key}`)
        if (array && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length)) return invalid(`${path}.${key}`)
        // Only an own, enumerable data property of an object may be omitted.
        if (!array && descriptor.value === undefined) continue
        Object.defineProperty(output, key, {
          value: visit(descriptor.value, `${path}.${key}`), enumerable: true, writable: true, configurable: true,
        })
      }
      return output
    } finally { ancestors.delete(item) }
  }
  return visit(value, '$')
}
