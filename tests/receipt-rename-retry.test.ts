import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeRecord, OperationExecutor } from '../src/core/service.ts'
import { getOperationStatus } from '../src/core/recovery.ts'
import { prepareOperation } from '../src/core/operations.ts'
import { encodePng } from '../src/core/png.ts'
import type { NovelAIClient } from '../src/core/client.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  }
})

const roots: string[] = []
let actualFs: typeof import('node:fs')
beforeEach(async () => {
  actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actualFs.renameSync)
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(actualFs.writeFileSync)
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(actualFs.unlinkSync)
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
  vi.spyOn(performance, 'now').mockReturnValue(0)
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    const checked = resolve(root)
    if (!checked.startsWith(resolve(join(tmpdir(), 'nai-receipt-rename-')))) throw new Error('Unexpected fixture cleanup path')
    rmSync(checked, { recursive: true, force: true })
  }
})

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'nai-receipt-rename-'))
  roots.push(root)
  return root
}
function errorWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Injected ${code}`), { code })
}
function previousReceipt(): { root: string; path: string; previous: string } {
  const root = temporary(), path = join(root, 'record.json'), previous = '{"status":"last-good"}\n'
  actualFs.writeFileSync(path, previous)
  return { root, path, previous }
}
function assertPreserved(root: string, path: string, previous: string): void {
  expect(readFileSync(path, 'utf8')).toBe(previous)
  expect(readdirSync(root)).toEqual(['record.json'])
  expect(fs.unlinkSync).toHaveBeenCalledOnce()
  expect(fs.unlinkSync).not.toHaveBeenCalledWith(path)
  expect(String(vi.mocked(fs.unlinkSync).mock.calls[0]![0])).toMatch(/\.tmp$/)
}

function savedStatus(flags: Record<string, unknown> = {}): Record<string, unknown> {
  const path = join(temporary(), 'receipt.json')
  actualFs.writeFileSync(path, JSON.stringify({
    id: '20261003T120000Z-abcdef1234', operation: 'generate', status: 'prepared',
    request: {}, api_payload: {}, ...flags,
  }))
  return getOperationStatus({ record_path: path })
}
async function execution() {
  const root = temporary()
  const executor = new OperationExecutor({
    token: () => '', baseUrl: () => 'https://offline.invalid', proxy: () => null,
    outputDir: () => root, dataDir: () => root,
  }, { run: async (fn) => fn() })
  const prepared = await prepareOperation({ prompt: 'geometric shapes', width: 64, height: 64, seed: 123 }, 'generate')
  const client = {
    postOperation: vi.fn().mockResolvedValue(encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255))),
    credits: vi.fn().mockRejectedValue(new Error('Billing must not be called')),
  }
  const receiptPath = () => join(root, readdirSync(root).find((name) => name.endsWith('.json'))!)
  return { root, executor, prepared, client, receiptPath }
}

describe('bounded atomic Windows receipt commits', () => {
  it('keeps the synchronous signature and does not wait on an immediate success', () => {
    const { root, path } = previousReceipt()
    expect(writeRecord(path, { status: 'generated' })).toBeUndefined()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ status: 'generated' })
    expect(fs.renameSync).toHaveBeenCalledOnce()
    expect(Atomics.wait).not.toHaveBeenCalled()
    expect(readdirSync(root)).toEqual(['record.json'])
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries transient %s with the same complete temporary file', (code) => {
    const { root, path } = previousReceipt()
    const error = errorWithCode(code)
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw error }).mockImplementationOnce(() => { throw error })
    writeRecord(path, { status: 'generated', description: 'complete receipt' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ status: 'generated', description: 'complete receipt' })
    expect(fs.writeFileSync).toHaveBeenCalledOnce()
    expect(fs.renameSync).toHaveBeenCalledTimes(3)
    const sources = vi.mocked(fs.renameSync).mock.calls.map(([source]) => String(source))
    expect(new Set(sources).size).toBe(1)
    expect(vi.mocked(Atomics.wait).mock.calls.map((call) => call[3])).toEqual([10, 20])
    expect(fs.unlinkSync).not.toHaveBeenCalled()
    expect(readdirSync(root)).toEqual(['record.json'])
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('bounds permanent %s and preserves the last good receipt', (code) => {
    const { root, path, previous } = previousReceipt(), error = errorWithCode(code)
    vi.mocked(fs.renameSync).mockImplementation(() => { throw error })
    expect(() => writeRecord(path, { status: 'submitted' })).toThrow(error)
    expect(fs.renameSync).toHaveBeenCalledTimes(5)
    expect(vi.mocked(Atomics.wait).mock.calls.map((call) => call[3])).toEqual([10, 20, 40, 80])
    assertPreserved(root, path, previous)
  })

  it.each(['ENOSPC', 'ENOENT', 'EINVAL'])('fails immediately for nontransient %s without damaging the destination', (code) => {
    const { root, path, previous } = previousReceipt(), error = errorWithCode(code)
    vi.mocked(fs.renameSync).mockImplementation(() => { throw error })
    expect(() => writeRecord(path, { status: 'submitted' })).toThrow(error)
    expect(fs.renameSync).toHaveBeenCalledOnce()
    expect(Atomics.wait).not.toHaveBeenCalled()
    assertPreserved(root, path, previous)
  })

  it('does not apply the Windows workaround on other platforms', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const { root, path, previous } = previousReceipt(), error = errorWithCode('EPERM')
    vi.mocked(fs.renameSync).mockImplementation(() => { throw error })
    expect(() => writeRecord(path, { status: 'submitted' })).toThrow(error)
    expect(fs.renameSync).toHaveBeenCalledOnce()
    expect(Atomics.wait).not.toHaveBeenCalled()
    assertPreserved(root, path, previous)
  })

  it('caps the remaining wait and does not make another attempt after its deadline', () => {
    const { root, path, previous } = previousReceipt(), error = errorWithCode('EBUSY')
    vi.mocked(performance.now).mockReturnValueOnce(0).mockReturnValueOnce(195).mockReturnValue(200)
    vi.mocked(fs.renameSync).mockImplementation(() => { throw error })
    expect(() => writeRecord(path, { status: 'submitted' })).toThrow(error)
    expect(fs.renameSync).toHaveBeenCalledOnce()
    expect(Atomics.wait).toHaveBeenCalledWith(expect.any(Int32Array), 0, 0, 5)
    assertPreserved(root, path, previous)
  })

  it('does not sleep once the retry budget is exhausted', () => {
    const { root, path, previous } = previousReceipt(), error = errorWithCode('EACCES')
    vi.mocked(performance.now).mockReturnValueOnce(0).mockReturnValue(200)
    vi.mocked(fs.renameSync).mockImplementation(() => { throw error })
    expect(() => writeRecord(path, { status: 'submitted' })).toThrow(error)
    expect(fs.renameSync).toHaveBeenCalledOnce()
    expect(Atomics.wait).not.toHaveBeenCalled()
    assertPreserved(root, path, previous)
  })

  it('cleans only its temporary file if writing it fails partway through', () => {
    const { root, path, previous } = previousReceipt(), error = errorWithCode('ENOSPC')
    vi.mocked(fs.writeFileSync).mockImplementationOnce((tmp) => {
      actualFs.writeFileSync(tmp, 'partial')
      throw error
    })
    expect(() => writeRecord(path, { status: 'submitted' })).toThrow(error)
    expect(fs.renameSync).not.toHaveBeenCalled()
    expect(Atomics.wait).not.toHaveBeenCalled()
    assertPreserved(root, path, previous)
  })
})

describe('receipt commit failures cannot submit or replay a POST', () => {
  it('makes zero POST calls when the initial prepared receipt cannot be committed', async () => {
    const { root, executor, prepared, client } = await execution()
    vi.mocked(fs.renameSync).mockImplementation(() => { throw errorWithCode('EPERM') })
    await expect(executor.execute(prepared, { client: client as unknown as NovelAIClient })).rejects.toMatchObject({ notSubmitted: true })
    expect(client.postOperation).not.toHaveBeenCalled()
    expect(client.credits).not.toHaveBeenCalled()
    expect(readdirSync(root)).toEqual([])
  })

  it('makes zero POST calls when the submitted receipt fails and preserves explicit not-submitted evidence', async () => {
    const { root, executor, prepared, client, receiptPath } = await execution()
    let blocked = 0
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (JSON.parse(readFileSync(from, 'utf8')).status === 'submitted') { blocked++; throw errorWithCode('EPERM') }
      return actualFs.renameSync(from, to)
    })
    await expect(executor.execute(prepared, { client: client as unknown as NovelAIClient })).rejects.toMatchObject({
      notSubmitted: true, submission_outcome_unknown: false,
      partialResult: { not_submitted: true, anlas_spent: 0 },
    })
    expect(blocked).toBe(5)
    expect(client.postOperation).not.toHaveBeenCalled()
    expect(client.credits).not.toHaveBeenCalled()
    expect(getOperationStatus({ record_path: receiptPath() })).toMatchObject({
      status: 'prepared', not_submitted: true, anlas_spent: 0,
      guidance: expect.stringContaining('request was not submitted'),
    })
    expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('retries only a transient submitted-receipt lock before making exactly one mock POST', async () => {
    const { executor, prepared, client } = await execution()
    let blocked = 0
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (JSON.parse(readFileSync(from, 'utf8')).status === 'submitted' && blocked++ < 2) throw errorWithCode('EBUSY')
      return actualFs.renameSync(from, to)
    })
    await expect(executor.execute(prepared, { client: client as unknown as NovelAIClient })).resolves.toMatchObject({ status: 'generated' })
    expect(client.postOperation).toHaveBeenCalledOnce()
    expect(client.credits).not.toHaveBeenCalled()
  })

  it('retains unknown POST flags and warning guidance without resubmitting', async () => {
    const { executor, prepared, client, receiptPath } = await execution()
    client.postOperation.mockRejectedValueOnce(new Error('Lost response after mock submission'))
    await expect(executor.execute(prepared, { client: client as unknown as NovelAIClient })).rejects.toMatchObject({ submission_outcome_unknown: true })
    const status = getOperationStatus({ record_path: receiptPath() })
    expect(status).toMatchObject({ status: 'failed', submission_outcome_unknown: true, anlas_spent: null })
    expect(status.guidance).toContain('Do not automatically retry or resubmit the POST')
    expect(client.postOperation).toHaveBeenCalledOnce()
    expect(client.credits).not.toHaveBeenCalled()
  })
})

describe('explicit receipt submission flags', () => {
  it('preserves explicit true and false booleans without inferring them from prepared', () => {
    expect(savedStatus({ not_submitted: true, submission_outcome_unknown: false })).toMatchObject({
      not_submitted: true, submission_outcome_unknown: false,
      guidance: expect.stringContaining('request was not submitted'),
    })
    expect(savedStatus({ not_submitted: false, submission_outcome_unknown: false })).toMatchObject({
      not_submitted: false, submission_outcome_unknown: false,
      guidance: expect.stringContaining('does not establish whether the server generated'),
    })
    const missing = savedStatus()
    expect(missing).not.toHaveProperty('not_submitted')
    expect(missing).not.toHaveProperty('submission_outcome_unknown')
    expect(missing.guidance).toContain('does not establish whether the server generated')
  })

  it.each(['true', 1, null])('does not coerce untrusted non-boolean flags %j', (value) => {
    const status = savedStatus({ not_submitted: value, submission_outcome_unknown: value })
    expect(status).not.toHaveProperty('not_submitted')
    expect(status).not.toHaveProperty('submission_outcome_unknown')
    expect(status.guidance).toContain('does not establish whether the server generated')
  })

  it.each(['prepared', 'generated'])('gives explicit unknown outcome priority over conflicting flags in %s receipts', (status) => {
    const result = savedStatus({ status, not_submitted: true, submission_outcome_unknown: true })
    expect(result).toMatchObject({ not_submitted: true, submission_outcome_unknown: true })
    expect(result.guidance).toContain('Do not automatically retry or resubmit the POST')
    expect(result.guidance).not.toContain('request was not submitted')
  })
})
