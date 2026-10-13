import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NovelAIClient, NovelAINotSubmitted } from '../src/core/client.ts'
import { OperationExecutor } from '../src/core/service.ts'
import { prepareOperation } from '../src/core/operations.ts'
import { encodePng } from '../src/core/png.ts'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const image = () => encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255))
const rejected = (retryAfter?: string) => new Response(JSON.stringify({ message: 'Concurrent generation is locked' }), { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} })
async function setup(options: { retryDelaySeconds?: number; retryMaxAttempts?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nai-retry-cancel-')); roots.push(root)
  const client = new NovelAIClient({ token: 'pst-offline-test', baseUrl: 'https://image.novelai.net', ...options })
  const readCredits = vi.spyOn(client, 'credits').mockRejectedValue(new Error('must not check quota'))
  const executor = new OperationExecutor({ token: () => 'pst-offline-test', baseUrl: () => 'https://image.novelai.net', proxy: () => null, outputDir: () => root, dataDir: () => root }, { run: async (fn) => fn() })
  const prepared = await prepareOperation({ prompt: 'offline test', width: 64, height: 64, max_anlas: 0 }, 'generate')
  const receipts = () => readdirSync(root).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(root, name), 'utf8')))
  return { root, client, readCredits, executor, prepared, receipts }
}

