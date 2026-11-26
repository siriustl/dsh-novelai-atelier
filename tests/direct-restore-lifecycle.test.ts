import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workbench } from '../src/workbench/app.ts'
import { Backup } from '../src/workbench/backup.ts'
import { prepareOperation } from '../src/core/operations.ts'

const roots: string[] = []
const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'nai-direct-restore-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const credits = () => ({ active: true, tier: 3, expires_at: Date.now() / 1000 + 86400, anlas: { subscription: 100, purchased: 0, total: 100 }, perks: {}, v5_usage: { isNegative: false }, v5_usage_summary: null })

describe('direct execution and restore lifecycle', () => {
  it.each(['transport failure', 'cancelled'])('blocks restore throughout an active direct operation and releases its gate after %s', async (outcome) => {
    const source = new Workbench(temporary()), wb = new Workbench(temporary())
    const archive = new Backup(source).export()
    const before = structuredClone(wb.store.data)
    const prepared = await prepareOperation({ prompt: 'offline tree', width: 64, height: 64, max_anlas: 0 }, 'generate')
    let reject!: (error: Error) => void
    const pending = new Promise<Uint8Array>((_yes, no) => { reject = no })
    const controller = new AbortController()
    let started!: () => void
    const postStarted = new Promise<void>((yes) => { started = yes })
    const client: any = { credits: vi.fn(), postOperation: vi.fn(() => { started(); return pending }) }
    const execution = wb.executor.execute(prepared, { client, signal: controller.signal })
    const settled = execution.catch((error) => error)
    await postStarted
    expect(wb.executor.activeExecutions).toBe(1)
    expect(() => new Backup(wb).restore(archive.path)).toThrow(/等待/)
    expect(wb.store.data).toEqual(before)
    if (outcome === 'transport failure') reject(new Error('offline transport failure'))
    else { controller.abort(); reject(new DOMException('Cancelled after submission', 'AbortError')) }
    expect(await settled).toBeInstanceOf(Error)
    expect(wb.executor.activeExecutions).toBe(0)
    expect(client.postOperation).toHaveBeenCalledOnce()
    expect(client.credits).not.toHaveBeenCalled()
    expect(wb.store.listJobs()).toHaveLength(0)
    expect(new Backup(wb).restore(archive.path)).toMatchObject({ restored: true, paused: true })
  })
})
