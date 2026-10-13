/** Reveal an existing registered output; never accepts an arbitrary client path. */
import { realpath, stat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { Workbench } from './app.ts'
import type { Rec } from './store.ts'

export class FolderOpenError extends Error {
  constructor(message: string) { super(message); this.name = 'FolderOpenError' }
}

export async function openFolder(path: string): Promise<void> {
  const command = process.platform === 'win32' ? join(process.env['SystemRoot'] || 'C:\\Windows', 'explorer.exe')
    : process.platform === 'darwin' ? 'open' : 'xdg-open'
  await new Promise<void>((resolve, reject) => {
    // Explorer honors STARTF_USESHOWWINDOW: hiding this GUI process creates an
    // invisible folder window even though spawn succeeds. Never hide it.
    const child = spawn(command, [path], { shell: false, stdio: 'ignore', windowsHide: false })
    const timer = setTimeout(() => {
      child.unref()
      reject(new FolderOpenError('文件管理器启动超时，请重试'))
    }, 10_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new FolderOpenError(`无法启动文件管理器：${error.message}`))
    })
    child.once('spawn', () => {
      // Explorer is a shell dispatcher, not a CLI. On Windows it can exit 1
      // after successfully opening a visible window; its exit code is not an acknowledgement.
      if (process.platform === 'win32') { clearTimeout(timer); child.unref(); resolve() }
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (process.platform === 'win32') return
      if (code === 0) resolve()
      else reject(new FolderOpenError(`文件管理器未能打开目录（${signal ?? code ?? '未知状态'}）`))
    })
  })
}

export async function revealArtwork(wb: Workbench, jobId: unknown, assetId?: unknown, reveal = openFolder): Promise<Rec> {
  if (typeof jobId !== 'string' || !jobId) throw new TypeError('请选择作品记录')
  if (assetId !== undefined && (typeof assetId !== 'string' || !assetId)) throw new TypeError('素材 ID 无效')
  const job = wb.store.getJob(jobId)
  const assets = (job['assets'] ?? []) as Rec[]
  const index = assetId === undefined ? 0 : assets.findIndex((asset) => asset['id'] === assetId)
  if (index < 0) throw new Error('此素材不属于所选作品')
  const result = job['result'] as Rec | undefined
  const originals = ((result?.['artifact_paths'] ?? []) as unknown[]).filter((path): path is string => typeof path === 'string' && !!path)
  const asset = assets[index]
  let original: string | undefined
  if (assetId === undefined) original = originals[0]
  else if (asset) {
    // Failed imports are omitted from assets; their indices no longer correspond
    // to artifact_paths. Match content identity rather than a compressed index.
    const hash = typeof asset['sha256'] === 'string' && /^[0-9a-f]{64}$/u.test(asset['sha256']) ? asset['sha256'] : null
    const ordered = [...originals].sort((a, b) => Number(basename(b) === asset['name']) - Number(basename(a) === asset['name']))
    for (const path of ordered) {
      try {
        if (hash) {
          const info = await stat(path)
          if (!info.isFile() || info.size > 48 * 1024 * 1024) continue
          const bytes = await readFile(path)
          if (bytes.length > 48 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== hash) continue
        } else if (basename(path) !== asset['name']) continue
        original = path; break
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    }
  }
  const candidates = [original, asset?.['path']].filter((path): path is string => typeof path === 'string' && !!path)
  for (const candidate of candidates) {
    let canonical: string
    try { canonical = await realpath(candidate); if (!(await stat(canonical)).isFile()) continue }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error }
    const folder = dirname(canonical)
    await reveal(folder)
    return { opened: true, directory: folder, path: canonical }
  }
  throw new Error('作品文件不存在，可能已被移动或删除')
}
