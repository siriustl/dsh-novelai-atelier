/** Scheduled creation bridged directly to DSH native `ctx.schedule`, plus one-click migration for legacy plans. */
import type { WorkbenchState } from '../shell.tsx'
import { R, h, Button, Card, Field, Modal, ErrorBox, OkBox, Empty, Select, Toggle, Num, keyboardActivate } from '../ui.tsx'
import { api, type Rec } from '../api.ts'
import { Icon } from '../icons.tsx'

const EMPTY_NEW_TASK = (): Rec => ({
  title: '每日定时生图',
  active: true,
  kind: 'daily',
  time: '09:00',
  weekdays: [1, 3, 5],
  interval_minutes: 60,
  at: '',
  rrule: '',
  timezone: 'Asia/Shanghai',
  target: 'new_once',
  mode: 'ai',
  model: 'nai-diffusion-5-full',
  v5_tier: 'high',
  count: 1,
  output_subdir: '',
  endpoint: '',
  instruction: '',
  randomize: '',
  fixed_prompt: '',
  fixed_negative_prompt: '',
  library_refs: [],
  dsh_prompt: '',
})

const WEEKDAY_LABELS: Array<[number, string]> = [
  [1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'], [5, '周五'], [6, '周六'], [0, '周日'],
]

export function SchedulesPanel({ state }: { state: WorkbenchState }): Rec {
  const r = R()
  const [available, setAvailable] = r.useState<boolean>(true)
  const [tasks, setTasks] = r.useState<Rec[]>([])
  const [legacy, setLegacy] = r.useState<Rec[]>([])
  const [showAll, setShowAll] = r.useState(false)
  const [editing, setEditing] = r.useState<Rec | null>(null)
  const [historyFor, setHistoryFor] = r.useState<Rec | null>(null)
  const [history, setHistory] = r.useState<Rec | null>(null)
  const [error, setError] = r.useState<string | null>(null)
  const [okMsg, setOkMsg] = r.useState<string | null>(null)
  const [busy, setBusy] = r.useState('')
  const [nowSec, setNowSec] = r.useState(Date.now())
  const loadVersion = r.useRef(0)
  const histVersion = r.useRef(0)

  const load = async (allFlag = showAll): Promise<void> => {
    const version = ++loadVersion.current
    try {
      const res = await api<Rec>(`/schedules${allFlag ? '?all=true' : ''}`)
      if (version !== loadVersion.current) return
      setAvailable(res['available'] !== false)
      setTasks((res['tasks'] ?? []) as Rec[])
      setLegacy((res['legacy'] ?? []) as Rec[])
      setError(null)
    } catch (e) {
      if (version === loadVersion.current) setError((e as Error).message)
    }
  }

  r.useEffect(() => {
    void load(showAll)
    return () => { loadVersion.current++; histVersion.current++ }
  }, [showAll])
  r.useEffect(() => {
    const t = setInterval(() => { void load(showAll) }, 15000)
    return () => clearInterval(t)
  }, [showAll])
  r.useEffect(() => {
    const t = setInterval(() => setNowSec(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const toggle = async (task: Rec): Promise<void> => {
    setBusy('toggle:' + String(task['id'])); setError(null); setOkMsg(null)
    try {
      const nextActive = task['status'] !== 'active'
      await api(`/schedules/${encodeURIComponent(String(task['id']))}`, 'PUT', {
        active: nextActive,
        expected_updated_at: task['updatedAt'],
      })
      setOkMsg(nextActive ? `已启用「${String(task['title'])}」` : `已暂停「${String(task['title'])}」`)
      await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }

  const runNow = async (task: Rec): Promise<void> => {
    setBusy('run:' + String(task['id'])); setError(null); setOkMsg(null)
    try {
      const res = await api<Rec>(`/schedules/${encodeURIComponent(String(task['id']))}/run`, 'POST', {})
      setOkMsg(res['pending'] ? String(res['message'] ?? '任务已在排队运行中') : `已触发「${String(task['title'])}」，DSH 将自动唤醒会话执行`)
      await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }

  const remove = async (task: Rec): Promise<void> => {
    if (!confirm(`从 DSH 删除定时任务「${String(task['title'])}」？`)) return
    setBusy('del:' + String(task['id'])); setError(null); setOkMsg(null)
    try {
      const qs = task['updatedAt'] ? `?expected_updated_at=${encodeURIComponent(String(task['updatedAt']))}` : ''
      await api(`/schedules/${encodeURIComponent(String(task['id']))}${qs}`, 'DELETE')
      setOkMsg(`已删除「${String(task['title'])}」`)
      await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }

  const openHistory = async (task: Rec): Promise<void> => {
    const version = ++histVersion.current
    setHistoryFor(task); setHistory(null); setError(null)
    try {
      const res = await api<Rec>(`/schedules/${encodeURIComponent(String(task['id']))}/history?limit=20`)
      if (version === histVersion.current) setHistory(res)
    } catch (e) { if (version === histVersion.current) setError((e as Error).message) }
  }
  const closeHistory = (): void => { histVersion.current++; setHistoryFor(null); setHistory(null) }

  const migrateLegacy = async (plan: Rec): Promise<void> => {
    setBusy('mig:' + String(plan['id'])); setError(null); setOkMsg(null)
    try {
      await api(`/schedules/legacy/${encodeURIComponent(String(plan['id']))}/migrate`, 'POST', { delete_legacy: true })
      setOkMsg(`已将旧计划「${String(plan['name'])}」迁移到 DSH 原生定时任务`)
      await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }

  const removeLegacy = async (plan: Rec): Promise<void> => {
    if (!confirm(`删除旧版定时计划「${String(plan['name'])}」？`)) return
    setBusy('dell:' + String(plan['id'])); setError(null); setOkMsg(null)
    try {
      await api(`/schedules/legacy/${encodeURIComponent(String(plan['id']))}?revision=${String(plan['revision'])}`, 'DELETE')
      setOkMsg(`已删除旧版计划「${String(plan['name'])}」`)
      await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }

  return h('div', null,
    Card({ title: '定时任务（DSH 原生调度）' },
      ErrorBox({ error }),
      OkBox({ text: okMsg }),
      h('p', { style: { margin: '0 0 10px', color: 'var(--nai-faint)', fontSize: 12 } },
        '定时任务由 DSH 原生调度器托管执行，触发时直接使用 DSH 会话与当前模型调用 NAI 工具，无需单独配置 AI 构思模型；在 DSH 定时任务面板与本页双向同步。'),
      h('div', { className: 'nai-row', style: { marginBottom: 10, gap: 8, flexWrap: 'wrap' } },
        Button({ kind: 'primary', disabled: !available, onClick: () => setEditing(EMPTY_NEW_TASK()) }, '＋ 新建定时生图'),
        Button({ small: true, ghost: true, icon: 'refresh', onClick: () => void load() }, '刷新'),
        Toggle({ checked: showAll, onChange: setShowAll, label: '显示全部 DSH 定时任务' }),
        h('span', { style: { flex: 1 } }),
        h('span', { className: available ? 'nai-pill ok' : 'nai-pill bad' },
          available ? '● 已接入 DSH 原生定时' : '○ DSH 定时服务未启用'),
      ),
      !tasks.length ? Empty({
        text: available
          ? '暂无 NAI 定时任务。点击「新建定时生图」或在对话中让 Agent 创建，任务将直接由 DSH 定时调度。'
          : '当前宿主未挂载 DSH 定时服务（ctx.schedule），请升级或启用 DSH 定时任务功能。',
      }) : null,
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, tasks.map((task) => {
        const id = String(task['id'])
        const active = task['status'] === 'active'
        const ended = task['status'] === 'ended'
        const lastDelivery = task['lastDelivery'] as Rec | null | undefined
        return h('div', {
          className: 'nai-sched-card', key: id, role: 'group', tabIndex: 0,
          'aria-label': String(task['title']),
          onKeyDown: keyboardActivate(() => setEditing(taskToEditDraft(task))),
          onClick: () => setEditing(taskToEditDraft(task)),
        },
          h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('strong', { style: { fontSize: 14 } }, String(task['title'])),
              active
                ? h('span', { className: 'nai-pill ok', style: { fontSize: 10, padding: '1px 7px' } }, '● 运行中')
                : ended
                  ? h('span', { className: 'nai-pill', style: { fontSize: 10, padding: '1px 7px' } }, '■ 已结束')
                  : h('span', { className: 'nai-pill', style: { fontSize: 10, padding: '1px 7px' } }, '○ 已暂停'),
              task['executionActive'] ? h('span', { className: 'nai-pill ok', style: { fontSize: 10, padding: '1px 7px' } }, '执行中') : null,
              h('span', { className: 'nai-pill', style: { fontSize: 10, padding: '1px 7px' } }, describeTarget(task['target'] as Rec | undefined)),
              formatCountdown(task, nowSec),
            ),
            h('div', { style: { fontSize: 12, color: 'var(--nai-dim)' } },
              describeTiming(task),
              lastDelivery?.['deliveredAt'] ? ` · 上次触发 ${new Date(String(lastDelivery['deliveredAt'])).toLocaleString('zh-CN')}` : '',
            ),
            h('div', { style: { fontSize: 11, color: 'var(--nai-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
              String(task['prompt'] ?? '').replace(/\s+/gu, ' ').slice(0, 140),
            ),
            h('div', { className: 'nai-row', style: { marginTop: 4, gap: 6, flexWrap: 'wrap' } },
              Button({
                small: true, icon: active ? 'pause' : 'play', kind: active ? 'ghost' : 'primary',
                disabled: busy !== '' || ended,
                onClick: (e: Rec) => { e.stopPropagation(); void toggle(task) },
              }, active ? '暂停' : '启用'),
              Button({
                small: true, icon: 'play', disabled: busy !== '',
                onClick: (e: Rec) => { e.stopPropagation(); void runNow(task) },
                title: '立即投递一次到目标会话（不改变下次定时时间）',
              }, '立即执行'),
              Button({
                small: true, kind: 'ghost', icon: 'list',
                onClick: (e: Rec) => { e.stopPropagation(); void openHistory(task) },
              }, '投递记录'),
              Button({
                small: true, kind: 'ghost', icon: 'edit',
                onClick: (e: Rec) => { e.stopPropagation(); setEditing(taskToEditDraft(task)) },
              }, '编辑'),
              Button({
                small: true, iconOnly: true, icon: 'trash', kind: 'ghost', className: 'danger',
                disabled: busy !== '',
                onClick: (e: Rec) => { e.stopPropagation(); void remove(task) },
                title: '删除任务',
              }),
            ),
          ),
        )
      })),
    ),
    legacy.length ? Card({ title: `旧版插件定时计划（${legacy.length} 条 · 已停用内置轮询）` },
      h('p', { style: { margin: '0 0 8px', color: 'var(--nai-faint)', fontSize: 12 } },
        '0.20 起不再使用插件内置定时器与独立 AI 构思渠道。你可以一键将旧计划迁移为 DSH 原生定时任务，或直接删除。'),
      h('div', { className: 'nai-list' }, legacy.map((plan) => h('div', { className: 'item', key: String(plan['id']) },
        h('div', { className: 'grow' },
          h('strong', null, String(plan['name'] ?? '未命名计划')),
          h('div', { className: 'sub' }, `${String(plan['kind'])} · ${String(plan['execution_mode'] === 'ai' ? 'AI 构思' : '固定请求')} · 每次 ${String(plan['count'] ?? 1)} 张`),
        ),
        Button({ small: true, kind: 'primary', disabled: !available || busy !== '', onClick: () => void migrateLegacy(plan) }, '迁移到 DSH'),
        Button({ small: true, kind: 'ghost', className: 'danger', disabled: busy !== '', onClick: () => void removeLegacy(plan) }, '删除'),
      ))),
    ) : null,
    editing ? h(ScheduleEditorModal, {
      initial: editing,
      endpoints: ((state.settings?.['nai_endpoints'] ?? []) as Rec[]).filter((ep) => ep['enabled'] !== false),
      onClose: () => setEditing(null),
      onSaved: (msg: string) => { setEditing(null); setOkMsg(msg); void load() },
      guardNavigation: state.guardNavigation,
    }) : null,
    historyFor ? h(Modal, {
      title: `投递记录 · ${String(historyFor['title'])}`, onClose: closeHistory, wide: true,
      footer: Button({ onClick: closeHistory }, '关闭'),
    }, history === null
      ? Empty({ text: '正在加载投递记录…' })
      : ((history['records'] ?? []) as Rec[]).length === 0
        ? Empty({ text: '暂无投递记录' })
        : h('div', { className: 'nai-list' }, ((history['records'] ?? []) as Rec[]).map((rec, i) =>
          h('div', { className: 'item', key: i },
            h('div', { className: 'grow' },
              h('div', null,
                new Date(String(rec['deliveredAt'] ?? rec['scheduledAt'])).toLocaleString('zh-CN'),
                ' ',
                h('span', { className: 'nai-tag' }, rec['trigger'] === 'manual' ? '手动触发' : '定时触发'),
              ),
              h('div', { className: 'sub' }, `目标会话：${String(rec['targetSessionId'] ?? '-')}`),
            ),
          ),
        )),
    ) : null,
  )
}

function taskToEditDraft(task: Rec): Rec {
  const kind = String(task['kind'] ?? 'daily')
  return {
    id: task['id'],
    expected_updated_at: task['updatedAt'],
    title: String(task['title'] ?? ''),
    active: task['status'] === 'active',
    kind: kind === 'every' ? 'interval' : kind === 'at' ? 'once' : kind,
    time: String(task['time'] ?? '09:00'),
    weekdays: Array.isArray(task['weekdays']) ? task['weekdays'] : [1, 3, 5],
    interval_minutes: task['everySeconds'] ? Math.max(1, Math.round(Number(task['everySeconds']) / 60)) : 60,
    at: kind === 'at' ? String(task['scheduledAt'] ?? '') : '',
    rrule: String(task['rrule'] ?? ''),
    expression: String(task['expression'] ?? ''),
    timezone: String(task['timeZone'] ?? 'Asia/Shanghai'),
    target: String((task['target'] as Rec | undefined)?.['kind'] ?? 'new_once'),
    mode: 'custom',
    dsh_prompt: String(task['prompt'] ?? ''),
    library_refs: [],
  }
}

function describeTarget(target: Rec | undefined): string {
  const kind = String(target?.['kind'] ?? '')
  if (kind === 'new_once') return '独立复用会话'
  if (kind === 'new') return '每次新会话'
  if (kind === 'session') return '绑定会话'
  return '默认会话'
}

function describeTiming(task: Rec): string {
  const kind = String(task['kind'] ?? '')
  if (kind === 'daily') return `每天 ${String(task['time'] ?? '')}（${String(task['timeZone'] ?? 'Asia/Shanghai')}）`
  if (kind === 'weekly') return `每周 ${String(task['time'] ?? '')}（${String(task['timeZone'] ?? 'Asia/Shanghai')}）`
  if (kind === 'every') return `每 ${Math.max(1, Math.round(Number(task['everySeconds'] ?? 3600) / 60))} 分钟`
  if (kind === 'at' || kind === 'after') return `单次 ${task['scheduledAt'] ? new Date(String(task['scheduledAt'])).toLocaleString('zh-CN') : ''}`
  if (kind === 'cron') return `Cron: ${String(task['expression'] ?? '')}`
  if (kind === 'rrule') return `RRULE · 下次 ${task['scheduledAt'] ? new Date(String(task['scheduledAt'])).toLocaleString('zh-CN') : ''}`
  return String(task['scheduledAtLocal'] ?? '')
}

function formatCountdown(task: Rec, now: number): Rec | null {
  if (task['status'] !== 'active') return null
  const next = task['scheduledAt'] ? new Date(String(task['scheduledAt'])).getTime() : null
  if (!next || !Number.isFinite(next)) return null
  const diffSec = Math.floor((next - now) / 1000)
  const pillStyle = { display: 'inline-flex', alignItems: 'center', gap: 4 }
  if (diffSec <= 0) return h('span', { className: 'nai-countdown', style: { color: 'var(--nai-ok)', borderColor: 'var(--nai-ok)', ...pillStyle } }, h(Icon, { name: 'clock', size: 10 }), '即将触发')
  if (diffSec < 60) return h('span', { className: 'nai-countdown', style: pillStyle }, h(Icon, { name: 'clock', size: 10 }), `${diffSec}秒后`)
  if (diffSec < 3600) return h('span', { className: 'nai-countdown', style: pillStyle }, h(Icon, { name: 'clock', size: 10 }), `${Math.floor(diffSec / 60)}分后`)
  if (diffSec < 86400) return h('span', { className: 'nai-countdown', style: pillStyle }, h(Icon, { name: 'clock', size: 10 }), `${Math.floor(diffSec / 3600)}小时${Math.floor((diffSec % 3600) / 60)}分后`)
  return h('span', { className: 'nai-countdown', style: pillStyle }, h(Icon, { name: 'clock', size: 10 }), `${Math.floor(diffSec / 86400)}天后`)
}

function ScheduleEditorModal({ initial, endpoints, onClose, onSaved, guardNavigation }: {
  initial: Rec
  endpoints: Rec[]
  onClose: () => void
  onSaved: (msg: string) => void
  guardNavigation?: WorkbenchState['guardNavigation']
}): Rec {
  const r = R()
  const [value, setValue] = r.useState<Rec>(structuredClone(initial))
  const [error, setError] = r.useState<string | null>(null)
  const [saving, setSaving] = r.useState(false)
  const [libOpen, setLibOpen] = r.useState(false)
  const [libRows, setLibRows] = r.useState<Rec[]>([])
  const [libKind, setLibKind] = r.useState('')
  const baseline = r.useRef(JSON.stringify(initial))
  const latest = r.useRef(value)
  latest.current = value
  const savingRef = r.useRef(false)
  const isEdit = Boolean(value['id'])

  const canLeave = (): boolean => !savingRef.current && !saving && (JSON.stringify(latest.current) === baseline.current || confirm('定时任务编辑尚未保存，放弃修改？'))
  const close = (): void => { if (canLeave()) onClose() }
  r.useEffect(() => guardNavigation?.(async () => canLeave()), [guardNavigation])
  r.useEffect(() => { void api<Rec[]>('/library').then(setLibRows).catch(() => {}) }, [])

  const set = (patch: Rec): void => { if (!savingRef.current && !saving) setValue((prev) => ({ ...prev, ...patch })) }
  const selectedRefs = (value['library_refs'] ?? []) as string[]

  const toggleWeekday = (day: number): void => {
    const cur = new Set<number>(Array.isArray(value['weekdays']) ? (value['weekdays'] as number[]) : [])
    if (cur.has(day)) cur.delete(day)
    else cur.add(day)
    set({ weekdays: [...cur] })
  }

  const save = async (): Promise<void> => {
    if (savingRef.current || saving) return
    savingRef.current = true
    setSaving(true); setError(null)
    try {
      const payload: Rec = {
        title: String(value['title'] ?? '').trim(),
        active: Boolean(value['active']),
        kind: value['kind'],
        timezone: String(value['timezone'] ?? 'Asia/Shanghai').trim() || 'Asia/Shanghai',
      }
      if (value['kind'] === 'daily') payload['time'] = value['time']
      else if (value['kind'] === 'weekly') { payload['time'] = value['time']; payload['weekdays'] = value['weekdays'] }
      else if (value['kind'] === 'interval') payload['interval_minutes'] = Number(value['interval_minutes'] ?? 60)
      else if (value['kind'] === 'once') payload['at'] = value['at']
      else if (value['kind'] === 'rrule') payload['rrule'] = value['rrule']
      else if (value['kind'] === 'cron') payload['expression'] = value['expression']

      if (!isEdit || (value['target'] === 'new_once' || value['target'] === 'new')) {
        if (!isEdit || value['target'] !== initial['target']) payload['target'] = value['target']
      }

      if (value['mode'] === 'custom') {
        payload['dsh_prompt'] = String(value['dsh_prompt'] ?? '')
      } else {
        payload['mode'] = value['mode']
        payload['model'] = value['model']
        if (value['model'] === 'nai-diffusion-5-full') payload['v5_tier'] = value['v5_tier']
        payload['count'] = Number(value['count'] ?? 1)
        if (String(value['output_subdir'] ?? '').trim()) payload['output_subdir'] = String(value['output_subdir']).trim()
        if (String(value['endpoint'] ?? '').trim()) payload['endpoint'] = String(value['endpoint']).trim()
        if (selectedRefs.length) payload['library_refs'] = selectedRefs
        if (value['mode'] === 'ai') {
          payload['instruction'] = value['instruction']
          payload['randomize'] = value['randomize']
          payload['fixed_prompt'] = value['fixed_prompt']
          payload['fixed_negative_prompt'] = value['fixed_negative_prompt']
        } else {
          payload['fixed_prompt'] = value['fixed_prompt']
          payload['fixed_negative_prompt'] = value['fixed_negative_prompt']
        }
      }

      if (isEdit) {
        if (value['expected_updated_at']) payload['expected_updated_at'] = value['expected_updated_at']
        await api(`/schedules/${encodeURIComponent(String(value['id']))}`, 'PUT', payload)
        onSaved(`已更新定时任务「${String(payload['title'])}」`)
      } else {
        await api('/schedules', 'POST', payload)
        onSaved(`已创建 DSH 定时任务「${String(payload['title'])}」`)
      }
    } catch (e) { setError((e as Error).message) } finally { savingRef.current = false; setSaving(false) }
  }

  return h(Modal, {
    title: isEdit ? `编辑 DSH 定时任务 · ${String(value['title'])}` : '新建 NAI 定时生图（DSH 原生调度）',
    onClose: close, wide: true,
    footer: h('div', { className: 'modal-actions' },
      ErrorBox({ error }),
      Button({ onClick: close, disabled: saving }, '取消'),
      Button({ kind: 'primary', onClick: () => void save(), disabled: saving }, saving ? '保存中…' : '保存'),
    ),
  },
    h('fieldset', { disabled: saving, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } },
      h('div', { className: 'nai-row', style: { flexWrap: 'wrap', gap: 8 } },
        Field({ label: '任务名称' }, h('input', { value: String(value['title'] ?? ''), maxLength: 120, onChange: (e: Rec) => set({ title: (e.target as HTMLInputElement).value }) })),
        Field({ label: '指令方式' }, Select({
          value: String(value['mode'] ?? 'ai'),
          onChange: (v: string) => set({ mode: v }),
          options: [
            { value: 'ai', label: 'AI 每次构思（推荐）' },
            { value: 'fixed', label: '固定提示词与参数' },
            { value: 'custom', label: '自定义完整 DSH 指令' },
          ],
        })),
        Field({ label: '目标会话' }, Select({
          value: String(value['target'] ?? 'new_once'),
          onChange: (v: string) => set({ target: v }),
          options: [
            { value: 'new_once', label: '独立复用会话（推荐）' },
            { value: 'new', label: '每次新开会话' },
            ...(value['target'] === 'session' ? [{ value: 'session', label: '保持原绑定会话' }] : []),
          ],
        })),
        Toggle({ checked: Boolean(value['active']), onChange: (v: boolean) => set({ active: v }), label: '启用' }),
      ),
      h('div', { style: { height: 8 } }),
      h('div', { className: 'nai-row', style: { flexWrap: 'wrap', gap: 8 } },
        Field({ label: '调度节奏' }, Select({
          value: String(value['kind'] ?? 'daily'),
          onChange: (v: string) => set({ kind: v }),
          options: [
            { value: 'daily', label: '每天' },
            { value: 'weekly', label: '每周' },
            { value: 'interval', label: '固定间隔' },
            { value: 'once', label: '单次' },
            { value: 'rrule', label: 'RFC 5545 RRULE' },
            ...(value['kind'] === 'cron' ? [{ value: 'cron', label: 'Cron 表达式' }] : []),
          ],
        })),
        value['kind'] === 'daily' || value['kind'] === 'weekly'
          ? Field({ label: '时间 (HH:MM)' }, h('input', { value: String(value['time'] ?? '09:00'), placeholder: '09:00', onChange: (e: Rec) => set({ time: (e.target as HTMLInputElement).value }) }))
          : null,
        value['kind'] === 'interval'
          ? Field({ label: '间隔（分钟）' }, Num({ value: value['interval_minutes'] ?? 60, onChange: (v) => set({ interval_minutes: v ?? 60 }), min: 1 }))
          : null,
        value['kind'] === 'once'
          ? Field({ label: '触发时间（YYYY-MM-DD HH:MM）' }, h('input', { value: String(value['at'] ?? ''), placeholder: '2026-12-01 09:00', onChange: (e: Rec) => set({ at: (e.target as HTMLInputElement).value }) }))
          : null,
        value['kind'] === 'rrule'
          ? Field({ label: 'RRULE 规则' }, h('textarea', { value: String(value['rrule'] ?? ''), style: { minHeight: 46 }, placeholder: 'DTSTART;TZID=Asia/Shanghai:20261201T090000\nRRULE:FREQ=DAILY', onChange: (e: Rec) => set({ rrule: (e.target as HTMLTextAreaElement).value }) }))
          : null,
        value['kind'] === 'cron'
          ? Field({ label: 'Cron 表达式' }, h('input', { value: String(value['expression'] ?? ''), placeholder: '0 9 * * *', onChange: (e: Rec) => set({ expression: (e.target as HTMLInputElement).value }) }))
          : null,
        value['kind'] !== 'interval' && value['kind'] !== 'rrule'
          ? Field({ label: '时区' }, h('input', { value: String(value['timezone'] ?? 'Asia/Shanghai'), onChange: (e: Rec) => set({ timezone: (e.target as HTMLInputElement).value }) }))
          : null,
      ),
      value['kind'] === 'weekly' ? h('div', { className: 'nai-row', style: { marginTop: 6, gap: 6, flexWrap: 'wrap' } },
        WEEKDAY_LABELS.map(([num, label]) => {
          const checked = Array.isArray(value['weekdays']) && (value['weekdays'] as number[]).includes(num)
          return Button({ small: true, kind: checked ? 'primary' : 'ghost', key: num, onClick: () => toggleWeekday(num) }, label)
        }),
      ) : null,
      h('div', { style: { height: 10 } }),
      value['mode'] === 'custom'
        ? Field({ label: '完整 DSH 定时指令（每次触发将直接作为用户消息发给目标会话）' },
          h('textarea', {
            value: String(value['dsh_prompt'] ?? ''),
            style: { minHeight: 160 },
            onChange: (e: Rec) => set({ dsh_prompt: (e.target as HTMLTextAreaElement).value }),
          }))
        : h('div', null,
          h('div', { className: 'nai-row', style: { flexWrap: 'wrap', gap: 8, marginBottom: 8 } },
            Field({ label: '模型' }, Select({
              value: String(value['model'] ?? 'nai-diffusion-5-full'),
              onChange: (v: string) => set({ model: v }),
              options: [
                { value: 'nai-diffusion-5-full', label: 'V5 Full' },
                { value: 'nai-diffusion-5-curated', label: 'V5 Curated' },
                { value: 'nai-diffusion-4-5-full', label: 'V4.5 Full' },
                { value: 'nai-diffusion-4-5-curated', label: 'V4.5 Curated' },
              ],
            })),
            value['model'] === 'nai-diffusion-5-full' ? Field({ label: 'V5 档位' }, Select({
              value: String(value['v5_tier'] ?? 'high'),
              onChange: (v: string) => set({ v5_tier: v }),
              options: [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium（省 42% 额度）' }],
            })) : null,
            Field({ label: '每次张数' }, Num({ value: value['count'] ?? 1, onChange: (v) => set({ count: v ?? 1 }), min: 1, max: 20, style: { width: 70 } })),
            Field({ label: '分类子目录' }, h('input', { value: String(value['output_subdir'] ?? ''), placeholder: '留空不分类', onChange: (e: Rec) => set({ output_subdir: (e.target as HTMLInputElement).value }) })),
            endpoints.length > 1 ? Field({ label: '指定接口（可选）' }, Select({
              value: String(value['endpoint'] ?? ''),
              onChange: (v: string) => set({ endpoint: v }),
              options: [{ value: '', label: '使用默认接口' }, ...endpoints.map((ep) => ({ value: String(ep['id']), label: String(ep['name']) }))],
            })) : null,
          ),
          Card({ title: '绑定资料库条目（触发时自动读取最新设定）' },
            h('div', { className: 'nai-row', style: { marginBottom: 6, gap: 6, flexWrap: 'wrap' } },
              Button({ small: true, onClick: () => { setLibKind('character'); setLibOpen(true) } }, '＋ 角色'),
              Button({ small: true, onClick: () => { setLibKind('branch'); setLibOpen(true) } }, '＋ 分支'),
              Button({ small: true, onClick: () => { setLibKind('artist'); setLibOpen(true) } }, '＋ 画师'),
              Button({ small: true, onClick: () => { setLibKind('blend'); setLibOpen(true) } }, '＋ 混合'),
              Button({ small: true, onClick: () => { setLibKind('preset'); setLibOpen(true) } }, '＋ 预设'),
            ),
            selectedRefs.length ? h('div', { className: 'nai-tags' }, selectedRefs.map((refId) => {
              const item = libRows.find((r2) => r2['id'] === refId)
              return h('span', { className: 'nai-tag', key: refId },
                `${item ? String(item['name']) : refId} `,
                Button({ small: true, icon: 'close', kind: 'ghost', onClick: () => set({ library_refs: selectedRefs.filter((x) => x !== refId) }) }, '移除'),
              )
            })) : h('div', { style: { color: 'var(--nai-faint)', fontSize: 11 } }, '未绑定资料库条目。'),
          ),
          h('div', { style: { height: 8 } }),
          value['mode'] === 'ai'
            ? h('div', { className: 'nai-grid' },
              Field({ label: '创作要求（每次触发由 DSH 当前模型构思提示词）' }, h('textarea', {
                value: String(value['instruction'] ?? ''), style: { minHeight: 70 },
                placeholder: '例如：画一张该角色在雨夜咖啡馆窗边看书的氛围插画',
                onChange: (e: Rec) => set({ instruction: (e.target as HTMLTextAreaElement).value }),
              })),
              Field({ label: '每次随机变化的方面（可选）' }, h('input', {
                value: String(value['randomize'] ?? ''), placeholder: '例如：天气、时间段、服装配色、镜头景别',
                onChange: (e: Rec) => set({ randomize: (e.target as HTMLInputElement).value }),
              })),
              h('div', { className: 'nai-grid', style: { gridTemplateColumns: '1fr 1fr' } },
                Field({ label: '固定正面片段（可选）' }, h('textarea', { value: String(value['fixed_prompt'] ?? ''), style: { minHeight: 44 }, onChange: (e: Rec) => set({ fixed_prompt: (e.target as HTMLTextAreaElement).value }) })),
                Field({ label: '固定负面片段（可选）' }, h('textarea', { value: String(value['fixed_negative_prompt'] ?? ''), style: { minHeight: 44 }, onChange: (e: Rec) => set({ fixed_negative_prompt: (e.target as HTMLTextAreaElement).value }) })),
              ),
            )
            : h('div', { className: 'nai-grid' },
              Field({ label: '固定正面提示词' }, h('textarea', { value: String(value['fixed_prompt'] ?? ''), style: { minHeight: 70 }, onChange: (e: Rec) => set({ fixed_prompt: (e.target as HTMLTextAreaElement).value }) })),
              Field({ label: '固定负面提示词（可选）' }, h('textarea', { value: String(value['fixed_negative_prompt'] ?? ''), style: { minHeight: 44 }, onChange: (e: Rec) => set({ fixed_negative_prompt: (e.target as HTMLTextAreaElement).value }) })),
            ),
        ),
      libOpen ? h(Modal, {
        title: '选择资料库条目', onClose: () => setLibOpen(false), wide: true,
        footer: Button({ onClick: () => setLibOpen(false) }, '关闭'),
      },
        h('div', { className: 'nai-row', style: { marginBottom: 10 } },
          Select({
            value: libKind, onChange: setLibKind,
            options: [{ value: '', label: '全部' }, { value: 'character', label: '角色' }, { value: 'branch', label: '角色分支' }, { value: 'artist', label: '画师' }, { value: 'blend', label: '混合' }, { value: 'preset', label: '预设' }],
          }),
        ),
        h('div', { className: 'nai-list' }, libRows.filter((row) => !libKind || row['kind'] === libKind).map((row) => h('div', {
          className: 'item', key: String(row['id']), role: 'button', tabIndex: 0,
          onKeyDown: keyboardActivate(() => {
            if (!selectedRefs.includes(String(row['id']))) set({ library_refs: [...selectedRefs, String(row['id'])] })
            setLibOpen(false)
          }),
          onClick: () => {
            if (!selectedRefs.includes(String(row['id']))) set({ library_refs: [...selectedRefs, String(row['id'])] })
            setLibOpen(false)
          },
        },
          h('div', { className: 'grow' },
            h('strong', null, row['kind'] === 'branch' && row['parent_name'] ? `${String(row['parent_name'])} · ${String(row['name'])}` : String(row['name'])),
            h('span', { className: 'nai-tag', style: { marginLeft: 6 } }, String(row['kind'])),
            h('div', { className: 'sub' }, String((row['data'] as Rec)?.['prompt'] ?? '').slice(0, 80)),
          ),
          Button({ small: true, kind: 'primary' }, '选用'),
        ))),
      ) : null,
    ),
  )
}
