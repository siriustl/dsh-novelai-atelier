import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NovelAIError, NovelAINotSubmitted } from '../src/core/client.ts'
import { OperationExecutor } from '../src/core/service.ts'
import { prepareOperation } from '../src/core/operations.ts'
import { encodePng } from '../src/core/png.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})
beforeEach(async () => { vi.mocked(fs.renameSync).mockImplementation((await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync) })

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const image = () => encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255))
const httpError = (status: number) => { const error = new NovelAIError(`NovelAI HTTP ${status}: request failed`); error.status_code = status; return error }
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'nai-direct-outcome-')); roots.push(root)
  const executor = new OperationExecutor({ token: () => 'pst-offline-test', baseUrl: () => 'https://image.novelai.net', proxy: () => null, outputDir: () => root, dataDir: () => root }, { run: async (fn) => fn() })
  const prepared = await prepareOperation({ prompt: 'tree', width: 64, height: 64, max_anlas: 0 }, 'generate')
  const client: any = { credits: vi.fn().mockRejectedValue(new Error('must not check billing')), postOperation: vi.fn().mockResolvedValue(image()) }
  const receipts = () => readdirSync(root).filter((name) => name.endsWith('.json') && name !== 'billing-review-required.json').map((name) => JSON.parse(readFileSync(join(root, name), 'utf8')))
  return { root, executor, prepared, client, receipts }
}

describe('execution without automatic billing defense', () => {
  it('submits a request with paid-size parameters and legacy max_anlas zero without a forecast gate', async () => {
    const { executor, client } = await setup()
    const prepared = await prepareOperation({ prompt: 'tree', width: 64, height: 64, steps: 50, max_anlas: 0 }, 'generate')
    await expect(executor.execute(prepared, { client })).resolves.toMatchObject({ status: 'generated', anlas_spent: null })
    expect(client.credits).not.toHaveBeenCalled()
    expect(client.postOperation).toHaveBeenCalledOnce()
  })

  it.each([3, 4, 5])('still returns a saved image if receipt commit %i fails', async (failureAt) => {
    const { executor, prepared, client } = await setup()
    const rename = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync
    let commits = 0
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (++commits === failureAt) throw new Error('injected receipt write failure')
      return rename(from, to)
    })
    const result = await executor.execute(prepared, { client })
    expect(result).toMatchObject({ status: 'generated', anlas_spent: null })
    expect(existsSync(String(result['image_path']))).toBe(true)
    expect((result['warnings'] as string[]).join(' ')).toMatch(/receipt/)
    if (failureAt === 4) expect(existsSync(String(result['response_path']))).toBe(true)
    expect(client.postOperation).toHaveBeenCalledOnce()
    expect(client.credits).not.toHaveBeenCalled()
  })

  it('does not replace a primary transport failure when its final receipt write also fails', async () => {
    const { executor, prepared, client } = await setup()
    const rename = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync
    let commits = 0
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (++commits >= 3) throw new Error('injected receipt write failure')
      return rename(from, to)
    })
    client.postOperation.mockRejectedValueOnce(new Error('original connection failure'))
    await expect(executor.execute(prepared, { client })).rejects.toMatchObject({ message: expect.stringContaining('original connection failure'), submission_outcome_unknown: true, partialResult: { anlas_spent: null } })
  })

  it('ignores and preserves a legacy billing marker without querying quota', async () => {
    const { root, executor, prepared, client, receipts } = await setup()
    const marker = '{"reason":"old user diagnostic"}'
    writeFileSync(join(root, 'billing-review-required.json'), marker)
    await expect(executor.execute(prepared, { client })).resolves.toMatchObject({ status: 'generated', anlas_spent: null, submission_outcome_unknown: false })
    expect(client.credits).not.toHaveBeenCalled()
    expect(readFileSync(join(root, 'billing-review-required.json'), 'utf8')).toBe(marker)
    expect(receipts()[0]).toMatchObject({ status: 'generated', anlas_spent: null })
  })

  it.each([
    ['caller abort', () => new DOMException('Cancelled after submission', 'AbortError')],
    ['deadline', () => new DOMException('POST timed out', 'TimeoutError')],
    ['transport loss', () => new Error('Connection reset after submission')],
    ['HTTP 408', () => httpError(408)],
    ['HTTP 500', () => httpError(500)],
    ['HTTP 503', () => httpError(503)],
  ] as const)('preserves %s ambiguity without retrying or globally blocking another request', async (_name, createError) => {
    const { root, executor, prepared, client, receipts } = await setup()
    client.postOperation.mockRejectedValueOnce(createError())
    await expect(executor.execute(prepared, { client })).rejects.toMatchObject({ receiptPath: expect.any(String), submission_outcome_unknown: true, partialResult: { status: 'failed', anlas_spent: null, submission_outcome_unknown: true } })
    expect(client.postOperation).toHaveBeenCalledOnce()
    expect(client.credits).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'billing-review-required.json'))).toBe(false)
    expect(receipts()[0]).toMatchObject({ status: 'failed', submission_outcome_unknown: true, anlas_spent: null })
    await expect(executor.execute(prepared, { client })).resolves.toMatchObject({ status: 'generated' })
    expect(client.postOperation).toHaveBeenCalledTimes(2)
  })

  it.each([401, 402, 403, 429])('reports verified HTTP %i rejection as not submitted', async (status) => {
    const { root, executor, prepared, client, receipts } = await setup()
    client.postOperation.mockRejectedValueOnce(httpError(status))
    await expect(executor.execute(prepared, { client })).rejects.toMatchObject({ notSubmitted: true, status_code: status, submission_outcome_unknown: false, partialResult: { anlas_spent: 0 } })
    expect(client.credits).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'billing-review-required.json'))).toBe(false)
    expect(receipts()[0]).toMatchObject({ status: 'prepared', not_submitted: true, anlas_spent: 0 })
  })

  it('wraps cancellation before submission without creating a submitted receipt', async () => {
    const { executor, prepared, client, receipts } = await setup()
    const controller = new AbortController(); controller.abort()
    await expect(executor.execute(prepared, { client, signal: controller.signal })).rejects.toBeInstanceOf(NovelAINotSubmitted)
    expect(client.postOperation).not.toHaveBeenCalled()
    expect(client.credits).not.toHaveBeenCalled()
    expect(receipts()).toHaveLength(0)
  })

  it('retains complete invalid responses and never invents a generation retry', async () => {
    const { root, executor, prepared, client, receipts } = await setup()
    client.postOperation.mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
    await expect(executor.execute(prepared, { client })).rejects.toMatchObject({ submission_outcome_unknown: false, partialResult: { status: 'failed', response_path: expect.any(String) } })
    expect(receipts()[0].response_path).toBeDefined()
    expect(existsSync(receipts()[0].response_path)).toBe(true)
    expect(client.postOperation).toHaveBeenCalledOnce()
    expect(existsSync(join(root, 'billing-review-required.json'))).toBe(false)
  })
})
