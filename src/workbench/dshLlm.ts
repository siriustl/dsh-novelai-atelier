/** Bridge that serves the workbench's OpenAI-style chat completions from the
 * DSH host LLM runtime. Default route = DSH 当前默认模型（设置→模型），
 * 也可在插件设置里改选 DSH 注册表中的任意 provider/model。
 * 识图：OpenAI image_url 数据块经宿主 attachments 服务登记为持久引用后，
 * 以 DSH 图片内容块下发；模型不支持时由宿主自动降级为文本占位。 */
import { createHash } from 'node:crypto'
import type { Rec } from './store.ts'

export interface DshLlmRuntime {
  stream(options: Rec): AsyncIterable<Rec>
  listProviders?(): Promise<unknown> | unknown
  listModels?(provider: string): Promise<unknown> | unknown
}

export interface DshAttachments {
  saveImages(inputs: Array<{ data: Uint8Array; mediaType: string; name?: string }>): Promise<Rec[]>
}

export interface DshLlmBridge {
  /** Run one chat-completions payload; resolves to an OpenAI-style assistant message. */
  complete(payload: Rec, signal?: AbortSignal, override?: Rec): Promise<Rec>
  /** Current route (default selection or override). */
  describe(): Promise<Rec>
  /** Every registered provider with its models, plus the current default selection. */
  catalog(): Promise<Rec>
  /** Whether image inputs can be admitted (attachments service mounted). */
  readonly vision: boolean
}

type Chunk = { type: string; index?: number; text?: string; id?: string; name?: string; argumentsDelta?: string }

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/s
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

