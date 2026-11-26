/** Legacy schedule storage: read-only access and cleanup for migrating pre-0.20 schedules to DSH native schedules. */
import type { Store, Rec } from './store.ts'
import type { ScheduleRow } from './storeDoc.ts'
import { ConflictError, KeyError, integer } from './util.ts'

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

  store.listSchedules = (): Rec[] =>
    data().schedules.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(scheduleView)

  store.getSchedule = (id: string): Rec => {
    const row = data().schedules.find((s) => s.id === id)
    if (!row) throw new KeyError(id)
    return scheduleView(row)
  }

  store.deleteSchedule = (id: string, expectedRevision?: number | null): void => {
    const row = data().schedules.find((s) => s.id === id)
    if (!row) throw new KeyError(id)
    if (expectedRevision !== null && expectedRevision !== undefined) {
      integer(expectedRevision, '计划版本', 0, 2 ** 53)
      if (row.revision !== expectedRevision) throw new ConflictError('计划已被更新，请刷新后重试')
    }
    data().schedules = data().schedules.filter((s) => s.id !== id)
    store.internalPersist()
  }

  store.listScheduleRuns = (id: string, limit = 100): Rec[] => {
    integer(limit, '记录数量', 1, 1000)
    return data().schedule_runs
      .filter((r) => r.schedule_id === id)
      .sort((a, b) => b.scheduled_for.localeCompare(a.scheduled_for))
      .slice(0, limit)
      .map((row) => ({
        ...(JSON.parse(row.data) as Rec),
        schedule_id: row.schedule_id,
        scheduled_for: row.scheduled_for,
        batch_id: row.batch_id,
        outcome: row.outcome,
      }))
  }
}
