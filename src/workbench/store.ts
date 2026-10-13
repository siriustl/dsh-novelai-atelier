/** Durable workbench data + transactional queue accounting (part 1: core, drafts, entries, assets). */
import { isDeepStrictEqual } from 'node:util'
import { ConflictError, KeyError, encode, integer, nowStamp, randomId, timestamp, asUtc } from './util.ts'
export { ConflictError, KeyError }
import { createStoreDoc, ENTRY_KINDS, emptyStoreData, type EntryRow, type StoreData } from './storeDoc.ts'
import { defaultDraft } from './library.ts'
import { applyStoreEntries } from './storeEntries.ts'
import { applyStoreQueue } from './storeQueue.ts'
import { applyStoreSchedules } from './storeSchedules.ts'
import { applyStoreCreative } from './storeCreative.ts'

export type Rec = Record<string, unknown>

export class Store {
  data: StoreData
  private persist: () => void
  private changeListeners = new Set<() => void>()

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }

  constructor(root: string) {
    const { doc, persist } = createStoreDoc(root + '/workbench.json')
    this.data = doc
    this.persist = () => {
      persist(this.data)
      for (const listener of this.changeListeners) {
        try { listener() } catch (error) { console.error('[Workbench] change listener failed:', (error as Error).message) }
      }
    }
    // 旧版本文档可能缺新表键（JsonDoc.load 不做默认值合并）：就地补齐，避免 undefined 迭代。
    const defaults = emptyStoreData()
    const mutable = this.data as unknown as Rec
    for (const key of Object.keys(defaults)) {
      if (mutable[key] === undefined) mutable[key] = (defaults as unknown as Rec)[key]
    }
    if (!this.data.drafts.length) {
      const draft = { ...defaultDraft(), id: 'main', revision: 0 } as Rec
      this.data.drafts.push({ id: 'main', revision: 0, data: encode(draft) })
      this.persist()
    }
    applyStoreEntries(this)
    applyStoreQueue(this)
    applyStoreSchedules(this)
    applyStoreCreative(this)
    const mutators = this as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const name of ['createDraft', 'switchDraft', 'saveVersion', 'saveEntry', 'deleteEntry', 'importEntries', 'addAsset',
      'recordDirectJob', 'claimJob', 'finishJob', 'recoverInterrupted', 'setPaused', 'cancelJob', 'updateJob', 'curateJobs',
      'saveSchedule', 'deleteSchedule', 'tickSchedules', 'claimScheduleRun', 'finishScheduleRun', 'scheduleOnce']) {
      const mutate = mutators[name]!.bind(this)
      mutators[name] = (...args) => {
        if (name === 'claimJob' && (this.getPaused() || !this.data.jobs.some((job) => job.status === 'queued') || this.data.jobs.some((job) => job.status === 'running'))) return null
        if (name === 'claimScheduleRun' && (this.getPaused() || !this.data.schedule_runs.some((run) => run.outcome === 'waiting_ai') || this.data.schedule_runs.some((run) => run.outcome === 'planning'))) return null
        if (name === 'tickSchedules') {
          const stamp = timestamp((args[0] as Date | string | null) ?? asUtc())
          if (this.getPaused() || !this.data.schedules.some((schedule) => schedule.enabled === 1 && schedule.next_run !== null && schedule.next_run <= stamp)) return []
        }
        return this.transaction(() => mutate(...args))
      }
    }
  }

  private transactionDepth = 0
  private transaction<T>(mutate: () => T): T {
    if (this.transactionDepth) return mutate()
    const before = structuredClone(this.data)
    this.transactionDepth++
    try { return mutate() } catch (error) { this.data = before; throw error }
    finally { this.transactionDepth-- }
  }

  /** Persist hook used by the store part modules. */
  internalPersist(): void { this.persist() }

  private save(): void { this.persist() }

  activeDraftId(): string {
    const raw = this.data.kv['active_draft']
    return raw ? JSON.parse(raw) as string : 'main'
  }

  // ---------- settings ----------
  getSettings(): Rec {
    const raw = this.data.kv['settings']
    return raw ? JSON.parse(raw) as Rec : {}
  }

  saveSettings(value: Rec): Rec {
    if (!(value instanceof Object) || Array.isArray(value)) throw new Error('设置必须是对象')
    const previous = this.data.kv['settings']
    this.data.kv['settings'] = encode(value)
    try { this.save() } catch (error) {
      if (previous === undefined) delete this.data.kv['settings']
      else this.data.kv['settings'] = previous
      throw error
    }
    return structuredClone(value)
  }

  // ---------- drafts ----------
  getDraft(id?: string | null): Rec {
    const ident = id || this.activeDraftId()
    const row = this.data.drafts.find((d) => d.id === ident)
    if (!row) throw new KeyError(ident)
    return JSON.parse(row.data) as Rec
  }

  saveDraft(data: Rec, expectedRevision: number): Rec {
    integer(expectedRevision, '草稿版本', 0, 2 ** 53)
    const ident = (data['id'] as string) || this.activeDraftId()
    const row = this.data.drafts.find((d) => d.id === ident)
    if (!row) throw new KeyError(ident)
    if (row.revision !== expectedRevision) throw new ConflictError('草稿已被更新，请刷新后重试')
    const draft = JSON.parse(row.data) as Rec
    for (const key of ['name', 'operation', 'request', 'locked_fields', 'library_refs']) {
      if (key in data) draft[key] = structuredClone(data[key])
    }
    if (!(draft['request'] instanceof Object) || Array.isArray(draft['request'])) throw new Error('request 必须是对象')
    if (!Array.isArray(draft['locked_fields']) || !draft['locked_fields'].every((v) => typeof v === 'string')) throw new Error('锁定字段必须是字符串列表')
    if (!Array.isArray(draft['library_refs'])) throw new Error('资料引用必须是列表')
    if (typeof draft['name'] !== 'string' || typeof draft['operation'] !== 'string') throw new Error('草稿名称和操作必须是文本')
    // Identical content does not churn revisions or rewrite the document.
    if (isDeepStrictEqual(draft, JSON.parse(row.data))) return draft
    draft['revision'] = expectedRevision + 1
    const encoded = encode(draft)
    const previous = { ...row }
    row.revision = draft['revision'] as number
    row.data = encoded
    try { this.save() } catch (error) { Object.assign(row, previous); throw error }
    return draft
  }

  listDrafts(): Rec[] {
    return this.data.drafts.slice().reverse().map((d) => JSON.parse(d.data) as Rec)
  }

  createDraft(data?: Rec | null, activate = true): Rec {
    const draft = { ...defaultDraft(), ...structuredClone(data ?? {}), id: randomId(), revision: 0 } as Rec
    if (!(draft['request'] instanceof Object) || typeof draft['name'] !== 'string' || !draft['name'].trim())
      throw new Error('草稿需要名称和有效参数')
    this.data.drafts.push({ id: draft['id'] as string, revision: 0, data: encode(draft) })
    if (activate) this.data.kv['active_draft'] = encode(draft['id'])
    this.save()
    return draft
  }

  switchDraft(ident: string): Rec {
    const row = this.data.drafts.find((d) => d.id === ident)
    if (!row) throw new KeyError(ident)
    if (this.activeDraftId() === ident) return JSON.parse(row.data) as Rec
    this.data.kv['active_draft'] = encode(ident)
    this.save()
    return JSON.parse(row.data) as Rec
  }

  deleteDraft(ident: string, revision: number): Rec {
    const row = this.data.drafts.find((d) => d.id === ident)
    if (!row) throw new KeyError(ident)
    if (row.revision !== revision) throw new ConflictError('草稿已修改，请刷新')
    const remaining = this.data.drafts.filter((d) => d.id !== ident)
    if (!remaining.length) {
      const draft = { ...defaultDraft(), id: randomId(), revision: 0 } as Rec
      remaining.push({ id: draft['id'] as string, revision: 0, data: encode(draft) })
    }
    const previousDrafts = this.data.drafts
    const previousActive = this.data.kv['active_draft']
    this.data.drafts = remaining
    if (this.activeDraftId() === ident) {
      this.data.kv['active_draft'] = encode(remaining[remaining.length - 1]!.id)
    }
    try { this.save() } catch (error) {
      this.data.drafts = previousDrafts
      if (previousActive === undefined) delete this.data.kv['active_draft']
      else this.data.kv['active_draft'] = previousActive
      throw error
    }
    return this.getDraft()
  }

  listVersions(ident: string): Rec[] {
    return this.data.draft_versions
      // Legacy unnamed autosnapshots stay on disk but are not user versions.
      .filter((v) => v.draft_id === ident && v.name.trim().length > 0)
      .slice().reverse()
      .map((v) => ({ id: v.id, draft_id: v.draft_id, revision: v.revision, name: v.name, data: JSON.parse(v.data), created_at: v.created_at }))
  }

  saveVersion(ident: string, name: unknown, revision: number): Rec {
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 200) throw new Error('请输入 1–200 字的版本名称')
    const row = this.data.drafts.find((d) => d.id === ident)
    if (!row) throw new KeyError(ident)
    if (row.revision !== revision) throw new ConflictError('草稿已修改，请刷新')
    const vid = randomId()
    this.data.draft_versions.push({ id: vid, draft_id: ident, revision, name: name.trim(), data: row.data, created_at: nowStamp() })
    this.save()
    return { id: vid, draft_id: ident, name: name.trim(), revision }
  }

  // ---------- entries / assets (defined in storeEntries.ts) ----------
  declare listEntries: (query?: string, kind?: string | null) => Rec[]
  declare getEntry: (id: string) => Rec
  declare saveEntry: (data: Rec, id?: string | null, expectedRevision?: number | null) => Rec
  declare deleteEntry: (id: string, expectedRevision?: number | null) => void
  declare importEntries: (entries: Rec[], choices?: Rec | null, expectedRevisions?: Rec | null) => Rec
  declare addAsset: (data: Rec) => Rec
  declare getAsset: (id: string) => Rec
  declare listAssets: () => Rec[]

  // ---------- queue / jobs (storeQueue.ts) ----------
  declare getSubmission: (idempotencyKey: string, fingerprint: string) => Rec[] | null
  declare createJobs: (snapshots: Rec[], budget: number, idempotencyKey?: string | null, opts?: { submissionFingerprint?: string; expectedDraftRevision?: number; scheduleId?: string | null; now?: string; deferPersist?: boolean }) => Rec[]
  /** Register a completed generation that bypassed the queue (direct tool call) so the gallery shows it. */
  declare recordDirectJob: (snapshot: Rec, result: Rec, anlas: number | null) => Rec
  declare getBatch: (id: string) => Rec
  declare listJobs: (limit?: number) => Rec[]
  declare getJob: (id: string) => Rec
  declare updateJob: (id: string, fields: Rec) => Rec
  declare cancelJob: (id: string) => Rec
  declare setPaused: (paused: boolean, reason?: string | null) => Rec
  declare getPaused: () => boolean
  declare queueState: () => Rec
  /** Resume a queue an older session left paused by an internal error when nothing is left to run. */
  declare clearStaleInternalErrorPause: () => boolean
  declare claimJob: (now?: Date | string | null) => Rec | null
  declare finishJob: (id: string, opts?: { result?: Rec | null; error?: string | null; notSubmitted?: boolean; actualAnlas?: number | null; now?: Date | string | null }) => Rec
  declare recoverInterrupted: () => number

  // ---------- schedules (storeSchedules.ts) ----------
  declare listSchedules: () => Rec[]
  declare getSchedule: (id: string) => Rec
  declare previewSchedule: (data: Rec, id?: string | null, now?: Date | string | null) => Rec
  declare saveSchedule: (data: Rec, id?: string | null, now?: Date | string | null) => Rec
  declare deleteSchedule: (id: string, expectedRevision?: number | null) => void
  declare tickSchedules: (now?: Date | string | null) => Rec[]
  declare scheduleSeed: (request: Rec, schedule: Rec, runIndex: number, index: number) => void
  declare claimScheduleRun: (now?: Date | string | null) => Rec | null
  declare finishScheduleRun: (run: Rec, opts?: { plan?: Rec | null; error?: string | null; cancelled?: boolean; now?: Date | string | null }) => Rec
  declare listScheduleRuns: (id: string, limit?: number) => Rec[]
  declare scheduleOnce: (ident: string, revision: number, key: string) => Rec
  declare librarySnapshot: (refs: string[]) => Rec[]

  // ---------- conversations & gallery (storeCreative.ts) ----------
  declare listConversations: (query?: string) => Rec[]
  declare getConversation: (ident: string) => Rec
  declare saveConversation: (data: Rec, ident?: string | null) => Rec
  declare deleteConversation: (ident: string) => void
  declare addMessage: (ident: string, role: string, content: string, data?: Rec | null) => Rec
  declare updateMessage: (mid: string, fields: Rec) => Rec
  declare forkConversation: (ident: string, messageId: string) => Rec
  declare getAssistantRun: (ident: string) => Rec
  declare updateAssistantRun: (ident: string, opts?: { status?: string | null; event?: Rec | null; data?: Rec | null; cancel?: boolean }) => Rec
  declare queryJobs: (opts?: { query?: string; offset?: number; limit?: number; model?: string; scheduleId?: string; libraryId?: string; status?: string; favorite?: boolean; archived?: boolean; after?: string; before?: string }) => Rec
  declare curateJobs: (ids: string[], opts?: { favorite?: boolean | null; archived?: boolean | null }) => Rec

  // ---------- shared internals ----------
  internal = {
    encode, timestamp, asUtc, nowStamp,
  }

  _entryRow(row: EntryRow): Rec {
    const res: Rec = { ...row, data: JSON.parse(row.data) as Rec }
    if (row.kind === 'branch' && row.parent_id) {
      const parent = this._findEntry(row.parent_id)
      if (parent) res['parent_name'] = parent.name
    }
    return res
  }

  _findEntry(id: string): EntryRow | undefined { return this.data.entries.find((e) => e.id === id) }
}