describe('configured read-only retries', () => {
  it('retries transient GET network and HTTP 503 failures at the default interval', async () => {
    vi.useFakeTimers()
    const client = new NovelAIClient({ token: 'pst-offline-test' })
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('read connection reset'))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ active: true, tier: 3, trainingStepsLeft: 100 })))
    vi.stubGlobal('fetch', fetchMock)
    const pending = client.credits()
    await vi.advanceTimersByTimeAsync(2999); expect(fetchMock).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1); expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3000)
    await expect(pending).resolves.toMatchObject({ anlas: { total: 100 } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry HTTP 401', async () => {
    const client = new NovelAIClient({ token: 'pst-offline-test' })
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 })); vi.stubGlobal('fetch', fetchMock)
    await expect(client.credits()).rejects.toMatchObject({ status_code: 401 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('cancels a pending read-only retry promptly', async () => {
    vi.useFakeTimers()
    const client = new NovelAIClient({ token: 'pst-offline-test' })
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('connection reset')); vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = client.credits(controller.signal)
    const failure = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1); controller.abort(); await failure
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('uses configured retry policy for tag suggestions', async () => {
    vi.useFakeTimers()
    const client = new NovelAIClient({ token: 'pst-offline-test', retryDelaySeconds: 1, retryMaxAttempts: 2 })
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('connection reset')).mockResolvedValueOnce(new Response('{"tags":[{"tag":"tree"}]}'))
    vi.stubGlobal('fetch', fetchMock)
    const pending = client.suggestTags('tree', 'nai-diffusion-5-full')
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toEqual([{ tag: 'tree', count: undefined }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('bounded safe POST retries', () => {
  it('defaults to three seconds and three total attempts, preserving payload and guards', async () => {
    vi.useFakeTimers()
    const { executor, client, prepared, root, readCredits } = await setup()
    const fetchMock = vi.fn().mockImplementationOnce(async () => rejected()).mockImplementationOnce(async () => rejected()).mockImplementationOnce(async () => new Response(image()))
    vi.stubGlobal('fetch', fetchMock)
    const beforeSubmit = vi.fn()
    const pending = executor.execute(prepared, { client, beforeSubmit })
    await vi.advanceTimersByTimeAsync(2999); expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3000)
    await expect(pending).resolves.toMatchObject({ operation: 'generate', anlas_spent: null })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(beforeSubmit).toHaveBeenCalledTimes(4)
    expect(new Set(fetchMock.mock.calls.map((call) => (call[1] as RequestInit).body)).size).toBe(1)
    expect(readCredits).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'billing-review-required.json'))).toBe(false)
  })

  it('stops after the third verified rejection as confirmed not submitted', async () => {
    vi.useFakeTimers()
    const { executor, client, prepared, receipts } = await setup()
    const fetchMock = vi.fn(async () => rejected()); vi.stubGlobal('fetch', fetchMock)
    const pending = executor.execute(prepared, { client })
    const failure = expect(pending).rejects.toMatchObject({ notSubmitted: true, status_code: 429, partialResult: { anlas_spent: 0 } })
    await vi.advanceTimersByTimeAsync(6000); await failure
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(receipts()[0]).toMatchObject({ status: 'prepared', not_submitted: true, anlas_spent: 0 })
  })

  it('checks stop or cancellation before every retry submission', async () => {
    vi.useFakeTimers()
    const { executor, client, prepared } = await setup()
    const fetchMock = vi.fn(async () => rejected()); vi.stubGlobal('fetch', fetchMock)
    let stopped = false
    const pending = executor.execute(prepared, { client, beforeSubmit: () => { if (stopped) throw new Error('stopped before submission') } })
    const failure = expect(pending).rejects.toBeInstanceOf(NovelAINotSubmitted)
    await vi.advanceTimersByTimeAsync(1); stopped = true
    await vi.advanceTimersByTimeAsync(3000); await failure
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('cancels the retry wait without another POST', async () => {
    vi.useFakeTimers()
    const { executor, client, prepared, readCredits, receipts } = await setup()
    const fetchMock = vi.fn(async () => rejected()); vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = executor.execute(prepared, { client, signal: controller.signal })
    const failure = expect(pending).rejects.toBeInstanceOf(NovelAINotSubmitted)
    await vi.advanceTimersByTimeAsync(1); controller.abort(); await failure
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(readCredits).not.toHaveBeenCalled()
    expect(receipts()[0]).toMatchObject({ not_submitted: true, anlas_spent: 0 })
  })

  it('honors configured timing, attempt limit and a longer Retry-After', async () => {
    vi.useFakeTimers()
    const { client, prepared } = await setup({ retryDelaySeconds: 1, retryMaxAttempts: 2 })
    const fetchMock = vi.fn().mockImplementationOnce(async () => rejected('5')).mockImplementationOnce(async () => new Response(image()))
    vi.stubGlobal('fetch', fetchMock)
    const pending = client.postOperation(prepared.endpoint, prepared.payload)
    await vi.advanceTimersByTimeAsync(4999); expect(fetchMock).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1); await pending
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'])('safely retries proven pre-connect %s failures', async (code) => {
    vi.useFakeTimers()
    const { client, prepared } = await setup()
    const error = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect failed'), { code }) })
    const fetchMock = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(new Response(image())); vi.stubGlobal('fetch', fetchMock)
    const pending = client.postOperation(prepared.endpoint, prepared.payload)
    await vi.advanceTimersByTimeAsync(3000); await pending
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['ECONNRESET', 'ETIMEDOUT'])('does not retry ambiguous transport %s', async (code) => {
    const { executor, client, prepared, receipts } = await setup()
    const error = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('transport lost'), { code }) })
    const fetchMock = vi.fn().mockRejectedValue(error); vi.stubGlobal('fetch', fetchMock)
    await expect(executor.execute(prepared, { client })).rejects.toMatchObject({ submission_outcome_unknown: true })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(receipts()[0]).toMatchObject({ submission_outcome_unknown: true, anlas_spent: null })
  })

  it('keeps cancellation while receiving a response ambiguous', async () => {
    const { executor, client, prepared } = await setup()
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_url: unknown, options: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(body) { options.signal!.addEventListener('abort', () => body.error(new DOMException('Aborted', 'AbortError')), { once: true }); controller.abort() },
    })))
    vi.stubGlobal('fetch', fetchMock)
    await expect(executor.execute(prepared, { client, signal: controller.signal })).rejects.toMatchObject({ submission_outcome_unknown: true })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
