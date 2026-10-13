/** Portable, credential-free workbench snapshots with atomic restore. */
import { zipSync, strToU8, strFromU8 } from 'fflate'
import { boundedUnzip } from '../core/archive.ts'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StoreData } from './storeDoc.ts'
import type { Rec } from './store.ts'
import { ConflictError, encode, timestamp } from './util.ts'
import type { Workbench } from './app.ts'

const TABLES = ['kv', 'drafts', 'draft_versions', 'entries', 'assets', 'batches', 'jobs', 'schedules',
  'schedule_runs', 'conversations', 'messages', 'assistant_runs', 'workspace_proposals'] as const

type TableKey = (typeof TABLES)[number]
const ARRAY_TABLES = TABLES.slice(1) as unknown as Exclude<TableKey, 'kv'>[]

/** Columns holding JSON-encoded values (parsed, redacted, re-encoded on export). */
const JSON_COLUMNS = new Set(['value', 'data', 'snapshot', 'result'])
const SECRET_KEYS = new Set(['secret', 'nai_secret', 'api_key', 'nai_token', 'token', 'authorization', 'password'])
const FILE_EXTENSIONS = new Set(['.json', '.png', '.jpg', '.jpeg', '.webp', '.vibe', '.naiv4vibe', '.response'])
const MAX_EXPANDED_FILES = 100_000
const MAX_BACKUP_BYTES = 1024 * 1024 * 1024 // fflate works in memory; keep a 1 GiB ceiling
const MEMBER_NAME = /^files\/[0-9a-f]{64}\.[a-z0-9]+$/u

interface BackupData {
  format: 'dsh-novelai-atelier-backup' | 'nai-atelier-backup'
  version: 1
  created_at: string
  credentials: false
  tables: Record<TableKey, Rec[]>
  files: string[]
}

function walk(value: unknown, key: string, visitString: (value: string, key: string) => unknown, dropSecrets: boolean): unknown {
  if (value instanceof Object && !Array.isArray(value)) {
    const out: Rec = {}
    for (const [k, v] of Object.entries(value as Rec)) {
      if (dropSecrets && SECRET_KEYS.has(k.toLowerCase())) continue
      out[k] = walk(v, k, visitString, dropSecrets)
    }
    return out
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, key, visitString, dropSecrets))
  if (typeof value === 'string') return visitString(value, key)
  return value
}

export class Backup {
  constructor(private wb: Workbench) {}

  private collectSecrets(): string[] {
    const secrets: string[] = []
    const push = (value: unknown): void => {
      if (typeof value === 'string' && value.length >= 16) secrets.push(value)
    }
    try { push(this.wb.settings.naiToken()) } catch { /* not configured */ }
    try {
      for (const profile of this.wb.settings.profiles()) {
        try { push(this.wb.settings.aiKey(String(profile['id'] ?? ''))) } catch { /* profile without a key */ }
      }
    } catch { /* legacy profiles unavailable */ }
    return secrets
  }

