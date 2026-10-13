import { unzipSync, type Unzipped } from 'fflate'

export function boundedUnzip(data: Uint8Array, limits: { bytes: number; fileBytes: number; files: number; accept?: (name: string) => boolean }): Unzipped {
  let count = 0
  let expanded = 0
  const names = new Set<string>()
  const output = unzipSync(data, {
    filter(file) {
      if (++count > limits.files || names.has(file.name)) throw new Error('Archive has too many or duplicate members')
      names.add(file.name)
      if (limits.accept && !limits.accept(file.name)) return false
      if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0 || file.originalSize > limits.fileBytes) throw new Error('Archive member exceeds the size limit')
      expanded += file.originalSize
      if (expanded > limits.bytes) throw new Error('Archive exceeds the expanded size limit')
      return true
    },
  })
  let actual = 0
  for (const bytes of Object.values(output)) {
    actual += bytes.length
    if (bytes.length > limits.fileBytes || actual > limits.bytes) throw new Error('Archive exceeds the size limit')
  }
  return output
}