export function createDshLlmBridge(llm: DshLlmRuntime, defaultSelection: () => Rec, attachments?: DshAttachments | null): DshLlmBridge {
  const route = (): Rec => {
    const picked = defaultSelection() as Rec
    return {
      provider: String(picked['provider'] ?? ''), model: String(picked['model'] ?? ''),
      ...(typeof picked['reasoningEffort'] === 'string' && picked['reasoningEffort'] ? { reasoningEffort: picked['reasoningEffort'] } : {}),
    }
  }

  const contentBlocks = (message: Rec): Rec[] => {
    if (Array.isArray(message['content'])) return message['content'] as Rec[]
    const text = String(message['content'] ?? '')
    return text ? [{ type: 'text', text }] : []
  }

  // 同一张图片（同字节）跨轮复用同一持久引用，避免每轮重复登记。
  const refCache = new Map<string, Rec>()
  const admitImage = async (dataUrl: string): Promise<Rec> => {
    if (!attachments) throw new Error('当前 DSH 模型渠道未启用图片输入（宿主 attachments 服务不可用）')
    const match = DATA_URL.exec(dataUrl.trim())
    if (!match) throw new Error('仅支持 data URL 形式的图片输入（image/png、jpeg、webp、gif）')
    const mediaType = match[1]!
    const data = Buffer.from(match[2]!, 'base64')
    if (data.length < 64) throw new Error('图片数据无效')
    if (data.length > 12_000_000) throw new Error('单张图片超过 12 MB，请先缩小后再试')
    const key = createHash('sha256').update(data).digest('hex')
    const cached = refCache.get(key)
    if (cached) return cached
    const refs = await attachments.saveImages([{ data, mediaType, name: `nai-workbench.${IMAGE_EXT[mediaType]}` }])
    const ref = refs[0]
    if (!ref || typeof ref['attachmentId'] !== 'string' || !ref['attachmentId']) throw new Error('图片登记失败（attachments 服务返回无效引用）')
    if (refCache.size >= 128) refCache.delete(refCache.keys().next().value!)
    refCache.set(key, ref)
    return ref
  }

  const convertBlocks = async (blocks: Rec[]): Promise<Rec[]> => {
    const out: Rec[] = []
    for (const block of blocks) {
      if (block instanceof Object && block['type'] === 'image_url') {
        const nested = block['image_url'] as Rec | undefined
        const url = String(nested?.['url'] ?? block['url'] ?? '')
        out.push({ type: 'image', attachment: await admitImage(url) })
      } else {
        out.push(block)
      }
    }
    return out
  }

  const toDshMessage = async (message: Rec): Promise<Rec> => {
    const role = String(message['role'])
    if (role === 'system') {
      return { role: 'system', content: await convertBlocks(contentBlocks(message)), source: { kind: 'system-prompt' } }
    }
    if (role === 'assistant') {
      const blocks: Rec[] = []
      const text = String(message['content'] ?? '')
      if (text) blocks.push({ type: 'text', text })
      for (const call of (message['tool_calls'] ?? []) as Rec[]) {
        blocks.push({
          type: 'tool-call',
          id: String(call['id'] ?? `call_${Math.random().toString(36).slice(2)}`),
          name: String((call['function'] as Rec)?.['name'] ?? ''),
          arguments: String((call['function'] as Rec)?.['arguments'] ?? '{}'),
        })
      }
      return { role: 'assistant', content: blocks, source: { kind: 'model', provider: 'dsh-novelai-atelier', model: 'bridge' } }
    }
    const toolCallId = String(message['tool_call_id'] ?? '')
    if (toolCallId) {
      return {
        role: 'tool',
        toolCallId,
        isError: message['is_error'] === true,
        content: await convertBlocks(contentBlocks(message)),
        source: { kind: 'tool', callId: toolCallId },
      }
    }
    return { role: 'user', content: await convertBlocks(contentBlocks(message)), source: { kind: 'user' } }
  }

  const complete = async (payload: Rec, signal?: AbortSignal, override?: Rec): Promise<Rec> => {
    signal?.throwIfAborted()
    if (!Array.isArray(payload['messages'])) throw new Error('模型消息必须是列表')
    const base = route()
    const provider = String(override?.['provider'] || base['provider'])
    const model = String(override?.['model'] || base['model'])
    if (!provider || !model) throw new Error('DSH 未配置默认模型，且插件未选择覆盖渠道')
    const effort = override?.['reasoningEffort'] ?? payload['reasoning_effort'] ??
      (provider === base['provider'] && model === base['model'] ? base['reasoningEffort'] : undefined)
    const options: Rec = {
      provider, model,
      ...(typeof effort === 'string' && effort ? { reasoningEffort: effort } : {}),
      messages: await Promise.all((payload['messages'] as Rec[]).map(toDshMessage)),
      ...(payload['max_tokens'] != null ? { maxTokens: payload['max_tokens'] } : {}),
      ...(signal ? { signal } : {}),
    }
    const tools = payload['tools'] as Rec[] | undefined
    if (tools?.length) {
      options['tools'] = tools.map((tool) => ({
        name: String((tool['function'] as Rec)?.['name'] ?? tool['name'] ?? ''),
        description: String((tool['function'] as Rec)?.['description'] ?? tool['description'] ?? ''),
        parameters: (tool['function'] as Rec)?.['parameters'] ?? tool['parameters'] ?? { type: 'object', properties: {} },
      }))
    }
    signal?.throwIfAborted()
    let text = ''
    let usage: Rec | undefined
    const calls = new Map<number, { id: string; name: string; args: string }>()
    for await (const record of llm.stream(options) as AsyncIterable<Rec>) {
      signal?.throwIfAborted()
      const chunk = (record['chunk'] ?? record) as Chunk
      if (chunk.type === 'usage') usage = (chunk as unknown as Rec)['usage'] as Rec
      else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'tool-call-delta') {
        const index = Number(chunk.index ?? 0)
        const call = calls.get(index) ?? { id: '', name: '', args: '' }
        if (chunk.id) call.id = String(chunk.id)
        if (chunk.name) call.name = String(chunk.name)
        if (chunk.argumentsDelta) call.args += String(chunk.argumentsDelta)
        calls.set(index, call)
      } else if (chunk.type === 'finish') {
        const reason = (chunk as unknown as Rec)['reason'] as Rec | undefined
        if (reason?.['kind'] === 'error') throw new Error(String((reason['failure'] as Rec)?.['message'] ?? 'DSH 模型调用失败'))
        if (reason?.['kind'] === 'aborted') throw new Error('模型调用已中止')
      }
    }
    signal?.throwIfAborted()
    const toolCalls = [...calls.values()].filter((c) => c.name).map((c, i) => ({
      id: c.id || `call_${i}`,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }))
    return {
      role: 'assistant',
      content: text,
      ...(usage ? { usage } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    }
  }

  return {
    complete,
    async describe() {
      const base = route()
      return { ...base, channel: 'dsh', vision: Boolean(attachments) }
    },
    async catalog() {
      const providers: Rec[] = []
      const raw = await llm.listProviders?.()
      const ids = Array.isArray(raw) ? raw : []
      for (const entry of ids) {
        const provider = typeof entry === 'string' ? entry : String((entry as Rec)?.['id'] ?? (entry as Rec)?.['provider'] ?? '')
        if (!provider) continue
        let models: Array<{ id: string; name?: string }> = []
        try {
          const listed = await llm.listModels?.(provider)
          models = (Array.isArray(listed) ? listed : []).map((m) => typeof m === 'string'
            ? { id: m }
            : { id: String((m as Rec)?.['id'] ?? (m as Rec)?.['model'] ?? ''), name: (m as Rec)?.['name'] as string | undefined })
            .filter((m) => m.id)
        } catch { /* provider without a model list stays empty */ }
        providers.push({ provider, models })
      }
      return { providers, default_selection: route() }
    },
    vision: Boolean(attachments),
  }
}
