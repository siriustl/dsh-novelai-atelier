/** Single-account worker with a lease and no automatic POST retries. */
import type { Store, Rec } from './store.ts'
import { NovelAINotSubmitted } from '../core/client.ts'

export class JobNotSubmitted extends Error {
  /** A safe, confirmed preflight failure; no billable request was submitted. */
}

export class Worker {
  private timer: NodeJS.Timeout | undefined
  private ticking = false
  private stopped = false
  private acquired = false
  private pendingResult: { id: string; options: NonNullable<Parameters<Store['finishJob']>[1]> } | null = null
  lastError: string | null = null

  private finish(id: string, options: NonNullable<Parameters<Store['finishJob']>[1]>): Rec {
    this.pendingResult = { id, options }
    const saved = this.store.finishJob(id, options)
    this.pendingResult = null
    this.lastError = null
    return saved
  }

  constructor(private store: Store, private runner: (job: Rec) => Promise<Rec>, private pollIntervalMs = 1000) {}

  get isStopped(): boolean { return this.stopped }

  start(): void {
    if (this.timer) return
    this.acquire()
    this.stopped = false
    this.timer = setInterval(() => {
      void this.safeTick()
    }, this.pollIntervalMs)
    this.timer.unref?.()
  }

  wake(): void {
    if (!this.stopped && this.timer) void this.safeTick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private acquire(): void {
    if (this.acquired) return
    this.acquired = true
    try {
      this.store.recoverInterrupted()
    } catch (error) {
      this.acquired = false
      throw error
    }
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick()
    } catch (error) {
      this.lastError = `任务状态保存失败：${(error as Error).message}`
      console.error('[Worker] tick error:', (error as Error).message)
    }
  }

  /** Run at most one durable workbench job synchronously. */
  async tick(now?: Date | string | null): Promise<Rec | null> {
    if (this.ticking) return null
    this.ticking = true
    try {
      this.acquire()
      if (this.pendingResult) return this.finish(this.pendingResult.id, this.pendingResult.options)
      if (this.stopped) return null
      this.lastError = null

      const job = this.store.claimJob(now ?? null)
      if (job === null) return null
      if (this.stopped) {
        return this.finish(job['id'] as string, { error: '队列已停止，任务未提交', notSubmitted: true, now: now ?? null })
      }
      let result: Rec
      try {
        result = await this.runner(structuredClone(job))
      } catch (error) {
        if (error instanceof JobNotSubmitted || error instanceof NovelAINotSubmitted) {
          return this.finish(job['id'] as string, { error: (error as Error).message, notSubmitted: true, now: now ?? null })
        }
        const message = (error as Error).name === 'NovelAIError'
          ? (error as Error).message
          : `操作失败 (${(error as Error).message || (error as Error).name})`
        const evidence = error as Error & { partialResult?: Rec; receiptPath?: string; submission_outcome_unknown?: boolean }
        const partial = evidence.partialResult ? { ...evidence.partialResult } : null
        if (partial && evidence.receiptPath) partial['record_path'] = evidence.receiptPath
        if (partial && evidence.submission_outcome_unknown) partial['submission_outcome_unknown'] = true
        return this.finish(job['id'] as string, { result: partial, error: message, now: now ?? null })
      }
      return this.finish(job['id'] as string, { result, now: now ?? null })
    } finally {
      this.ticking = false
    }
  }
}
