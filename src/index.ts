/** NovelAI Atelier host entry. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Workbench, workbenchDirectory, VERSION } from './workbench/app.ts'
import { registerOnDemandTools } from './bootstrap.ts'
import { registerTools } from './tools.ts'
import { createApiHandler } from './workbench/web.ts'
import { createDshLlmBridge, type DshLlmRuntime, type DshAttachments } from './workbench/dshLlm.ts'
import { registerPromptingSkill, type ToolExposure } from './runtime.ts'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Rec } from './workbench/store.ts'

export const name = 'dsh-novelai-atelier'
export const inject: string[] = []

export interface Config {
  token: string
  outputDirectory: string
  proxyUrl: string
  startWorker: boolean
  apiPrefix: string
  toolExposure?: ToolExposure
  onDemandTools?: boolean
}

export const Config: Schema<Config> = Schema.object({
  token: Schema.string().role('secret').default('').description('NovelAI 令牌；留空使用工作台保存的令牌'),
  outputDirectory: Schema.string().default('').description('图片输出目录；留空使用工作台设置'),
  proxyUrl: Schema.string().default('').description('HTTP(S) 代理地址；留空使用工作台设置'),
  startWorker: Schema.boolean().default(true).description('启动常驻任务队列'),
  apiPrefix: Schema.string().default('/api/nai').description('工作台 API 路由前缀'),
  toolExposure: Schema.union(['global', 'scoped']).default('global').description('完整工具曝光：global全局；scoped仅NAI模式或当前已启用会话'),
  onDemandTools: Schema.boolean().default(false).description('常规会话仅加载NAI入口，按需启用当前会话的完整工具'),
})

interface WebServerLike {
  register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void
  tapIndex(transform: (html: string) => string): () => void
}

export function validateApiPrefix(value: string): string {
  const prefix = (value || '/api/nai').replace(/\/+$/u, '')
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/u.test(prefix) || prefix === '/api') {
    throw new Error('API prefix must be a distinct absolute path, for example /api/nai')
  }
  return prefix
}

export function apply(ctx: Context, config: Config): void {
  if (scopeOf(ctx) !== undefined) throw new Error('dsh-novelai-atelier must be mounted on the host; use dsh-novelai-atelier/agent inside presets')
  const prefix = validateApiPrefix(config.apiPrefix)
  const logger = ctx.logger('dsh-novelai-atelier')
  const dataDir = workbenchDirectory()
  const wb = new Workbench(dataDir)
  const token = config.token.trim()
  if (token) {
    if (!token.startsWith('pst-') || /\s/u.test(token)) throw new Error('Invalid NovelAI token')
    wb.pluginToken = token
  }
  const overrides: Rec = {}
  if (config.outputDirectory.trim()) overrides['output_directory'] = config.outputDirectory.trim()
  if (config.proxyUrl.trim()) overrides['proxy_url'] = config.proxyUrl.trim()
  if (Object.keys(overrides).length) wb.settings.save(overrides)

  ctx.inject(['llm', 'agentDefaultModel'], (bridgeCtx) => {
    const llm = bridgeCtx.get('llm') as unknown as DshLlmRuntime
    const defaultModel = bridgeCtx.get('agentDefaultModel') as { currentSelection?: () => Rec }
    const attach = (attachments: DshAttachments | null) => wb.setDshLlm(createDshLlmBridge(llm, () => defaultModel?.currentSelection?.() ?? {}, attachments))
    let active = true
    bridgeCtx.effect(() => {
      attach(null)
      return () => { active = false; wb.setDshLlm(null) }
    }, 'dsh-novelai-atelier llm bridge')
    bridgeCtx.inject(['attachments'], (imageCtx) => imageCtx.effect(() => {
      const attachments = imageCtx.get('attachments') as DshAttachments | undefined
      attach(attachments?.saveImages ? attachments : null)
      return () => { if (active) attach(null) }
    }, 'dsh-novelai-atelier image bridge'))
  })

  const toolExposure = config.toolExposure ?? 'global'
  const onDemandTools = toolExposure === 'scoped' && config.onDemandTools === true
  ctx.provide('naiAtelier', { workbench: wb, toolExposure, onDemandTools })
  if (toolExposure === 'global') {
    ctx.inject(['tools'], (toolsCtx) => { registerTools(toolsCtx, wb) })
    registerPromptingSkill(ctx)
  } else if (onDemandTools) {
    ctx.inject(['tools', 'agents'], async (toolsCtx) => { await registerOnDemandTools(toolsCtx, wb) })
  }

  ctx.inject(['webServer', 'connection'], (webCtx) => webCtx.effect(() => {
    const webServer = webCtx.get('webServer') as WebServerLike
    const connection = webCtx.get('connection') as { requestRejection(req: IncomingMessage): 401 | 403 | undefined }
    if (!webServer || !connection?.requestRejection) {
      logger.warn('Authenticated Web services unavailable; workbench API not mounted')
      return () => {}
    }
    const handle = createApiHandler({ workbench: wb, async checkRequest(req) { return connection.requestRejection(req) === undefined } })
    const routeDispose = webServer.register({ kind: 'prefix', path: prefix, handler: async (req, res) => { await handle(req, res, prefix) } })
    const indexDispose = webServer.tapIndex((html) => html.replace('</head>', `<script>window.__NAI_ATELIER_API_PREFIX__=${JSON.stringify(prefix)};</script></head>`))
    logger.info('Workbench API: %s/api/* (v%s)', prefix, VERSION)
    return () => { indexDispose(); routeDispose() }
  }, 'dsh-novelai-atelier web routes'))

  // Queue lifetime is independent of optional Web/LLM services; dependencies
  // attach when available without stopping image tools or rebuilding the store.
  ctx.effect(() => {
    if (config.startWorker) wb.start()
    return () => wb.stop()
  }, 'dsh-novelai-atelier worker')
}

export { Workbench, VERSION }
