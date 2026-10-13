import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workbench } from '../src/workbench/app.ts'
import { Backup } from '../src/workbench/backup.ts'

const roots: string[] = []
const workbench = () => { const root = mkdtempSync(join(tmpdir(), 'nai-retry-settings-')); roots.push(root); return new Workbench(root) }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('configured retry policy end to end', () => {
  it('defaults to three seconds and three total attempts for direct and frozen clients', () => {
    const wb = workbench()
    wb.settings.save({ nai_token: 'pst-synthetic-retry-settings' })
    expect(wb.settings.public()).toMatchObject({ retry_delay_seconds: 3, retry_max_attempts: 3 })
    for (const client of [wb.executor.makeClient(), wb.client(), wb.client(wb.settings.freeze())])
      expect(client).toMatchObject({ retryDelaySeconds: 3, retryMaxAttempts: 3 })
  })

  it('persists changes and freezes the chosen policy for queued work without network requests', () => {
    const wb = workbench()
    wb.settings.save({ nai_token: 'pst-synthetic-retry-settings', retry_delay_seconds: 5, retry_max_attempts: 2 })
    const frozen = wb.settings.freeze()
    wb.settings.save({ retry_delay_seconds: 1, retry_max_attempts: 1 })
    expect(wb.client(frozen)).toMatchObject({ retryDelaySeconds: 5, retryMaxAttempts: 2 })
    expect(wb.executor.makeClient()).toMatchObject({ retryDelaySeconds: 1, retryMaxAttempts: 1 })
    const reopened = new Workbench(wb.root)
    expect(reopened.settings.public()).toMatchObject({ retry_delay_seconds: 1, retry_max_attempts: 1 })
    expect(reopened.executor.makeClient()).toMatchObject({ retryDelaySeconds: 1, retryMaxAttempts: 1 })
    const { retry_delay_seconds: _delay, retry_max_attempts: _attempts, ...oldContext } = frozen
    expect(reopened.client(oldContext)).toMatchObject({ retryDelaySeconds: 3, retryMaxAttempts: 3 })
  })

  it.each([
    { retry_delay_seconds: -1 }, { retry_delay_seconds: 61 }, { retry_delay_seconds: 1.5 },
    { retry_max_attempts: 0 }, { retry_max_attempts: 11 }, { retry_max_attempts: 1.5 },
  ])('rejects invalid settings without changing persisted values: %j', (invalid) => {
    const wb = workbench()
    const before = wb.settings.public()
    expect(() => wb.settings.save(invalid)).toThrow(/重试|尝试/)
    expect(wb.settings.public()).toEqual(before)
    expect(new Workbench(wb.root).settings.public()).toEqual(before)
  })

  it('preserves target-machine retry settings when restoring a portable backup', () => {
    const source = workbench(), target = workbench()
    source.settings.save({ retry_delay_seconds: 6, retry_max_attempts: 4 })
    target.settings.save({ retry_delay_seconds: 2, retry_max_attempts: 1 })
    const archive = new Backup(source).export()
    new Backup(target).restore(archive.path)
    expect(target.settings.public()).toMatchObject({ retry_delay_seconds: 2, retry_max_attempts: 1 })
    expect(new Workbench(target.root).settings.public()).toMatchObject({ retry_delay_seconds: 2, retry_max_attempts: 1 })
  })
})
