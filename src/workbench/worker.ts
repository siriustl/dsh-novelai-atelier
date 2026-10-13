/** Single-account worker with a lease and no automatic POST retries. Ported from jobs.py. */
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
  private planning: AbortController | undefined
  private wakeWaiters: Array<() => void> = []
  private pendingResult: { id: string; options: NonNullable<Parameters<Store['finishJob']>[1]> } | null = null
  lastError: string | null = null

  private finish(id: string, options: NonNullable<Parameters<Store['finishJob']>[1]>): Rec {
    this.pendingResult = { id, options }
    const saved = this.store.finishJob(id, options)
    this.pendingResult = null
    this.lastError = null
    return saved
  }

  constructor(private store: Store, private runner: (job: Rec) => Promise<Rec>,
    private schedulePlanner: ((run: Rec, signal?: AbortSignal) => Promise<Rec>) | null = null, private pollIntervalMs = 1000) {}

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
    for (const w of this.wakeWaiters.splice(0)) w()
  }

  stop(): void {
    this.stopped = true
    this.planning?.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.wake()
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
      const worked = await this.tick()
      if (!worked) await this.waitInterval()
    } catch (error) {
      // Log transient internal tick errors without permanently pausing the whole queue
      this.lastError = `任务状态保存失败：${(error as Error).message}`
      console.error('[Worker] tick error:', (error as Error).message)
      await this.waitInterval()
    }
  }

  private waitInterval(): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        const index = this.wakeWaiters.indexOf(done)
        if (index !== -1) this.wakeWaiters.splice(index, 1)
        resolve()
      }
      const timer = setTimeout(done, this.pollIntervalMs)
      this.wakeWaiters.push(done)
    })
  }

  /** Enqueue due schedules and run at most one durable job synchronously. */
  async tick(now?: Date | string | null): Promise<Rec | null> {
    if (this.ticking) return null
    this.ticking = true
    try {
      this.acquire()
      if (this.pendingResult) return this.finish(this.pendingResult.id, this.pendingResult.options)
      if (this.stopped) return null
      this.lastError = null
      this.store.tickSchedules(now ?? null)

      // Always process pending AI schedule planning promptly so multiple schedules don't starve
      const run = this.store.claimScheduleRun(now ?? null)
      if (run !== null) {
        const controller = new AbortController()
        this.planning = controller
        const checkState = (): void => {
          const row = this.store.data.schedule_runs.find((r) => r.schedule_id === run['schedule_id'] && r.scheduled_for === run['scheduled_for'])
          const schedule = this.store.data.schedules.find((s) => s.id === run['schedule_id'])
          if (this.stopped || this.store.getPaused() || row?.outcome !== 'planning' || schedule?.revision !== run['schedule_revision'])
            controller.abort()
        }
        const unsubscribe = this.store.onChange(checkState)
        try {
          checkState()
          controller.signal.throwIfAborted()
          if (!this.schedulePlanner) throw new JobNotSubmitted('尚未配置定时 AI 助手，本轮未提交生图')
          const plan = await this.schedulePlanner(structuredClone(run), controller.signal)
          controller.signal.throwIfAborted()
          this.store.finishScheduleRun(run, { plan, cancelled: this.stopped, now: now ?? null })
        } catch (error) {
          const message = controller.signal.aborted ? 'AI 构思已中止，本轮未提交生图'
            : error instanceof JobNotSubmitted || (error as Error).name === 'AssistantError'
            ? (error as Error).message
            : `AI 构思或参数校验失败 (${(error as Error).name})，本轮未提交生图`
          this.store.finishScheduleRun(run, { error: message, cancelled: this.stopped || controller.signal.aborted, now: now ?? null })
        } finally {
          unsubscribe()
          this.planning = undefined
        }
      }
      if (this.stopped) return null

      let job = this.store.claimJob(now ?? null)
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
