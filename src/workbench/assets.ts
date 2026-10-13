/** Asset library: content-addressed files, thumbnails, library zip import/export. Ported from assets.py. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { basename, join, relative, isAbsolute } from 'node:path'
import sharp from 'sharp'
import { zipSync } from 'fflate'
import { boundedUnzip } from '../core/archive.ts'
import { decodePng } from '../core/png.ts'
import { Raster } from '../core/raster.ts'
import type { Store, Rec } from './store.ts'

export const MAX_ASSET = 48 * 1024 * 1024

export class Assets {
  readonly directory: string

  constructor(private store: Store, root: string, private captureWriteGuard: () => () => void = () => () => {}) {
    this.directory = join(root, 'assets')
    mkdirSync(this.directory, { recursive: true })
  }

  async add(data: Uint8Array, name: string): Promise<Rec> {
    const checkWrite = this.captureWriteGuard()
    checkWrite()
    if (!data.length || data.length > MAX_ASSET) throw new Error('文件为空或超过 48 MiB')
    name = basename(name).slice(0, 200)
    const digest = createHash('sha256').update(data).digest('hex')
    let suffix = name.slice(name.lastIndexOf('.')).toLowerCase()
    let width: number | null = null
    let height: number | null = null
    let mime: string
    if (suffix === '.vibe' || suffix === '.naiv4vibe') {
      if (data.length > 8 * 1024 * 1024) throw new Error('Vibe 文件超过 8 MiB')
      mime = 'application/octet-stream'
    } else {
      try {
        if (data[0] === 0x89 && data[1] === 0x50) {
          const decoded = decodePng(data)
          if (decoded.width * decoded.height > 32 * 1024 * 1024) throw new Error('请使用不超过 32MP 的静态 PNG、JPEG 或 WebP')
          width = decoded.width; height = decoded.height
          suffix = '.png'; mime = 'image/png'
        } else if (data[0] === 0xff && data[1] === 0xd8) {
          const raster = await decodeViaRaster(data)
          width = raster.width; height = raster.height
          suffix = '.jpg'; mime = 'image/jpeg'
        } else if (data.length > 12 && Buffer.from(data.subarray(0, 4)).toString('latin1') === 'RIFF') {
          const raster = await decodeViaRaster(data)
          width = raster.width; height = raster.height
          suffix = '.webp'; mime = 'image/webp'
        } else {
          throw new Error()
        }
      } catch (error) {
        if (error instanceof Error && /32MP|Vibe/.test(error.message)) throw error
        throw new Error('无法读取图片文件')
      }
    }
    let path = join(this.directory, `${digest}${suffix}`)
    const frozen = this.store.listAssets().find((asset) => asset['id'] === digest)
    if (mime.startsWith('image/') && frozen?.['mime'] === 'application/octet-stream' && frozen['width'] === null && frozen['height'] === null) {
      const frozenPath = String(frozen['path'])
      const member = relative(this.directory, frozenPath)
      if (frozen['sha256'] !== digest || !new RegExp(`^${digest}(?:\\.[a-z0-9_-]{1,20})?$`, 'u').test(member))
        throw new Error('冻结素材路径或哈希无效')
      const [root, source] = await Promise.all([realpath(this.directory), realpath(frozenPath)])
      const rel = relative(root, source)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('素材路径超出工作台目录')
      const info = await stat(source)
      if (!info.isFile() || info.size > MAX_ASSET || createHash('sha256').update(readFileSync(source)).digest('hex') !== digest)
        throw new Error('冻结素材内容已改变，不能补全元信息')
      path = frozenPath
    }
    checkWrite()
    if (!existsSync(path)) writeFileSync(path, data)
    return this.store.addAsset({ id: digest, path, name, mime, width, height, sha256: digest })
  }

  async fromPath(path: string): Promise<Rec> {
    const source = path.replace(/^~(?=\/|\\|$)/u, process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.')
    if (!existsSync(source) || !statSync(source).isFile() || statSync(source).size > MAX_ASSET)
      throw new Error('文件不存在或超过素材大小限制')
    return this.add(readFileSync(source), basename(source))
  }

  freezePaths(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((x) => this.freezePaths(x))
    if (value instanceof Object && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        ['image_path', 'mask_path', 'encoding_path'].includes(key) && item
          ? [key, this.fromPathSync(String(item))]
          : [key, this.freezePaths(item)]))
    }
    return value
  }

  private fromPathSync(path: string): string {
    // freeze_paths only needs the stable content path; reuse an existing asset when present.
    const resolved = path.replace(/^~(?=\/|\\|$)/u, process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.')
    const data = readFileSync(resolved)
    const digest = createHash('sha256').update(data).digest('hex')
    const existing = this.store.listAssets().find((a) => a['id'] === digest)
    if (existing) return existing['path'] as string
    // Fallback: register synchronously via store (mime/size validated lazily on use).
    const suffix = resolved.slice(resolved.lastIndexOf('.')).toLowerCase()
    const target = join(this.directory, `${digest}${suffix}`)
    if (!existsSync(target)) writeFileSync(target, data)
    this.store.addAsset({ id: digest, path: target, name: basename(resolved), mime: 'application/octet-stream', width: null, height: null, sha256: digest })
    return target
  }

  private thumbnails = new Map<string, Buffer>()
  private thumbnailBytes = 0
  private thumbnailPending = new Map<string, Promise<Buffer>>()

  async thumbnail(ident: string): Promise<Buffer> {
    const asset = this.store.getAsset(ident)
    if (!String(asset['mime']).startsWith('image/')) throw new Error('此素材没有图片预览')
    const [root, source] = await Promise.all([realpath(this.directory), realpath(String(asset['path']))])
    const rel = relative(root, source)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('素材路径超出工作台目录')
    const info = await stat(source)
    if (!info.isFile() || info.size > MAX_ASSET) throw new Error('素材文件过大或无效')
    const key = `${source}:${info.mtimeMs}:${info.size}`
    const cached = this.thumbnails.get(key)
    if (cached) { this.thumbnails.delete(key); this.thumbnails.set(key, cached); return cached }
    const pending = this.thumbnailPending.get(key)
    if (pending) return pending
    const task = sharp(source, { limitInputPixels: 32 * 1024 * 1024 })
      .rotate().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
      .then((buffer) => {
        this.thumbnails.set(key, buffer); this.thumbnailBytes += buffer.length
        while (this.thumbnailBytes > 32 * 1024 * 1024 || this.thumbnails.size > 128) {
          const oldest = this.thumbnails.keys().next().value!
          this.thumbnailBytes -= this.thumbnails.get(oldest)!.length; this.thumbnails.delete(oldest)
        }
        return buffer
      }).finally(() => this.thumbnailPending.delete(key))
    this.thumbnailPending.set(key, task)
    return task
  }

  async vision(ident: string): Promise<Rec> {
    return { mime: 'image/png', data: (await this.thumbnail(ident)).toString('base64') }
  }

  exportLibrary(ids: string[] | null = null): Uint8Array {
    let entries = this.store.listEntries()
    if (ids !== null) {
      const index = new Map(entries.map((e) => [e['id'] as string, e]))
      const selectedIds = new Set(ids)
      const pending = [...ids]
      while (pending.length) {
        const entry = index.get(pending.pop()!)
        if (!entry) continue
        const deps = [
          ...((entry['parent_id'] ? [entry['parent_id'] as string] : [])),
          ...(((entry['data'] as Rec)['artists'] ?? []) as Array<Rec>).map((a) => a['id'] as string),
        ]
        for (const dep of deps) {
          if (!selectedIds.has(dep)) { selectedIds.add(dep); pending.push(dep) }
        }
      }
      entries = entries.filter((e) => selectedIds.has(e['id'] as string))
    }
    const selected = new Set<string>()
    for (const e of entries) for (const i of ((e['data'] as Rec)['examples'] ?? []) as string[]) selected.add(i)
    const assets = [...selected].map((i) => this.store.getAsset(i))
    const manifest = {
      format: 'novelai-workbench-library', version: 1, entries,
      assets: assets.map((a) => Object.fromEntries(Object.entries(a).filter(([k]) => !['path', 'metadata'].includes(k)))),
    }
    const files: Record<string, Uint8Array> = {
      'library.json': new TextEncoder().encode(JSON.stringify(manifest)),
    }
    for (const asset of assets) {
      const suffix = String(asset['path']).slice(String(asset['path']).lastIndexOf('.'))
      files[`assets/${asset['id']}${suffix}`] = readFileSync(String(asset['path']))
    }
    return zipSync(files)
  }

  async importLibrary(data: Uint8Array, opts: { preview?: boolean; choices?: Rec | null; expectedRevisions?: Rec | null } = {}): Promise<Rec> {
    const { preview = false, choices = null, expectedRevisions = null } = opts
    const checkWrite = preview ? () => {} : this.captureWriteGuard()
    checkWrite()
    if (data.length > 128 * 1024 * 1024) throw new Error('资料包超过 128 MiB')
    let unzipped: Record<string, Uint8Array>
    try {
      unzipped = boundedUnzip(data, { bytes: 128 * 1024 * 1024, fileBytes: MAX_ASSET, files: 10000 })
    } catch {
      throw new Error('资料包损坏或缺少必需字段')
    }
    if (Object.keys(unzipped).length > 3000) throw new Error('资料包展开后过大')
    let manifest: Rec
    try {
      manifest = JSON.parse(new TextDecoder().decode(unzipped['library.json'])) as Rec
    } catch { throw new Error('资料包损坏或缺少必需字段') }
    if (manifest['format'] !== 'novelai-workbench-library' || manifest['version'] !== 1) throw new Error('不支持的资料包格式')
    const entries = manifest['entries'] as Rec[] | undefined
    if (!Array.isArray(entries) || entries.length > 2000) throw new Error('资料条目过多')
    const assetmap = new Map<string, string>()
    for (const asset of (manifest['assets'] ?? []) as Rec[]) {
      const ident = asset['id'] as string
      if (typeof ident !== 'string' || ident.length !== 64 || /[^0-9a-f]/u.test(ident)) throw new Error('素材 ID 无效')
      const memberName = Object.keys(unzipped).find((n) => n.startsWith(`assets/${ident}.`))
      if (!memberName) throw new Error('资料包缺少素材')
      const raw = unzipped[memberName]!
      if (createHash('sha256').update(raw).digest('hex') !== ident) throw new Error('素材哈希不符')
      if (!preview) {
        checkWrite()
        const added = await this.add(raw, String(asset['name'] ?? basename(memberName)))
        checkWrite()
        assetmap.set(ident, added['id'] as string)
      } else {
        assetmap.set(ident, ident)
      }
    }
    // Validate every parent/example reference before writing entries.
    const idList = entries.map((e) => e['id'] as string)
    if (new Set(idList).size !== entries.length) throw new Error('资料包含重复 ID')
    for (const e of entries) {
      if (e['parent_id'] && !idList.includes(e['parent_id'] as string)) throw new Error('分支缺少所属角色')
      for (const x of ((e['data'] as Rec)?.['examples'] ?? []) as string[]) {
        if (!assetmap.has(x)) throw new Error('条目缺少例图')
      }
    }
    if (preview) {
      const existing = this.store.listEntries()
      const sourceIndex = new Map(entries.map((e) => [e['id'] as string, e]))
      const existingIndex = new Map(existing.map((e) => [e['id'] as string, e]))
      const identity = (e: Rec, index: Map<string, Rec>): string => {
        const parent = index.get((e['parent_id'] as string) ?? '')
        return [e['kind'], String(e['name']).toLowerCase(), parent ? String(parent['name']).toLowerCase() : ''].join('\u0000')
      }
      const result = entries.map((entry) => {
        let same = existing.find((e) => e['id'] === entry['id'] && e['kind'] === entry['kind'])
        const candidates = existing.filter((e) => identity(e, existingIndex) === identity(entry, sourceIndex))
        same = same ?? (candidates.length === 1 ? candidates[0] : undefined)
        return { entry, existing: same ?? null, ambiguous: !same && candidates.length > 1 }
      })
      return { entries: result, assets: assetmap.size, sha256: createHash('sha256').update(data).digest('hex') }
    }
    checkWrite()
    const result = this.store.importEntries(entries, choices, expectedRevisions) as Rec
    return { ...result, assets_imported: assetmap.size }
  }
}

let decodeRasterFn: ((data: Uint8Array, maxPixels?: number) => Promise<Raster>) | undefined

async function decodeViaRaster(data: Uint8Array): Promise<Raster> {
  if (!decodeRasterFn) {
    const { decodeRaster } = await import('../core/imageInputs.ts')
    decodeRasterFn = decodeRaster
  }
  return decodeRasterFn(data, 32 * 1024 * 1024)
}
