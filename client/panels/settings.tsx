/** Settings: NovelAI token, output dir, DSH AI channel for scheduled composition, whole-library backup. */
import type { WorkbenchState } from '../shell.tsx'
import { R, h, Button, Card, Field, ErrorBox, OkBox, Select } from '../ui.tsx'
import { api, API_BASE, saveBlob, type Rec } from '../api.ts'
import { Icon } from '../icons.tsx'
import { dateTimeLabel } from '../format.ts'

/** Same host rule the backend uses; kept local so the client bundle stays Node-free. */
const HUAMIO_QUOTA_URL = 'https://api.novelai.me/api/v1/novelai/v5-energy-policy'
function officialHost(value: string): boolean {
  try { return /(^|\.)novelai\.net$/u.test(new URL(value).hostname) } catch { return false }
}

export function SettingsPanel({ state }: { state: WorkbenchState }): Rec {
  const r = R()
  const settings = state.settings!
  const [error, setError] = r.useState<string | null>(null)
  const [okMsg, setOkMsg] = r.useState<string | null>(null)
  const [probes, setProbes] = r.useState<Rec>({})
  const [busy, setBusy] = r.useState('')
  const [catalog, setCatalog] = r.useState<Rec | null>(null)
  const [restorePreview, setRestorePreview] = r.useState<Rec | null>(null)
  const [restoreFile, setRestoreFile] = r.useState<File | null>(null)
  const [editingId, setEditingId] = r.useState<string | null>(null)
  const [draft, setDraft] = r.useState<Rec | null>(null)
  const saveTail = r.useRef<Promise<unknown>>(Promise.resolve())
  const saveVersion = r.useRef(0)
  r.useEffect(() => state.guardNavigation?.(async () => (await saveTail.current) !== false), [state.guardNavigation])

  const ai = settings['ai'] as Rec
  const endpoints = (settings['nai_endpoints'] ?? []) as Rec[]

  const save = (patch: Rec, message: string): Promise<boolean> => {
    const version = ++saveVersion.current
    const captured = structuredClone(patch)
    setBusy('save'); setError(null); setOkMsg(null)
    const work = saveTail.current.then(async () => {
      try {
        await api('/settings', 'PUT', captured)
        await state.refresh()
        if (version === saveVersion.current) setOkMsg(message)
        return true
      } catch (e) { setError((e as Error).message); return false }
      finally { if (version === saveVersion.current) setBusy('') }
    })
    saveTail.current = work
    return work
  }
  const testEndpoint = async (id: string): Promise<void> => {
    setBusy('nai:' + id); setError(null)
    try {
      const result = await api<Rec>('/settings/test', 'POST', { target: 'nai', endpoint_id: id })
      setProbes((current) => ({ ...current, [id]: { credits: result['credits'] as Rec, allowance: (result['allowance'] ?? null) as Rec | null } }))
      setOkMsg(`接口「${String(endpoints.find((item) => item['id'] === id)?.['name'] ?? id)}」连接正常`)
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const mutateEndpoints = (change: (list: Rec[]) => void, message: string): void => {
    const list = structuredClone(endpoints)
    change(list)
    void save({ nai_endpoints: list }, message)
  }
  const beginEdit = (item: Rec | null): void => {
    setEditingId(item ? String(item['id']) : 'new')
    setDraft(item ? {
      id: item['id'], name: item['name'], base_url: item['base_url'], token: '',
      enabled: item['enabled'] !== false, v5_share: Number(item['v5_share'] ?? 1),
      assume_opus: item['assume_opus'] === true, quota_kind: String(item['quota_kind'] ?? 'none'),
      quota_url: String(item['quota_url'] ?? ''), quota_token: '',
      subscription_note: String(item['subscription_note'] ?? ''), subscription_expires: String(item['subscription_expires'] ?? ''),
    } : {
      name: '', base_url: 'https://image.novelai.net', token: '', enabled: true,
      v5_share: 1, assume_opus: false, quota_kind: 'none', quota_url: '', quota_token: '',
      subscription_note: '', subscription_expires: '',
    })
  }
  const submitEdit = (): void => {
    if (!draft) return
    const name = String(draft['name'] ?? '').trim()
    const base = String(draft['base_url'] ?? '').trim()
    if (!name || !base) { setError('接口名称和 API 地址都需要填写'); return }
    const next = structuredClone(endpoints)
    if (editingId === 'new') next.push({ ...draft })
    else {
      const index = next.findIndex((item) => item['id'] === editingId)
      if (index < 0) { setError('这个接口已不在列表里，请刷新后重试'); return }
      next[index] = { ...next[index], ...draft }
    }
    void save({ nai_endpoints: next }, '已保存接口配置').then((saved) => {
      if (!saved) return
      setEditingId(null); setDraft(null)
    })
  }
  const endpointRows = (): Rec[] => endpoints.map((item, index) => {
    const id = String(item['id'])
    const probe = probes[id] as { credits?: Rec; allowance?: Rec | null } | undefined
    const credits = probe?.credits
    const allowance = probe?.allowance
    const freeMode = String(item['free_mode'] ?? 'none')
    const freeLabel = item['official'] ? '官方判定' : freeMode === 'opus' ? '小图免费' : '按量计费'
    const share = Number(item['v5_share'] ?? 1)
    const quotaKind = String(item['quota_kind'] ?? 'none')
    const subscription = item['official'] ? null : (String(item['subscription_note'] ?? '') || '未填写')
    return h('div', { key: id, style: { border: '1px solid var(--nai-border, #2a2a35)', borderRadius: 8, padding: 10, marginBottom: 8 } },
      h('div', { className: 'nai-row', style: { gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        h('input', {
          type: 'checkbox', checked: item['enabled'] === true, title: '启用此接口',
          onChange: () => mutateEndpoints((list) => { list[index]!['enabled'] = item['enabled'] !== true }, '已更新接口启用状态'),
        }),
        h('strong', { style: { textDecoration: item['enabled'] === true ? 'none' : 'line-through' } }, String(item['name'])),
        item['active'] ? h('span', { className: 'nai-pill ok' }, 'Agent 默认') : null,
        h('span', { className: 'nai-pill' }, item['official'] ? '官方' : '非官方'),
        h('span', { className: 'nai-pill' }, freeLabel),
        h('span', { style: { flex: 1 } }),
        Button({ small: true, ghost: true, disabled: busy !== '', onClick: () => void testEndpoint(id) }, busy === 'nai:' + id ? '查询中…' : '查额度'),
        item['active'] ? null : Button({ small: true, ghost: true, disabled: busy !== '', onClick: () => void save({ nai_active_endpoint: id }, '已设为 Agent 默认接口') }, '设为默认'),
        Button({ small: true, ghost: true, disabled: busy !== '' || index === 0, onClick: () => mutateEndpoints((list) => { [list[index - 1], list[index]] = [list[index]!, list[index - 1]!] }, '已调整优先级') }, '↑'),
        Button({ small: true, ghost: true, disabled: busy !== '' || index === endpoints.length - 1, onClick: () => mutateEndpoints((list) => { [list[index], list[index + 1]] = [list[index + 1]!, list[index]!] }, '已调整优先级') }, '↓'),
        Button({ small: true, ghost: true, onClick: () => beginEdit(item) }, '编辑'),
        Button({
          small: true, ghost: true, kind: 'danger', disabled: busy !== '' || endpoints.length <= 1,
          onClick: () => {
            const label = String(item['name'])
            if (!confirm(`删除接口「${label}」？${item['active'] ? '它当前是 Agent 默认接口，删除后会改用列表里第一条启用的接口。' : ''}此操作不可撤销。`)) return
            mutateEndpoints((list) => { list.splice(index, 1) }, '已删除接口')
          },
        }, '删除'),
      ),
      h('div', { className: 'nai-row', style: { gap: 10, marginTop: 4, color: 'var(--nai-faint)', fontSize: 12, flexWrap: 'wrap' } },
        h('span', null, String(item['base_url'])),
        h('span', null, item['token_configured'] ? `令牌 ${String(item['token_hint'] ?? '')}` : '未配置令牌'),
        share > 1 ? h('span', null, `拼车 ${share} 人`) : null,
        quotaKind !== 'none' ? h('span', null, quotaKind === 'huamio' ? '额度查询：画喵预设' : '额度查询：自定义') : null,
        subscription ? h('span', null, `订阅：${subscription}`) : null,
        !item['official'] && item['subscription_expires'] ? h('span', null, `到期：${String(item['subscription_expires'])}`) : null,
      ),
      probe ? h('div', { className: 'nai-kv', style: { marginTop: 6 } },
        h('span', { className: 'k' }, 'Anlas 余额'), h('span', null, String((credits?.['anlas'] as Rec | undefined)?.['total'] ?? '查询失败')),
        h('span', { className: 'k' }, '订阅'),
        h('span', null, item['official']
          ? (credits?.['active'] === true ? `Opus · 生效中` : `Tier ${String(credits?.['tier'] ?? '—')} · 未生效`)
          : subscription),
        h('span', { className: 'k' }, '到期'),
        h('span', null, item['official']
          ? (Number(credits?.['expires_at'] ?? 0) > 0 ? dateTimeLabel(Number(credits?.['expires_at'])) : '—')
          : (String(item['subscription_expires'] ?? '') || '—')),
        credits?.['v5_usage_summary'] ? h('span', { className: 'k' }, 'V5 余量') : null,
        credits?.['v5_usage_summary'] ? h('span', null, `${String((credits['v5_usage_summary'] as Rec)['remaining_percent'] ?? '-')}%`) : null,
        allowance?.ok ? h('span', { className: 'k' }, '站点 V5 余量') : null,
        allowance?.ok ? h('span', null,
          `${String(allowance['percent'] ?? '-')}%（${String(allowance['available_images'] ?? '-')} / ${String(allowance['capacity_images'] ?? '-')} 张${allowance['share_count'] ? `，${String(allowance['share_count'])} 人拼车` : ''}）`) : null,
        allowance && allowance['ok'] !== true ? h('span', { className: 'k' }, '站点额度') : null,
        allowance && allowance['ok'] !== true ? h('span', null, String(allowance['note'] ?? '不可用')) : null,
        quotaKind !== 'none' && !allowance ? h('span', { className: 'k' }, '站点额度') : null,
        quotaKind !== 'none' && !allowance ? h('span', null, '未配置站点登录令牌') : null,
      ) : null,
    )
  })
  const endpointEditor = (): Rec | null => {
    if (!draft) return null
    const quotaKind = String(draft['quota_kind'] ?? 'none')
    const draftOfficial = officialHost(String(draft['base_url'] ?? ''))
    return h('div', { style: { border: '1px solid var(--nai-border, #2a2a35)', borderRadius: 8, padding: 10 } },
      h('div', { className: 'nai-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' } },
        Field({ label: '名称' }, h('input', { value: String(draft['name'] ?? ''), placeholder: '例如：中转接口', onInput: (e: Rec) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value }) })),
        Field({ label: 'API 地址' }, h('input', { value: String(draft['base_url'] ?? ''), placeholder: 'https://image.novelai.net 或 https://api.example.com/v1', onInput: (e: Rec) => setDraft({ ...draft, base_url: (e.target as HTMLInputElement).value }) })),
        Field({ label: '令牌（留空表示不修改）' }, h('input', { type: 'password', value: String(draft['token'] ?? ''), placeholder: 'pst-… 或中转 key', autoComplete: 'off', onInput: (e: Rec) => setDraft({ ...draft, token: (e.target as HTMLInputElement).value }) })),
        Field({ label: '拼车人数 N（V5 额度按 1/N 估算）' }, h('input', { type: 'number', min: 1, max: 64, step: 1, value: Number(draft['v5_share'] ?? 1), onInput: (e: Rec) => setDraft({ ...draft, v5_share: Number((e.target as HTMLInputElement).value) }) })),
        Field({ label: '站点额度查询' }, Select({
          value: quotaKind,
          onChange: (value) => setDraft({ ...draft, quota_kind: value, quota_url: value === 'huamio' ? HUAMIO_QUOTA_URL : value === 'none' ? '' : String(draft['quota_url'] ?? '') }),
          options: [{ value: 'none', label: '不支持（只看 API）' }, { value: 'huamio', label: '画喵（填站点登录令牌即可）' }, { value: 'custom', label: '自定义地址' }],
        })),
        quotaKind === 'huamio'
          ? Field({ label: '站点登录令牌（会过期）', hint: '登录画喵网站后按 F12 → 网络，点任意 api.novelai.me 请求，复制请求头 Authorization 里 Bearer 后面那段；整行粘贴也行。' },
            h('input', { type: 'password', value: String(draft['quota_token'] ?? ''), placeholder: 'eyJhbGci… 或 Bearer eyJhbGci…', autoComplete: 'off', onInput: (e: Rec) => setDraft({ ...draft, quota_token: (e.target as HTMLInputElement).value }) }))
          : null,
        quotaKind === 'custom'
          ? Field({ label: '站点额度查询地址', hint: '返回 JSON，需包含 allocation.available_images 与 capacity_images。' },
            h('input', { value: String(draft['quota_url'] ?? ''), placeholder: 'https://api.example.com/api/v1/novelai/v5-energy-policy', onInput: (e: Rec) => setDraft({ ...draft, quota_url: (e.target as HTMLInputElement).value }) }))
          : null,
        quotaKind === 'custom'
          ? Field({ label: '站点登录令牌（会过期）' }, h('input', { type: 'password', value: String(draft['quota_token'] ?? ''), placeholder: '留空表示不修改', autoComplete: 'off', onInput: (e: Rec) => setDraft({ ...draft, quota_token: (e.target as HTMLInputElement).value }) }))
          : null,
        !draftOfficial ? Field({ label: '订阅说明（可选，仅展示）' }, h('input', { value: String(draft['subscription_note'] ?? ''), placeholder: '例如：Opus 拼车 · 4 人', onInput: (e: Rec) => setDraft({ ...draft, subscription_note: (e.target as HTMLInputElement).value }) })) : null,
        !draftOfficial ? Field({ label: '订阅到期（可选，仅展示）' }, h('input', { value: String(draft['subscription_expires'] ?? ''), placeholder: 'YYYY-MM-DD', onInput: (e: Rec) => setDraft({ ...draft, subscription_expires: (e.target as HTMLInputElement).value }) })) : null,
      ),
      quotaKind === 'huamio' ? h('div', { style: { fontSize: 11, color: 'var(--nai-faint)', marginTop: 6 } }, `查询地址：${HUAMIO_QUOTA_URL}`) : null,
      !draftOfficial ? h('label', { className: 'nai-row', style: { gap: 6, marginTop: 6, fontSize: 12, cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: draft['assume_opus'] === true, onChange: (e: Rec) => setDraft({ ...draft, assume_opus: (e.target as HTMLInputElement).checked }) }),
        '该接口小图免费（类 Opus：≤1MP、≤28 步；V5 仍由接口自己的额度池结算）') : null,
      h('div', { className: 'nai-row', style: { marginTop: 8 } },
        Button({ kind: 'primary', small: true, onClick: submitEdit }, '保存接口'),
        Button({ ghost: true, small: true, onClick: () => { setEditingId(null); setDraft(null) } }, '取消'),
      ),
    )
  }
  const testAi = async (): Promise<void> => {
    setBusy('ai'); setError(null)
    try {
      const result = await api<Rec>('/settings/test', 'POST', { target: 'ai' })
      const route = (result['route'] ?? {}) as Rec
      setOkMsg(`AI 构思渠道连通正常（${String(route['provider'] ?? '?')} / ${String(route['model'] ?? '?')}，${String(result['elapsed_ms'] ?? '?')}ms）`)
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const loadCatalog = r.useCallback(async (): Promise<void> => {
    try { setCatalog(await api<Rec>('/settings/ai-channel')) } catch (e) { setError((e as Error).message) }
  }, [])
  r.useEffect(() => { void loadCatalog() }, [loadCatalog])

  const exportBackup = async (): Promise<void> => {
    setBusy('backup-export'); setError(null); setOkMsg(null)
    try {
      const res = await fetch(API_BASE + '/backups/export', { headers: { 'X-Workbench-Request': '1' } })
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`)
      const blob = await res.blob()
      const name = res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/u)?.[1]
        ?? `atelier-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/gu, '-')}.zip`
      saveBlob(blob, name)
      setOkMsg('备份已导出（含接口令牌，请妥善保管）')
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const pickRestore = async (file: File): Promise<void> => {
    setBusy('backup-preview'); setError(null); setOkMsg(null); setRestorePreview(null); setRestoreFile(null)
    try {
      const data = new FormData()
      data.append('file', file)
      setRestorePreview(await api<Rec>('/backups/preview', 'POST', data))
      setRestoreFile(file)
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const runRestore = async (): Promise<void> => {
    if (!restoreFile) return
    setBusy('backup-restore'); setError(null)
    try {
      const data = new FormData()
      data.append('file', restoreFile)
      const result = await api<Rec>('/backups/restore', 'POST', data)
      setRestorePreview(null); setRestoreFile(null)
      setOkMsg(`恢复完成。上一份备份已自动保存：${String(result['previous_backup'] ?? '-')}；队列已暂停，请在创作页核对后恢复。`)
      await state.refresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }

  const overrideKey = `${String(ai['dsh_provider'] ?? '')}|${String(ai['dsh_model'] ?? '')}`

  const channelOptions = (): Array<{ value: string; label: string }> => {
    const options = [{ value: '|', label: '跟随 DSH 默认模型（设置 → 模型）' }]
    for (const entry of (catalog?.['providers'] ?? []) as Rec[]) {
      const provider = String(entry['provider'])
      for (const model of (entry['models'] ?? []) as Rec[]) {
        options.push({ value: `${provider}|${String(model['id'])}`, label: `${provider} · ${String(model['name'] ?? model['id'])}` })
      }
    }
    if (!options.some((o) => o.value === overrideKey) && overrideKey !== '|')
      options.push({ value: overrideKey, label: `${String(ai['dsh_provider'])} · ${String(ai['dsh_model'])}（当前）` })
    return options
  }

  return h('div', null,
    ErrorBox({ error }),
    OkBox({ text: okMsg }),
    Card({ title: 'NovelAI 接口' },
      h('p', { style: { margin: '0 0 8px', color: 'var(--nai-faint)', fontSize: 12 } },
        '可保存多条接口（官方或中转），列表顺序即优先级。Agent 工具默认使用标记为「Agent 默认」的接口，调用时也可用 endpoint 参数指定；某个接口失败不会自动切到下一条，避免在未知接口上重复扣费。'),
      ...endpointRows(),
      endpointEditor(),
      h('div', { className: 'nai-row', style: { marginTop: 8 } },
        Button({ icon: 'plus', ghost: true, onClick: () => beginEdit(null), disabled: busy !== '' || endpoints.length >= 20 }, '添加接口'),
      ),
    ),
    Card({ title: '输出与网络' },
      h('div', { className: 'nai-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' } },
        Field({ label: '图片输出目录（绝对路径）' },
          h('input', { defaultValue: String(settings['output_directory'] ?? ''), onBlur: (e: Rec) => void save({ output_directory: (e.target as HTMLInputElement).value }, '已保存输出目录') })),
        Field({ label: '代理地址（可选，所有接口共用）' },
          h('input', { defaultValue: String(settings['proxy_url'] ?? ''), onBlur: (e: Rec) => void save({ proxy_url: (e.target as HTMLInputElement).value }, '已保存代理') })),
      ),
    ),
    Card({ title: 'AI 构思渠道（定时任务专用）' },
      h('p', { style: { margin: '0 0 8px', color: 'var(--nai-faint)', fontSize: 12 } },
        '定时计划的「AI 构思」通过 DSH 的模型渠道改写提示词。默认使用 DSH 设置 → 模型 中的当前模型；也可为定时任务单独指定其他已配置渠道。日常生图协作直接在 DSH 对话里说即可。'),
      h('div', { className: 'nai-row', style: { marginBottom: 8 } },
        h('span', { className: catalog?.['available'] ? 'nai-pill ok' : 'nai-pill' },
          catalog?.['available'] ? 'DSH 渠道可用' : 'DSH 渠道不可用'),
        h('span', { style: { flex: 1 } }),
        Button({ small: true, ghost: true, onClick: () => void loadCatalog() }, '刷新渠道'),
        Button({ onClick: () => void testAi(), disabled: busy !== '' }, busy === 'ai' ? '检测中…' : '测试连通'),
      ),
      h('div', { className: 'nai-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' } },
        Field({ label: '模型渠道' },
          catalog === null ? h('span', { style: { color: 'var(--nai-faint)', fontSize: 12 } }, '正在加载渠道列表…') : Select({
            value: overrideKey,
            onChange: (v: string) => {
              const [provider, model] = v.split('|')
              void save({ ai: { dsh_provider: provider ?? '', dsh_model: model ?? '' } }, '已保存 AI 构思渠道')
            },
            options: channelOptions(),
          })),
        Field({ label: '最大输出 tokens' }, h('input', { type: 'number', defaultValue: ai['max_output_tokens'] ?? 4096, min: 256, max: 200000, onBlur: (e: Rec) => { const value = Number(e.target.value); if (value !== Number(ai['max_output_tokens'] ?? 4096)) void save({ ai: { max_output_tokens: value } }, '已保存 AI 输出上限') } })),
      ),
    ),
    Card({ title: '重试' },
      h('div', { className: 'nai-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' } },
        Field({ label: '重试间隔（秒）' }, h('input', { type: 'number', defaultValue: settings['retry_delay_seconds'] ?? 3, min: 0, max: 60, step: 1, onBlur: (e: Rec) => { const value = Number(e.target.value); if (value !== Number(settings['retry_delay_seconds'] ?? 3)) void save({ retry_delay_seconds: value }, '已保存重试间隔') } })),
        Field({ label: '最多尝试次数（含首次）' }, h('input', { type: 'number', defaultValue: settings['retry_max_attempts'] ?? 3, min: 1, max: 10, step: 1, onBlur: (e: Rec) => { const value = Number(e.target.value); if (value !== Number(settings['retry_max_attempts'] ?? 3)) void save({ retry_max_attempts: value }, '已保存尝试次数') } }))),
      h('p', { style: { margin: '8px 0 0', color: 'var(--nai-faint)', fontSize: 12 } }, '仅重试读取或确认未提交的请求；生成结果不明时不会重新提交。')),
    Card({ title: '备份与恢复（整库快照）' },
      h('p', { style: { margin: '0 0 8px', color: 'var(--nai-faint)', fontSize: 12 } },
        '导出包含草稿、版本历史、资料库、作品记录、定时计划、全部图片素材和 NovelAI 接口（含令牌）的 zip 快照；备份文件本身就是凭据，请妥善保管。恢复会替换本机全部工作台数据（自动先保存当前备份），代理与 AI 渠道保留本机设置，恢复后队列暂停、定时计划停用。'),
      h('div', { className: 'nai-row', style: { marginBottom: 8 } },
        Button({ icon: 'download', onClick: () => void exportBackup(), disabled: busy !== '' }, busy === 'backup-export' ? '正在打包…' : '导出备份'),
        h('label', { className: 'nai-btn', style: { cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 } },
          h(Icon, { name: 'upload' }),
          busy === 'backup-preview' ? '正在读取…' : '选择备份文件预览',
          h('input', {
            type: 'file', accept: '.zip', className: 'nai-file-input', disabled: busy !== '',
            onChange: (e: Rec) => {
              const file = (e.target as HTMLInputElement).files?.[0]
              if (file) void pickRestore(file)
              ;(e.target as HTMLInputElement).value = ''
            },
          }),
        ),
      ),
      restorePreview ? h('div', { className: 'nai-kv', style: { marginTop: 6 } },
        h('span', { className: 'k' }, '备份时间'), h('span', null, String(restorePreview['created_at'] ?? '-')),
        h('span', { className: 'k' }, '草稿'), h('span', null, String((restorePreview['counts'] as Rec)?.['drafts'] ?? 0)),
        h('span', { className: 'k' }, '作品记录'), h('span', null, String((restorePreview['counts'] as Rec)?.['jobs'] ?? 0)),
        h('span', { className: 'k' }, '资料条目'), h('span', null, String((restorePreview['counts'] as Rec)?.['entries'] ?? 0)),
        h('span', { className: 'k' }, '定时计划'), h('span', null, String((restorePreview['counts'] as Rec)?.['schedules'] ?? 0)),
        h('span', { className: 'k' }, '图片文件'), h('span', null, String(restorePreview['files'] ?? 0)),
        h('span', { className: 'k' }, '凭据'), h('span', null, restorePreview['credentials_included'] ? '包含（异常）' : '不含'),
        h('div', { className: 'nai-row', style: { marginTop: 8 } },
          Button({ kind: 'danger', icon: 'alert', onClick: () => void runRestore(), disabled: busy !== '' }, busy === 'backup-restore' ? '正在恢复…' : '恢复此备份（替换本机数据）'),
          Button({ ghost: true, onClick: () => { setRestorePreview(null); setRestoreFile(null) } }, '取消'),
        ),
      ) : null,
    ),
  )
}
