import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const desktop = process.env['NAI_PRESET_DESKTOP_EXECUTABLE'] ?? 'D:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'
const script = fileURLToPath(new URL('../scripts/verify-preset-composition.mjs', import.meta.url))
const project = fileURLToPath(new URL('..', import.meta.url))
const available = existsSync(desktop)
let root = ''
let report: any

describe.skipIf(!available)('complete installed DSH preset composition', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'nai-complete-preset-'))
    const path = join(root, 'report.json')
    const child = spawnSync(desktop, ['--expose-internals', script], {
      cwd: project,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NAI_PRESET_REPORT: path },
      stdio: 'inherit', timeout: 30000,
    })
    if (child.error) throw child.error
    expect(child.status).toBe(0)
    report = JSON.parse(readFileSync(path, 'utf8'))
    expect(report.passed).toBe(true)
  }, 40000)
  afterAll(() => {
    if (!root) return
    const checked = resolve(root)
    if (!checked.startsWith(resolve(tmpdir()) + '\\nai-complete-preset-') && !checked.startsWith(resolve(tmpdir()) + '/nai-complete-preset-')) throw new Error('Refuse unexpected fixture cleanup path')
    rmSync(checked, { recursive: true, force: true })
  })
  it('reproduces the actual missing required search config through Registry and Loader', () => {
    const broken = report.cases[0]
    expect(broken.passed).toBe(true)
    expect(broken.roster.broken).toContain('sampleOverCapGlobResults missing required value')
    expect(broken.roster.broken).toMatch(/^tool-fs-search /)
    expect(broken.import_errors ?? []).toEqual([])
  })
  it('activates every real child row, mounts and inherits the full NAI tools without leaking services', () => {
    const fixed = report.cases[1]
    expect(fixed.roster.broken).toBeUndefined()
    expect(fixed.inventory.rows).toHaveLength(11)
    expect(fixed.inventory.rows.every((row: any) => row.enabled === true && row.fiberState === 2)).toBe(true)
    expect(fixed.nai_tool_count).toBe(15)
    expect(fixed.ordinary_nai_tools).toBe(0)
    expect(fixed.descendant_nai_tools).toBe(15)
    expect(fixed.shared_draft_read).toBe(true)
    expect(fixed.services_isolated).toBe(true)
    expect(fixed.prompt_composed).toBe(true)
    expect(fixed.skill_isolated).toBe(true)
    expect(fixed.host_backend_calls).toEqual([])
    expect(report.nai_requests).toBe(0)
    expect(report.user_store_used).toBe(false)
  })
})
