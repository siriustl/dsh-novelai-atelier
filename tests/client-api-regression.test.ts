import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, assetUrl, saveBlob } from '../client/api.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('browser API boundary', () => {
  it('preserves HTTP conflict details without automatically retrying a mutation', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'Draft changed', details: { field: 'revision' }, code: 'conflict' }), { status: 409 }))
    vi.stubGlobal('fetch', fetcher)
    const failure = await api('/draft', 'PATCH', { base_revision: 2 }).catch((error) => error)
    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 409, code: 'conflict', details: { field: 'revision' }, retryable: false })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'same-origin', method: 'PATCH' })
  })

  it('does not expose host HTML errors as panel content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>private server internals</html>', { status: 401 })))
    const failure = await api('/bootstrap').catch((error) => error)
    expect(failure.status).toBe(401)
    expect(failure.message).not.toContain('<html>')
    expect(failure.message).not.toContain('private server')
  })

  it('reports a successful non-JSON mutation response as unconfirmed instead of pretending it was saved', async () => {
    const fetcher = vi.fn(async () => new Response('not json', { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(api('/jobs', 'POST', {})).rejects.toMatchObject({ status: 200, name: 'ApiError' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('keeps caller cancellation identity and forwards the exact signal', async () => {
    const signal = AbortSignal.abort()
    const reason = new DOMException('Cancelled', 'AbortError')
    const fetcher = vi.fn(async () => { throw reason })
    vi.stubGlobal('fetch', fetcher)
    await expect(api('/library', 'GET', undefined, undefined, signal)).rejects.toBe(reason)
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ signal })
  })

  it('wraps network failures but never retries them automatically', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    vi.stubGlobal('fetch', fetcher)
    await expect(api('/jobs', 'POST', {})).rejects.toMatchObject({ status: 0, retryable: true })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('supports empty acknowledged responses and encodes asset ids', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    expect(await api('/empty')).toBeNull()
    expect(assetUrl('one/two')).toContain('one%2Ftwo/file')
  })

  it('keeps a downloadable object URL alive until browser navigation can consume it', () => {
    vi.useFakeTimers()
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    const appendChild = vi.fn()
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('document', { createElement: () => anchor, body: { appendChild } })
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:download'), revokeObjectURL })
    saveBlob(new Blob(['content']), 'artworks.zip')
    expect(appendChild).toHaveBeenCalledWith(anchor)
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(anchor.download).toBe('artworks.zip')
    expect(revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download')
  })
})
