/** Shared polling, navigation and account state for the embedded workbench. */
import { R, Button, h, ErrorBox, Spinner, Modal } from './ui.tsx'
import { api, type Rec } from './api.ts'
import { Icon, type IconName } from './icons.tsx'
import { dateTimeLabel } from './format.ts'
import { WorkspacePanel } from './panels/workspace.tsx'
import { GalleryPanel } from './panels/gallery.tsx'
import { LibraryPanel } from './panels/library.tsx'
import { DraftsPanel } from './panels/drafts.tsx'
import { SchedulesPanel } from './panels/schedules.tsx'
import { SettingsPanel } from './panels/settings.tsx'

export interface WorkbenchState {
  bootstrap: Rec | null
  draft: Rec | null
  settings: Rec | null
  assets: Rec[]
  paused: boolean
  error: string | null
  refresh: () => Promise<void>
  patchDraft: (patch: Rec, baseRevision: number) => Promise<Rec>
  fail: (e: unknown) => void
  go: (page: string, jobId?: string) => void
  clearError?: () => void
  focusJobId?: string | null
  guardNavigation?: (guard: () => Promise<boolean>) => () => void
  librarySeed?: Rec | null
  clearLibrarySeed?: () => void
  saveToLibrary?: (entry: Rec) => void
}

const PAGES: Array<[string, IconName, string]> = [
  ['create', 'brush', '创作'], ['gallery', 'image', '画廊'], ['library', 'library', '资料库'],
  ['drafts', 'files', '草稿'], ['schedules', 'calendar', '定时任务'], ['settings', 'settings', '设置'],
]

export function reconcileBootstrap(current: Rec | null, incoming: Rec): Rec {
  const next = current && current['draft']?.['id'] === incoming['draft']?.['id'] && Number(current['draft']?.['revision']) > Number(incoming['draft']?.['revision']) ? { ...incoming, draft: current['draft'] } : incoming
  return current && JSON.stringify(current) === JSON.stringify(next) ? current : next
}

