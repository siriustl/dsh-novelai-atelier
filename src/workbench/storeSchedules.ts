/** Store part: schedules, runs, AI-recipe freezing, tick, run-once. Ported from store.py schedules. */
import type { Store, Rec } from './store.ts'
import type { ScheduleRow } from './storeDoc.ts'
import { ConflictError, KeyError, encode, integer, money, nowStamp, randomId, timestamp, asUtc, nextDaily, validTimezone, localInstant } from './util.ts'
import { checkScheduledRequest } from './scheduledAssistant.ts'
import { creativeDraft } from './schedulePlanner.ts'

function scheduleView(row: ScheduleRow): Rec {
  const value = JSON.parse(row.data) as Rec
  Object.assign(value, {
    id: row.id, revision: row.revision, next_run: row.next_run, runs: row.runs,
    spent: row.spent, created_at: row.created_at, updated_at: row.updated_at,
  })
  value['execution_mode'] ??= 'fixed'
  value['enabled'] = row.enabled === 1
  return value
}

export function applyStoreSchedules(store: Store): void {
  const data = () => store.data

  const validateAiRecipe = (value: unknown): Rec => {
    if (!(value instanceof Object) || Array.isArray(value)) throw new Error('AI 计划需要 ai_recipe 对象')
    const recipe = value as Rec
    const result: Rec = {}
    for (const key of ['instruction', 'randomize', 'fixed_prompt', 'fixed_negative_prompt']) {
      const text = recipe[key]
      if (text !== undefined && (typeof text !== 'string' || text.length > 24000)) throw new Error(`AI 计划的 ${key} 必须是不超过 24000 字符的文本`)
      result[key] = (text ?? '') as string
      result[key] = (result[key] as string).trim()
    }
    for (const key of ['library_refs', 'locked_fields']) {
      const items = recipe[key] ?? []
      if (!Array.isArray(items) || items.length > 200 || !items.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 300))
        throw new Error(`AI 计划的 ${key} 必须是字符串列表`)
      result[key] = [...new Set(items as string[])]
    }
    if ('character_slots' in recipe) {
      const slots = recipe['character_slots']
      if (!Array.isArray(slots) || slots.length > 22 || slots.some((s) => !(s instanceof Object) || typeof (s as Rec)['entry_id'] !== 'string' || !Number.isInteger((s as Rec)['prompt_set'] ?? -1)))
        throw new Error('人物槽需要 entry_id 和可选 prompt_set，最多 22 人')
      result['character_slots'] = structuredClone(slots)
    }
    if (!(result['instruction'] || result['randomize'] || result['fixed_prompt'] || (result['library_refs'] as string[]).length))
      throw new Error('请填写 AI 创作要求或选择固定资料')
    return result
  }

  store.librarySnapshot = (refs: string[]): Rec[] => {
    // Freeze selected entries plus the relations needed to interpret them.
    const result = new Map<string, Rec>()
    const pending = [...refs]
    while (pending.length) {
      const ident = pending.shift()!
      if (result.has(ident)) continue
      const row = store._findEntry(ident)
      if (!row) throw new Error('计划引用的资料已不存在，请重新选择')
      const entry = store._entryRow(row)
      result.set(ident, entry)
      if (entry['parent_id']) pending.push(entry['parent_id'] as string)
      if (entry['kind'] === 'blend') {
        for (const artist of ((entry['data'] as Rec)['artists'] ?? []) as Array<Rec>) pending.push(artist['id'] as string)
      }
    }
    return [...result.values()]
  }

  const prepareSchedule = (input: Rec, previous: ScheduleRow | undefined, current: Date): { item: Rec; nextRun: string | null; runs: number } => {
    if (!(input instanceof Object)) throw new Error('计划必须是对象')
    if ('expected_revision' in input) {
      integer(input['expected_revision'], '计划版本', 0, 2 ** 53)
      if (!previous || previous.revision !== input['expected_revision']) throw new ConflictError('计划已被更新，请刷新后重试')
    }
    const item: Rec = previous ? JSON.parse(previous.data) as Rec : {
      name: '定时生成', enabled: true, kind: 'once', timezone: 'Asia/Shanghai', count: 1,
      max_total_anlas: 0, max_runs: 1, missed_policy: 'skip', execution_mode: 'fixed',
    }
    if (previous) item['enabled'] = previous.enabled === 1
    const allowed = ['name', 'enabled', 'kind', 'timezone', 'at', 'time', 'interval_minutes', 'operation', 'request',
      'count', 'max_total_anlas', 'max_runs', 'missed_policy', 'snapshot', 'seed_mode', 'execution_mode', 'ai_recipe']
    for (const key of allowed) if (key in input) item[key] = structuredClone(input[key])
    item['execution_mode'] ??= 'fixed'
    if (typeof item['execution_mode'] !== 'string' || !['fixed', 'ai'].includes(item['execution_mode'])) throw new Error('执行模式必须是 fixed 或 ai')
    item['seed_mode'] ??= item['execution_mode'] === 'ai' ? 'random' : 'fixed'
    const oldData = previous ? JSON.parse(previous.data) as Rec : {}
    if (item['execution_mode'] === 'ai') {
      item['ai_recipe'] = validateAiRecipe(item['ai_recipe'] ?? {})
      if ('ai_recipe' in input || !('ai_library_snapshot' in oldData)) {
        const slotIds = ((item['ai_recipe'] as Rec)['character_slots'] ?? []) as Array<Rec>
        item['ai_library_snapshot'] = store.librarySnapshot([...(item['ai_recipe'] as Rec)['library_refs'] as string[], ...slotIds.map((s) => s['entry_id'] as string)])
      }
    } else {
      delete item['ai_library_snapshot']
    }
    if (typeof item['kind'] !== 'string' || !['once', 'daily', 'interval'].includes(item['kind']) || typeof item['missed_policy'] !== 'string' || !['skip', 'once'].includes(item['missed_policy']))
      throw new Error('无效计划类型或错过执行策略')
    if (typeof item['enabled'] !== 'boolean' || typeof item['name'] !== 'string') throw new Error('计划名称和启用状态无效')
    if (!validTimezone(item['timezone'] as string)) throw new Error('未知 IANA 时区')
    integer(item['count'], '每轮数量', 1, 50)
    integer(item['max_runs'], '最多轮数', 1, 100000)
    item['max_total_anlas'] = money(item['max_total_anlas'])
    if (typeof item['operation'] !== 'string' || !(item['request'] instanceof Object)) throw new Error('计划需要 operation 和 request')
    if (!['fixed', 'increment', 'random'].includes((item['seed_mode'] ?? 'fixed') as string)) throw new Error('未知种子模式')
    if ('snapshot' in item && !(item['snapshot'] instanceof Object)) throw new Error('计划 snapshot 必须是对象')
    let candidate: Date
    if (item['kind'] === 'once') {
      try {
        const at = item['at']
        if (typeof at !== 'string') throw new Error()
        if (/(Z|[+-]\d{2}:?\d{2})$/u.test(at)) {
          candidate = asUtc(at)
        } else {
          const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(at)
          if (!m) throw new Error()
          candidate = localInstant(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), item['timezone'] as string, Number(m[6] ?? 0))
        }
      } catch { throw new Error('单次计划需要有效 ISO at 时间') }
      item['at'] = timestamp(candidate)
    } else if (item['kind'] === 'daily') {
      const clock = item['time'] ?? ''
      if (typeof clock !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(clock)) throw new Error('每日计划需要 HH:MM 时间')
      candidate = nextDaily(current, clock, item['timezone'] as string)
    } else {
      const interval = integer(item['interval_minutes'], '间隔分钟数', 1, 525600)
      candidate = new Date(current.getTime() + interval * 60000)
    }
    const timingKeys = ['kind', 'timezone', 'at', 'time', 'interval_minutes']
    const timingChanged = timingKeys.some((key) => JSON.stringify(item[key]) !== JSON.stringify(oldData[key]))
    let nextRun: string | null
    if (previous && !timingChanged && !(item['enabled'] === true && previous.enabled !== 1)) {
      nextRun = previous.next_run
    } else {
      nextRun = timestamp(candidate)
    }
    let runs = previous ? previous.runs : 0
    if (runs >= (item['max_runs'] as number)) {
      item['enabled'] = false
      nextRun = null
    }
    return { item, nextRun, runs }
  }

  const cancelSchedulePending = (id: string, stamp: string, reason: string): void => {
    for (const job of data().jobs) {
      if (job.schedule_id === id && job.status === 'queued') {
        job.status = 'cancelled'; job.cancel_requested = 1; job.updated_at = stamp; job.finished_at = stamp
      }
    }
    for (const run of data().schedule_runs) {
      if (run.schedule_id === id && ['waiting_ai', 'planning'].includes(run.outcome)) {
        const value = JSON.parse(run.data) as Rec
        value['error'] = reason
        value['finished_at'] = stamp
        run.outcome = 'cancelled'
        run.data = encode(value)
      }
    }
  }

  const publicScheduleRun = (row: { schedule_id: string; scheduled_for: string; batch_id: string | null; outcome: string; data: string }): Rec => {
    const value = JSON.parse(row.data) as Rec
    delete value['schedule']
    value['schedule_id'] = row.schedule_id
    value['scheduled_for'] = row.scheduled_for
    value['batch_id'] = row.batch_id
    value['outcome'] = row.outcome
    value['execution_mode'] ??= 'fixed'
    const jobs = row.batch_id ? data().jobs.filter((j) => j.batch_id === row.batch_id) : []
    value['job_ids'] = jobs.map((j) => j.id)
    value['jobs'] = jobs.map((j) => {
      const view = jobViewLite(j)
      return view
    })
    if (value['requests']) value['request'] = (value['requests'] as Rec[])[0]
    if (jobs.length) {
      const statuses = new Set(jobs.map((j) => j.status))
      if (statuses.has('running')) value['outcome'] = 'running'
      else if (statuses.has('queued')) value['outcome'] = 'queued'
      else if (statuses.size === 1 && statuses.has('completed')) value['outcome'] = 'completed'
      else if (statuses.size === 1 && statuses.has('cancelled')) value['outcome'] = 'cancelled'
      else value['outcome'] = 'failed'
    }
    return value
  }

  const jobViewLite = (j: { id: string; status: string; error: string | null; actual: number | null; ceiling: number; finished_at: string | null; snapshot: string; result: string | null }): Rec => {
    const snapshot = JSON.parse(j.snapshot) as Rec
    return {
      id: j.id, status: j.status, error: j.error, actual_anlas: j.actual, max_anlas: j.ceiling,
      finished_at: j.finished_at, request: snapshot['request'], operation: snapshot['operation'],
      assets: (j.result ? (JSON.parse(j.result) as Rec)['assets'] : undefined) ?? [],
    }
  }

  store.listSchedules = (): Rec[] =>
    data().schedules.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(scheduleView)

  store.getSchedule = (id: string): Rec => {
    const row = data().schedules.find((s) => s.id === id)
    if (!row) throw new KeyError(id)
    return scheduleView(row)
  }

  store.previewSchedule = (input: Rec, id?: string | null, now?: Date | string | null): Rec => {
    const current = asUtc(now ?? null)
    const previous = id ? data().schedules.find((s) => s.id === id) : undefined
    if (id && !previous) throw new KeyError(id)
    const { item, nextRun, runs } = prepareSchedule(input, previous, current)
    return {
      ...item, id: id ?? null, revision: previous?.revision ?? 0, next_run: nextRun, runs,
      spent: previous?.spent ?? 0, reserved: previous?.reserved ?? 0, preview: true,
    }
  }

  store.saveSchedule = (input: Rec, id?: string | null, now?: Date | string | null): Rec => {
    const current = asUtc(now ?? null)
    const previous = id ? data().schedules.find((s) => s.id === id) : undefined
    if (id && !previous) throw new KeyError(id)
    const { item, nextRun, runs } = prepareSchedule(input, previous, current)
    const identifier = id ?? randomId()
    const stamp = timestamp(current)
    if (previous) cancelSchedulePending(identifier, stamp, '计划已编辑或停用，本轮未提交生图')
    const row: ScheduleRow = {
      id: identifier, data: encode(item), enabled: item['enabled'] ? 1 : 0, next_run: nextRun,
      runs, spent: previous?.spent ?? 0, reserved: previous?.reserved ?? 0,
      created_at: previous?.created_at ?? stamp, updated_at: stamp, revision: previous ? previous.revision + 1 : 0,
    }
    const idx = data().schedules.findIndex((s) => s.id === identifier)
    if (idx >= 0) data().schedules[idx] = row
    else data().schedules.push(row)
    store.internalPersist()
    return store.getSchedule(identifier)
  }

  store.deleteSchedule = (id: string, expectedRevision?: number | null): void => {
    const row = data().schedules.find((s) => s.id === id)
    if (!row) throw new KeyError(id)
    if (expectedRevision !== null && expectedRevision !== undefined) {
      integer(expectedRevision, '计划版本', 0, 2 ** 53)
      if (row.revision !== expectedRevision) throw new ConflictError('计划已被更新，请刷新后重试')
    }
    if (data().jobs.some((j) => j.schedule_id === id && j.status === 'running'))
      throw new ConflictError('计划存在执行中任务，请先停用并等待完成')
    const stamp = nowStamp()
    cancelSchedulePending(id, stamp, '计划已删除，本轮未提交生图')
    data().schedules = data().schedules.filter((s) => s.id !== id)
    store.internalPersist()
  }

  store.scheduleSeed = (request: Rec, schedule: Rec, runIndex: number, index: number): void => {
    const mode = (schedule['seed_mode'] ?? 'fixed') as string
    const seed = ((schedule['request'] as Rec)?.['seed'] ?? request['seed']) as number | undefined
    if (mode === 'random') {
      request['seed'] = Math.floor(Math.random() * 2 ** 32)
    } else if (mode === 'increment' && Number.isInteger(seed)) {
      request['seed'] = ((seed as number) + runIndex * (schedule['count'] as number) + index) % 2 ** 32
    } else if (mode === 'fixed' && Number.isInteger(seed)) {
      request['seed'] = seed
    }
  }

  store.tickSchedules = (now?: Date | string | null): Rec[] => {
    const current = asUtc(now ?? null)
    const stamp = timestamp(current)
    const created: Rec[] = []
    const state = data().kv['queue']
    if (state && (JSON.parse(state) as Rec)['paused'] === true) return []
    const due = data().schedules
      .filter((s) => s.enabled === 1 && s.next_run !== null && s.next_run <= stamp)
      .sort((a, b) => a.next_run!.localeCompare(b.next_run!) || a.id.localeCompare(b.id))
    for (const row of due) {
      const item = JSON.parse(row.data) as Rec
      const dueAt = asUtc(row.next_run)
      const late = current.getTime() - dueAt.getTime() > 60000
      const skipped = late && item['missed_policy'] === 'skip'
      let nextRun: string | null
      if (item['kind'] === 'once') nextRun = null
      else if (item['kind'] === 'daily') nextRun = timestamp(nextDaily(current, item['time'] as string, item['timezone'] as string))
      else {
        const periodMs = (item['interval_minutes'] as number) * 60000
        nextRun = timestamp(new Date(dueAt.getTime() + periodMs * (Math.floor((current.getTime() - dueAt.getTime()) / periodMs) + 1)))
      }
      let runs = row.runs
      let enabled = nextRun !== null && runs < (item['max_runs'] as number)
      const previouslySeen = data().schedule_runs.some((r) => r.schedule_id === row.id && r.scheduled_for === row.next_run)
      if (!previouslySeen) {
        let batchId: string | null = null
        let outcome = skipped ? 'skipped' : 'queued'
        const mode = (item['execution_mode'] ?? 'fixed') as string
        const runData: Rec = { execution_mode: mode, created_at: stamp, schedule_revision: row.revision }
        if (runs >= (item['max_runs'] as number)) {
          outcome = 'run_limit'; enabled = false; nextRun = null
        } else if (!skipped) {
          const waitingAi = data().schedule_runs.some((r) => r.schedule_id === row.id && ['waiting_ai', 'planning'].includes(r.outcome))
          const jobInProgress = data().jobs.some((j) => j.schedule_id === row.id && ['queued', 'running'].includes(j.status))
          const busy = mode === 'ai' && (waitingAi || jobInProgress)
          if (busy) {
            outcome = 'skipped_busy'
            runData['busy_reason'] = waitingAi ? '前一轮正在进行 AI 构思' : '前一轮生图任务仍在排队或执行中'
          } else if (mode === 'ai') {
            outcome = 'waiting_ai'
            runData['schedule'] = scheduleView(row)
            runs += 1
          } else {
            const snapshots: Rec[] = []
            for (let index = 0; index < (item['count'] as number); index++) {
              const snapshot = structuredClone((item['snapshot'] ?? {}) as Rec)
              snapshot['operation'] = item['operation']
              snapshot['request'] = structuredClone(item['request'])
              snapshot['schedule_run'] = { schedule_id: row.id, scheduled_for: row.next_run, revision: row.revision }
              store.scheduleSeed(snapshot['request'] as Rec, item, runs, index)
              snapshots.push(snapshot)
            }
            const jobs = createJobsFor(store, snapshots, item['max_total_anlas'] as number, `schedule:${row.id}:${row.next_run}`, row.id, stamp)
            created.push(...jobs)
            batchId = (jobs[0]!['batch_id'] as string) ?? null
            runData['operation'] = item['operation']
            runData['requests'] = jobs.map((job) => (job['request'] as Rec))
            runs += 1
          }
          if (runs >= (item['max_runs'] as number)) { enabled = false; nextRun = null }
        }
        data().schedule_runs.push({ schedule_id: row.id, scheduled_for: row.next_run!, batch_id: batchId, outcome, data: encode(runData) })
      }
      row.runs = runs
      row.enabled = enabled ? 1 : 0
      row.next_run = nextRun
      row.updated_at = stamp
    }
    if (due.length) store.internalPersist()
    return created
  }

  store.claimScheduleRun = (now?: Date | string | null): Rec | null => {
    const stamp = timestamp(now ?? asUtc())
    const state = data().kv['queue']
    if (state && (JSON.parse(state) as Rec)['paused'] === true) return null
    if (data().schedule_runs.some((r) => r.outcome === 'planning')) return null
    const waiting = data().schedule_runs
      .filter((r) => r.outcome === 'waiting_ai')
      .sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for) || a.schedule_id.localeCompare(b.schedule_id))
    let changed = false
    for (const row of waiting) {
      const value = JSON.parse(row.data) as Rec
      const schedule = data().schedules.find((s) => s.id === row.schedule_id)
      if (!schedule || schedule.revision !== value['schedule_revision']) {
        value['error'] = '计划已更改，本轮未提交生图'
        value['finished_at'] = stamp
        row.outcome = 'cancelled'
        row.data = encode(value)
        changed = true
        continue
      }
      value['started_at'] = stamp
      row.outcome = 'planning'
      row.data = encode(value)
      store.internalPersist()
      return { ...value, schedule_id: row.schedule_id, scheduled_for: row.scheduled_for, outcome: 'planning' }
    }
    if (changed) store.internalPersist()
    return null
  }

  store.finishScheduleRun = (run: Rec, opts: { plan?: Rec | null; error?: string | null; cancelled?: boolean; now?: Date | string | null } = {}): Rec => {
    // Commit a complete AI plan and its jobs atomically after rechecking state.
    const stamp = timestamp(opts.now ?? asUtc())
    const row = data().schedule_runs.find((r) => r.schedule_id === run['schedule_id'] && r.scheduled_for === run['scheduled_for'])
    if (!row) throw new KeyError(run['schedule_id'] as string)
    if (row.outcome !== 'planning') {
      const plan = opts.plan
      if (row.outcome === 'cancelled' && plan && typeof plan['ai_reply'] === 'string') {
        const cancelledData = JSON.parse(row.data) as Rec
        cancelledData['ai_reply'] = (plan['ai_reply'] as string).slice(0, 100000)
        row.data = encode(cancelledData)
      }
      return publicScheduleRun(row)
    }
    const value = JSON.parse(row.data) as Rec
    const scheduleRow = data().schedules.find((s) => s.id === row.schedule_id)
    const state = data().kv['queue']
    const paused = state ? (JSON.parse(state) as Rec)['paused'] === true : false
    const invalidated = !scheduleRow || scheduleRow.revision !== value['schedule_revision']
    let outcome = 'failed'
    let batchId: string | null = null
    value['finished_at'] = stamp
    const plan = opts.plan
    if (plan && typeof plan['ai_reply'] === 'string') value['ai_reply'] = (plan['ai_reply'] as string).slice(0, 100000)
    if (plan) {
      for (const key of ['warnings', 'tool_steps', 'usage']) {
        if (Array.isArray(plan[key])) value[key] = structuredClone(plan[key])
      }
    }
    if (plan?.['planning_metrics'] instanceof Object) value['planning_metrics'] = structuredClone(plan['planning_metrics'])
    if (opts.cancelled || paused || invalidated) {
      outcome = 'cancelled'
      value['error'] = opts.error ?? '队列已暂停或计划已更改，本轮未提交生图'
    } else if (opts.error) {
      value['error'] = opts.error
    } else {
      const saved = value['schedule'] as Rec
      const snapshots = plan ? plan['snapshots'] : undefined
      if (!Array.isArray(snapshots) || snapshots.length !== saved['count'])
        throw new Error('AI 计划结果数量与授权每轮数量不一致')
      const frozen: Rec[] = []
      snapshots.forEach((snapshot, index) => {
        if (!(snapshot instanceof Object) || snapshot['operation'] !== saved['operation'])
          throw new Error('AI 不可改变定时计划的操作类型')
        const request = checkScheduledRequest(saved, snapshot['request'])
        const snapshotTemplate = structuredClone((saved['snapshot'] ?? {}) as Rec)
        const refs = creativeDraft(saved).draft['library_refs']
        snapshotTemplate['operation'] = saved['operation']
        snapshotTemplate['request'] = request
        snapshotTemplate['library_refs'] = refs
        snapshotTemplate['schedule_run'] = { schedule_id: row.schedule_id, scheduled_for: row.scheduled_for, revision: value['schedule_revision'] }
        // Fixed user locks take precedence over schedule seed variation.
        const recipe = saved['ai_recipe'] as Rec
        const lockedFields = (recipe['locked_fields'] ?? []) as string[]
        const seedLocked = lockedFields.some((lock) => ['request.seed', 'request'].includes(normalizeLock(lock)))
        if (!seedLocked) store.scheduleSeed(snapshotTemplate['request'] as Rec, saved, saved['runs'] as number, index)
        frozen.push(snapshotTemplate)
      })
      value['operation'] = saved['operation']
      value['requests'] = frozen.map((item) => item['request'])
      const jobs = createJobsFor(store, frozen, saved['max_total_anlas'] as number, `schedule:${row.schedule_id}:${row.scheduled_for}`, row.schedule_id, stamp)
      batchId = jobs[0]!['batch_id'] as string
      outcome = 'queued'
    }
    row.outcome = outcome
    row.batch_id = batchId
    row.data = encode(value)
    store.internalPersist()
    return publicScheduleRun(row)
  }

  store.listScheduleRuns = (id: string, limit = 100): Rec[] => {
    integer(limit, '记录数量', 1, 1000)
    return data().schedule_runs
      .filter((r) => r.schedule_id === id)
      .sort((a, b) => b.scheduled_for.localeCompare(a.scheduled_for))
      .slice(0, limit)
      .map(publicScheduleRun)
  }

  store.scheduleOnce = (ident: string, revision: number, key: string): Rec => {
    if (typeof key !== 'string' || key.length < 1 || key.length > 200) throw new Error('需要稳定的执行请求标识')
    const stamp = nowStamp()
    const marker = 'schedule-once:' + ident + ':' + key
    const old = data().kv[marker]
    if (old) return JSON.parse(old) as Rec
    const row = data().schedules.find((s) => s.id === ident)
    if (!row) throw new KeyError(ident)
    if (row.revision !== revision) throw new ConflictError('计划已经更新，请刷新')
    const state = data().kv['queue']
    if (state && (JSON.parse(state) as Rec)['paused'] === true) throw new ConflictError('请先恢复队列再执行一次')
    const schedule = scheduleView(row)
    if ((schedule['runs'] as number) >= (schedule['max_runs'] as number)) throw new Error('已达到计划次数上限')
    if (data().jobs.some((j) => j.schedule_id === ident && ['queued', 'running'].includes(j.status)) ||
      data().schedule_runs.some((r) => r.schedule_id === ident && ['planning', 'waiting_ai'].includes(r.outcome)))
      throw new ConflictError('此计划还有未完成的执行，请先等待完成')
    const ai = schedule['execution_mode'] === 'ai'
    const run: Rec = { execution_mode: schedule['execution_mode'] ?? 'fixed', created_at: stamp, schedule_revision: revision, manual: true }
    let batchId: string | null = null
    if (ai) {
      run['schedule'] = schedule
    } else {
      const snapshots: Rec[] = []
      for (let i = 0; i < (schedule['count'] as number); i++) {
        const snapshot = structuredClone((schedule['snapshot'] ?? {}) as Rec)
        snapshot['operation'] = schedule['operation']
        snapshot['request'] = structuredClone(schedule['request'])
        snapshot['schedule_run'] = { schedule_id: ident, scheduled_for: stamp, revision }
        store.scheduleSeed(snapshot['request'] as Rec, schedule, schedule['runs'] as number, i)
        snapshots.push(snapshot)
      }
      const jobs = createJobsFor(store, snapshots, schedule['max_total_anlas'] as number, marker, ident, stamp)
      batchId = jobs[0]!['batch_id'] as string
      run['operation'] = schedule['operation']
      run['requests'] = snapshots.map((s) => s['request'])
    }
    data().schedule_runs.push({ schedule_id: ident, scheduled_for: stamp, batch_id: batchId, outcome: ai ? 'waiting_ai' : 'queued', data: encode(run) })
    const exhausted = (schedule['runs'] as number) + 1 >= (schedule['max_runs'] as number)
    row.runs += 1
    row.enabled = exhausted ? 0 : row.enabled
    row.next_run = exhausted ? null : row.next_run
    row.updated_at = stamp
    const result = { schedule_id: ident, scheduled_for: stamp, count: schedule['count'], charged_to_schedule: true }
    data().kv[marker] = encode(result)
    store.internalPersist()
    return result
  }
}

/** Access the queue-internal job creation through the queue module. */
function createJobsFor(store: Store, snapshots: Rec[], budget: number, idempotencyKey: string, scheduleId: string, now: string): Rec[] {
  return store.createJobs(snapshots, budget, idempotencyKey, { scheduleId, now, deferPersist: true })
}

function normalizeLock(value: string): string {
  return value.trim().replace(/^\//u, '').replace(/\//gu, '.').replace(/\[(\d+)\]/gu, '.$1').replace(/^(?!operation$|request).*$/u, (m) => m.startsWith('request.') ? m : 'request.' + m)
}
