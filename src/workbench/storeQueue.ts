/** Durable sequential jobs. Legacy billing fields are retained only for stored-data compatibility. */
import { createHash } from 'node:crypto'
import type { Store, Rec } from './store.ts'
import type { JobRow } from './storeDoc.ts'
import { ConflictError, KeyError, encode, integer, money, nowStamp, randomId, timestamp, asUtc } from './util.ts'

function jobView(row: JobRow): Rec {
  const job = JSON.parse(row.snapshot) as Rec
  Object.assign(job, {
    id: row.id, batch_id: row.batch_id, schedule_id: row.schedule_id, status: row.status, error: row.error,
    attempts: row.attempts, created_at: row.created_at, updated_at: row.updated_at, started_at: row.started_at, finished_at: row.finished_at,
    actual_anlas: row.actual, cancel_requested: row.cancel_requested === 1, favorite: row.favorite === 1, archived: row.archived === 1,
  })
  job['result'] = row.result ? JSON.parse(row.result) : null
  if (job['result'] instanceof Object && 'assets' in (job['result'] as Rec)) job['assets'] = (job['result'] as Rec)['assets']
  return job
}

export function applyStoreQueue(store: Store): void {
  const data = () => store.data
  const validateKey = (key: string | null, fp?: string | null): void => {
    if (key != null && (typeof key !== 'string' || key.length < 1 || key.length > 256)) throw new Error('幂等键长度必须是 1–256 字符')
    if (fp != null && (typeof fp !== 'string' || !/^[0-9a-f]{64}$/u.test(fp))) throw new Error('提交指纹必须是 SHA256')
  }
  store.getSubmission = (key, fp) => {
    validateKey(key, fp)
    const batch = data().batches.find((row) => row.idempotency_key === key)
    if (!batch) return null
    if (batch.fingerprint !== fp) throw new ConflictError('同一幂等键对应不同任务')
    return data().jobs.filter((row) => row.batch_id === batch.id).map(jobView)
  }
  store.createJobs = (snapshots, budget, key = null, opts = {}) => {
    if (!Array.isArray(snapshots) || snapshots.length < 1 || snapshots.length > 50) throw new Error('每批需要 1–50 个任务')
    validateKey(key, opts.submissionFingerprint)
    const fp = opts.submissionFingerprint ?? createHash('sha256').update(encode({ snapshots, budget })).digest('hex')
    if (key != null) {
      const existing = store.getSubmission(key, fp)
      if (existing) return existing
    }
    if (opts.expectedDraftRevision != null) {
      integer(opts.expectedDraftRevision, '草稿版本', 0, 2 ** 53)
      const draft = store.getDraft(snapshots[0]?.['draft_id'] as string | undefined)
      if (draft['revision'] !== opts.expectedDraftRevision) throw new ConflictError('草稿在准备提交期间被更新，请刷新后重试')
    }
    for (const snapshot of snapshots) {
      if (!(snapshot instanceof Object) || typeof snapshot['operation'] !== 'string' || !(snapshot['request'] instanceof Object)) throw new Error('任务需要 operation 和 request')
    }
    const batchCount = data().batches.length, jobCount = data().jobs.length
    const batchId = randomId(), now = opts.now ?? nowStamp()
    try {
      data().batches.push({ id: batchId, budget: money(budget), spent: 0, reserved: 0, idempotency_key: key, fingerprint: fp, schedule_id: opts.scheduleId ?? null, created_at: now })
      const jobs = snapshots.map((snapshot): JobRow => ({
        id: randomId(), batch_id: batchId, schedule_id: opts.scheduleId ?? null, status: 'queued', snapshot: encode(snapshot),
        result: null, error: null, ceiling: 0, reserved: 0, actual: null, attempts: 0, cancel_requested: 0, favorite: 0, archived: 0,
        created_at: now, updated_at: now, started_at: null, finished_at: null,
      }))
      data().jobs.push(...jobs)
      if (!opts.deferPersist) store.internalPersist()
      return jobs.map(jobView)
    } catch (error) {
      data().batches.splice(batchCount)
      data().jobs.splice(jobCount)
      throw error
    }
  }
  store.recordDirectJob = (snapshot, result, anlas) => {
    const id = String(result['id'] ?? randomId())
    const existing = data().jobs.find((row) => row.id === id)
    if (existing) return jobView(existing)
    const now = nowStamp(), batchId = `direct-${randomId()}`
    const actual = anlas === null ? null : money(anlas, '实际消耗')
    data().batches.push({ id: batchId, budget: 0, spent: actual ?? 0, reserved: 0, idempotency_key: null, fingerprint: createHash('sha256').update(encode(snapshot)).digest('hex'), schedule_id: null, created_at: now })
    const row: JobRow = {
      id, batch_id: batchId, schedule_id: null, status: result['error'] || result['submission_outcome_unknown'] === true || result['status'] === 'failed' ? 'failed' : 'completed',
      snapshot: encode(snapshot), result: encode(result), error: typeof result['error'] === 'string' ? result['error'] : null,
      ceiling: 0, reserved: 0, actual, attempts: 1, cancel_requested: 0, favorite: 0, archived: 0,
      created_at: now, updated_at: now, started_at: now, finished_at: now,
    }
    data().jobs.push(row)
    store.internalPersist()
    return jobView(row)
  }
  store.getBatch = (id) => {
    const row = data().batches.find((batch) => batch.id === id)
    if (!row) throw new KeyError(id)
    return { ...row }
  }
  store.listJobs = (limit = 500) => { integer(limit, '任务数量', 1, 10000); return data().jobs.slice().reverse().slice(0, limit).map(jobView) }
  store.getJob = (id) => { const row = data().jobs.find((job) => job.id === id); if (!row) throw new KeyError(id); return jobView(row) }
  store.updateJob = (id, fields) => {
    if (Object.keys(fields).some((key) => key !== 'favorite')) throw new Error('只能直接更新收藏状态')
    const row = data().jobs.find((job) => job.id === id)
    if (!row) throw new KeyError(id)
    if ('favorite' in fields) {
      if (typeof fields['favorite'] !== 'boolean') throw new Error('favorite 必须是布尔值')
      row.favorite = fields['favorite'] ? 1 : 0
      row.updated_at = nowStamp()
      store.internalPersist()
    }
    return jobView(row)
  }
  store.cancelJob = (id) => {
    const row = data().jobs.find((job) => job.id === id)
    if (!row) throw new KeyError(id)
    const now = nowStamp()
    if (row.status === 'queued') { row.status = 'cancelled'; row.cancel_requested = 1; row.updated_at = now; row.finished_at = now }
    else if (row.status === 'running') { row.cancel_requested = 1; row.updated_at = now }
    store.internalPersist()
    return jobView(row)
  }
  store.setPaused = (paused, reason = null) => {
    if (typeof paused !== 'boolean') throw new Error('paused 必须是布尔值')
    const value = { paused, reason: paused ? reason ?? null : null }
    data().kv['queue'] = encode(value)
    store.internalPersist()
    return value
  }
  store.queueState = () => {
    const raw = data().kv['queue']
    return raw ? JSON.parse(raw) as Rec : { paused: false, reason: null }
  }
  store.getPaused = () => store.queueState()['paused'] === true
  store.clearStaleInternalErrorPause = () => {
    const state = store.queueState()
    if (state['paused'] !== true || typeof state['reason'] !== 'string' || !state['reason'].includes('队列发生内部错误')) return false
    if (data().jobs.some((job) => job.status === 'running')) return false
    store.setPaused(false)
    return true
  }
  store.claimJob = (now) => {
    if (store.getPaused() || data().jobs.some((row) => row.status === 'running')) return null
    const row = data().jobs.filter((job) => job.status === 'queued').sort((a, b) => Number(a.schedule_id !== null) - Number(b.schedule_id !== null) || a.created_at.localeCompare(b.created_at))[0]
    if (!row) return null
    const stamp = timestamp(now ?? asUtc())
    row.status = 'running'; row.attempts++; row.updated_at = stamp; row.started_at = stamp
    store.internalPersist()
    return jobView(row)
  }
  store.finishJob = (id, opts = {}) => {
    const row = data().jobs.find((job) => job.id === id)
    if (!row) throw new KeyError(id)
    if (row.status !== 'running') throw new ConflictError('任务已经结束，不能重复保存结果')
    const result = opts.result ?? null, error = opts.error ?? null
    const actual = opts.notSubmitted ? 0 : opts.actualAnlas ?? (result?.['anlas_spent'] as number | null | undefined) ?? null
    if (actual !== null) money(actual, '实际消耗')
    row.status = error ? 'failed' : 'completed'; row.result = result ? encode(result) : null; row.error = error; row.actual = actual; row.reserved = 0
    const stamp = timestamp(opts.now ?? asUtc())
    row.updated_at = stamp; row.finished_at = stamp
    if (actual !== null) {
      const batch = data().batches.find((batch) => batch.id === row.batch_id)
      if (batch) batch.spent += actual
      const schedule = data().schedules.find((schedule) => schedule.id === row.schedule_id)
      if (schedule) schedule.spent += actual
    }
    store.internalPersist()
    return jobView(row)
  }
  store.recoverInterrupted = () => {
    const stamp = nowStamp()
    let count = 0
    for (const row of data().jobs) {
      if (['running', 'needs_review', 'budget_blocked'].includes(row.status)) {
        const result = row.result ? JSON.parse(row.result) as Rec : null
        row.status = Array.isArray(result?.['artifact_paths']) && result['artifact_paths'].length > 0 ? 'completed' : 'failed'
        if (row.status === 'failed') row.error = '上次生成未完成；不会自动重新提交，可直接开始新的生成'
        row.updated_at = stamp; row.finished_at ??= stamp; count++
      }
      row.reserved = 0
    }
    for (const row of data().batches) row.reserved = 0
    for (const row of data().schedules) row.reserved = 0
    const state = store.queueState()
    if (state['paused'] === true && typeof state['reason'] === 'string' && /^(?:任务结果或计费需要核对|上次运行中断，需要核对任务结果|队列发生内部错误)/u.test(state['reason'])) data().kv['queue'] = encode({ paused: false, reason: null })
    for (const run of data().schedule_runs.filter((run) => run.outcome === 'planning')) {
      const value = JSON.parse(run.data) as Rec
      value['error'] = '上次 AI 构思中断，本轮未提交生图'; value['finished_at'] = stamp
      run.outcome = 'failed'; run.data = encode(value)
    }
    store.internalPersist()
    return count
  }
}