  /** Gather every referenced file into content-addressed zip members. */
  private collectFiles(tables: Record<TableKey, Rec[]>): { paths: Map<string, string>; blobs: Map<string, Uint8Array>; bytes: number } {
    const paths = new Map<string, string>()
    const blobs = new Map<string, Uint8Array>()
    let bytes = 0
    const register = (raw: string): void => {
      if (paths.has(raw)) return
      if (!existsSync(raw)) throw new Error('备份所需文件缺失：' + raw)
      const data = readFileSync(raw)
      bytes += data.length
      if (bytes > MAX_BACKUP_BYTES) throw new Error('备份包含的文件总量超过 1 GiB，请先归档旧作品与素材')
      const digest = createHash('sha256').update(data).digest('hex')
      const suffix = raw.slice(raw.lastIndexOf('.')).toLowerCase()
      const member = 'files/' + digest + suffix
      paths.set(raw, '@file/' + member)
      blobs.set(member, new Uint8Array(data))
    }
    for (const row of tables['assets']) {
      try {
        const data = JSON.parse(String(row['data'] ?? '')) as Rec
        if (typeof data['path'] === 'string' && data['path']) register(data['path'])
      } catch { /* malformed asset row is re-validated below by portable() */ }
    }
    // Walk the same shapes the Python port walks: every *_path / *_paths string.
    const collectPaths = (value: unknown, key = ''): void => {
      if (value instanceof Object && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value as Rec)) collectPaths(v, k)
      } else if (Array.isArray(value)) {
        for (const item of value) collectPaths(item, key)
      } else if (typeof value === 'string' && (key.endsWith('_path') || key.endsWith('_paths')) && value) {
        if (value.startsWith('@')) return
        if (!value.includes('\\') && !value.includes('/')) return
        if (!FILE_EXTENSIONS.has(value.slice(value.lastIndexOf('.')).toLowerCase())) return
        if (!existsSync(value)) return
        register(value)
      }
    }
    for (const table of ['jobs', 'drafts', 'draft_versions', 'schedules', 'messages'] as const) {
      for (const row of tables[table]) {
        for (const column of ['value', 'data', 'snapshot', 'result', 'content']) {
          const raw = row[column]
          if (typeof raw !== 'string' || !raw) continue
          try { collectPaths(JSON.parse(raw)) } catch { collectPaths(raw, column) }
        }
      }
    }
    return { paths, blobs, bytes }
  }

  export(): { path: string; bytes: number } {
    const source = this.wb.store.data
    const tables = {} as Record<TableKey, Rec[]>
    tables['kv'] = Object.entries(source['kv'] ?? {}).map(([key, value]) => ({ key, value }))
    // 深拷贝：导出的脱敏改写绝不能落在 live 存储对象上（回归：曾因别名改写污染在线文档）。
    for (const key of ARRAY_TABLES) tables[key] = structuredClone(source[key] ?? []) as unknown as Rec[]

    const { paths, blobs } = this.collectFiles(tables)
    const secrets = this.collectSecrets()
    const portableString = (value: string, key: string): unknown => {
      if (key === 'output_directory' || key === 'output_dir') return '@output'
      const mapped = paths.get(value)
      if (mapped) return mapped
      let next = value
      for (const secret of secrets) next = next.split(secret).join('[凭据已移除]')
      return next.replace(/pst-[A-Za-z0-9_-]{16,}/gu, '[凭据已移除]')
    }
    // Receipt files are payload too: redact their contents before hashing them,
    // and resolve JSON-to-file references before rewriting the manifest paths.
    const originalPaths = new Map(paths)
    const portableBlobs = new Map<string, Uint8Array>()
    const converted = new Map<string, string>()
    const visiting = new Set<string>()
    const portableMember = (member: string): string => {
      const cached = converted.get(member)
      if (cached) return cached
      if (visiting.has(member)) throw new Error('备份 JSON 文件含循环文件引用，无法安全打包')
      visiting.add(member)
      let bytes = blobs.get(member)!
      if (member.endsWith('.json')) {
        const document: unknown = JSON.parse(strFromU8(bytes))
        bytes = strToU8(encode(walk(document, '', (value, key) => {
          const reference = originalPaths.get(value)
          return reference ? '@file/' + portableMember(reference.slice('@file/'.length)) : portableString(value, key)
        }, true)))
      }
      const suffix = member.slice(member.lastIndexOf('.'))
      const target = 'files/' + createHash('sha256').update(bytes).digest('hex') + suffix
      portableBlobs.set(target, bytes)
      converted.set(member, target)
      visiting.delete(member)
      return target
    }
    for (const [path, reference] of originalPaths) paths.set(path, '@file/' + portableMember(reference.slice('@file/'.length)))
    if ([...portableBlobs.values()].reduce((total, bytes) => total + bytes.length, 0) > MAX_BACKUP_BYTES) throw new Error('备份包含的文件总量超过 1 GiB')
    for (const rows of Object.values(tables)) {
      for (const row of rows) {
        for (const [column, raw] of Object.entries(row)) {
          if (JSON_COLUMNS.has(column) && typeof raw === 'string' && raw) {
            try { row[column] = encode(walk(JSON.parse(raw), '', portableString, true)) } catch { /* keep original value */ }
          } else if (column === 'content' && typeof raw === 'string' && raw) {
            row[column] = String(portableString(raw, 'content'))
          }
        }
      }
    }
    const manifest: BackupData = {
      format: 'dsh-novelai-atelier-backup', version: 1, created_at: timestamp(), credentials: false,
      tables, files: [...portableBlobs.keys()],
    }
    const directory = join(this.wb.root, 'backups')
    mkdirSync(directory, { recursive: true })
    const target = join(directory, 'atelier-' + timestamp().replace(/:/gu, '-').replace(/\+/gu, '_') + '.zip')
    const zipped = zipSync({ 'workbench.json': strToU8(JSON.stringify(manifest)), ...Object.fromEntries(portableBlobs) })
    writeFileSync(target, zipped)
    return { path: target, bytes: zipped.length }
  }

  /** Parse and fully validate one backup archive; throws readable errors. */
  private inspect(path: string): { data: BackupData; zipped: Record<string, Uint8Array> } {
    let zipped: Record<string, Uint8Array>
    try {
      const raw = readFileSync(path)
      if (raw.length > MAX_BACKUP_BYTES) throw new Error('备份文件超过 1 GiB')
      zipped = boundedUnzip(new Uint8Array(raw), { bytes: MAX_BACKUP_BYTES, fileBytes: 256 * 1024 * 1024, files: MAX_EXPANDED_FILES, accept: (name) => name === 'workbench.json' || MEMBER_NAME.test(name) })
    } catch (error) {
      if (error instanceof Error && error.message.includes('1 GiB')) throw error
      throw new Error('备份损坏或不是有效的 zip 文件')
    }
    const names = Object.keys(zipped)
    if (names.length > MAX_EXPANDED_FILES) throw new Error('备份展开后文件过多')
    const manifestRaw = zipped['workbench.json']
    if (!manifestRaw || manifestRaw.length > 256 * 1024 * 1024) throw new Error('备份损坏或缺少必要内容')
    let data: BackupData
    try { data = JSON.parse(strFromU8(manifestRaw)) as BackupData } catch { throw new Error('备份损坏或缺少必要内容') }
    if ((data?.format !== 'dsh-novelai-atelier-backup' && data?.format !== 'nai-atelier-backup') || data?.version !== 1
      || !Array.isArray(data.files) || !data.files.every((file) => typeof file === 'string')
      || new Set(data.files).size !== data.files.length
      || !data.tables || typeof data.tables !== 'object'
      || new Set(Object.keys(data.tables)).size !== TABLES.length
      || !TABLES.every((key) => Array.isArray(data.tables[key]))
      || !data.tables['drafts'].length) {
      throw new Error('不支持的工作台备份格式，或备份缺少草稿')
    }
    for (const key of TABLES) {
      if (!data.tables[key].every((row) => row instanceof Object && !Array.isArray(row))) throw new Error('备份表结构与当前版本不兼容：' + key)
    }
    const validateReference = (value: string, key: string): string => {
      if (value.startsWith('@file/')) {
        if (!data.files.includes(value.slice('@file/'.length))) throw new Error('备份引用了缺失的文件')
      } else if (value && (key.endsWith('_path') || key.endsWith('_paths'))) {
        throw new Error('备份文件引用必须使用打包路径')
      }
      return value
    }
    for (const rows of Object.values(data.tables)) {
      for (const row of rows) {
        for (const [column, raw] of Object.entries(row)) {
          if (JSON_COLUMNS.has(column) && typeof raw === 'string' && raw) {
            walk(JSON.parse(raw), '', validateReference, false)
          }
        }
      }
    }
    for (const row of data.tables['assets']) {
      let asset: Rec
      try { asset = JSON.parse(String(row['data'])) as Rec } catch { throw new Error('备份素材记录无效') }
      if (typeof asset['path'] !== 'string' || !asset['path'].startsWith('@file/') || !data.files.includes(asset['path'].slice('@file/'.length))) {
        throw new Error('备份素材必须引用已打包的文件')
      }
    }
    for (const member of data.files) {
      if (!MEMBER_NAME.test(member) || !zipped[member]) throw new Error('备份文件路径无效或缺失')
      if (member.endsWith('.json')) {
        try { walk(JSON.parse(strFromU8(zipped[member]!)), '', validateReference, false) } catch {
          throw new Error('备份 JSON 文件无效或引用未打包的文件')
        }
      }
    }
    return { data, zipped }
  }

  preview(path: string): Rec {
    const { data } = this.inspect(path)
    return {
      created_at: data.created_at,
      counts: Object.fromEntries(TABLES.map((key) => [key, data.tables[key].length])),
      files: data.files.length,
      credentials_included: false,
      note: '恢复会替换本机工作台数据，先自动保存当前备份；恢复后队列暂停、计划停用，进行中的任务标记为需核对。NovelAI 令牌等本机凭据保留，不会从备份导入。',
    }
  }

  restore(path: string): Rec {
    const { data, zipped } = this.inspect(path)
    const store = this.wb.store
    if (this.wb.executor.activeExecutions > 0 || store.data.jobs?.some((j) => j.status === 'running' || j.status === 'queued')
      || store.data.assistant_runs?.some((r) => r.status === 'running' || r.status === 'queued')
      || store.data.schedule_runs?.some((r) => r.outcome === 'planning' || r.outcome === 'waiting_ai')) {
      throw new ConflictError('请等待正在执行的 AI 和生图任务结束后恢复备份')
    }
    const previous = this.export()
    const original = structuredClone(store.data)
    const wasStarted = this.wb.workerStarted
    this.wb.maintenance = true
    this.wb.restoreEpoch += 1
    this.wb.stop()
    try {
      const assetsDirectory = join(this.wb.root, 'assets')
      mkdirSync(assetsDirectory, { recursive: true })
      const output = join(this.wb.root, 'outputs')
      mkdirSync(output, { recursive: true })
      const mapping = new Map<string, string>()
      const restoring = new Set<string>()
      const restoreMember = (member: string): string => {
        const reference = '@file/' + member
        const cached = mapping.get(reference)
        if (cached) return cached
        if (restoring.has(member)) throw new Error('备份 JSON 文件含循环文件引用，无法安全恢复')
        if (!data.files.includes(member) || !zipped[member]) throw new Error('备份引用了缺失的文件')
        restoring.add(member)
        let bytes = zipped[member]!
        if (createHash('sha256').update(bytes).digest('hex') !== member.slice('files/'.length, member.lastIndexOf('.'))) {
          throw new Error('备份文件校验失败：' + member)
        }
        if (member.endsWith('.json')) {
          bytes = strToU8(encode(walk(JSON.parse(strFromU8(bytes)), '', relocateString, true)))
        }
        const suffix = member.slice(member.lastIndexOf('.'))
        const target = join(assetsDirectory, createHash('sha256').update(bytes).digest('hex') + suffix)
        if (!existsSync(target)) writeFileSync(target, bytes)
        mapping.set(reference, target)
        restoring.delete(member)
        return target
      }
      function relocateString(value: string): unknown {
        if (value === '@output') return output
        if (value.startsWith('@file/')) return restoreMember(value.slice('@file/'.length))
        return value
      }
      for (const member of data.files) restoreMember(member)
      const restored = {} as StoreData
      restored['kv'] = {}
      const currentSettings = this.wb.settings.raw()
      const preserveLocalSettings = (imported: Rec): string => {
        for (const field of ['nai_secret', 'nai_base_url', 'proxy_url', 'output_directory', 'retry_delay_seconds', 'retry_max_attempts']) {
          if (currentSettings[field] !== undefined) imported[field] = currentSettings[field]
          else delete imported[field]
        }
        imported['ai'] = currentSettings['ai']
        imported['ai_profiles'] = currentSettings['ai_profiles'] ?? {}
        return encode(imported)
      }
      restored['kv']['settings'] = preserveLocalSettings({})
      for (const row of data.tables['kv']) {
        const key = String(row['key'] ?? '')
        const value = row['value']
        if (key === 'settings') {
          // Preserve local connections even when the backup has no usable settings row.
          try {
            const imported = typeof value === 'string' && value ? walk(JSON.parse(value), '', relocateString, true) : {}
            if (!imported || typeof imported !== 'object' || Array.isArray(imported)) throw new Error('Invalid settings row')
            restored['kv'][key] = preserveLocalSettings(imported as Rec)
          } catch { restored['kv'][key] = preserveLocalSettings({}) }
        } else {
          const relocated = typeof value === 'string' && value
            ? (() => { try { return encode(walk(JSON.parse(value), '', relocateString, true)) } catch { return value } })()
            : value
          restored['kv'][key] = relocated as string
        }
      }
      for (const key of ARRAY_TABLES) {
        const rows = structuredClone(data.tables[key]) as Rec[]
        for (const row of rows) {
          for (const [column, raw] of Object.entries(row)) {
            if (JSON_COLUMNS.has(column) && typeof raw === 'string' && raw) {
              try { row[column] = encode(walk(JSON.parse(raw), '', relocateString, false)) } catch { /* keep */ }
            }
          }
          if (key === 'schedules') row['enabled'] = 0
          if (key === 'jobs' && ['running', 'queued', 'needs_review', 'budget_blocked'].includes(String(row['status']))) {
            const result = row['result'] ? JSON.parse(String(row['result'])) as Rec : null
            row['status'] = Array.isArray(result?.['artifact_paths']) && result['artifact_paths'].length ? 'completed' : 'failed'
            if (row['status'] === 'failed') row['error'] = '从备份恢复的未完成任务，不会自动重新提交'
            row['reserved'] = 0
          }
          if (key === 'assistant_runs' && (row['status'] === 'running' || row['status'] === 'queued')) row['status'] = 'interrupted'
          if (key === 'schedule_runs' && (row['outcome'] === 'planning' || row['outcome'] === 'waiting_ai')) row['outcome'] = 'cancelled'
          if (key === 'workspace_proposals' && row['status'] !== 'done') row['status'] = 'failed'
        }
        ;(restored as unknown as Record<string, unknown>)[key] = rows
      }
      restored['kv']['queue'] = encode({ paused: true, reason: '备份恢复后任务暂停，可手动继续' })

      // 就地替换文档对象：persist 闭包持有同一引用，必须原地清空重填。
      const live = store.data
      live['kv'] = restored['kv']
      for (const key of ARRAY_TABLES) live[key] = restored[key] as never
      store.internalPersist()
      return { restored: true, previous_backup: previous.path, paused: true }
    } catch (error) {
      Object.assign(store.data, original)
      throw error
    } finally {
      this.wb.maintenance = false
      if (wasStarted) this.wb.start()
    }
  }
}
