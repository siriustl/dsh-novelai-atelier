/** A small global entry point; complete capabilities are owned by the requesting Agent. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Workbench } from './workbench/app.ts'
import { registerTools } from './tools.ts'
import { registerPromptingSkill } from './runtime.ts'

export const ACTIVATION_KEY = 'dsh-novelai-atelier.agent-tools.v1'
export const LEGACY_ACTIVATION_KEY = 'nai-atelier.agent-tools.v1'
export const BOOTSTRAP_TOOL = 'nai_use_tools'
type LiveAgent = NonNullable<ToolRunContext['agent']>
type CapabilityFiber = ReturnType<Context['plugin']>
interface Activation { fiber: CapabilityFiber }

function enabledSessions(wb: Workbench): Set<string> {
  const raw = wb.store.data.kv[ACTIVATION_KEY] ?? wb.store.data.kv[LEGACY_ACTIVATION_KEY]
  if (raw === undefined) return new Set()
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value as { version?: unknown }).version !== 1 ||
      !Array.isArray((value as { sessions?: unknown }).sessions)) throw new Error('NAI capability activation state is invalid')
  const ids = (value as { sessions: unknown[] }).sessions
  if (!ids.every(id => typeof id === 'string' && id.length > 0)) throw new Error('NAI capability session IDs are invalid')
  return new Set(ids as string[])
}

function persistActivation(wb: Workbench, id: string, enabled: boolean): void {
  const ids = enabledSessions(wb)
  if (ids.has(id) === enabled) return
  if (enabled) ids.add(id)
  else ids.delete(id)
  const previous = wb.store.data.kv[ACTIVATION_KEY]
  const previousLegacy = wb.store.data.kv[LEGACY_ACTIVATION_KEY]
  const encoded = JSON.stringify({ version: 1, sessions: [...ids].sort() })
  wb.store.data.kv[ACTIVATION_KEY] = encoded
  wb.store.data.kv[LEGACY_ACTIVATION_KEY] = encoded
  try { wb.store.internalPersist() }
  catch (error) {
    if (previous === undefined) delete wb.store.data.kv[ACTIVATION_KEY]
    else wb.store.data.kv[ACTIVATION_KEY] = previous
    if (previousLegacy === undefined) delete wb.store.data.kv[LEGACY_ACTIVATION_KEY]
    else wb.store.data.kv[LEGACY_ACTIVATION_KEY] = previousLegacy
    throw error
  }
}

async function disposeFiber(fiber: CapabilityFiber): Promise<void> {
  await Promise.resolve(fiber.dispose())
  while (fiber.inertia !== undefined) await fiber.inertia
}

export async function registerOnDemandTools(ctx: Context, wb: Workbench): Promise<void> {
  const agents = ctx.get('agents')
  const tools = ctx.get('tools')
  if (!agents || !tools) throw new Error('NAI on-demand tools require tools and agents services')
  const active = new Map<LiveAgent, Activation>()
  const locks = new Map<LiveAgent, Promise<unknown>>()
  let closing = false
  const capability = {
    name: 'dsh-novelai-atelier-demand-capabilities',
    inject: ['tools'],
    apply(capCtx: Context): void {
      registerTools(capCtx, wb)
      registerPromptingSkill(capCtx)
    },
  }
  const checkAgent = (agent: LiveAgent | undefined): LiveAgent => {
    if (closing || !agent || agents.get(agent.id) !== agent || !agent.ctx || scopeOf(agent.ctx) !== agent) {
      throw new Error('NAI capability activation requires the exact live requesting Agent')
    }
    return agent
  }
  const available = (agent: LiveAgent): boolean => Boolean(tools.get('nai_generate_image', agent) && tools.get('nai_workbench_status', agent))
  const count = (agent: LiveAgent): number => tools.schemas(agent).filter(tool => tool.name.startsWith('nai_') && tool.name !== BOOTSTRAP_TOOL).length
  const serial = <T>(agent: LiveAgent, task: () => Promise<T>): Promise<T> => {
    const previous = locks.get(agent)
    const work = (previous ? previous.catch(() => {}) : Promise.resolve()).then(task)
    locks.set(agent, work)
    void work.finally(() => { if (locks.get(agent) === work) locks.delete(agent) }).catch(() => {})
    return work
  }
  const mount = async (agent: LiveAgent): Promise<Activation> => {
    checkAgent(agent)
    const existing = active.get(agent)
    if (existing) return existing
    const state = { fiber: agent.ctx.plugin(capability) }
    active.set(agent, state)
    try {
      await state.fiber
      checkAgent(agent)
      if (!available(agent)) throw new Error('NAI capability registration did not complete')
      state.fiber.ctx.effect(() => () => { if (active.get(agent) === state) active.delete(agent) }, 'nai capability tracking')
      return state
    } catch (error) {
      if (active.get(agent) === state) active.delete(agent)
      await disposeFiber(state.fiber)
      throw error
    }
  }
  const unmount = async (agent: LiveAgent, state: Activation): Promise<void> => {
    if (active.get(agent) === state) active.delete(agent)
    await disposeFiber(state.fiber)
  }
  const setEnabled = async (agent: LiveAgent, enabled: boolean, signal?: AbortSignal) => serial(agent, async (): Promise<Record<string, string | number | boolean>> => {
    checkAgent(agent)
    signal?.throwIfAborted()
    const owned = active.get(agent)
    if (!owned && available(agent)) {
      return { enabled: true, source: 'preset', changed: false, tool_count: count(agent), note: enabled ? '工具已由当前模式提供' : '当前模式常驻提供工具，入口不会卸载模式能力' }
    }
    if (enabled) {
      if (owned) return { enabled: true, source: 'session', changed: false, tool_count: count(agent) }
      const state = await mount(agent)
      try { signal?.throwIfAborted(); persistActivation(wb, agent.id, true) }
      catch (error) { await unmount(agent, state); throw error }
      return { enabled: true, source: 'session', changed: true, tool_count: count(agent) }
    }
    persistActivation(wb, agent.id, false)
    if (owned) {
      try { await unmount(agent, owned) }
      catch (error) {
        persistActivation(wb, agent.id, true)
        await mount(agent)
        throw error
      }
    }
    return { enabled: false, source: 'off', changed: Boolean(owned), tool_count: count(agent) }
  })

  ctx.effect(() => tools.register(defineTool({
    name: BOOTSTRAP_TOOL,
    description: '用户需要NovelAI/NAI生图、编辑或提示词时，先启用本会话完整NAI工具与技能。enabled=false关闭本会话按需能力；不改变模式、不生成、不授权消费。',
    parameters: { enabled: { type: 'boolean', default: true, description: '默认true启用；false关闭本会话按需工具。' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) { return setEnabled(checkAgent(exec.agent), args.enabled !== false, exec.signal) },
  })), 'nai on-demand entry')

  const restore = async (agent: LiveAgent, signal?: AbortSignal): Promise<void> => {
    try {
      if (!enabledSessions(wb).has(agent.id)) return
      await setEnabled(agent, true, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      ctx.logger('dsh-novelai-atelier').warn('NAI capability restoration unavailable; inspect the activation marker and workbench storage')
    }
  }
  ctx.on('agent/created', async ({ agent, source, signal }) => {
    if (source === 'clear') {
      await serial(agent, async () => {
        checkAgent(agent)
        signal?.throwIfAborted()
        try { persistActivation(wb, agent.id, false) }
        catch { ctx.logger('dsh-novelai-atelier').warn('NAI capability reset could not be persisted; current session capabilities remain disabled') }
        const owned = active.get(agent)
        if (owned) await unmount(agent, owned)
      })
      return
    }
    await restore(agent, signal)
  })
  ctx.effect(() => async () => {
    closing = true
    await Promise.allSettled([...locks.values()])
    const states = [...active.values()]
    active.clear()
    await Promise.all(states.map(state => disposeFiber(state.fiber)))
  }, 'nai on-demand capability cleanup')

  // Late service attachment also restores already-live sessions after plugin reload.
  await Promise.all(agents.list().map(agent => restore(agent)))
}
