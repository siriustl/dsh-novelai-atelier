/** Scheduled creation: fixed / AI-recipe plans with runs history. */
import type { WorkbenchState } from '../shell.tsx'
import { R, h, Button, Card, Field, Modal, ErrorBox, Empty, Select, Toggle, Num, keyboardActivate } from '../ui.tsx'
import { api, assetThumb, type Rec } from '../api.ts'

const EMPTY_PLAN = (): Rec => ({
  name: '定时生成', enabled: false, kind: 'daily', timezone: 'Asia/Shanghai', time: '09:00', at: '',
  interval_minutes: 60, operation: 'generate', count: 1, max_runs: 10, max_total_anlas: 0,
  missed_policy: 'skip', execution_mode: 'ai', seed_mode: 'random',
  request: { model: 'nai-diffusion-5-full', prompt: '', max_anlas: 0 },
  ai_recipe: { instruction: '', randomize: '', fixed_prompt: '', fixed_negative_prompt: '', library_refs: [], locked_fields: [] },
})

export function addScheduleLibraryReference(plan: Rec, entry: Rec): Rec {
  const recipe = (plan['ai_recipe'] ?? {}) as Rec
  const refs = (recipe['library_refs'] ?? []) as string[]
  const id = String(entry['id'])
  if (refs.includes(id)) return plan
  const next: Rec = { ...plan, ai_recipe: { ...recipe, library_refs: [...refs, id] } }
  if (plan['execution_mode'] === 'fixed') {
    const request = (plan['request'] ?? {}) as Rec
    const prompt = String((entry['data'] as Rec)?.['prompt'] ?? '')
    const negative = String((entry['data'] as Rec)?.['negative_prompt'] ?? '')
    if (['character', 'branch'].includes(String(entry['kind']))) {
      next['request'] = { ...request, characters: [...((request['characters'] ?? []) as Rec[]), { prompt, negative_prompt: negative }] }
    } else {
      next['request'] = {
        ...request, prompt: [request['prompt'], prompt].filter(Boolean).join(', '),
        negative_prompt: [request['negative_prompt'], negative].filter(Boolean).join(', '),
      }
    }
  }
  return next
}

export function removeScheduleLibraryReference(plan: Rec, id: string): Rec {
  const recipe = (plan['ai_recipe'] ?? {}) as Rec
  return { ...plan, ai_recipe: { ...recipe, library_refs: ((recipe['library_refs'] ?? []) as string[]).filter((ref) => ref !== id) } }
}

