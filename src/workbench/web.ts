/** Workbench HTTP API for the embedded Web GUI panel. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { relative as relativePath, isAbsolute } from 'node:path'
import type { AssistantContext } from './assistant.ts'
import { Workbench, guide, presets, publicJob } from './app.ts'
import type { Rec } from './store.ts'
import { parseMultipart } from './multipart.ts'

export interface WebDeps {
  workbench: Workbench
  checkRequest: (req: IncomingMessage) => Promise<boolean>
}

const JSON_BODY_LIMIT = 2 * 1024 * 1024

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      chunks.length = 0
      reject(error)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) { fail(new HttpStatus(413, '上传内容过大')); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('aborted', () => fail(new HttpStatus(400, '请求已中止')))
    req.on('error', fail)
  })
}

class HttpStatus extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function json(res: ServerResponse, status: number, value: unknown): boolean {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(Buffer.from(JSON.stringify(value), 'utf8'))
  return true
}

function sendFile(res: ServerResponse, data: Uint8Array, mime: string, download?: string): void {
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    ...(download ? { 'Content-Disposition': `attachment; filename="${download}"` } : {}),
  })
  res.end(data)
}

function imageMime(data: Uint8Array): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data.length > 12 && Buffer.from(data.subarray(0, 4)).toString('latin1') === 'RIFF') return 'image/webp'
  return 'application/octet-stream'
}

const fs = () => import('node:fs')

export function createApiHandler(deps: WebDeps): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean> {
  const wb = deps.workbench

  return async function handle(req, res, pathname): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://local')
    const relative = url.pathname.startsWith(pathname) ? url.pathname.slice(pathname.length) : url.pathname
    const path = relative.replace(/^\/api\/?/u, '').replace(/\/+$/u, '')
    const pieces = path.split('/')
    const method = (req.method ?? 'GET').toUpperCase()
    const epoch = wb.restoreEpoch
    const readOnly = method === 'GET' || method === 'HEAD' || (method === 'POST' && (
      ['validate', 'quote', 'inspect', 'recover', 'workspace/read', 'library/export', 'library/preview',
        'library/import-preview', 'gallery/export', 'backups/preview', 'schedules/preview', 'settings/test'].includes(path)
      || (pieces[0] === 'conversations' && pieces.length === 3 && pieces[2] === 'context')
    ))
    const q = (name: string) => url.searchParams.get(name)
    const ok = (value: unknown) => json(res, 200, value)

    try {
      if (wb.maintenance) return json(res, 503, { error: '工作台正在恢复备份，请稍后刷新' })
      if (!(await deps.checkRequest(req))) return json(res, 403, { error: '未授权的请求' })

      // ---- body parsing (JSON unless multipart) ----
      let body: Rec = {}
      const contentType = String(req.headers['content-type'] ?? '')
      if (['POST', 'PUT', 'PATCH'].includes(method)) {
        const raw = await readBody(req, path.startsWith('backups') ? 1024 * 1024 * 1024 + 1024 * 1024
          : path === 'assets' || path.includes('library/import') ? 128 * 1024 * 1024 + 1024 : JSON_BODY_LIMIT)
        if (contentType.includes('multipart/form-data')) {
          const parts = parseMultipart(raw, contentType)
          const file = parts.get('file')
          if (!file) throw new Error('请选择文件')
          ;(req as IncomingMessage & { __file__?: { data: Uint8Array; filename: string; fields: Rec } }).__file__ = {
            data: file.data,
            filename: file.filename ?? 'upload.bin',
            fields: Object.fromEntries([...parts.entries()].filter(([k]) => k !== 'file').map(([k, v]) => [k, Buffer.from(v.data).toString('utf8')])),
          }
        } else if (raw.length) {
          try { body = JSON.parse(raw.toString('utf8')) as Rec } catch { throw new HttpStatus(400, '无效 JSON') }
          if (!(body instanceof Object) || Array.isArray(body)) throw new HttpStatus(400, '请求必须是 JSON 对象')
        }
      }
      if (!readOnly) wb.assertRestoreEpoch(epoch)
      const upload = () => (req as IncomingMessage & { __file__?: { data: Uint8Array; filename: string; fields: Rec } }).__file__!

      // ---- file routes (no JSON envelope) ----
      if (path.startsWith('files/')) {
        if (method !== 'GET' && method !== 'HEAD') throw new HttpStatus(405, '需要 GET')
        let target: string
        try { target = decodeURIComponent(path.slice('files/'.length)) } catch { throw new HttpStatus(400, '无效文件路径') }
        const { readFileSync, existsSync, statSync, realpathSync } = await fs()
        const assetRoot = realpathSync(wb.assets.directory)
        const known = wb.store.listAssets().map((asset) => String(asset['path'])).filter((file) => {
          try { const rel = relativePath(assetRoot, realpathSync(file)); return !rel.startsWith('..') && !isAbsolute(rel) } catch { return false }
        })
        for (const job of wb.store.listJobs(10000)) {
          const result = job['result'] as Rec | null
          for (const file of (result?.['artifact_paths'] ?? []) as unknown[]) {
            if (typeof file === 'string') known.push(file)
          }
        }
        if (!existsSync(target)) throw new HttpStatus(404, '文件不存在')
        const canonical = realpathSync(target)
        if (!known.some((file) => { try { return realpathSync(file) === canonical } catch { return false } })) {
          throw new HttpStatus(403, '只允许读取工作台已登记的素材与作品')
        }
        const stat = statSync(canonical)
        if (!stat.isFile()) throw new HttpStatus(404, '文件不存在')
        if (stat.size > 64 * 1024 * 1024) throw new HttpStatus(413, '文件过大')
        const data = readFileSync(canonical)
        sendFile(res, method === 'HEAD' ? new Uint8Array(0) : data, imageMime(data))
        return true
      }

      // ---- events (SSE) ----
      if (path === 'events' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
        const timer = setInterval(() => {
          try {
            const data = { jobs: wb.store.listJobs().length, paused: wb.store.getPaused() }
            res.write(`event: update\ndata: ${JSON.stringify(data)}\n\n`)
          } catch { clearInterval(timer) }
        }, 3000)
        req.on('close', () => clearInterval(timer))
        return true
      }

      // ---- core ----
      if (path === 'bootstrap' && method === 'GET') return ok(wb.bootstrap(q('compact') === 'true'))
      if (path === 'draft' && method === 'GET') return ok(wb.store.getDraft())
      if (path === 'draft' && method === 'PUT') return ok(wb.store.saveDraft(body, body['revision'] as number))
      if (path === 'draft' && method === 'PATCH') return ok(wb.store.saveDraft(body, (body['base_revision'] ?? body['revision']) as number))
      if (path === 'draft/reset' && method === 'POST') return ok(wb.resetDraft(body['revision'] as number, (body['draft_id'] as string) ?? null))
      if (path === 'settings' && method === 'GET') return ok(wb.settings.public())
      if (path === 'settings' && method === 'PUT') return ok(wb.settings.save(body))
      if (path === 'settings/test' && method === 'POST') return ok(await testConnection(wb, body))
      if (path === 'settings/ai-channel' && method === 'GET') return ok(await wb.aiChannelCatalog())
      if (path === 'credits' && method === 'GET') return ok(await wb.credits())
      if (path === 'schema' && method === 'GET') {
        const operation = q('operation') ?? 'generate'
        const described = (await import('./describe.ts')).describeOperation() as Rec
        const schema = (described['operations'] as Rec)[operation]
        if (!schema) throw new Error('未知操作')
        return ok(schema)
      }
      if (path === 'presets' && method === 'GET') return ok(presets(q('model') ?? 'nai-diffusion-5-full'))
      if (path === 'guide' && method === 'GET') return ok({ text: guide(q('topic') ?? 'overview') })
      if (path === 'tags' && method === 'GET') {
        const query = q('query') ?? ''
        if (query.length < 2 || query.length > 60) throw new Error('请输入 2–60 字符的标签片段')
        const tags = await wb.executor.suggestTags(query, q('model') ?? 'nai-diffusion-5-full', (q('language') as 'en' | 'jp') ?? 'en')
        return ok({ tags })
      }
      if ((path === 'validate' || path === 'quote') && method === 'POST') {
        return ok(path === 'validate' ? await wb.validate(String(body['operation'] ?? 'generate'), body['request'] as Rec)
          : await wb.quote(String(body['operation'] ?? 'generate'), body['request'] as Rec))
      }
      if (path === 'library/export' && method === 'GET') {
        const data = wb.assets.exportLibrary(null)
        sendFile(res, data, 'application/zip', 'atelier-library.zip')
        return true
      }
      if (path === 'library/export' && method === 'POST') {
        const data = wb.assets.exportLibrary((body['ids'] ?? null) as string[] | null)
        sendFile(res, data, 'application/zip', 'atelier-library.zip')
        return true
      }
      if (path === 'assets' && method === 'POST') {
        const file = upload()
        return ok(await wb.assets.add(file.data, file.filename))
      }
      if ((path === 'library/import' || path === 'library/import-preview' || path === 'library/import-merge') && method === 'POST') {
        const file = upload()
        const fields = file.fields ?? {}
        return ok(await wb.assets.importLibrary(file.data, {
          preview: path.endsWith('preview'),
          choices: fields['choices'] ? JSON.parse(String(fields['choices'])) as Rec : null,
          expectedRevisions: fields['expected_revisions'] ? JSON.parse(String(fields['expected_revisions'])) as Rec : null,
        }))
      }
      if (path === 'library' && method === 'GET') return ok(wb.store.listEntries(q('query') ?? '', q('kind') || null))
      if (path === 'library' && method === 'POST') return ok(wb.store.saveEntry(body))
      if (pieces[0] === 'library' && pieces.length === 2) {
        if (method === 'PUT') return ok(wb.store.saveEntry(body, pieces[1], (body['revision'] as number) ?? null))
        if (method === 'DELETE') { wb.store.deleteEntry(pieces[1]!, q('revision') === null ? null : Number(q('revision'))); return ok({ deleted: true }) }
        if (method === 'GET') return ok(wb.store.getEntry(pieces[1]!))
      }
      if (path === 'library/preview' && method === 'POST') {
        const { entryPrompt } = await import('./library.ts')
        const entry = wb.store.getEntry(String(body['entry_id']))
        const { prompt, negative } = entryPrompt(entry, wb.store.listEntries(), Number(body['prompt_set'] ?? -1))
        return ok({
          entry, prompt, negative_prompt: negative,
          inherits_parent: entry['kind'] === 'branch' && !((entry['data'] as Rec)['replace_identity']),
        })
      }
      if (path === 'assets' && method === 'GET') return ok(wb.store.listAssets())
      if (pieces[0] === 'assets' && pieces.length === 3 && method === 'GET') {
        const asset = wb.store.getAsset(pieces[1]!)
        if (pieces[2] === 'file') {
          const { readFileSync, realpathSync } = await fs()
          const target = realpathSync(String(asset['path']))
          const rel = relativePath(realpathSync(wb.assets.directory), target)
          if (rel.startsWith('..') || isAbsolute(rel)) throw new HttpStatus(403, '素材路径超出工作台目录')
          const data = readFileSync(target)
          sendFile(res, data, String(asset['mime'] ?? imageMime(data)))
          return true
        }
        if (pieces[2] === 'thumb') {
          sendFile(res, await wb.assets.thumbnail(pieces[1]!), 'image/png')
          return true
        }
      }
      if (path === 'inspect' && method === 'POST') {
        const { inspectImage } = await import('../core/metadata.ts')
        return ok(inspectImage(String(wb.store.getAsset(String(body['asset_id']))['path'])))
      }
      if (path === 'recover' && method === 'POST') {
        const { recoverRequest } = await import('../core/recovery.ts')
        const source = body['asset_id'] ? String(wb.store.getAsset(String(body['asset_id']))['path']) : String(body['record_path'])
        return ok(await recoverRequest(source))
      }
      if (path === 'prepare' && method === 'POST') return ok(await wb.prepare(body))
      if (path === 'jobs/pause' && method === 'POST') {
        if (typeof body['paused'] !== 'boolean') throw new Error('paused 必须是布尔值')
        wb.store.setPaused(body['paused'])
        return ok({ paused: wb.store.getPaused() })
      }
      if (path === 'jobs' && method === 'GET') return ok(wb.jobs())
      if (path === 'jobs' && method === 'POST') return ok(await wb.submitJobs(body, (req.headers['idempotency-key'] as string) ?? null))
      if (pieces[0] === 'jobs' && pieces.length >= 2) {
        if (pieces.length === 2 && method === 'GET') return ok(publicJob(wb.store.getJob(pieces[1]!)))
        if (pieces.length === 3 && pieces[2] === 'cancel' && method === 'POST') return ok(publicJob(wb.store.cancelJob(pieces[1]!)))
        if (pieces.length === 3 && pieces[2] === 'favorite' && method === 'POST') {
          if (typeof body['favorite'] !== 'boolean') throw new Error('favorite 必须是布尔值')
          return ok(publicJob(wb.store.updateJob(pieces[1]!, { favorite: body['favorite'] })))
        }
      }
      if (path === 'schedules' && method === 'GET') return ok(wb.store.listSchedules().map(stripScheduleRuntime))
      if (path === 'schedules' && method === 'POST') return ok(await wb.saveSchedule(body))
      if (path === 'schedules/preview' && method === 'POST') return ok(await wb.previewSchedule(body))
      if (pieces[0] === 'schedules' && pieces.length === 3 && pieces[2] === 'runs' && method === 'GET') {
        return ok(wb.store.listScheduleRuns(pieces[1]!))
      }
      if (pieces[0] === 'schedules' && pieces.length === 2) {
        if (method === 'GET') {
          const schedule = wb.store.listSchedules().find((s) => s['id'] === pieces[1])
          if (!schedule) throw new Error(String(pieces[1]))
          return ok(stripScheduleRuntime(schedule))
        }
        if (method === 'PUT') return ok(await wb.saveSchedule(body, pieces[1]))
        if (method === 'DELETE') { wb.store.deleteSchedule(pieces[1]!, q('revision') === null ? null : Number(q('revision'))); return ok({ deleted: true }) }
      }
      if (pieces[0] === 'schedules' && pieces.length === 3 && method === 'POST') {
        if (pieces[2] === 'copy') {
          const source = stripScheduleRuntime(wb.store.getSchedule(pieces[1]!)) as Rec
          const copy = Object.fromEntries(Object.entries(source).filter(([k]) =>
            !['id', 'revision', 'expected_revision', 'runs', 'spent', 'reserved', 'next_run', 'created_at', 'updated_at', 'ai_library_snapshot'].includes(k)))
          copy['name'] = `${source['name']} · 副本`
          copy['enabled'] = false
          return ok(await wb.saveSchedule(copy))
        }
        if (pieces[2] === 'once') {
          const result = wb.store.scheduleOnce(pieces[1]!, body['revision'] as number, (req.headers['idempotency-key'] as string) ?? `once:${Date.now()}`)
          wb.worker.wake()
          return ok(result)
        }
      }

      // ---- drafts (creative_api) ----
      if (path === 'drafts' && method === 'GET') return ok(wb.store.listDrafts())
      if (path === 'drafts' && method === 'POST') return ok(wb.store.createDraft((body['draft'] ?? null) as Rec, body['activate'] !== false))
      if (pieces[0] === 'drafts' && pieces.length >= 2) {
        const ident = pieces[1]!
        if (pieces.length === 2) {
          if (method === 'GET') return ok(wb.store.getDraft(ident))
          if (method === 'DELETE') return ok(wb.store.deleteDraft(ident, Number(q('revision'))))
          if (method === 'PUT') return ok(wb.store.saveDraft({ ...body, id: ident }, body['revision'] as number))
        }
        if (pieces.length === 3 && pieces[2] === 'activate' && method === 'POST') return ok(wb.store.switchDraft(ident))
        if (pieces.length === 3 && pieces[2] === 'versions') {
          if (method === 'GET') return ok(wb.store.listVersions(ident))
          if (method === 'POST') return ok(wb.store.saveVersion(ident, String(body['name']), body['revision'] as number))
        }
      }

      // ---- conversations ----
      if (path === 'conversations' && method === 'GET') return ok(wb.store.listConversations(q('query') ?? ''))
      if (path === 'conversations' && method === 'POST') return ok(wb.store.saveConversation(body))
      if (path === 'conversations/import' && method === 'POST') return ok(wb.conversations.importLegacy(body['messages']))
      if (pieces[0] === 'conversations' && pieces.length >= 2) {
        const ident = pieces[1]!
        if (pieces.length === 2) {
          if (method === 'GET') return ok(wb.store.getConversation(ident))
          if (method === 'PUT') return ok(wb.store.saveConversation(body, ident))
          if (method === 'DELETE') { wb.store.deleteConversation(ident); return ok({ deleted: true }) }
        }
        if (pieces.length === 3 && method === 'POST') {
          if (pieces[2] === 'fork') return ok(wb.store.forkConversation(ident, String(body['message_id'])))
          if (pieces[2] === 'context') return ok(wb.conversations.context(ident, {
            message: String(body['message'] ?? ''),
            asset_ids: (body['asset_ids'] ?? null) as string[] | null,
            library_ids: (body['library_ids'] ?? null) as string[] | null,
          }))
          if (pieces[2] === 'runs') return ok(wb.conversations.start(ident, body, (req.headers['idempotency-key'] as string) ?? ''))
        }
      }
      if (pieces[0] === 'assistant-runs' && pieces.length >= 2) {
        if (method === 'GET') return ok(wb.store.getAssistantRun(pieces[1]!))
        if (method === 'POST' && pieces.length === 3 && pieces[2] === 'cancel') return ok(wb.conversations.cancel(pieces[1]!))
      }
      if (pieces[0] === 'messages' && pieces.length === 3 && pieces[2] === 'apply' && method === 'POST') {
        return ok(await wb.conversations.applyMessage(pieces[1]!, body))
      }
      // ---- gallery ----
      if (path === 'gallery' && method === 'GET') {
        const result = wb.store.queryJobs({
          query: q('query') ?? '', offset: Number(q('offset') ?? 0), limit: Number(q('limit') ?? 48),
          model: q('model') ?? '', scheduleId: q('schedule_id') ?? '', libraryId: q('library_id') ?? '',
          favorite: q('favorite') === 'true', archived: q('archived') === 'true', status: q('status') ?? '',
          after: q('after') ?? '', before: q('before') ?? '',
        }) as Rec
        return ok({ ...result, items: (result['items'] as Rec[]).map(publicJob) })
      }
      if (path === 'gallery/reveal' && method === 'POST') {
        const { revealArtwork } = await import('./reveal.ts')
        return ok(await revealArtwork(wb, body['job_id'], body['asset_id']))
      }
      if (path === 'gallery/curate' && method === 'POST') return ok(wb.store.curateJobs(body['ids'] as string[], {
        favorite: (body['favorite'] as boolean | null) ?? null, archived: (body['archived'] as boolean | null) ?? null,
      }))
      if (path === 'gallery/export' && method === 'POST') {
        const ids = body['ids']
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 || !ids.every((v) => typeof v === 'string')) {
          throw new Error('请选择 1–500 条作品记录')
        }
        const { zipSync, strToU8 } = await import('fflate')
        const fsp = await import('node:fs/promises')
        const records: Rec[] = []
        const seen = new Set<string>()
        const imageMembers = new Map<string, string>()
        const images: Record<string, Uint8Array> = {}
        let expandedBytes = 0
        for (const id of ids as string[]) {
          const job = publicJob(wb.store.getJob(id)) as Rec
          for (const asset of (job['assets'] ?? []) as Rec[]) {
            if (typeof asset['id'] === 'string' && typeof asset['path'] === 'string') {
              if (!/^[A-Za-z0-9_-]{1,128}$/u.test(asset['id'])) throw new Error('作品素材 ID 无效')
              const suffix = asset['path'].slice(asset['path'].lastIndexOf('.')).toLowerCase()
              if (!/^\.(?:png|jpe?g|webp|vibe|naiv4vibe)$/u.test(suffix)) throw new Error('作品素材格式无效')
              const member = 'images/' + asset['id'] + suffix
              imageMembers.set(asset['path'], member)
              if (seen.has(asset['id'])) continue
              seen.add(asset['id'])
              const size = (await fsp.stat(asset['path'])).size
              expandedBytes += size
              if (size > 48 * 1024 * 1024 || expandedBytes > 128 * 1024 * 1024) throw new HttpStatus(413, '作品包超过大小限制，请分批导出')
              const bytes = await fsp.readFile(asset['path'])
              if (bytes.length > size || bytes.length > 48 * 1024 * 1024) throw new HttpStatus(413, '作品文件在导出期间变大，请重试')
              images[member] = new Uint8Array(bytes)
            }
          }
          records.push(job)
        }
        const shared = records.map((record) => artworkShareValue(record, imageMembers))
        const notice = 'NovelAI Atelier artwork export\n\n' +
          'records.json omits private connection settings, credentials, and local file paths.\n' +
          'Original artwork bytes are preserved. PNG text and hidden alpha metadata may contain prompts, seeds, and other private information.\n' +
          'This package is not anonymized. Review the records and image metadata before sharing.\n'
        const zipped = zipSync({ ...images, 'records.json': strToU8(JSON.stringify(shared, null, 2)), 'README.txt': strToU8(notice) })
        sendFile(res, zipped, 'application/zip', 'atelier-artworks.zip')
        return true
      }

      // ---- assistant ----
      if (path === 'assistant/apply' && method === 'POST') return ok(await wb.applyProposal(body))
      if (path === 'assistant/actions/propose' && method === 'POST') return ok(await wb.workspace.propose(String(body['action']), (body['arguments'] ?? {}) as Rec))
      if (path === 'assistant/actions/apply' && method === 'POST') return ok(await wb.workspace.apply(String(body['proposal_id'])))
      if (path === 'workspace/read' && method === 'POST') return ok(await wb.workspace.read(String(body['action']), (body['arguments'] ?? {}) as Rec))
      if (path === 'assistant' && method === 'POST') {
        const allowed = new Set(['message', 'history', 'draft_revision', 'allow_generate', 'max_images', 'max_total_anlas', 'asset_ids'])
        if (Object.keys(body).some((k) => !allowed.has(k))) throw new Error('AI 请求包含未知字段')
        if (typeof body['message'] !== 'string') throw new Error('请填写 AI 消息')
        const { Assistant } = await import('./assistant.ts')
        const context: AssistantContext = {
          ...wb.dshChat(),
          getDraft: () => wb.store.getDraft(),
          searchLibrary: (query, kind) => wb.store.listEntries(query, kind),
          validate: (operation, request) => wb.validate(operation, request),
          quote: (operation, request) => wb.quote(operation, request),
          async submit(operation, request, count, budget, rev) {
            return wb.submitJobs({ operation, request, count, max_total_anlas: budget, draft_revision: rev })
          },
          getConfig: () => wb.settings.aiConfig('default'),
          getApiKey: () => wb.settings.aiKey('default'),
          getAssetImage: (assetId) => wb.assets.vision(assetId),
          readWorkspace: (action, args) => wb.workspace.read(action, args),
          proposeAction: (action, args) => wb.workspace.propose(action, args),
        }
        return ok(await new Assistant(context).run(String(body['message']), {
          history: (body['history'] ?? null) as Rec[] | null,
          draftRevision: (body['draft_revision'] ?? null) as number | null,
          allowGenerate: Boolean(body['allow_generate']),
          maxImages: Number(body['max_images'] ?? 1),
          maxTotalAnlas: Number(body['max_total_anlas'] ?? 0),
          assetIds: (body['asset_ids'] ?? null) as string[] | null,
        }))
      }
      // ---- backups（整库快照：凭据脱敏导出、预览、原子恢复） ----
      if (path === 'backups/export' && method === 'GET') {
        const { Backup } = await import('./backup.ts')
        const result = new Backup(wb).export()
        const fsp = await import('node:fs/promises')
        const name = result.path.slice(result.path.lastIndexOf('\\') + 1).slice(result.path.lastIndexOf('/') + 1)
        sendFile(res, new Uint8Array(await fsp.readFile(result.path)), 'application/zip', name)
        return true
      }
      if ((path === 'backups/preview' || path === 'backups/restore') && method === 'POST') {
        const incoming = upload()
        const { Backup } = await import('./backup.ts')
        const fsp = await import('node:fs/promises')
        const folder = wb.root + '/backup-imports'
        await fsp.mkdir(folder, { recursive: true })
        const target = folder + '/import-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.zip'
        await fsp.writeFile(target, incoming.data)
        try {
          if (path === 'backups/restore') wb.assertRestoreEpoch(epoch)
          const backup = new Backup(wb)
          return ok(path === 'backups/preview' ? backup.preview(target) : backup.restore(target))
        } finally {
          await fsp.unlink(target).catch(() => {})
        }
      }

      if (path === 'shutdown' && method === 'POST') return ok({ ok: true, note: 'DSH 插件常驻运行，无需关停工作台' })
      return json(res, 404, { error: '接口不存在' })
    } catch (error) {
      const name = (error as Error).name
      if (error instanceof HttpStatus) return json(res, error.status, { error: error.message })
      if (name === 'FolderOpenError') return json(res, 503, { error: (error as Error).message, code: 'FOLDER_OPEN_FAILED' })
      if (name === 'ConflictError' || /已被更新|已被修改|冲突|已停止/.test((error as Error).message)) return json(res, 409, { error: (error as Error).message })
      if (name === 'KeyError' || /不存在/.test((error as Error).message)) return json(res, 404, { error: (error as Error).message })
      if (name === 'AssistantError') return json(res, 400, { error: (error as Error).message })
      if (name === 'NovelAIError') return json(res, 400, { error: (error as Error).message })
      if (name === 'TypeError' || name === 'ZodError') return json(res, 400, { error: '参数校验失败', details: (error as Error).message })
      if (name === 'HTTPError' || name === 'FetchError') return json(res, 503, { error: '网络连接失败，请检查服务地址和代理' })
      return json(res, 400, { error: `本地操作未完成，请检查配置、文件或凭据（${name}）`, detail: (error as Error).message?.slice(0, 300) })
    }
  }
}

const SHARE_PRIVATE_KEYS = new Set([
  'context', 'snapshot', 'secret', 'secrets', 'nai_secret', 'token', 'nai_token', 'api_key',
  'authorization', 'password', 'credential', 'credentials', 'base_url', 'nai_base_url',
  'proxy_url', 'output_directory', 'output_dir', 'server_message_untrusted',
])

/** Share records use archive-relative paths; source images remain byte-for-byte originals. */
function artworkShareValue(value: unknown, imageMembers: Map<string, string>, key = ''): unknown {
  const lowerKey = key.toLowerCase()
  if (SHARE_PRIVATE_KEYS.has(lowerKey)) return undefined
  if (Array.isArray(value)) return value.map((item) => artworkShareValue(item, imageMembers, key)).filter((item) => item !== undefined)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, artworkShareValue(item, imageMembers, field)])
      .filter(([, item]) => item !== undefined))
  }
  if (typeof value === 'string') {
    if (lowerKey === 'path' || lowerKey.endsWith('_path') || lowerKey.endsWith('_paths')) return imageMembers.get(value)
    if (isAbsolute(value) || /^~[\\/]/u.test(value)) return undefined
    return value.replace(/pst-[A-Za-z0-9_-]+/gu, '[credential omitted]')
      .replace(/(?<!\w)(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]*/gu, '[local path omitted]')
      .replace(/(?<![:\w/])\/(?:[^/\s]+\/)+[^\r\n]*/gu, '[local path omitted]')
  }
  return value
}

function stripScheduleRuntime(value: Rec): Rec {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['snapshot', 'context'].includes(k)))
}

async function testConnection(wb: Workbench, body: Rec): Promise<Rec> {
  const target = String(body['target'] ?? 'nai')
  if (target === 'nai') return { ok: true, credits: await wb.credits() }
  // AI 构思渠道 = DSH 模型；直接发一个极小补全验证连通。
  return await wb.testAiChannel()
}
