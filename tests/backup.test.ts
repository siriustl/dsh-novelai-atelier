/** Backup roundtrip: export → inspect → preview → restore on a throwaway data dir. */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Backup } from '../src/workbench/backup.ts'
import { Workbench } from '../src/workbench/app.ts'

function makeWorkbench(): { wb: Workbench; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'nai-backup-'))
  // 素材库需要至少一张真实图片文件
  mkdirSync(join(root, 'assets'), { recursive: true })
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
    'hex',
  )
  writeFileSync(join(root, 'assets', 'smoke.png'), png)
  return { wb: new Workbench(root), root }
}

describe('backup roundtrip', () => {
  it('exports a credential-free zip and restores an identical store', () => {
    const { wb, root } = makeWorkbench()
    try {
      wb.start()
      // 写入已知状态：本机 settings、草稿、资料条目、带文件引用的作业快照
      wb.store.saveSettings({ marker: 'from-backup', nai_secret: 'LOCAL-SEALED' })
      wb.store.createDraft({ name: 'roundtrip', operation: 'generate', request: { model: 'nai-diffusion-5-full', prompt: 'smoke test' } }, true)
      wb.store.saveEntry({ kind: 'character', name: '测试角色', data: { prompt: '1girl' } } as never)
      const asset = wb.store.addAsset({ path: join(root, 'assets', 'smoke.png'), mime: 'image/png' } as never)
      void asset

      const exported = new Backup(wb).export()
      expect(existsSync(exported.path)).toBe(true)
      expect(exported.bytes).toBeGreaterThan(0)

      // 回归：导出绝不能改动 live 存储（曾因别名改写把素材路径污染成 @file 标记）
      const liveBefore = JSON.stringify(wb.store.data)
      new Backup(wb).export()
      expect(JSON.stringify(wb.store.data)).toBe(liveBefore)

      const backup = new Backup(wb)
      const preview = backup.preview(exported.path)
      expect(preview['credentials_included']).toBe(false)
      expect((preview['counts'] as Record<string, number>)['drafts']).toBeGreaterThanOrEqual(2)
      expect((preview['counts'] as Record<string, number>)['assets']).toBeGreaterThanOrEqual(1)

      // 备份 zip 内不得包含明文凭据
      const zipRaw = readFileSync(exported.path).toString('latin1')
      expect(zipRaw).not.toContain('pst-')

      const beforeDrafts = wb.store.listDrafts().length
      wb.store.deleteDraft(wb.store.listDrafts()[0]!['id'] as string, wb.store.listDrafts()[0]!['revision'] as number)
      expect(wb.store.listDrafts().length).toBe(beforeDrafts - 1)

      const restored = backup.restore(exported.path)
      expect(restored['restored']).toBe(true)
      expect(restored['paused']).toBe(true)
      expect(wb.store.listDrafts().length).toBe(beforeDrafts)
      expect(wb.store.listDrafts().some((d) => d['name'] === 'roundtrip')).toBe(true)
      expect(wb.store.getPaused()).toBe(true)
      expect(existsSync(join(root, 'assets', 'smoke.png'))).toBe(true)
      // 本机 settings：备份字段进入，本机私有凭据保留
      const settings = JSON.parse(wb.store.data.kv['settings'] ?? '{}') as Record<string, unknown>
      expect(settings['marker']).toBe('from-backup')
      expect(settings['nai_secret']).toBe('LOCAL-SEALED')
      // worker 已随恢复结束重启
      expect(wb.workerStarted).toBe(true)
    } finally {
      wb.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to restore while jobs are running and rejects broken archives', () => {
    const { wb, root } = makeWorkbench()
    try {
      wb.start()
      const backup = new Backup(wb)
      const exported = backup.export()
      // 构造一个运行中任务
      const jobs = wb.store.createJobs([{ operation: 'generate', request: { model: 'nai-diffusion-5-full', prompt: 'x', width: 832, height: 1216 } }], 0)
      const job = jobs[0]!
      expect(job).toBeTruthy()
      expect(() => backup.restore(exported.path)).toThrow(/等待正在执行/)
      wb.store.cancelJob(job['id'] as string)
      // 损坏文件
      const bad = join(root, 'bad.zip')
      writeFileSync(bad, Buffer.from('not a zip'))
      expect(() => backup.preview(bad)).toThrow(/损坏/)
    } finally {
      wb.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