export function Shell(): Rec {
  const r = R()
  const [boot, setBoot] = r.useState<Rec | null>(null)
  const [page, setPage] = r.useState('create')
  const [librarySeed, setLibrarySeed] = r.useState<Rec | null>(null)
  const [focusJobId, setFocusJobId] = r.useState<string | null>(null)
  const [error, setError] = r.useState<string | null>(null)
  const [connectionError, setConnectionError] = r.useState<string | null>(null)
  const [paused, setPaused] = r.useState(false)
  const [pausing, setPausing] = r.useState(false)
  const [credits, setCredits] = r.useState<Rec | null>(null)
  const [creditsError, setCreditsError] = r.useState<string | null>(null)
  const [creditsOpen, setCreditsOpen] = r.useState(false)
  const [creditsBusy, setCreditsBusy] = r.useState(false)
  const generation = r.useRef(0)
  const activeRefresh = r.useRef(0)
  const creditPending = r.useRef(false)
  const alive = r.useRef(true)
  const controllers = r.useRef(new Set<AbortController>())
  const navigationGuard = r.useRef<(() => Promise<boolean>) | null>(null)
  const tokenConfigured = Boolean(boot?.['settings']?.['token_configured'])
  const tokenReady = r.useRef(tokenConfigured)
  tokenReady.current = tokenConfigured
  const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden'

  const refresh = r.useCallback(async (): Promise<void> => {
    const version = ++generation.current
    const controller = new AbortController()
    controllers.current.add(controller)
    activeRefresh.current++
    try {
      const state = await api<Rec>('/bootstrap?compact=true', 'GET', undefined, undefined, controller.signal)
      if (!alive.current || version !== generation.current) return
      setBoot((current) => reconcileBootstrap(current, state))
      setPaused(Boolean(state['paused']))
      setConnectionError(null)
    } catch (e) { if (alive.current && !controller.signal.aborted && version === generation.current) setConnectionError((e as Error).message) }
    finally { controllers.current.delete(controller); activeRefresh.current-- }
  }, [])

  const loadCredits = r.useCallback(async (): Promise<void> => {
    if (!tokenReady.current || creditPending.current) return
    const controller = new AbortController()
    controllers.current.add(controller)
    creditPending.current = true
    setCreditsBusy(true)
    try {
      const value = await api<Rec>('/credits', 'GET', undefined, undefined, controller.signal)
      if (alive.current) { setCredits(value); setCreditsError(null) }
    } catch (e) { if (alive.current && !controller.signal.aborted) setCreditsError((e as Error).message) }
    finally { controllers.current.delete(controller); creditPending.current = false; if (alive.current) setCreditsBusy(false) }
  }, [])

  r.useEffect(() => {
    alive.current = true
    void refresh()
    const timer = setInterval(() => { if (visible() && activeRefresh.current === 0) void refresh() }, 5000)
    return () => { alive.current = false; clearInterval(timer); for (const controller of controllers.current) controller.abort() }
  }, [refresh])
  r.useEffect(() => { setCredits(null); setCreditsError(null) }, [tokenConfigured])

  const fail = (e: unknown): void => setError(e instanceof Error ? e.message : String(e))
  const patchDraft = async (patch: Rec, baseRevision: number): Promise<Rec> => {
    const draft = await api<Rec>('/draft', 'PATCH', { ...patch, base_revision: baseRevision })
    generation.current++
    if (alive.current) setBoot((current) => current && current['draft']?.['id'] === draft['id'] && Number(draft['revision']) >= Number(current['draft']?.['revision']) && JSON.stringify(current['draft']) !== JSON.stringify(draft) ? { ...current, draft } : current)
    return draft
  }
  const go = (next: string, jobId?: string): void => {
    if (!PAGES.some(([id]) => id === next)) return
    void (async () => {
      if (next !== page && navigationGuard.current && !await navigationGuard.current()) { setError('当前编辑尚未保存或操作未完成，请先处理当前页面'); return }
      setFocusJobId(jobId ?? null)
      setPage(next)
    })().catch(fail)
  }
  const saveToLibrary = (entry: Rec): void => {
    void (async () => {
      if (navigationGuard.current && !await navigationGuard.current()) return
      setLibrarySeed(structuredClone(entry))
      setPage('library')
    })().catch(fail)
  }
  const guardNavigation = (guard: () => Promise<boolean>): (() => void) => {
    navigationGuard.current = guard
    return () => { if (navigationGuard.current === guard) navigationGuard.current = null }
  }
  const togglePause = async (): Promise<void> => {
    if (pausing) return
    setPausing(true)
    try {
      const result = await api<Rec>('/jobs/pause', 'POST', { paused: !paused })
      setPaused(Boolean(result['paused']))
      setError(null)
      void refresh()
    } catch (e) { fail(e) } finally { setPausing(false) }
  }

  if (!boot) return h('div', { className: 'nai-root' }, h('div', { className: 'nai-empty' },
    ErrorBox({ error: connectionError }), connectionError ? Button({ icon: 'refresh', onClick: () => void refresh() }, '重新连接') : [h(Spinner, null), ' 正在连接工作台']))

  const draft = boot['draft'] as Rec
  const settings = boot['settings'] as Rec
  const state: WorkbenchState = { bootstrap: boot, draft, settings, assets: boot['assets'] as Rec[] ?? [], paused, error, refresh, patchDraft, fail, go, focusJobId, clearError: () => setError(null), guardNavigation, librarySeed, clearLibrarySeed: () => setLibrarySeed(null), saveToLibrary }
  const anlas = credits?.['anlas'] as Rec | undefined
  const totalAnlas = anlas?.['total']
  const v5 = credits?.['v5_usage_summary'] as Rec | undefined
  const activeJobs = Number(boot['summary']?.['active_jobs'] ?? ((boot['jobs'] ?? []) as Rec[]).filter((job) => ['queued', 'running'].includes(String(job['status']))).length)
  const queue = (boot['queue'] ?? {}) as Rec
  const pauseReason = paused && queue['reason'] ? String(queue['reason']) : null

  return h('div', { className: 'nai-root', 'data-page': page },
    h('div', { className: 'nai-shell' },
      h('header', { className: 'nai-topbar' },
        h('div', { className: 'brand' }, h('span', { className: 'nai-brand-mark' }, h(Icon, { name: 'brush', size: 20 })), h('span', { className: 'nai-brand-name' }, 'NovelAI Atelier'), h('span', { className: 'nai-brand-version' }, `v${boot['version']}`)),
        h('div', { className: 'nai-topbar-actions' },
          h('button', { type: 'button', className: `nai-pill ${paused ? 'bad' : 'ok'}`, 'aria-pressed': paused, disabled: pausing, title: paused ? pauseReason ?? '恢复任务' : '暂停后续任务', onClick: () => void togglePause() }, h(Icon, { name: paused ? 'play' : 'pause' }), paused ? '已暂停' : activeJobs ? `${activeJobs} 个任务` : '就绪'),
          h('button', { type: 'button', className: `nai-pill ${creditsError ? 'bad' : ''}`, title: creditsError ?? (tokenConfigured ? '查看账户额度' : '配置 NovelAI 令牌'), onClick: () => { if (tokenConfigured) { setCreditsOpen(true); void loadCredits() } else go('settings') } }, h(Icon, { name: tokenConfigured ? creditsError ? 'alert' : 'coins' : 'settings' }), !tokenConfigured ? '配置令牌' : creditsError ? '额度查询失败' : totalAnlas == null ? '令牌已配置' : `${Number(totalAnlas).toLocaleString('zh-CN')} Anlas`))),
      error || connectionError || boot['worker_error'] ? h('div', { className: 'nai-shell-error' }, ErrorBox({ error: error ?? connectionError ?? String(boot['worker_error']) }), Button({ icon: error ? 'close' : 'refresh', iconOnly: true, kind: 'ghost', title: error ? '关闭提示' : '重新连接', onClick: () => error ? setError(null) : void refresh() })) : null,
      pauseReason ? h('div', { className: 'nai-shell-error', role: 'status' }, pauseReason) : null,
      h('div', { className: 'nai-body' },
        h('nav', { className: 'nai-nav', 'aria-label': '工作台导航' }, PAGES.map(([id, icon, label]) => h('button', { key: id, type: 'button', className: page === id ? 'active' : '', 'aria-current': page === id ? 'page' : undefined, onClick: () => go(id) }, h(Icon, { name: icon }), label, id === 'gallery' && activeJobs > 0 ? h('span', { className: 'nai-nav-badge' }, String(activeJobs)) : null))),
        h('main', { className: 'nai-main' },
          page === 'create' ? h(WorkspacePanel, { key: String(draft['id']), state }) : null,
          page === 'gallery' ? h(GalleryPanel, { state }) : null,
          page === 'library' ? h(LibraryPanel, { state }) : null,
          page === 'drafts' ? h(DraftsPanel, { state }) : null,
          page === 'schedules' ? h(SchedulesPanel, { state }) : null,
          page === 'settings' ? h(SettingsPanel, { state }) : null))),
    creditsOpen ? h(Modal, { title: 'NovelAI 额度', onClose: () => setCreditsOpen(false), footer: h('div', { className: 'modal-actions' }, Button({ small: true, icon: 'refresh', disabled: creditsBusy, onClick: () => void loadCredits() }, creditsBusy ? '刷新中…' : '刷新额度'), Button({ onClick: () => setCreditsOpen(false) }, '关闭')) },
      ErrorBox({ error: creditsError }),
      credits === null ? h('div', { className: 'nai-empty' }, creditsBusy ? '正在查询额度' : '暂无额度数据') : h('div', { className: 'nai-kv' },
        h('span', { className: 'k' }, '订阅档位'), h('span', null, credits['tier'] === 3 ? `Opus${credits['active'] ? ' · 生效中' : ' · 未生效'}` : `Tier ${credits['tier'] ?? '—'}`),
        h('span', { className: 'k' }, '订阅额度'), h('span', null, anlas?.['subscription'] ?? '—'),
        h('span', { className: 'k' }, '购买额度'), h('span', null, anlas?.['purchased'] ?? '—'),
        h('span', { className: 'k' }, '总余额'), h('strong', null, totalAnlas == null ? '—' : `${totalAnlas} Anlas`),
        v5 ? h('span', { className: 'k' }, 'V5 额度池') : null,
        v5 ? h('span', null, v5['pool_available'] === true ? '当前可用' : v5['pool_available'] === false ? '已用尽' : '未确认', v5['remaining_percent'] != null ? ` · 剩余 ${Number(v5['remaining_percent']).toFixed(1)}%` : '') : null,
        v5?.['refill_percentage_points_per_day'] != null ? h('span', { className: 'k' }, '每日回充') : null,
        v5?.['refill_percentage_points_per_day'] != null ? h('span', null, `${Number(v5['refill_percentage_points_per_day']).toFixed(1)} 个百分点`) : null,
        h('span', { className: 'k' }, '订阅到期'), h('span', null, dateTimeLabel(credits['expires_at'])))) : null)
}
