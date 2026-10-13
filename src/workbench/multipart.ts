/** Minimal multipart/form-data parser for single-file uploads (assets/library import). */

export interface MultipartPart {
  name: string
  filename?: string
  contentType?: string
  data: Uint8Array
}

export function parseMultipart(body: Uint8Array, contentTypeHeader: string): Map<string, MultipartPart> {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentTypeHeader)
  if (!match) throw new Error('请求不是有效的 multipart 表单')
  const boundary = '--' + (match[1] ?? match[2])!
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const boundaryBytes = encoder.encode(boundary)
  const parts = new Map<string, MultipartPart>()
  // Split on boundary occurrences.
  let index = indexOf(body, boundaryBytes, 0)
  if (index < 0) throw new Error('multipart 边界缺失')
  index += boundaryBytes.length
  for (;;) {
    // After a boundary: either `--` (final) or CRLF then part.
    if (body[index] === 0x2d && body[index + 1] === 0x2d) break
    if (body[index] === 0x0d && body[index + 1] === 0x0a) index += 2
    const headerEnd = indexOf(body, encoder.encode('\r\n\r\n'), index)
    if (headerEnd < 0) break
    const headerText = decoder.decode(body.subarray(index, headerEnd))
    const next = indexOf(body, boundaryBytes, headerEnd)
    if (next < 0) break
    let dataEnd = next - 2 // strip trailing CRLF
    if (dataEnd < headerEnd + 4) dataEnd = headerEnd + 4
    const nameMatch = /name="([^"]*)"/iu.exec(headerText)
    const fileMatch = /filename="([^"]*)"/iu.exec(headerText)
    const typeMatch = /content-type:\s*([^\r\n]+)/iu.exec(headerText)
    const name = nameMatch?.[1] ?? `part-${parts.size}`
    parts.set(name, {
      name,
      filename: fileMatch?.[1] || undefined,
      contentType: typeMatch?.[1]?.trim() || undefined,
      data: body.slice(headerEnd + 4, dataEnd),
    })
    index = next + boundaryBytes.length
    if (index >= body.length) break
  }
  return parts
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = Math.max(0, from); i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}
