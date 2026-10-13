import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NovelAIClient } from '../src/core/client.ts'

const pools = vi.hoisted(() => [] as Array<{ destroy: ReturnType<typeof vi.fn> }>)
vi.mock('undici', () => ({ ProxyAgent: class {
  destroy = vi.fn(async () => {})
  constructor() { pools.push(this) }
} }))
beforeEach(() => { pools.length = 0 })
afterEach(() => vi.unstubAllGlobals())
const client = () => new NovelAIClient({ token: 'pst-offline-fixture', proxy: 'http://proxy.invalid' })

describe('request-owned proxy pools', () => {
  it('destroys the dispatcher after consuming a successful response', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    vi.stubGlobal('fetch', fetcher)
    expect(await client().postOperation('/ai/upscale', {})).toEqual(new Uint8Array([1, 2, 3]))
    expect(pools).toHaveLength(1)
    expect(fetcher.mock.calls[0]![1].dispatcher).toBe(pools[0])
    expect(pools[0]!.destroy).toHaveBeenCalledOnce()
  })

  it.each(['network', 'body', 'http'])('destroys the dispatcher after a %s failure without retrying an unknown POST', async (kind) => {
    const fetcher = vi.fn(async () => {
      if (kind === 'network') throw new Error('Offline fixture')
      if (kind === 'body') return new Response(new ReadableStream({ start(controller) { controller.error(new Error('Broken fixture stream')) } }))
      return new Response('{"message":"Denied"}', { status: 401 })
    })
    vi.stubGlobal('fetch', fetcher)
    await expect(client().postOperation('/ai/upscale', {})).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(pools).toHaveLength(1)
    expect(pools[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('does not allocate a dispatcher for a request cancelled before submission', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(client().postOperation('/ai/upscale', {}, AbortSignal.abort())).rejects.toMatchObject({ notSubmitted: true })
    expect(pools).toHaveLength(0)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