export function SchedulesPanel({ state }: { state: WorkbenchState }): Rec {
  const r = R()
  const [rows, setRows] = r.useState<Rec[]>([])
  const [editing, setEditing] = r.useState<Rec | null>(null)
  const [runsFor, setRunsFor] = r.useState<Rec | null>(null)
  const [runs, setRuns] = r.useState<Rec[]>([])
  const [error, setError] = r.useState<string | null>(null)
  const loadVersion = r.useRef(0)
  const runsVersion = r.useRef(0)

  const [nowSec, setNowSec] = r.useState(Date.now())
  const [recentGallery, setRecentGallery] = r.useState<Rec[]>([])

  const loadRecentGallery = async (): Promise<void> => {
    try {
      const res = await api<Rec>('/gallery?limit=40&status=completed')
      setRecentGallery((res['items'] ?? []) as Rec[])
    } catch {}
  }

  const load = async (): Promise<void> => {
    const version = ++loadVersion.current
    try {
      const rows = await api<Rec[]>('/schedules')
      if (version !== loadVersion.current) return
      setRows(rows)
      setError(null)
      void loadRecentGallery()
    } catch (e) { if (version === loadVersion.current) setError((e as Error).message) }
  }
  R().useEffect(() => {
    void load()
    return () => { loadVersion.current++; runsVersion.current++ }
  }, [])
  R().useEffect(() => {
    const t = setInterval(() => { void load() }, 10000)
    return () => clearInterval(t)
  }, [])
  R().useEffect(() => {
    const t = setInterval(() => setNowSec(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const remove = async (schedule: Rec): Promise<void> => {
    if (!confirm(`删除计划「${String(schedule['name'])}」？`)) return
    try {
      await api(`/schedules/${encodeURIComponent(String(schedule['id']))}?revision=${String(schedule['revision'])}`, 'DELETE')
      await load()
    } catch (e) { setError((e as Error).message) }
  }
  const toggle = async (schedule: Rec): Promise<void> => {
    try {
      await api(`/schedules/${String(schedule['id'])}`, 'PUT', { ...schedule, enabled: !schedule['enabled'], expected_revision: schedule['revision'] })
      await load()
    } catch (e) { setError((e as Error).message) }
  }
  const runOnce = async (schedule: Rec): Promise<void> => {
    try {
      await api(`/schedules/${String(schedule['id'])}/once`, 'POST', { revision: schedule['revision'] })
      await load()
    } catch (e) { setError((e as Error).message) }
  }
  const copyPlan = async (schedule: Rec): Promise<void> => {
    try {
      await api(`/schedules/${String(schedule['id'])}/copy`, 'POST', {})
      await load()
    } catch (e) { setError((e as Error).message) }
  }
  const closeRuns = (): void => { runsVersion.current++; setRunsFor(null); setRuns([]) }
  const openRuns = async (schedule: Rec): Promise<void> => {
    const version = ++runsVersion.current
    setRunsFor(schedule)
    setRuns([]); setError(null)
    try {
      const rows = await api<Rec[]>(`/schedules/${encodeURIComponent(String(schedule['id']))}/runs`)
      if (version === runsVersion.current) setRuns(rows)
    } catch (e) { if (version === runsVersion.current) setError((e as Error).message) }
  }

  return Card({ title: '定时任务' },
    ErrorBox({ error }),
    h('div', { className: 'nai-row', style: { marginBottom: 10 } },
      Button({ onClick: () => setEditing(EMPTY_PLAN()) }, '＋ 新建计划'),
      h('span', { style: { flex: 1 } }),
      state.paused ? h('span', { className: 'nai-pill bad' }, '队列已暂停，计划不会执行') : null,
    ),
    !rows.length ? Empty({ text: '暂无定时计划。可按每天/间隔定时，用 AI 每次重新构思提示词，或复用固定参数。' }) : null,
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, rows.map((schedule) => {
      const id = String(schedule['id'])
      const latestJob = recentGallery.find((j) => j['schedule_id'] === id)
      const firstAsset = latestJob ? ((latestJob['assets'] ?? []) as Rec[]).find((a) => String(a['mime'] ?? '').startsWith('image/')) : null
      return h('div', {
        className: 'nai-sched-card', key: id, role: 'group', tabIndex: 0,
        'aria-label': String(schedule['name']), onKeyDown: keyboardActivate(() => setEditing(structuredClone(schedule))),
        onClick: () => setEditing(structuredClone(schedule)),
      },
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('strong', { style: { fontSize: 14 } }, String(schedule['name'])),
            schedule['enabled']
              ? h('span', { className: 'nai-pill ok', style: { fontSize: 10, padding: '1px 7px' } }, '● 启用中')
              : h('span', { className: 'nai-pill', style: { fontSize: 10, padding: '1px 7px' } }, '○ 已停用'),
            h('span', { className: 'nai-pill', style: { fontSize: 10, padding: '1px 7px' } },
              schedule['execution_mode'] === 'ai' ? '🤖 AI 构思' : '📌 固定请求'),
            formatCountdown(schedule, nowSec),
          ),
          h('div', { style: { fontSize: 12, color: 'var(--nai-dim)' } },
            describeTiming(schedule),
            ` · 每次 ${String(schedule['count'])} 张 · 进度 ${String(schedule['runs'])}/${String(schedule['max_runs'])} 轮`
          ),
          h('div', { className: 'nai-row', style: { marginTop: 6, gap: 6 } },
            Button({
              small: true, kind: schedule['enabled'] ? 'ghost' : 'primary',
              onClick: (e: Rec) => { e.stopPropagation(); void toggle(schedule) },
              title: schedule['enabled'] ? '暂停此计划' : '启动此计划',
            }, schedule['enabled'] ? '⏸ 暂停' : '▶ 启用'),
            Button({
              small: true,
              onClick: (e: Rec) => { e.stopPropagation(); void runOnce(schedule) },
              title: '立即触发一次此任务（加入队列）',
            }, '⏱ 立即执行一次'),
            Button({
              small: true, kind: 'ghost',
              onClick: (e: Rec) => { e.stopPropagation(); void copyPlan(schedule) },
              title: '复制生成新计划',
            }, '⧉ 复制'),
            Button({
              small: true, kind: 'ghost',
              onClick: (e: Rec) => { e.stopPropagation(); void openRuns(schedule) },
              title: '查看运行日志',
            }, '☰ 执行记录'),
            Button({
              small: true, kind: 'ghost',
              onClick: (e: Rec) => { e.stopPropagation(); setEditing(structuredClone(schedule)) },
              title: '编辑任务配置',
            }, '✎ 编辑'),
            h('button', {
              type: 'button', className: 'nai-icon-btn', 'aria-label': '删除定时计划',
              onClick: (e: Rec) => { e.stopPropagation(); void remove(schedule) },
              title: '删除任务',
              style: { cursor: 'pointer', color: 'var(--nai-danger)', marginLeft: 6, padding: '2px 6px' },
            }, '✕'),
          ),
        ),
        firstAsset ? h('div', {
          className: 'nai-sched-thumb',
          title: '最新生成的作品，点击前往画廊查看',
          onClick: (e: Rec) => { e.stopPropagation(); state.go('gallery') },
        },
          h('img', { alt: '最新生成作品', src: assetThumb(String(firstAsset['id'])), loading: 'lazy' }),
        ) : null,
      )
    })),
    editing ? h(PlanEditor, { plan: editing, onClose: () => setEditing(null), onSaved: () => { setEditing(null); void load() }, fail: (e: unknown) => setError((e as Error).message), guardNavigation: state.guardNavigation }) : null,
    runsFor ? h(Modal, {
      title: `执行记录 · ${String(runsFor['name'])}`, onClose: closeRuns, wide: true,
      footer: Button({ onClick: closeRuns }, '关闭'),
    }, runs.length ? h('div', { className: 'nai-list' }, runs.map((run, i) =>
      h('div', { className: 'item', key: i },
        h('div', { className: 'grow' },
          h('div', null, new Date(String(run['scheduled_for'])).toLocaleString('zh-CN'), ' ', h('span', { className: 'nai-tag' }, OUTCOME_LABELS[String(run['outcome'])] ?? String(run['outcome']))),
          run['busy_reason'] ? h('div', { className: 'sub', style: { color: 'var(--nai-accent)' } }, '忙碌原因：' + String(run['busy_reason'])) : null,
          run['error'] ? h('div', { className: 'sub', style: { color: 'var(--nai-danger)' } }, String(run['error'])) : null,
          (run['ai_reply'] ? h('div', { className: 'sub' }, String(run['ai_reply']).slice(0, 140)) : null),
        )))) : Empty({ text: '暂无执行记录' })) : null,
  )
}

const OUTCOME_LABELS: Rec = {
  queued: '排队生图',
  waiting_ai: '等待 AI 构思',
  planning: 'AI 构思中',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  skipped: '超时跳过',
  skipped_busy: '跳过（忙碌）',
  budget_or_run_limit: '执行次数已达上限',
}

function formatCountdown(schedule: Rec, now: number): Rec {
  if (!schedule['enabled']) return h('span', { className: 'nai-pill', style: { fontSize: 10, padding: '1px 6px' } }, '⏸ 已停用')
  const next = schedule['next_run'] ? new Date(String(schedule['next_run'])).getTime() : null
  if (!next) return h('span', { className: 'nai-pill', style: { fontSize: 10, padding: '1px 6px' } }, '已达轮数上限')
  const diffSec = Math.floor((next - now) / 1000)
  if (diffSec <= 0) return h('span', { className: 'nai-countdown', style: { color: 'var(--nai-ok)', borderColor: 'var(--nai-ok)' } }, '⏳ 触发队列中')
  if (diffSec < 60) return h('span', { className: 'nai-countdown' }, `⏳ ${diffSec}秒后执行`)
  if (diffSec < 3600) {
    const m = Math.floor(diffSec / 60)
    const s = diffSec % 60
    return h('span', { className: 'nai-countdown' }, `⏳ ${m}分${s}秒后执行`)
  }
  const hVal = Math.floor(diffSec / 3600)
  const mVal = Math.floor((diffSec % 3600) / 60)
  return h('span', { className: 'nai-countdown' }, `⏳ ${hVal}小时${mVal}分后执行`)
}

function describeTiming(schedule: Rec): string {
  const kind = String(schedule['kind'])
  if (kind === 'once') return `单次 ${schedule['at'] ? new Date(String(schedule['at'])).toLocaleString('zh-CN') : ''}`
  if (kind === 'daily') return `每天 ${String(schedule['time'])}（${String(schedule['timezone'])}）`
  return `每 ${String(schedule['interval_minutes'])} 分钟`
}

function PlanEditor({ plan, onClose, onSaved, fail, guardNavigation }: { plan: Rec; onClose: () => void; onSaved: () => void; fail: (e: unknown) => void; guardNavigation?: WorkbenchState['guardNavigation'] }): Rec {
  const r = R()
  const [value, setValue] = r.useState<Rec>(structuredClone(plan))
  const [error, setError] = r.useState<string | null>(null)
  const [preview, setPreview] = r.useState<Rec | null>(null)
  const [busy, setBusy] = r.useState(false)
  const [libOpen, setLibOpen] = r.useState(false)
  const [libRows, setLibRows] = r.useState<Rec[]>([])
  const [libKind, setLibKind] = r.useState('')
  const [saving, setSaving] = r.useState(false)
  const savePending = r.useRef(false)
  const baseline = r.useRef(JSON.stringify(plan))
  const canLeave = (): boolean => !savePending.current && !referencePending.current && (JSON.stringify(latestValue.current) === baseline.current || confirm('计划编辑尚未保存，放弃本次编辑？'))
  const close = (): void => { if (canLeave()) onClose() }
  r.useEffect(() => guardNavigation?.(async () => canLeave()), [guardNavigation])
  const set = (patch: Rec): void => { if (!savePending.current) setValue({ ...value, ...patch }) }
  const request = value['request'] as Rec
  const recipe = (value['ai_recipe'] ?? {}) as Rec

  r.useEffect(() => {
    void api<Rec[]>('/library').then(setLibRows).catch(() => {})
  }, [])

  const save = async (): Promise<void> => {
    if (referencePending.current || savePending.current) return
    savePending.current = true
    setSaving(true); setBusy(true); setError(null)
    try {
      if (value['id']) await api(`/schedules/${encodeURIComponent(String(value['id']))}`, 'PUT', { ...value, expected_revision: value['revision'] })
      else await api('/schedules', 'POST', value)
      onSaved()
    } catch (e) { setError((e as Error).message) }
    finally { savePending.current = false; setSaving(false); setBusy(false) }
  }
  const doPreview = async (): Promise<void> => {
    setBusy(true); setError(null); setPreview(null)
    try { setPreview(await api<Rec>('/schedules/preview', 'POST', value)) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const latestValue = r.useRef(value)
  latestValue.current = value
  const editorAlive = r.useRef(true)
  const referencePending = r.useRef(false)
  const [referenceBusy, setReferenceBusy] = r.useState(false)
  r.useEffect(() => { editorAlive.current = true; return () => { editorAlive.current = false } }, [])
  const addLibraryRef = async (entry: Rec): Promise<void> => {
    if (referencePending.current || savePending.current) return
    referencePending.current = true
    setReferenceBusy(true)
    const mode = latestValue.current['execution_mode']
    try {
      let resolved = entry
      if (mode === 'fixed') {
        const preview = await api<Rec>('/library/preview', 'POST', { entry_id: entry['id'] })
        resolved = { ...entry, data: { ...entry['data'], prompt: preview['prompt'], negative_prompt: preview['negative_prompt'] } }
      }
      if (!editorAlive.current || mode !== latestValue.current['execution_mode']) return
      setValue((current) => addScheduleLibraryReference(current, resolved))
      setLibOpen(false)
    } catch (e) { if (editorAlive.current) setError((e as Error).message) }
    finally { referencePending.current = false; if (editorAlive.current) setReferenceBusy(false) }
  }
  const removeLibraryRef = (id: string): void => {
    if (!savePending.current) setValue((current) => removeScheduleLibraryReference(current, id))
  }

  const selectedRefs = (recipe['library_refs'] ?? []) as string[]

  return h(Modal, {
    title: value['id'] ? `编辑计划 · ${String(value['name'])}` : '新建计划', onClose: close, wide: true,
    footer: h('div', { className: 'modal-actions' },
      ErrorBox({ error }),
      Button({ onClick: () => void doPreview(), disabled: busy || referenceBusy }, '预览 AI 构思'),
      Button({ onClick: close, disabled: saving }, '取消'),
      Button({ kind: 'primary', onClick: () => void save(), disabled: busy || referenceBusy }, '保存')),
  },
    h('fieldset', { disabled: saving, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } },
    h('div', { className: 'nai-row' },
      h(Field, { label: '名称' }, h('input', { value: String(value['name'] ?? ''), onChange: (e: Rec) => set({ name: (e.target as HTMLInputElement).value }) })),
      h(Field, { label: '执行模式' }, Select({
        value: String(value['execution_mode']), onChange: (v: string) => set({ execution_mode: v }),
        options: [{ value: 'ai', label: '每次 AI 构思' }, { value: 'fixed', label: '固定请求' }],
      })),
      h(Field, { label: '种子模式' }, Select({
        value: String(value['seed_mode'] ?? 'random'), onChange: (v: string) => set({ seed_mode: v }),
        options: [{ value: 'random', label: '随机' }, { value: 'increment', label: '递增' }, { value: 'fixed', label: '固定' }],
      })),
      h(Toggle, { checked: Boolean(value['enabled']), onChange: (v: boolean) => set({ enabled: v }), label: '启用' }),
    ),
    h('div', { style: { height: 8 } }),
    h('div', { className: 'nai-row' },
      h(Field, { label: '节奏' }, Select({
        value: String(value['kind']), onChange: (v: string) => set({ kind: v }),
        options: [{ value: 'daily', label: '每天' }, { value: 'interval', label: '间隔' }, { value: 'once', label: '单次' }],
      })),
      value['kind'] === 'daily' ? h(Field, { label: '时间 (HH:MM)' }, h('input', { value: String(value['time'] ?? ''), placeholder: '09:00', onChange: (e: Rec) => set({ time: (e.target as HTMLInputElement).value }) })) : null,
      value['kind'] === 'interval' ? h(Field, { label: '间隔（分钟）' }, Num({ value: value['interval_minutes'] ?? 60, onChange: (v) => set({ interval_minutes: v ?? 60 }), min: 1 })) : null,
      value['kind'] === 'once' ? h(Field, { label: '时间（本地时间，YYYY-MM-DD HH:MM）' }, h('input', { value: String(value['at'] ?? ''), placeholder: '2026-01-01 09:00', onChange: (e: Rec) => set({ at: (e.target as HTMLInputElement).value }) })) : null,
      h(Field, { label: '时区' }, h('input', { value: String(value['timezone'] ?? 'Asia/Shanghai'), onChange: (e: Rec) => set({ timezone: (e.target as HTMLInputElement).value }) })),
      h(Field, { label: '错过策略' }, Select({
        value: String(value['missed_policy']), onChange: (v: string) => set({ missed_policy: v }),
        options: [{ value: 'skip', label: '跳过错过的轮次' }, { value: 'once', label: '补跑一次' }],
      })),
    ),
    h('div', { style: { height: 8 } }),
    h('div', { className: 'nai-row' },
      h(Field, { label: '每次数量（1-50）' }, Num({ value: value['count'] ?? 1, onChange: (v) => set({ count: v ?? 1 }), min: 1, max: 50, style: { width: 76 } })),
      h(Field, { label: '最多执行次数' }, Num({ value: value['max_runs'] ?? 10, onChange: (v) => set({ max_runs: v ?? 10 }), min: 1, style: { width: 90 } })),
    ),
    h('div', { style: { height: 8 } }),
    Card({ title: '角色与画风引用（从资料库）' },
      h('div', { className: 'nai-row', style: { marginBottom: 6 } },
        Button({ small: true, onClick: () => { setLibKind('character'); setLibOpen(true) } }, '＋ 添加角色'),
        Button({ small: true, onClick: () => { setLibKind('artist'); setLibOpen(true) } }, '＋ 添加画师/画风'),
        Button({ small: true, onClick: () => { setLibKind('blend'); setLibOpen(true) } }, '＋ 添加画师混合'),
        h('span', { style: { flex: 1 } }),
      ),
      selectedRefs.length ? h('div', { className: 'nai-tags' }, selectedRefs.map((refId) => {
        const item = libRows.find((r2) => r2['id'] === refId)
        return h('span', { className: 'nai-tag', key: refId },
          `${item ? String(item['name']) : refId} (${item ? String(item['kind']) : '资料'}) `,
          Button({
            small: true, icon: 'close', kind: 'ghost',
            title: value['execution_mode'] === 'ai' ? '移除此资料绑定；手写固定片段保持不变' : '仅移除来源标签；已应用的固定提示词和角色保持不变',
            onClick: () => removeLibraryRef(refId),
          }, value['execution_mode'] === 'ai' ? '移除绑定' : '移除来源标签'),
        )
      })) : h('div', { className: 'hint', style: { color: 'var(--nai-faint)', fontSize: 11 } }, '未引用资料库条目。点击上方按钮可直接将角色身份特征或画师风格绑定到此定时任务中。'),
    ),
    h('div', { style: { height: 8 } }),
    value['execution_mode'] === 'ai'
      ? Card({ title: 'AI 构思要求' },
          h('div', { className: 'nai-grid' },
            Field({ label: '创作要求（每次唤醒 AI 重新编写）' }, h('textarea', {
              value: String(recipe['instruction'] ?? ''), style: { minHeight: 70 },
              onChange: (e: Rec) => set({ ai_recipe: { ...recipe, instruction: (e.target as HTMLTextAreaElement).value } }),
            })),
            h('div', { className: 'nai-grid', style: { gridTemplateColumns: '1fr 1fr' } },
              Field({ label: '固定正面片段（必须出现在结果中）' }, h('textarea', {
                value: String(recipe['fixed_prompt'] ?? ''), style: { minHeight: 44 },
                onChange: (e: Rec) => set({ ai_recipe: { ...recipe, fixed_prompt: (e.target as HTMLTextAreaElement).value } }),
              })),
              Field({ label: '固定负面片段' }, h('textarea', {
                value: String(recipe['fixed_negative_prompt'] ?? ''), style: { minHeight: 44 },
                onChange: (e: Rec) => set({ ai_recipe: { ...recipe, fixed_negative_prompt: (e.target as HTMLTextAreaElement).value } }),
              }))),
            Field({ label: '需要变化的方面（描述哪些内容每次随机）' }, h('textarea', {
              value: String(recipe['randomize'] ?? ''), style: { minHeight: 44 },
              onChange: (e: Rec) => set({ ai_recipe: { ...recipe, randomize: (e.target as HTMLTextAreaElement).value } }),
            })),
            Field({ label: '锁定字段（逗号分隔，如 request.prompt, request.model）' }, h('input', {
              value: ((recipe['locked_fields'] ?? []) as string[]).join(', '),
              onChange: (e: Rec) => set({ ai_recipe: { ...recipe, locked_fields: (e.target as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean) } }),
            }))),
          h('p', { className: 'hint', style: { color: 'var(--nai-faint)', fontSize: 11 } },
            '固定请求计划请使用固定草稿内容：切换为「固定请求」模式后直接编辑下方提示词。'))
      : Field({ label: '固定提示词' }, h('textarea', {
          value: String(request['prompt'] ?? ''), style: { minHeight: 70 },
          onChange: (e: Rec) => set({ request: { ...request, prompt: (e.target as HTMLTextAreaElement).value } }),
        })),
    preview ? h('div', { className: 'nai-proposal' },
      h('strong', null, 'AI 构思预览'),
      h('div', { style: { marginTop: 4, whiteSpace: 'pre-wrap' } }, String(preview['ai_reply'] ?? '')),
      preview['request'] ? h('div', { className: 'sub', style: { color: 'var(--nai-faint)', marginTop: 6, fontSize: 11 } },
        '提示词：' + String((preview['request'] as Rec)['prompt'] ?? '').slice(0, 300)) : null) : null,
    libOpen ? h(Modal, {
      title: '从资料库选择角色 / 画风', onClose: () => setLibOpen(false), wide: true,
      footer: Button({ onClick: () => setLibOpen(false) }, '关闭'),
    },
      h('div', { className: 'nai-row', style: { marginBottom: 10 } },
        Select({
          value: libKind, onChange: setLibKind,
          options: [{ value: '', label: '全部' }, { value: 'character', label: '角色' }, { value: 'artist', label: '画师' }, { value: 'blend', label: '混合' }, { value: 'preset', label: '预设' }],
        }),
      ),
      h('div', { className: 'nai-list' }, libRows.filter((r3) => !libKind || r3['kind'] === libKind).map((r3) => h('div', {
        className: 'item', key: String(r3['id']), role: 'button', tabIndex: 0,
        onKeyDown: keyboardActivate(() => void addLibraryRef(r3)),
        onClick: () => void addLibraryRef(r3),
      },
        h('div', { className: 'grow' },
          h('strong', null, String(r3['name'])),
          h('span', { className: 'nai-tag', style: { marginLeft: 6 } }, String(r3['kind'])),
          h('div', { className: 'sub' }, String((r3['data'] as Rec)?.['prompt'] ?? '').slice(0, 80)),
        ),
        Button({ small: true, kind: 'primary' }, '选用'),
      ))),
    ) : null),
  )
}
