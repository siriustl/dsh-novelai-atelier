/** Creation workspace: operations (txt2img / img2img / enhance / upscale / augment),
 * prompt, parameters, characters, presets, references, submit. */
import type { WorkbenchState } from '../shell.tsx'
import { R, h, Button, Field, Card, Modal, ErrorBox, WarnBox, OkBox, Select, Toggle, Num, Empty, keyboardActivate } from '../ui.tsx'
import { api, uploadFile, assetThumb, assetUrl, fileUrl, type Rec } from '../api.ts'
import { DraftSaveQueue, type DraftSaveStatus } from '../draft-save.ts'
import { Icon, type IconName } from '../icons.tsx'
import { ImagePreview } from '../image.tsx'
import { modelLabel, operationLabel } from '../format.ts'
import { readPendingDraft, cachePendingDraft, clearPendingDraft } from '../draft-cache.ts'
import { MaskEditor } from './mask.tsx'

const MODELS = ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated']
const SAMPLERS: Array<[string, string]> = [
  ['k_euler_ancestral', 'Euler Ancestral'],
  ['k_euler', 'Euler'],
  ['k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'],
  ['k_dpmpp_2m', 'DPM++ 2M'],
  ['k_dpmpp_sde', 'DPM++ SDE'],
]
const SIZE_PRESETS: Array<[string, number, number]> = [
   ['竖版 832×1216', 832, 1216],
   ['方形 1024×1024', 1024, 1024],
   ['横版 1216×832', 1216, 832],
   ['宽屏 1344×768 (16:9)', 1344, 768],
   ['小图 512×768 (速览)', 512, 768],
]
/** Operations the panel drives. */
const OPERATIONS: Array<[string, string]> = [
  ['generate', '文生图'],
  ['img2img', '图生图'],
  ['enhance', 'Enhance 增强'],
  ['upscale', '专用放大'],
  ['augment', '导演工具'],
  ['inpaint', '局部重绘'],
  ['reference_generate', '参考图生成'],
  ['encode_vibe', 'Vibe 编码'],
]
const OPERATION_ICONS: Record<string, IconName> = { generate: 'sparkles', img2img: 'image', enhance: 'sliders', upscale: 'expand', augment: 'brush', inpaint: 'edit', reference_generate: 'layers', encode_vibe: 'layers' }
const AUG_TOOLS: Array<[string, string]> = [
  ['bg-removal', '背景去除'], ['lineart', '线稿化'], ['sketch', '素描化'], ['colorize', '上色'],
  ['emotion', '表情修改'], ['declutter', '去除杂物'], ['declutter-keep-bubbles', '除杂物（保留气泡）'],
]
const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'scared', 'surprised', 'tired', 'excited', 'nervous',
  'thinking', 'confused', 'shy', 'disgusted', 'smug', 'bored', 'laughing', 'irritated', 'aroused',
  'embarrassed', 'worried', 'love', 'determined', 'hurt', 'playful']
