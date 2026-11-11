import { InspirationEngine } from '../src/workbench/inspiration.ts'

const query = process.argv.slice(2).join(' ').trim() || 'forest'
const engine = new InspirationEngine('unused')
try {
  const result = await engine.search({ query, source: 'danbooru', limit: 1 })
  const item = result.items[0]
  let image: Record<string, unknown> | null = null
  if (item?.previewUrl) {
    try {
      const fetched = await engine.fetchImage(item.previewUrl)
      image = { ok: true, contentType: fetched.contentType, bytes: fetched.buffer.length }
    } catch (error) {
      image = { ok: false, code: (error as { code?: string }).code ?? 'IMAGE_ERROR', message: (error as Error).message }
    }
  }
  console.log(JSON.stringify({ query, count: result.items.length, errors: result.errors, hasMore: result.hasMore, image }, null, 2))
} finally {
  await engine.close()
}
