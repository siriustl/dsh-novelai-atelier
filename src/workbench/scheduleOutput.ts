/** Schedule-local output selection, independent of mutable workbench settings. */
import { OutputSubdirSchema } from '../core/outputDirectory.ts'

type Rec = Record<string, unknown>

export function scheduleOutputSubdir(schedule: Rec): string | null {
  const value = 'output_subdir' in schedule ? schedule['output_subdir'] : (schedule['request'] as Rec | undefined)?.['output_subdir']
  if (value == null || (typeof value === 'string' && !value.trim())) return null
  return OutputSubdirSchema.parse(value)
}

/** Legacy request-only directories remain valid until explicitly changed or cleared. */
export function scheduleRequest(schedule: Rec): Rec {
  const request = structuredClone(schedule['request']) as Rec
  const subdir = scheduleOutputSubdir(schedule)
  if (subdir === null) delete request['output_subdir']
  else request['output_subdir'] = subdir
  return request
}

export function checkScheduleOutput(schedule: Rec, proposed: Rec): Rec {
  const subdir = scheduleOutputSubdir(schedule)
  const actual = proposed['output_subdir'] == null ? null : OutputSubdirSchema.parse(proposed['output_subdir'])
  if (actual !== subdir) throw new Error('AI 不可改变计划的分类子目录：request.output_subdir')
  const request = structuredClone(proposed)
  if (subdir === null) delete request['output_subdir']
  else request['output_subdir'] = subdir
  return request
}
