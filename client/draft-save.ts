/** Serializes optimistic edits, coalesces typing, and preserves unacknowledged content. */
import type { Rec } from './api.ts'

export type DraftSaveStatus = 'saved' | 'saving' | 'failed'

export class DraftSaveQueue {
  revision: number
  failed = false
  private pending: Rec | null = null
  private running: Promise<void> | null = null
  private failure: unknown = null
  private listeners = new Set<() => void>()
  private releaseDelay: (() => void) | null = null

  constructor(revision: number, private readonly send: (patch: Rec, revision: number) => Promise<Rec>, private readonly delayMs = 0) { this.revision = revision }
  get busy(): boolean { return this.running !== null }
  get status(): DraftSaveStatus { return this.failed ? 'failed' : this.busy ? 'saving' : 'saved' }
  get error(): string | null { return this.failed ? this.failure instanceof Error ? this.failure.message : String(this.failure) : null }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* Observer failure cannot change an acknowledged save. */ }
    }
  }

  enqueue(patch: Rec): Promise<void> {
    this.pending = { ...this.pending, ...structuredClone(patch) }
    if (this.failed) { this.notify(); return Promise.reject(this.failure) }
    // Notify on every edit, including edits while a request is in flight, so the
    // browser recovery cache always holds the latest unacknowledged content.
    if (this.running) { this.notify(); return this.running }
    return this.start(true)
  }

  restore(patch: Rec, revision: number): void {
    if (this.running) throw new Error('不能替换正在保存的草稿')
    this.revision = revision
    this.pending = structuredClone(patch)
    this.failed = true
    this.failure = new Error('已恢复本窗口未保存的编辑，请核对后重试保存或另存副本')
    this.notify()
  }

  retry(): Promise<void> {
    if (this.running) return this.running
    if (!this.pending) return Promise.resolve()
    this.failed = false
    this.failure = null
    return this.start(false)
  }

  private start(delayed: boolean): Promise<void> {
    const work = delayed && this.delayMs > 0
      ? new Promise<void>((resolve) => {
        const release = () => { clearTimeout(timer); this.releaseDelay = null; resolve() }
        const timer = setTimeout(release, this.delayMs)
        this.releaseDelay = release
      }).then(() => this.drain())
      : this.drain()
    this.running = work.finally(() => { this.running = null; this.notify() })
    this.notify()
    return this.running
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const patch = this.pending
      this.pending = null
      try {
        const saved = await this.send(patch, this.revision)
        const revision = saved['revision'] as number
        // An idempotent save may keep its revision, but must echo the content.
        const keys = Object.keys(patch)
        const unchanged = keys.length > 0 && keys.every((key) => Object.prototype.hasOwnProperty.call(saved, key) && JSON.stringify(saved[key]) === JSON.stringify(patch[key]))
        if (!Number.isSafeInteger(revision) || revision < this.revision || (revision === this.revision && !unchanged)) throw new Error('工作台未确认新的草稿版本')
        this.revision = revision
        this.notify()
      } catch (error) {
        this.pending = { ...patch, ...(this.pending as Rec | null) }
        this.failed = true
        this.failure = error
        this.notify()
        throw error
      }
    }
  }

  async flush(): Promise<void> {
    this.releaseDelay?.()
    while (this.running) await this.running
    if (this.failed) throw this.failure
  }
}