/** Operations that carry the full prompt/parameter model. */
const PROMPT_OPS = new Set(['generate', 'img2img', 'enhance', 'inpaint', 'reference_generate'])
/** Operations that require a source image. */
const IMAGE_OPS = new Set(['img2img', 'enhance', 'upscale', 'augment', 'inpaint', 'encode_vibe'])
const INPAINT_MODELS = ['nai-diffusion-5-full', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated']
/** Vibe/Precise references only exist on V4.5. */
const REF_MODELS = ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated']

const STATUS_TEXT: Rec = { queued: '排队', running: '执行中', completed: '完成', failed: '失败', cancelled: '已取消' }

export function WorkspacePanel({ state }: { state: WorkbenchState }): Rec {
  const r = R()
  const draft = state.draft!
  const cached = r.useMemo(() => {
    const pending = readPendingDraft(String(draft['id']))
    if (pending && pending['operation'] === draft['operation'] && JSON.stringify(pending['request']) === JSON.stringify(draft['request'])) { clearPendingDraft(String(draft['id'])); return null }
    return pending
  }, [draft['id']])
  const [request, setRequest] = r.useState<Rec>(() => structuredClone(cached?.['request'] ?? draft['request']))
  const [operation, setOperationState] = r.useState(String(cached?.['operation'] ?? draft['operation'] ?? 'generate'))
  const latestRequest = r.useRef(request)
  latestRequest.current = request
  const latestOperation = r.useRef(operation)
  latestOperation.current = operation
  const saverRef = r.useRef<{ id: string; queue: DraftSaveQueue } | null>(null)
  const draftId = String(draft['id'])
  if (!saverRef.current || saverRef.current.id !== draftId) {
    saverRef.current = { id: draftId, queue: new DraftSaveQueue(Number(draft['revision']), (patch, revision) => state.patchDraft({ ...patch, id: draftId }, revision), 250) }
    if (cached) saverRef.current.queue.restore({ operation: cached['operation'], request: cached['request'] }, Number(cached['revision']))
  }
  const saver = saverRef.current.queue
  const [saveStatus, setSaveStatus] = r.useState<DraftSaveStatus>(saver.status)
  r.useEffect(() => {
    const update = () => {
      setSaveStatus(saver.status)
      if (saver.status === 'saved') clearPendingDraft(draftId)
      else cachePendingDraft(draftId, saver.revision, latestOperation.current, latestRequest.current)
    }
    update()
    return saver.subscribe(update)
  }, [saver])
  r.useEffect(() => state.guardNavigation?.(async () => {
    try { await saver.flush(); return true } catch { setSaveStatus('failed'); return false }
  }), [saver])
  r.useEffect(() => {
    if (typeof window === 'undefined') return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (saver.status !== 'saved') { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [saver])
  r.useEffect(() => {
    if (!saver.busy && !saver.failed && Number(draft['revision']) > saver.revision) {
      saver.revision = Number(draft['revision'])
      const next = structuredClone(draft['request'])
      latestRequest.current = next
      setRequest(next)
      setOperationState(String(draft['operation'] ?? 'generate'))
    }
  }, [draftId, draft['revision'], saveStatus])
  const [error, setError] = r.useState<string | null>(null)
  const [warnings, setWarnings] = r.useState<string[]>([])
  const [okMsg, setOkMsg] = r.useState<string | null>(null)
  const [busy, setBusy] = r.useState('')
  const submitting = r.useRef(false)
  const submissionKey = r.useRef<{ fingerprint: string; key: string } | null>(null)
  const [count, setCount] = r.useState<number>(1)
  const [seedMode, setSeedMode] = r.useState<string>('increment')
  const [variantsOpen, setVariantsOpen] = r.useState(false)
  const [variants, setVariants] = r.useState<string>('')
  const [libraryOpen, setLibraryOpen] = r.useState(false)
  const [libraryKind, setLibraryKind] = r.useState('character')
  const [libraryRows, setLibraryRows] = r.useState<Rec[]>([])
  const [uploadOpen, setUploadOpen] = r.useState(false)
  const [maskOpen, setMaskOpen] = r.useState(false)
  const [prepareOpen, setPrepareOpen] = r.useState(false)
  const [prepWidth, setPrepWidth] = r.useState<number | null>(null)
  const [prepHeight, setPrepHeight] = r.useState<number | null>(null)
  const [prepMode, setPrepMode] = r.useState('contain')
  const [prepBackground, setPrepBackground] = r.useState('#ffffff')
  const [prepCrop, setPrepCrop] = r.useState('')
  const [prepBoxes, setPrepBoxes] = r.useState('')
  const [prepResult, setPrepResult] = r.useState<Rec | null>(null)
  const references = r.useMemo<Rec[]>((): Rec[] => {
    const vibes = (request['vibes'] ?? []) as Rec[]
    const precise = (request['precise_references'] ?? []) as Rec[]
    return [...vibes.map((v, i) => ({ kind: 'vibe', i, path: v['encoding_path'], strength: v['strength'] })),
      ...precise.map((v, i) => ({ kind: 'precise', i, path: v['image_path'], strength: v['strength'], type: v['type'], fidelity: v['fidelity'] }))]
  }, [request])
  const effectiveModel = request['model'] === undefined ? operation === 'reference_generate' || operation === 'encode_vibe' ? 'nai-diffusion-4-5-full' : 'nai-diffusion-5-full' : request['model']
  const isV5 = String(effectiveModel).startsWith('nai-diffusion-5-')
  const needsImage = IMAGE_OPS.has(operation)
  const promptOp = PROMPT_OPS.has(operation)

  const recentJobs = ((state.bootstrap?.['jobs'] ?? []) as Rec[]).slice(0, 6)
  const latestArtwork = recentJobs.find((job) => (job['assets'] as Rec[] | undefined)?.some((asset) => String(asset['mime']).startsWith('image/')))
  const latestAsset = (latestArtwork?.['assets'] as Rec[] | undefined)?.find((asset) => String(asset['mime']).startsWith('image/'))
  const comparisonCount = operation === 'generate' ? variants.split('\n').filter((line) => line.trim()).length : 0
  const effectiveCount = IMAGE_OPS.has(operation) ? 1 : comparisonCount || count
  const set = (patch: Rec): void => {
    const next = { ...latestRequest.current, ...patch }
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key]
    if (JSON.stringify(next) === JSON.stringify(latestRequest.current)) return
    latestRequest.current = next
    setRequest(next)
    void saver.enqueue({ request: next }).catch((e) => state.fail(e))
  }
  const setOperation = (op: string): void => {
    if (op === latestOperation.current) return
    const next = { ...latestRequest.current }
    if (op === 'inpaint' && String(next['model']) === 'nai-diffusion-5-curated') next['model'] = 'nai-diffusion-5-full'
    if (op === 'reference_generate' || op === 'encode_vibe') {
      if (op === 'reference_generate' && ((next['characters'] ?? []) as Rec[]).length > 6) { setError('V4.5 最多支持 6 个角色，请先调整角色槽'); return }
      if (String(next['model']).startsWith('nai-diffusion-5')) next['model'] = 'nai-diffusion-4-5-full'
      next['transparent_background'] = false
      if (next['quality_preset'] === 'light') next['quality_preset'] = 'standard'
    }
    latestRequest.current = next
    latestOperation.current = op
    setRequest(next)
    setOperationState(op)
    void saver.enqueue({ operation: op, request: next })
      .then(() => { setOkMsg(null); setWarnings([]) }).catch((e) => state.fail(e))
  }
  const recoverDraft = async (mode: 'retry' | 'reload' | 'copy'): Promise<void> => {
    if (saver.busy) return
    setBusy('recover'); setError(null)
    try {
      if (mode === 'retry') await saver.retry()
      else if (mode === 'copy') {
        await api('/drafts', 'POST', { draft: { name: `${String(draft['name'])} · 未保存副本`, operation: latestOperation.current, request: structuredClone(latestRequest.current), locked_fields: draft['locked_fields'] ?? [], library_refs: draft['library_refs'] ?? [] }, activate: true })
        await state.refresh()
      } else {
        if (!confirm('重新载入将放弃尚未保存的本地编辑。可先另存副本。')) return
        const saved = await api<Rec>(`/drafts/${encodeURIComponent(draftId)}`)
        saverRef.current = { id: draftId, queue: new DraftSaveQueue(Number(saved['revision']), (patch, revision) => state.patchDraft({ ...patch, id: draftId }, revision), 250) }
        latestRequest.current = structuredClone(saved['request'])
        latestOperation.current = String(saved['operation'])
        setRequest(latestRequest.current)
        setOperationState(latestOperation.current)
        await state.refresh()
      }
      clearPendingDraft(draftId)
      state.clearError?.()
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const setModel = (model: string): void => {
    if (!model.startsWith('nai-diffusion-5-') && ((latestRequest.current['characters'] ?? []) as Rec[]).length > 6) { setError('V4.5 最多支持 6 个角色，请先调整角色槽'); return }
    const patch: Rec = { model }
    if (model.startsWith('nai-diffusion-5-')) patch['variety_boost'] = false
    else {
      patch['transparent_background'] = false
      if (latestRequest.current['quality_preset'] === 'light') patch['quality_preset'] = 'standard'
      if (operation === 'enhance' && latestRequest.current['mode'] === 'max') patch['mode'] = 'regular'
    }
    if (model === 'nai-diffusion-4-5-curated' && latestRequest.current['negative_preset'] === 'furryFocus') patch['negative_preset'] = 'heavy'
    set(patch)
  }
  const setField = (key: string) => (value: unknown): void => {
    const defaultable = ['width', 'height', 'strength', 'noise', 'defry', 'cfg_rescale', 'information_extracted'].includes(key)
    set({ [key]: value === null && defaultable ? undefined : value })
  }

  const resetDraft = async (): Promise<void> => {
    if (!confirm('清空当前草稿？提示词、输入图、角色槽与参数将恢复默认。如需保留当前内容，请先在草稿页保存命名版本。')) return
    try {
      await saver.flush()
      const reset = await api<Rec>('/draft/reset', 'POST', { revision: saver.revision, draft_id: draftId })
      sourceUploadVersion.current++
      setBusy('')
      saverRef.current = { id: draftId, queue: new DraftSaveQueue(Number(reset['revision']), (patch, revision) => state.patchDraft({ ...patch, id: draftId }, revision), 250) }
      latestRequest.current = structuredClone(reset['request'])
      latestOperation.current = String(reset['operation'] ?? 'generate')
      setRequest(latestRequest.current)
      setOperationState(latestOperation.current)
      await state.refresh()
      setOkMsg('草稿已重置')
    } catch (e) { setError((e as Error).message) }
  }

  const sourceUploadVersion = r.useRef(0)
  r.useEffect(() => () => { sourceUploadVersion.current++ }, [])
  const uploadSource = async (file: File): Promise<void> => {
    const version = ++sourceUploadVersion.current
    setBusy('source')
    try {
      const asset = await uploadFile(file)
      if (version !== sourceUploadVersion.current) return
      set({ image_path: String(asset['path']), mask_path: undefined })
      await saver.flush()
      if (version === sourceUploadVersion.current) setOkMsg('源图已就绪')
    } catch (e) { if (version === sourceUploadVersion.current) setError((e as Error).message) }
    finally { if (version === sourceUploadVersion.current) setBusy('') }
  }

  const doValidate = async (): Promise<void> => {
    setBusy('validate'); setError(null); setWarnings([]); setOkMsg(null)
    try {
      await saver.flush()
      const captured = structuredClone(latestRequest.current)
      const capturedOperation = latestOperation.current
      const result = await api<Rec>('/validate', 'POST', { operation: capturedOperation, request: captured })
      if (capturedOperation !== latestOperation.current || JSON.stringify(captured) !== JSON.stringify(latestRequest.current)) { setOkMsg('草稿已变更，本次校验结果未应用'); return }
      setWarnings((result['warnings'] ?? []) as string[])
      if (result['resolved_request']) {
        const resolved = structuredClone(result['resolved_request']) as Rec
        latestRequest.current = resolved
        setRequest(resolved)
        await saver.enqueue({ request: resolved })
      }
      setOkMsg('参数有效')
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const doSubmit = async (): Promise<void> => {
    if (submitting.current) return
    if (needsImage && !String(request['image_path'] ?? '')) { setError('请先上传源图'); return }
    if (operation === 'inpaint' && !String(request['mask_path'] ?? '')) { setError('请先绘制遮罩（标注要重绘的区域）'); return }
    if (operation === 'reference_generate' && !((request['vibes'] as Rec[] ?? []).length || (request['precise_references'] as Rec[] ?? []).length)) {
      setError('参考图生成需要至少一个 Vibe 编码或参考图（在「角色与参考」里上传）'); return
    }
    submitting.current = true
    setBusy('submit'); setError(null); setOkMsg(null)
    try {
      await saver.flush()
      const body: Rec = {
        operation: latestOperation.current, request: structuredClone(latestRequest.current),
        count: IMAGE_OPS.has(latestOperation.current) ? 1 : count, seed_mode: seedMode,
        draft_revision: saver.revision, draft_id: draftId,
      }
      if (operation === 'generate' && variants.trim()) {
        const parsed = variants.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Rec)
        if (parsed.some((v) => !(v instanceof Object) || Array.isArray(v))) throw new Error('每行参数对照必须是 JSON 对象')
        if (parsed.length) body['variants'] = parsed
      }
      const fingerprint = JSON.stringify(body)
      if (submissionKey.current?.fingerprint !== fingerprint) submissionKey.current = { fingerprint, key: crypto.randomUUID() }
      const result = await api<Rec>('/jobs', 'POST', body, { 'Idempotency-Key': submissionKey.current.key })
      submissionKey.current = null
      const jobs = (result['jobs'] ?? []) as Rec[]
      setOkMsg(state.paused ? `已准备 ${jobs.length} 次生成；任务已暂停` : `已开始${jobs.length > 1 ? `逐张生成：${jobs.length} 次` : '生成'}`)
      void state.refresh()
    } catch (e) { setError((e as Error).message) } finally { submitting.current = false; setBusy('') }
  }
  const openLibrary = async (kind: string): Promise<void> => {
    setLibraryKind(kind); setLibraryOpen(true)
    try { setLibraryRows(await api<Rec[]>('/library?kind=' + kind)) } catch (e) { state.fail(e) }
  }
  const applyEntry = async (entry: Rec): Promise<void> => {
    try {
      const preview = await api<Rec>('/library/preview', 'POST', { entry_id: entry['id'] })
      const req = applyEntryToRequest(structuredClone(latestRequest.current), { ...entry, data: { ...entry['data'], prompt: preview['prompt'], negative_prompt: preview['negative_prompt'] } })
      set(req)
      const slot = entry['kind'] === 'character' || entry['kind'] === 'branch' ? ((req['characters'] ?? []) as Rec[]).length - 1 : null
      await saver.enqueue({ library_refs: [...(draft['library_refs'] ?? []), { id: entry['id'], revision: preview['entry']?.['revision'] ?? entry['revision'], name: entry['name'], parent_id: entry['parent_id'] ?? entry['id'], prompt_set: -1, ...(slot !== null ? { slot } : {}) }] })
      await saver.flush()
      setLibraryOpen(false)
      setOkMsg(`已应用「${String(entry['name'])}」`)
    } catch (e) { setError((e as Error).message) }
  }
  const uploadReference = async (file: File, kind: 'vibe' | 'precise'): Promise<void> => {
    try {
      if (((latestRequest.current['characters'] ?? []) as Rec[]).length > 6) throw new Error('V4.5 最多支持 6 个角色，请先调整角色槽')
      if (latestOperation.current !== 'reference_generate' && !confirm('图像参考使用 V4.5 参考图生成模式。切换并保留当前提示词？')) return
      const opposite = kind === 'vibe' ? 'precise_references' : 'vibes'
      if (((latestRequest.current[opposite] ?? []) as Rec[]).length && !confirm('Vibe 与 Precise 不能混用。替换另一种参考？')) return
      const asset = await uploadFile(file)
      const path = String(asset['path'])
      if (kind === 'vibe') {
        const vibes = ((latestRequest.current['vibes'] ?? []) as Rec[]).slice()
        vibes.push({ encoding_path: path, strength: 0.6 })
        set({ vibes, precise_references: [] })
      } else {
        const precise = ((latestRequest.current['precise_references'] ?? []) as Rec[]).slice()
        precise.push({ image_path: path, type: 'character', strength: 1, fidelity: 1 })
        set({ precise_references: precise, vibes: [] })
      }
      setOperation('reference_generate')
      await saver.flush()
      setUploadOpen(false)
    } catch (e) { setError((e as Error).message); throw e }
  }

  const imagePath = String(request['image_path'] ?? '')
  const runPrepare = async (): Promise<void> => {
    setBusy('prepare'); setError(null)
    try {
      const body: Rec = { image_path: imagePath, mode: prepMode, background: prepBackground }
      if (prepWidth != null && prepHeight != null) { body['width'] = prepWidth; body['height'] = prepHeight }
      const crop = prepCrop.trim() ? prepCrop.split(/[,\s]+/u).map(Number) : null
      if (crop) {
        if (crop.length !== 4 || crop.some((n) => !Number.isFinite(n))) throw new Error('裁切框需要 4 个数字：left, top, right, bottom')
        body['crop_box'] = crop
      }
      if ((prepWidth == null) !== (prepHeight == null)) throw new Error('目标宽度和高度需要同时填写')
      const boxes = prepBoxes.trim() ? prepBoxes.split('\n').filter((line) => line.trim()).map((line) => line.trim().split(/[,\s]+/u).map(Number)) : []
      if (boxes.some((box) => box.length !== 4 || box.some((n) => !Number.isFinite(n)))) throw new Error('每个遮罩矩形需要 4 个数字：left, top, right, bottom')
      if (boxes.length) body['mask_boxes'] = boxes
      const result = await api<Rec>('/prepare', 'POST', body)
      setPrepResult(result)
      setOkMsg('画布准备完成（原图未改动）')
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const applyPrepared = (assetIndex: number, target: 'image' | 'mask'): void => {
    const assets = (prepResult?.['assets'] ?? []) as Rec[]
    const asset = assets[assetIndex]
    if (!asset) return
    if (target === 'image') {
      const patch: Rec = { image_path: String(asset['path']), mask_path: undefined }
      if (Number(asset['width']) > 0 && Number(asset['height']) > 0) { patch['width'] = Number(asset['width']); patch['height'] = Number(asset['height']) }
      set(patch)
      setOkMsg('已设为源图（尺寸已同步）')
    } else {
      set({ mask_path: String(asset['path']), mask_mode: 'luminance' })
      setOkMsg('已设为遮罩')
    }
  }
  const imageField = needsImage ? h('div', { className: 'nai-row', style: { marginBottom: 10 } },
    imagePath ? h('img', { alt: '图像预览', src: fileUrl(imagePath), style: { height: 72, borderRadius: 8, border: '1px solid var(--nai-border-soft)' } }) : null,
    h('label', { className: 'nai-btn' }, busy === 'source' ? '上传中…' : imagePath ? '更换源图' : '＋ 上传源图',
      h('input', {
        type: 'file', accept: 'image/png,image/jpeg,image/webp', className: 'nai-file-input',
        onChange: (e: Rec) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          if (file) void uploadSource(file)
        },
      })),
    imagePath ? Button({ small: true, ghost: true, onClick: () => { setPrepResult(null); setPrepareOpen(true) } }, '⧉ 准备画布') : null,
    h('span', { className: 'hint', style: { color: 'var(--nai-faint)', fontSize: 11 } }, 'PNG / JPEG / WebP，原图不会被修改'),
  ) : null

  const maskPath = String(request['mask_path'] ?? '')
  const maskField = operation === 'inpaint' ? h('div', { className: 'nai-row', style: { marginBottom: 10 } },
    maskPath ? h('img', { alt: '图像预览', src: fileUrl(maskPath), title: '遮罩预览（白=重绘）', style: { height: 72, borderRadius: 8, border: '1px solid var(--nai-accent)' } }) : null,
    Button({ disabled: !imagePath, onClick: () => setMaskOpen(true) }, maskPath ? '重新绘制遮罩' : '✎ 绘制遮罩'),
    maskPath ? Button({ small: true, ghost: true, onClick: () => set({ mask_path: undefined }) }, '移除遮罩') : null,
    !imagePath ? h('span', { className: 'hint', style: { color: 'var(--nai-faint)', fontSize: 11 } }, '先上传源图，再绘制遮罩') : null,
  ) : null

  const opBody: Rec[] = []
  if (operation === 'img2img') {
    opBody.push(
      Field({ label: '强度（Strength，重绘幅度）' }, Num({ value: request['strength'] ?? 0.7, onChange: setField('strength'), min: 0.01, max: 0.99, step: 0.01 })),
      Field({ label: '噪声（Noise）' }, Num({ value: request['noise'] ?? 0, onChange: setField('noise'), min: 0, max: 0.99, step: 0.01 })),
      h(Toggle, { checked: Boolean(request['color_correct']), onChange: setField('color_correct'), label: '色彩校正（保持原图色调）' }),
    )
  } else if (operation === 'enhance') {
    opBody.push(
      Field({ label: '强度（默认 0.2）' }, Num({ value: request['strength'] ?? 0.2, onChange: setField('strength'), min: 0.01, max: 0.99, step: 0.01 })),
      Field({ label: '模式' }, Select({
        value: String(request['mode'] ?? 'regular'), onChange: setField('mode'),
        options: isV5
          ? [{ value: 'regular', label: '常规' }, { value: 'max', label: 'Max（仅 V5）' }]
          : [{ value: 'regular', label: '常规' }],
      })),
      h(Toggle, { checked: request['append_enhance_tags'] !== false, onChange: setField('append_enhance_tags'), label: '自动追加增强 tag' }),
    )
  } else if (operation === 'upscale') {
    opBody.push(h('span', { className: 'hint', style: { color: 'var(--nai-faint)', fontSize: 11 } }, '使用 NovelAI 官方放大（约 2×），按结果扣费。'))
  } else if (operation === 'inpaint') {
    opBody.push(
      Field({ label: '重绘强度（1=完全按提示词重画）' }, Num({ value: request['strength'] ?? 1, onChange: setField('strength'), min: 0, max: 1, step: 0.05 })),
      Field({ label: '遮罩通道' }, Select({
        value: String(request['mask_mode'] ?? 'luminance'), onChange: setField('mask_mode'),
        options: [{ value: 'luminance', label: '亮度（推荐）' }, { value: 'alpha', label: '透明度' }],
      })),
      h(Toggle, { checked: request['color_correct'] !== false, onChange: setField('color_correct'), label: '色彩校正' }),
    )
  } else if (operation === 'augment') {
    opBody.push(
      Field({ label: '工具' }, Select({
        value: String(request['tool'] ?? 'bg-removal'), onChange: (v: string) => { set({ tool: v, emotion: v === 'emotion' ? 'neutral' : null }) },
        options: AUG_TOOLS.map(([v, l]) => ({ value: v, label: l })),
      })),
      ...(String(request['tool'] ?? '') === 'emotion' ? [Field({ label: '目标表情' }, Select({ value: String(request['emotion'] ?? 'neutral'), onChange: setField('emotion'), options: EMOTIONS.map((e2) => ({ value: e2, label: e2 })) }))] : []),
      ...(['colorize', 'emotion', 'declutter', 'declutter-keep-bubbles'].includes(String(request['tool'] ?? '')) ? [Field({ label: '提示词（引导）' }, h('input', { value: String(request['prompt'] ?? ''), onChange: (e: Rec) => set({ prompt: (e.target as HTMLInputElement).value }) }))] : []),
      Field({ label: '强度（defry 0-5）' }, Num({ value: request['defry'] ?? 0, onChange: setField('defry'), min: 0, max: 5 })),
    )
  } else if (operation === 'encode_vibe') {
    opBody.push(
      Field({ label: '编码模型' }, Select({ value: String(effectiveModel), onChange: setModel, options: REF_MODELS.map((model) => ({ value: model, label: modelLabel(model) })) })),
      Field({ label: '信息提取量（0.01–1，默认 0.7）' }, Num({ value: request['information_extracted'] ?? 0.7, onChange: setField('information_extracted'), min: 0.01, max: 1, step: 0.05 })),
    )
  } else if (operation === 'reference_generate') {
    opBody.push(
      h('span', { className: 'hint', style: { color: 'var(--nai-faint)', fontSize: 11 } }, 'V4.5 专用：在「角色与参考」里上传 Vibe 编码（.vibe/.naiv4vibe）或参考图，配合提示词生成。'),
      h(Toggle, { checked: request['normalize_vibe_strengths'] !== false, onChange: setField('normalize_vibe_strengths'), label: '归一化 Vibe 强度' }),
    )
  }

  return h('div', { className: 'nai-workspace' },
    h('header', { className: 'nai-workspace-header' },
      h('div', { className: 'nai-workspace-heading' },
        h('h1', null, String(draft['name'] || '未命名作品')),
        h('span', { className: 'nai-workspace-context' }, [operationLabel(operation), promptOp || operation === 'encode_vibe' ? modelLabel(effectiveModel) : ''].filter(Boolean).join(' · '))),
      h('div', { className: 'nai-workspace-header-actions' },
        h('div', { className: 'nai-save-state', 'data-save-status': saveStatus, role: 'status' },
          h(Icon, { name: saveStatus === 'failed' ? 'alert' : saveStatus === 'saving' ? 'loader' : 'check', className: saveStatus === 'saving' ? 'nai-spin' : '' }),
          saveStatus === 'failed' ? '未同步' : saveStatus === 'saving' ? '同步中' : '已同步'),
        Button({ icon: 'play', iconOnly: true, kind: 'primary', title: '执行当前操作', disabled: busy !== '' || saveStatus === 'failed' || !state.settings?.['token_configured'], onClick: () => void doSubmit() }))),
    saveStatus === 'failed' ? h('div', { className: 'nai-save-recovery', role: 'alert' },
      h('div', null, h('strong', null, '本地编辑尚未保存'), h('p', null, saver.error)),
      h('div', { className: 'nai-row' },
        Button({ small: true, icon: 'refresh', disabled: busy !== '', onClick: () => void recoverDraft('retry') }, '重试保存'),
        Button({ small: true, icon: 'copy', disabled: busy !== '', onClick: () => void recoverDraft('copy') }, '另存副本'),
        Button({ small: true, icon: 'undo', kind: 'ghost', disabled: busy !== '', onClick: () => void recoverDraft('reload') }, '重新载入'))) : null,
    ErrorBox({ error }),
    OkBox({ text: okMsg }),
    Card({ title: '操作', className: 'nai-workspace-operations' },
      h('div', { className: 'nai-mode-bar' },
        h('div', { className: 'nai-mode-group', role: 'group', 'aria-label': '图像操作' },
          OPERATIONS.map(([op, label]) => Button({
            key: op, small: true, icon: OPERATION_ICONS[op], className: 'nai-mode', 'aria-pressed': operation === op,
            onClick: () => setOperation(op),
          }, label))),
        Button({ small: true, kind: 'ghost', icon: 'undo', iconOnly: true, onClick: () => void resetDraft(), title: '重置草稿' }, '重置草稿')),
      needsImage ? h('div', { style: { height: 10 } }) : null,
      imageField,
      maskField,
      opBody.length ? h('div', { className: 'nai-row', style: { marginTop: needsImage ? 8 : 0 } }, opBody) : null,
    ),
    promptOp ? Card({ title: '画面', className: 'nai-workspace-prompt' },
      h('div', { className: 'nai-prompt' },
        Field({ label: '提示词' },
          h('textarea', {
            id: 'nai-prompt',
            value: String(request['prompt'] ?? ''),
            onChange: (e: Rec) => set({ prompt: (e.target as HTMLTextAreaElement).value }),
            onKeyDown: (e: Rec) => {
              if ((e as KeyboardEvent).ctrlKey && (e as KeyboardEvent).key === 'Enter' && state.settings?.['token_configured'] && busy === '') { e.preventDefault(); void doSubmit() }
            },
            placeholder: '描述画面内容…支持 tag 与自然语言混合',
          })),
        h('div', { className: 'prompt-meta' }, `${String(request['prompt'] ?? '').length} 字符`,
          state.saveToLibrary ? Button({ small: true, icon: 'library', kind: 'ghost', disabled: !String(request['prompt'] ?? '').trim(), onClick: () => state.saveToLibrary!({ kind: 'preset', name: '', data: { prompt: String(latestRequest.current['prompt'] ?? ''), negative_prompt: String(latestRequest.current['negative_prompt'] ?? ''), prompt_sets: [], examples: [], notes: '' } }) }, '存入资料库') : null),
        h('div', { style: { height: 8 } }),
        Field({ label: '负面提示词（不想要的内容）' },
          h('textarea', {
            value: String(request['negative_prompt'] ?? ''),
            style: { minHeight: 44 },
            onChange: (e: Rec) => set({ negative_prompt: (e.target as HTMLTextAreaElement).value }),
          })),
      ),
    ) : null,
    promptOp ? Card({ title: '模型与参数', className: 'nai-workspace-parameters' },
      h('div', { className: 'nai-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' } },
        Field({ label: '模型' }, Select({
          value: String(effectiveModel), onChange: setModel,
          options: (operation === 'inpaint' ? INPAINT_MODELS : operation === 'reference_generate' ? REF_MODELS : MODELS).map((m) => ({ value: m, label: modelLabel(m) })),
        })),
        operation === 'inpaint' ? null : (() => {
          const width = request['width'] ?? (needsImage ? null : 832)
          const height = request['height'] ?? (needsImage ? null : 1216)
          const autoSize = width === null && height === null
          const sizeKey = autoSize ? 'source' : `${width ?? 'auto'}x${height ?? 'auto'}`
          const mp = width !== null && height !== null ? (Number(width) * Number(height) / 1048576).toFixed(2) : null
          return Field({
            label: '尺寸',
            hint: mp === null ? '尺寸以源图和校验结果为准' : `${mp} MP`,
          }, Select({
            value: sizeKey,
            onChange: (v: string) => {
              if (v === 'source') { set({ width: undefined, height: undefined }); return }
              const [w, hh] = v.split('x').map(Number)
              if (Number.isFinite(w) && Number.isFinite(hh)) set({ width: w, height: hh })
            },
            options: [
              ...(needsImage ? [{ value: 'source', label: '源图尺寸' }] : []),
              ...SIZE_PRESETS.map(([label, w, hh]) => ({ value: `${w}x${hh}`, label })),
              ...(autoSize || SIZE_PRESETS.some(([, w, hh]) => `${w}x${hh}` === sizeKey)
                ? []
                : [{ value: sizeKey, label: `自定义 ${width ?? '自动'}×${height ?? '自动'}` }]),
            ],
          }))
        })(),
        Field({ label: '步数' }, Num({ value: request['steps'] ?? null, onChange: setField('steps'), min: 1, max: 50, placeholder: '默认 23' })),
        Field({ label: '引导强度' }, Num({ value: request['scale'] ?? null, onChange: setField('scale'), min: 0, max: 10, step: 0.1, placeholder: isV5 ? '默认 7' : '默认 5' })),
        Field({ label: '种子' }, Num({ value: request['seed'] ?? null, onChange: setField('seed'), min: 0, max: 4294967295, placeholder: '随机' })),
        Field({ label: '采样器' }, Select({ value: String(request['sampler'] ?? 'k_euler_ancestral'), onChange: setField('sampler'), options: SAMPLERS.map(([v, l]) => ({ value: v, label: l })) })),
      ),
      h('details', { className: 'nai-adv' },
        h('summary', null, '高级参数'),
        h('div', { className: 'nai-adv-body' },
          h('div', { className: 'nai-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' } },
            Field({ label: '宽度' }, Num({ value: request['width'], onChange: setField('width'), min: 64, max: 4096, step: 64 })),
            Field({ label: '高度' }, Num({ value: request['height'], onChange: setField('height'), min: 64, max: 4096, step: 64 })),
            Field({ label: '质量预设' }, Select({
              value: String(request['quality_preset'] ?? 'standard'), onChange: setField('quality_preset'),
              options: [{ value: 'standard', label: '标准' }, ...(isV5 ? [{ value: 'light', label: '轻度' }] : []), { value: 'none', label: '关闭' }],
            })),
            Field({ label: '负面预设' }, Select({
              value: String(request['negative_preset'] ?? 'heavy'), onChange: setField('negative_preset'),
              options: [{ value: 'heavy', label: 'Heavy（推荐）' }, { value: 'light', label: 'Light' },
                { value: 'humanFocus', label: 'Human Focus' }, ...(effectiveModel === 'nai-diffusion-4-5-curated' ? [] : [{ value: 'furryFocus', label: 'Furry Focus' }]),
                { value: 'none', label: '关闭' }].map((o) => o as { value: string; label: string }),
            })),
            Field({ label: 'CFG Rescale' }, Num({ value: request['cfg_rescale'] ?? 0, onChange: setField('cfg_rescale'), min: 0, max: 1, step: 0.05 })),
          ),
          h('div', { className: 'nai-row', style: { marginTop: 10 } },
            !isV5 ? h(Toggle, { checked: Boolean(request['variety_boost']), onChange: setField('variety_boost'), label: '多样性增强' }) : null,
            isV5 ? h(Toggle, { checked: Boolean(request['transparent_background']), onChange: setField('transparent_background'), label: '透明背景' }) : null,
          ),
        ),
      ),
    ) : null,
    promptOp ? Card({ title: '角色与参考', className: 'nai-workspace-references' },
      h('div', { className: 'nai-row' },
        Button({ onClick: () => openLibrary('character') }, '＋ 从资料库选角色'),
        Button({ onClick: () => openLibrary('artist') }, '＋ 从资料库选画师'),
        Button({ onClick: () => openLibrary('blend') }, '＋ 画师混合'),
        Button({ onClick: () => setUploadOpen(true) }, '＋ 上传参考图 / Vibe'),
      ),
      h('div', { style: { height: 8 } }),
      h(CharacterEditor, { request, set, isV5, saveToLibrary: state.saveToLibrary }),
      references.length ? h('div', { className: 'nai-references' }, references.map((ref) => {
        const key = ref['kind'] === 'vibe' ? 'vibes' : 'precise_references'
        const update = (patch: Rec) => {
          const list = structuredClone((latestRequest.current[key] ?? []) as Rec[])
          list[Number(ref['i'])] = { ...list[Number(ref['i'])], ...patch }
          set({ [key]: list })
        }
        return h('div', { className: 'nai-reference', key: `${key}:${ref['i']}` },
          h('div', { className: 'nai-reference-title' }, h(Icon, { name: ref['kind'] === 'vibe' ? 'layers' : 'image' }),
            h('span', null, `${ref['kind'] === 'vibe' ? 'Vibe' : 'Precise'} #${Number(ref['i']) + 1}`),
            h('span', { className: 'nai-reference-name', title: String(ref['path']) }, String(ref['path'] ?? '').split(/[\\/]/u).pop()),
            Button({ icon: 'close', iconOnly: true, kind: 'ghost', small: true, title: '移除此参考', onClick: () => set({ [key]: ((latestRequest.current[key] ?? []) as Rec[]).filter((_, index) => index !== ref['i']) }) })),
          h('div', { className: 'nai-row' },
            Field({ label: '强度' }, Num({ value: ref['strength'] ?? (ref['kind'] === 'vibe' ? 0.6 : 1), min: ref['kind'] === 'vibe' ? 0 : -1, max: 1, step: 0.05, onChange: (value) => update({ strength: value ?? 0 }) })),
            ref['kind'] === 'precise' ? Field({ label: '参考类型' }, Select({ value: ref['type'] ?? 'character', onChange: (value) => update({ type: value }), options: [{ value: 'character', label: '角色' }, { value: 'style', label: '风格' }, { value: 'character&style', label: '角色与风格' }] })) : null,
            ref['kind'] === 'precise' ? Field({ label: '保真度' }, Num({ value: ref['fidelity'] ?? 1, min: -1, max: 1, step: 0.05, onChange: (value) => update({ fidelity: value ?? 0 }) })) : null))
      })) : null,
    ) : null,
    latestAsset ? Card({ title: '最近作品', className: 'nai-workspace-preview' },
      h('div', { className: 'nai-artwork-preview', role: 'button', tabIndex: 0, 'aria-label': '查看最近作品', onKeyDown: keyboardActivate(() => state.go('gallery', String(latestArtwork!['id']))), onClick: () => state.go('gallery', String(latestArtwork!['id'])) },
        h(ImagePreview, { src: assetUrl(String(latestAsset['id'])), alt: String((latestArtwork!['request'] as Rec)?.['prompt'] || '最近生成作品') })),
      h('div', { className: 'nai-artwork-caption' }, h('span', null, operationLabel(latestArtwork!['operation'])), Button({ small: true, icon: 'eye', kind: 'ghost', onClick: () => state.go('gallery', String(latestArtwork!['id'])) }, '查看作品'))) : null,
    Card({ title: '生成设置', className: 'nai-workspace-submit' },
      h('div', { className: 'nai-row' },
        IMAGE_OPS.has(operation) ? null : Field({ label: '数量' }, Num({ value: count, onChange: (v) => setCount(v ?? 1), min: 1, max: 50, style: { width: 70 } })),
        IMAGE_OPS.has(operation) ? null : Field({ label: '种子模式' }, Select({
          value: seedMode, onChange: setSeedMode,
          options: [{ value: 'increment', label: '递增' }, { value: 'fixed', label: '固定' }, { value: 'random', label: '随机' }],
        })),
        operation === 'generate' ? Button({ onClick: () => setVariantsOpen(true) }, '参数对照…') : null,
      ),
      h('div', { className: 'nai-row nai-command-bar' },
        h('span', { className: 'nai-command-context' }, `${effectiveCount} 次`),
        Button({ icon: 'check', kind: 'ghost', onClick: () => void doValidate(), disabled: busy !== '' || saveStatus === 'failed' }, busy === 'validate' ? '校验中…' : '校验参数'),
        h('span', { style: { flex: 1 } }),
        Button({
          kind: 'primary', icon: 'play', onClick: () => void doSubmit(), disabled: busy !== '' || saveStatus === 'failed' || !state.settings?.['token_configured'],
          title: state.settings?.['token_configured'] ? '' : '请先在设置中配置 NovelAI 令牌',
        }, busy === 'submit' ? '提交中…' : operation === 'encode_vibe' ? '开始编码' : operation === 'upscale' ? '开始放大' : effectiveCount > 1 ? '逐张生成' : '生成'),
      ),
      recentJobs.length ? h('div', { className: 'nai-jobs-strip' }, recentJobs.map((job) => {
        const st = String(job['status'])
        const cls = st === 'completed' ? 'st-done' : st === 'failed' ? 'st-fail' : 'st-run'
        const asset = ((job['assets'] ?? []) as Rec[]).find((a) => String(a['mime'] ?? '').startsWith('image/'))
        return h('button', {
          type: 'button',
          className: 'job', key: String(job['id']),
          title: '点击打开画廊查看详情',
          style: { cursor: 'pointer' },
          onClick: () => state.go('gallery', String(job['id'])),
        },
          asset ? h('img', { alt: '图像预览', src: assetThumb(String(asset['id'])) }) : h('span', { className: 'st-run', style: { opacity: 0.55 } }, job['operation'] === 'encode_vibe' ? '♪' : '·'),
          h('span', { className: cls }, STATUS_TEXT[st] ?? st),
          h('span', { style: { color: 'var(--nai-faint)' } }, '#' + String(job['id']).slice(0, 6)))
      })) : null,
    ),
    WarnBox({ warnings }),
    libraryOpen ? h(Modal, {
      title: '资料库 · ' + libraryKind, wide: true,
      onClose: () => setLibraryOpen(false),
      footer: Button({ onClick: () => setLibraryOpen(false) }, '关闭'),
    }, libraryRows.length
      ? h('div', { className: 'nai-list' }, libraryRows.map((entry) =>
        h('div', { className: 'nai-list item', key: String(entry['id']), role: 'button', tabIndex: 0, onKeyDown: keyboardActivate(() => void applyEntry(entry)), onClick: () => void applyEntry(entry) },
          (entry['data'] as Rec)?.['examples']?.length
            ? h('img', { alt: '图像预览', src: assetUrl(String(((entry['data'] as Rec)['examples'] as string[])[0])), style: { width: 44, height: 44, borderRadius: 6, objectFit: 'cover' } })
            : null,
          h('div', { className: 'grow' },
            h('div', null, entry['kind'] === 'branch' && entry['parent_name'] ? `${String(entry['parent_name'])} - ${String(entry['name'])}` : String(entry['name'])),
            h('div', { className: 'sub' }, String((entry['data'] as Rec)?.['prompt'] ?? '').slice(0, 90))),
        )))
      : Empty({ text: '该分类暂无资料，请先在资料库面板创建' })) : null,
    uploadOpen ? h(UploadModal, { onClose: () => setUploadOpen(false), onFile: uploadReference }) : null,
    variantsOpen ? h(VariantsModal, { onClose: () => setVariantsOpen(false), value: variants, onChange: setVariants }) : null,
    maskOpen && imagePath ? h(MaskEditor, {
      imagePath,
      onClose: () => setMaskOpen(false),
      onSaved: (maskPath: string) => {
        if (String(latestRequest.current['image_path'] ?? '') !== imagePath) return
        set({ mask_path: maskPath, mask_mode: 'luminance' }); setOkMsg('遮罩已保存')
      },
    }) : null,
    prepareOpen && imagePath ? h(Modal, {
      title: '准备画布（裁切 / 缩放 / 垫边 / 矩形遮罩）', wide: true,
      onClose: () => setPrepareOpen(false),
    },
      h('p', { style: { margin: '0 0 8px', color: 'var(--nai-faint)', fontSize: 12 } },
        '全部本地处理、不联网不扣费，原图永不改动。处理结果作为新素材入库，可一键设为源图或遮罩。'),
      h('div', { className: 'nai-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' } },
        Field({ label: '目标宽度（64 倍数，可空）' }, Num({ value: prepWidth, onChange: setPrepWidth, min: 64, max: 4096, step: 64 })),
        Field({ label: '目标高度（64 倍数，可空）' }, Num({ value: prepHeight, onChange: setPrepHeight, min: 64, max: 4096, step: 64 })),
        Field({ label: '缩放模式' }, Select({
          value: prepMode, onChange: setPrepMode,
          options: [{ value: 'contain', label: '完整放入（垫边）' }, { value: 'cover', label: '填满（裁边）' }, { value: 'stretch', label: '拉伸' }, { value: 'pad', label: '仅垫画布（不缩放）' }],
        })),
        Field({ label: '垫边底色' }, h('input', { value: prepBackground, onChange: (e: Rec) => setPrepBackground((e.target as HTMLInputElement).value), placeholder: '#ffffff 或 transparent' })),
        Field({ label: '裁切框 left,top,right,bottom（可空）' }, h('input', { value: prepCrop, onChange: (e: Rec) => setPrepCrop((e.target as HTMLInputElement).value), placeholder: '0, 0, 512, 512' })),
        Field({ label: '矩形遮罩（每行 left,top,right,bottom）' }, h('textarea', {
          value: prepBoxes, style: { minHeight: 46 },
          onChange: (e: Rec) => setPrepBoxes((e.target as HTMLTextAreaElement).value),
          placeholder: '100, 100, 400, 400',
        })),
      ),
      h('div', { className: 'nai-row', style: { marginTop: 10 } },
        Button({ kind: 'primary', onClick: () => void runPrepare(), disabled: busy !== '' }, busy === 'prepare' ? '处理中…' : '▶ 执行准备'),
        prepResult ? h('span', { style: { color: 'var(--nai-faint)', fontSize: 12 } }, `产出 ${((prepResult['artifact_paths'] ?? []) as string[]).length} 个文件`) : null,
      ),
      prepResult ? h('div', { className: 'nai-row', style: { marginTop: 10, alignItems: 'flex-start' } },
        ((prepResult['assets'] ?? []) as Rec[]).map((asset, i) => h('div', { key: i, style: { textAlign: 'center', marginRight: 12 } },
          h('img', { alt: '图像预览', src: assetThumb(String(asset['id'])), style: { height: 96, borderRadius: 8, border: '1px solid var(--nai-border-soft)', display: 'block', marginBottom: 6 } }),
          h('div', { className: 'nai-row' },
            i === 0 ? Button({ small: true, onClick: () => applyPrepared(i, 'image') }, '设为源图') : Button({ small: true, onClick: () => applyPrepared(i, 'mask') }, '设为遮罩'),
          ),
        )),
      ) : null,
    ) : null,
  )
}

function applyEntryToRequest(request: Rec, entry: Rec): Rec {
  const req = request
  const data = (entry['data'] ?? {}) as Rec
  const prompt = String(data['prompt'] ?? '')
  const negative = String(data['negative_prompt'] ?? '')
  if (entry['kind'] === 'character' || entry['kind'] === 'branch') {
    const characters = (req['characters'] ?? []) as Rec[]
    const limit = String(req['model'] ?? 'nai-diffusion-5-full').startsWith('nai-diffusion-5-') ? 22 : 6
    if (characters.length >= limit) throw new Error(`已达模型角色上限 ${limit}`)
    characters.push({ prompt, negative_prompt: negative })
    req['characters'] = characters
  } else {
    req['prompt'] = [req['prompt'], prompt].filter(Boolean).join(', ')
    req['negative_prompt'] = [req['negative_prompt'], negative].filter(Boolean).join(', ')
  }
  return req
}

function CharacterEditor({ request, set, isV5, saveToLibrary }: { request: Rec; set: (patch: Rec) => void; isV5: boolean; saveToLibrary?: (entry: Rec) => void }): Rec {
  const r = R()
  const characters = structuredClone((request['characters'] ?? []) as Rec[])
  const update = (): void => set({ characters })
  const limit = isV5 ? 22 : 6
  return h('div', null,
    characters.length === 0 ? h('div', { className: 'nai-empty', style: { padding: '8px 0' } }, '无独立角色（使用单一画面提示词）') : null,
    characters.map((c, i) => h('div', {
      key: i, className: 'nai-card',
      style: {
        padding: 12, marginTop: 10,
        background: 'var(--nai-panel-2)',
        border: '1px solid var(--nai-border-soft)',
        borderLeft: '4px solid var(--nai-accent)',
        borderRadius: 8,
      },
    },
      h('div', { className: 'nai-row', style: { marginBottom: 6 } },
        h('span', { className: 'nai-pill', style: { fontSize: 11, fontWeight: 'bold', color: 'var(--nai-accent)' } }, `👤 角色 ${i + 1}`),
        h('span', { style: { flex: 1 } }),
        saveToLibrary ? Button({ small: true, icon: 'library', kind: 'ghost', disabled: !String(c['prompt'] ?? '').trim(), onClick: () => saveToLibrary({ kind: 'character', name: '', data: { prompt: String(c['prompt'] ?? ''), negative_prompt: String(c['negative_prompt'] ?? ''), prompt_sets: [], examples: [], notes: '' } }) }, '存入资料库') : null,
        Button({ small: true, kind: 'danger', onClick: () => { characters.splice(i, 1); update() } }, '移除角色')),
      h('div', { className: 'nai-grid', style: { gridTemplateColumns: '1fr 1fr', marginTop: 6 } },
        Field({ label: '角色提示词' }, h('textarea', {
          value: String(c['prompt'] ?? ''), style: { minHeight: 52 },
          placeholder: '输入该角色的发型、服饰、动作、特征…',
          onChange: (e: Rec) => { c['prompt'] = (e.target as HTMLTextAreaElement).value; update() },
        })),
        Field({ label: '角色负面词（通常留空即可）' }, h('textarea', {
          value: String(c['negative_prompt'] ?? ''), style: { minHeight: 52 },
          placeholder: '针对该角色的负面元素（非必需）…',
          onChange: (e: Rec) => { c['negative_prompt'] = (e.target as HTMLTextAreaElement).value; update() },
        }))),
      isV5 ? h('div', { className: 'nai-row', style: { marginTop: 6 } },
        h('span', { className: 'hint', style: { color: 'var(--nai-faint)', fontSize: 11 } }, '定位坐标（可选，0.0–1.0）：'),
        h('span', { style: { fontSize: 11, color: 'var(--nai-dim)' } }, 'X:'),
        Num({ value: c['x'] ?? null, onChange: (v) => { c['x'] = v; update() }, min: 0, max: 1, step: 0.1, style: { width: 72 } }),
        h('span', { style: { fontSize: 11, color: 'var(--nai-dim)' } }, 'Y:'),
        Num({ value: c['y'] ?? null, onChange: (v) => { c['y'] = v; update() }, min: 0, max: 1, step: 0.1, style: { width: 72 } }),
      ) : null,
    )),
    characters.length < limit
      ? Button({ style: { marginTop: 8 }, onClick: () => { characters.push({ prompt: '', negative_prompt: '' }); update() } }, `＋ 添加角色（${characters.length}/${limit}）`)
      : h('div', { className: 'hint', style: { marginTop: 6, color: 'var(--nai-faint)', fontSize: 11 } }, `已达模型角色上限 ${limit}`),
  )
}

function UploadModal({ onClose, onFile }: { onClose: () => void; onFile: (file: File, kind: 'vibe' | 'precise') => Promise<void> }): Rec {
  const r = R()
  const [error, setError] = r.useState<string | null>(null)
  return h(Modal, { title: '上传参考', onClose },
    ErrorBox({ error }),
    h('p', { style: { color: 'var(--nai-dim)', fontSize: 12 } },
      'Vibe：已编码的 .vibe / .naiv4vibe 文件。参考图：PNG/JPEG，将作为 Precise Reference（每次 5 Anlas）。两者不能混用。'),
    h('div', { className: 'nai-row' },
      h('label', { className: 'nai-btn' }, '选择 Vibe 文件',
        h('input', {
          type: 'file', accept: '.vibe,.naiv4vibe', className: 'nai-file-input',
          onChange: (e: Rec) => {
            const file = (e.target as HTMLInputElement).files?.[0]
            if (file) void onFile(file, 'vibe').catch((err) => setError((err as Error).message))
          },
        })),
      h('label', { className: 'nai-btn' }, '选择参考图片',
        h('input', {
          type: 'file', accept: 'image/png,image/jpeg,image/webp', className: 'nai-file-input',
          onChange: (e: Rec) => {
            const file = (e.target as HTMLInputElement).files?.[0]
            if (file) void onFile(file, 'precise').catch((err) => setError((err as Error).message))
          },
        })),
    ),
  )
}

function VariantsModal({ onClose, value, onChange }: { onClose: () => void; value: string; onChange: (v: string) => void }): Rec {
  return h(Modal, { title: '参数对照（每行一组 JSON 修改）', onClose, wide: true },
    h('p', { style: { color: 'var(--nai-dim)', fontSize: 12 } },
      '每行一个 JSON 对象，只允许 model/scale/steps/cfg_rescale/strength/noise/seed/sampler/quality_preset/negative_preset/prompt_suffix。示例：'),
    h('pre', { style: { color: 'var(--nai-faint)', fontSize: 11, margin: '4px 0 8px' } }, '{"scale":5}\n{"scale":7,"prompt_suffix":"smile"}'),
    h('textarea', { value, style: { minHeight: 140, width: '100%' }, onChange: (e: Rec) => onChange((e.target as HTMLTextAreaElement).value) }),
  )
}
