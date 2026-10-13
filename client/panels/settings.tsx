/** Settings: NovelAI token, output dir, DSH AI channel for scheduled composition, whole-library backup. */
import type { WorkbenchState } from '../shell.tsx'
import { R, h, Button, Card, Field, ErrorBox, OkBox, Select } from '../ui.tsx'
import { api, API_BASE, saveBlob, type Rec } from '../api.ts'

export function SettingsPanel({ state }: { state: WorkbenchState }): Rec {
  const r = R()
  const settings = state.settings!
  const [error, setError] = r.useState<string | null>(null)
  const [okMsg, setOkMsg] = r.useState<string | null>(null)
  const [credits, setCredits] = r.useState<Rec | null>(null)
  const [busy, setBusy] = r.useState('')
  const [catalog, setCatalog] = r.useState<Rec | null>(null)
  const [restorePreview, setRestorePreview] = r.useState<Rec | null>(null)
  const [restoreFile, setRestoreFile] = r.useState<File | null>(null)
  const tokenInput = r.useRef<HTMLInputElement | null>(null)
  const saveTail = r.useRef<Promise<unknown>>(Promise.resolve())
  const saveVersion = r.useRef(0)
  r.useEffect(() => state.guardNavigation?.(async () => (await saveTail.current) !== false), [state.guardNavigation])

  const ai = settings['ai'] as Rec

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
  const testNai = async (): Promise<void> => {
    setBusy('nai'); setError(null)
    try {
      const result = await api<Rec>('/settings/test', 'POST', { target: 'nai' })
      setCredits(result['credits'] as Rec)
      setOkMsg('NovelAI 连接正常')
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
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
      setOkMsg('备份已导出（凭据已脱敏；可在目标机器通过「恢复备份」导入）')
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

  const anlas = credits ? (credits['anlas'] as Rec) : null
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
    Card({ title: 'NovelAI 连接' },
      h('div', { className: 'nai-row' },
        h('span', { className: settings['token_configured'] ? 'nai-pill ok' : 'nai-pill bad' },
          String(settings['token_source'] ?? '未配置')),
        h('span', { style: { flex: 1 } }),
        Button({ onClick: () => void testNai(), disabled: busy !== '' || !settings['token_configured'] }, busy === 'nai' ? '检测中…' : '测试连接'),
      ),
      h('div', { style: { height: 8 } }),
      h('div', { className: 'nai-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' } },
        Field({ label: 'NovelAI 令牌（pst-…，保存后仅显示状态）' },
          h('input', {
            type: 'password', placeholder: settings['token_configured'] ? '已配置，输入可替换' : '粘贴令牌',
            ref: (node: HTMLInputElement | null) => { tokenInput.current = node }, autoComplete: 'off',
          })),
        Field({ label: 'API 地址' },
          h('input', { defaultValue: String(settings['nai_base_url'] ?? ''), onBlur: (e: Rec) => void save({ nai_base_url: (e.target as HTMLInputElement).value }, '已保存 API 地址') })),
        Field({ label: '图片输出目录（绝对路径）' },
          h('input', { defaultValue: String(settings['output_directory'] ?? ''), onBlur: (e: Rec) => void save({ output_directory: (e.target as HTMLInputElement).value }, '已保存输出目录') })),
        Field({ label: '代理地址（可选）' },
          h('input', { defaultValue: String(settings['proxy_url'] ?? ''), onBlur: (e: Rec) => void save({ proxy_url: (e.target as HTMLInputElement).value }, '已保存代理') })),
      ),
      h('div', { className: 'nai-row', style: { marginTop: 10 } },
        Button({
          onClick: () => {
            const input = tokenInput.current
            const token = input?.value.trim()
            if (token) void save({ nai_token: token }, '令牌已加密保存').then((saved) => { if (saved && input && input.value.trim() === token) input.value = '' })
            else setError('请先输入 NovelAI 令牌')
          },
          kind: 'primary', small: true, disabled: busy !== '' && busy !== 'save',
        }, '保存令牌'),
      ),
      (credits && anlas) ? h('div', { style: { marginTop: 10 }, className: 'nai-kv' },
        h('span', { className: 'k' }, '订阅等级'), h('span', null, String(credits['tier'] ?? '-')),
        h('span', { className: 'k' }, 'Anlas 余额'), h('span', null, String(anlas['total'] ?? '-')),
        credits['v5_usage_summary'] ? h('span', { className: 'k' }, 'V5 用量') : null,
        credits['v5_usage_summary'] ? h('span', null, `剩余 ${String((credits['v5_usage_summary'] as Rec)['remaining_percent'] ?? '-')}%`) : null,
      ) : null,
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
        '导出包含草稿、版本历史、资料库、作品记录、定时计划与全部图片素材的 zip 快照；NovelAI 令牌等凭据不会写入备份。恢复会替换本机全部工作台数据（自动先保存当前备份），恢复后队列暂停、定时计划停用。'),
      h('div', { className: 'nai-row', style: { marginBottom: 8 } },
        Button({ onClick: () => void exportBackup(), disabled: busy !== '' }, busy === 'backup-export' ? '正在打包…' : '⬇ 导出备份'),
        h('label', { className: 'nai-btn', style: { cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 } },
          busy === 'backup-preview' ? '正在读取…' : '⬆ 选择备份文件预览',
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
          Button({ kind: 'danger', onClick: () => void runRestore(), disabled: busy !== '' }, busy === 'backup-restore' ? '正在恢复…' : '⚠ 恢复此备份（替换本机数据）'),
          Button({ ghost: true, onClick: () => { setRestorePreview(null); setRestoreFile(null) } }, '取消'),
        ),
      ) : null,
    ),
  )
}
