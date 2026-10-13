import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NovelAIClient } from '../src/core/client.ts'
import { Store } from '../src/workbench/store.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('submission durability', () => {
  it('commits a manual schedule run and its jobs in a single durable transition', () => {
    const root = mkdtempSync(join(tmpdir(), 'nai-schedule-atomic-'))
    try {
      const store = new Store(root)
      const schedule = store.saveSchedule({
        name: 'atomic test', kind: 'once', at: new Date(Date.now() + 3600_000).toISOString(),
        operation: 'generate', request: { prompt: 'test', max_anlas: 0 },
        count: 1, max_runs: 2, max_total_anlas: 0, enabled: false,
      })
      const persist = vi.spyOn(store, 'internalPersist')
      store.scheduleOnce(String(schedule.id), Number(schedule.revision), 'manual-once')
      expect(persist).toHaveBeenCalledTimes(1)
      const restarted = new Store(root)
      expect(restarted.getSchedule(String(schedule.id)).runs).toBe(1)
      expect(restarted.listScheduleRuns(String(schedule.id))).toHaveLength(1)
      expect(restarted.listJobs()).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists accepted jobs and idempotency before a worker claims them', () => {
    const root = mkdtempSync(join(tmpdir(), 'nai-durability-'))
    try {
      const first = new Store(root)
      first.setPaused(true)
      const snapshot = { operation: 'generate', request: { prompt: 'test', max_anlas: 5 } }
      const jobs = first.createJobs([snapshot], 5, 'durable-submit')
      const restarted = new Store(root)
      expect(restarted.getPaused()).toBe(true)
      expect(restarted.getJob(String(jobs[0]!.id)).status).toBe('queued')
      const repeated = restarted.createJobs([snapshot], 5, 'durable-submit')
      expect(repeated[0]!.id).toBe(jobs[0]!.id)
      expect(restarted.listJobs()).toHaveLength(1)
      expect(restarted.getBatch(String(jobs[0]!.batch_id)).budget).toBe(5)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('NovelAI cancellation', () => {
  it('never submits when a per-call or client-default signal is already aborted', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    const client = new NovelAIClient({ token: 'pst-test', signal: controller.signal })
    await expect(client.generate({})).rejects.toMatchObject({ name: 'AbortError' })
    await expect(new NovelAIClient({ token: 'pst-test' }).generate({}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps caller cancellation attached while response bytes stream', async () => {
    const controller = new AbortController()
    let bodyStarted!: () => void
    const started = new Promise<void>((resolve) => { bodyStarted = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(body) {
          options.signal!.addEventListener('abort', () => body.error(new DOMException('Aborted', 'AbortError')), { once: true })
        },
        pull() { bodyStarted() },
      })
      return new Response(stream)
    }))
    const pending = new NovelAIClient({ token: 'pst-test' }).generate({}, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await started
    controller.abort()
    await rejected
  })

  it('keeps the request deadline attached while a body stalls', async () => {
    vi.useFakeTimers()
    let bodyStarted!: () => void
    const started = new Promise<void>((resolve) => { bodyStarted = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(body) {
        options.signal!.addEventListener('abort', () => body.error(new DOMException('Aborted', 'AbortError')), { once: true })
      },
      pull() { bodyStarted() },
    }))))
    const pending = new NovelAIClient({ token: 'pst-test' }).generate({})
    const rejected = expect(pending).rejects.toThrow('Generation outcome is unknown')
    await started
    await vi.advanceTimersByTimeAsync(180_000)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not resubmit when cancelled during HTTP 429 backoff', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: 'locked' }), { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = new NovelAIClient({ token: 'pst-test', signal: controller.signal }).generate({})
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    controller.abort()
    await rejected
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes the caller listener on success and network failure', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([1])))
      .mockRejectedValueOnce(new Error('network unavailable'))
    vi.stubGlobal('fetch', fetchMock)
    const client = new NovelAIClient({ token: 'pst-test' })
    await client.generate({}, controller.signal)
    await expect(client.generate({}, controller.signal)).rejects.toThrow('Generation outcome is unknown')
    expect(remove).toHaveBeenCalledTimes(2)
  })
})
