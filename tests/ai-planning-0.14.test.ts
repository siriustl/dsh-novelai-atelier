import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Assistant, type AssistantContext } from '../src/workbench/assistant.ts'
import { Store, type Rec } from '../src/workbench/store.ts'
import { Worker } from '../src/workbench/worker.ts'
import { Workbench } from '../src/workbench/app.ts'
import { createDshLlmBridge } from '../src/workbench/dshLlm.ts'

const roots: string[] = []
const root = () => { const p = mkdtempSync(join(tmpdir(), 'nai-planner-014-')); roots.push(p); return p }
afterEach(() => { vi.restoreAllMocks(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
const request = { model: 'nai-diffusion-5-full', prompt: 'no humans, scenery', seed: 42, max_anlas: 0 }
const propose = (prompt = 'no humans, blue teapot') => ({ role: 'assistant', content: 'A new scene.', usage: { inputTokens: 123, outputTokens: 25 }, tool_calls: [{ id: 'proposal', function: { name: 'propose_draft', arguments: JSON.stringify({ patch: { request: { prompt } } }) } }] })
const context = (chatComplete: AssistantContext['chatComplete']): AssistantContext => ({
  getDraft: () => ({ id: 'test', revision: 0, operation: 'generate', request, locked_fields: [], library_refs: [] }),
  getConfig: () => ({ max_output_tokens: 4096 }), getApiKey: () => '', chatComplete,
  searchLibrary: () => [], validate: async (_op, req) => ({ valid: true, resolved_request: req }),
  quote: async () => ({}), submit: async () => { throw new Error('No submission') },
})

function waiting() {
  let entered!: (value: AbortSignal) => void
  const started = new Promise<AbortSignal>((resolve) => { entered = resolve })
  const call = vi.fn(async (_payload: Rec, signal?: AbortSignal): Promise<Rec> => {
    if (!signal) throw new Error('Signal missing')
    entered(signal)
    return await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      if (signal.aborted) reject(signal.reason)
    })
  })
  return { started, call }
}

describe('bounded assistant planning', () => {
  it('ends after one validated proposal and retains actual DSH usage', async () => {
    const call = vi.fn(async () => propose())
    const result = await new Assistant(context(call)).planDraft('Compose a new scene.')
    expect(call).toHaveBeenCalledOnce()
    expect(result.usage).toEqual([{ inputTokens: 123, outputTokens: 25 }])
    expect((result.draft as any).request.prompt).toBe('no humans, blue teapot')
  })
  it('loads only short general rules by default and advertises on-demand topics without male', async () => {
    let payload!: Rec
    await new Assistant(context(async (p) => { payload = p; return propose() })).planDraft('Compose.')
    const text = String((payload.messages as Rec[])[0]!.content)
    expect(text.length).toBeLessThan(9000)
    const guides = ((payload.tools as any[]).find((t) => t.function.name === 'read_guide')).function.parameters.properties.topic.enum
    expect(guides).toContain('prompting'); expect(guides).not.toContain('male')
    expect((payload.tools as any[]).some((t) => t.function.name === 'submit_generation')).toBe(false)
  })
  it('forwards run-level signal during provider wait and never validates late output', async () => {
    const controller = new AbortController(), pending = waiting(), ctx = context(pending.call)
    const validate = vi.spyOn(ctx, 'validate')
    const task = new Assistant(ctx).run('Compose.', { signal: controller.signal })
    const signal = await pending.started
    controller.abort()
    expect(signal.aborted).toBe(true)
    expect(await task).toMatchObject({ cancelled: true, proposal: null, jobs: [] })
    expect(validate).not.toHaveBeenCalled()
  })
  it('rejects already cancelled planning without provider I/O', async () => {
    const call = vi.fn(async () => propose())
    await expect(new Assistant(context(call), { signal: AbortSignal.abort() }).planDraft('Compose.')).rejects.toThrow()
    expect(call).not.toHaveBeenCalled()
  })
  it('preserves locks despite a successful-looking provider response', async () => {
    const ctx = context(async () => propose()), original = ctx.getDraft
    ctx.getDraft = () => ({ ...original(), locked_fields: ['prompt'] })
    await expect(new Assistant(ctx, { maxRounds: 1 }).planDraft('Compose.')).rejects.toThrow(/未返回/)
  })
})

describe('assistant generation without monetary defense', () => {
  const submissions = () => ({ role: 'assistant', content: '', tool_calls: [1, 2].map((id) => ({ id: `submit-${id}`, function: { name: 'submit_generation', arguments: '{"count":1}' } })) })

  it('submits authorized images without a quote, monetary tool input or budget validation', async () => {
    let firstPayload!: Rec
    const call = vi.fn().mockImplementationOnce(async (payload: Rec) => { firstPayload = payload; return submissions() }).mockResolvedValueOnce({ content: 'Submitted.' })
    const ctx = context(call)
    ctx.quote = vi.fn(async () => { throw new Error('must not quote') })
    ctx.submit = vi.fn(async (_op, _request, count) => ({ jobs: Array.from({ length: count }, (_v, id) => ({ id: `job-${id}`, status: 'queued' })) }))
    const result = await new Assistant(ctx).run('Generate two images.', { allowGenerate: true, maxImages: 2, maxTotalAnlas: -100 })
    expect(result.jobs).toHaveLength(2)
    expect(ctx.quote).not.toHaveBeenCalled()
    expect(ctx.submit).toHaveBeenCalledTimes(2)
    const submitTool = (firstPayload.tools as Rec[]).find((tool) => (tool.function as Rec).name === 'submit_generation')!
    expect(((submitTool.function as Rec).parameters as Rec).properties).not.toHaveProperty('max_total_anlas')
    expect(String((firstPayload.messages as Rec[])[0]!.content)).not.toContain('max_total_anlas')
    const outputs = (call.mock.calls[1]![0].messages as Rec[]).filter((item) => item.role === 'tool').map((item) => JSON.parse(String(item.content)))
    expect(outputs).toEqual([expect.objectContaining({ remaining_images: 1 }), expect.objectContaining({ remaining_images: 0 })])
    expect(outputs.some((value) => 'remaining_anlas_authorization' in value)).toBe(false)
  })

  it('still enforces the authorized image count', async () => {
    const call = vi.fn().mockResolvedValueOnce(submissions()).mockResolvedValueOnce({ content: 'Done.' })
    const ctx = context(call)
    ctx.submit = vi.fn(async () => ({ jobs: [{ id: 'job', status: 'queued' }] }))
    const result = await new Assistant(ctx).run('Generate one image.', { allowGenerate: true, maxImages: 1 })
    expect(result.jobs).toHaveLength(1)
    expect(ctx.submit).toHaveBeenCalledOnce()
    expect((result.tool_steps as Rec[]).map((step) => step.ok)).toEqual([true, false])
  })

  it('never repeats a submission with an uncertain acknowledgment', async () => {
    const call = vi.fn().mockResolvedValueOnce(submissions()).mockResolvedValueOnce({ content: 'Acknowledgment unknown.' })
    const ctx = context(call)
    ctx.submit = vi.fn(async () => ({}))
    const result = await new Assistant(ctx).run('Generate two images.', { allowGenerate: true, maxImages: 2 })
    expect(ctx.submit).toHaveBeenCalledOnce()
    expect(result.jobs).toEqual([])
    expect((result.tool_steps as Rec[]).map((step) => step.ok)).toEqual([false, false])
  })

  it('does not expose or execute generation without explicit permission', async () => {
    const call = vi.fn().mockResolvedValueOnce(submissions()).mockResolvedValueOnce({ content: 'Suggestion only.' })
    const ctx = context(call)
    ctx.submit = vi.fn(async () => ({ jobs: [] }))
    const result = await new Assistant(ctx).run('Suggest a composition.')
    expect(ctx.submit).not.toHaveBeenCalled()
    expect(result.jobs).toEqual([])
  })
})

describe('scheduled model cancellation', () => {
  it.each(['edit', 'disable', 'delete', 'pause', 'stop'] as const)('aborts %s during real planner wait and leaves no image jobs', async (action) => {
    const wb = new Workbench(root()), pending = waiting()
    wb.setDshLlm({ complete: pending.call, describe: async () => ({}), catalog: async () => ({}), vision: false })
    const schedule = wb.store.saveSchedule({ name: 'test', kind: 'once', at: '2026-10-01T00:00:00Z', missed_policy: 'once', execution_mode: 'ai', request,
      operation: 'generate', ai_recipe: { instruction: 'Illustrated scenery, no people.' }, max_runs: 1 })
    const runner = vi.spyOn(wb, 'runJob')
    const task = wb.worker.tick('2026-10-01T00:00:00Z')
    const signal = await pending.started
    if (action === 'stop') wb.stop()
    else if (action === 'pause') wb.store.setPaused(true)
    else if (action === 'delete') wb.store.deleteSchedule(String(schedule.id))
    else wb.store.saveSchedule(action === 'edit' ? { name: 'changed' } : { enabled: false }, String(schedule.id))
    expect(signal.aborted).toBe(true)
    await task
    expect(wb.store.listJobs()).toHaveLength(0)
    expect(runner).not.toHaveBeenCalled()
    expect(wb.store.listScheduleRuns(String(schedule.id))[0]!.outcome).toBe('cancelled')
    wb.stop()
  })
  it('ignores a late successful planner when its signal is cancelled', async () => {
    const store = new Store(root())
    const schedule = store.saveSchedule({ name: 'test', kind: 'once', at: '2026-10-01T00:00:00Z', missed_policy: 'once', execution_mode: 'ai', request,
      operation: 'generate', ai_recipe: { instruction: 'Scenery' }, max_runs: 1 })
    let complete!: (p: Rec) => void, entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const runner = vi.fn(async () => ({ anlas_spent: 0 }))
    const worker = new Worker(store, runner, async () => { entered(); return await new Promise((resolve) => { complete = resolve }) })
    const task = worker.tick('2026-10-01T00:00:00Z')
    await started; store.saveSchedule({ enabled: false }, String(schedule.id))
    complete({ snapshots: [{ operation: 'generate', request }], ai_reply: 'late' })
    await task
    expect(store.listJobs()).toHaveLength(0); expect(runner).not.toHaveBeenCalled()
  })
  it('allows the final naturally disabled occurrence to complete with observability', async () => {
    const wb = new Workbench(root())
    const calls = vi.fn(async () => propose())
    wb.setDshLlm({ complete: calls, describe: async () => ({}), catalog: async () => ({}), vision: false })
    const schedule = wb.store.saveSchedule({ name: 'final', kind: 'once', at: '2026-10-01T00:00:00Z', missed_policy: 'once', execution_mode: 'ai', request,
      operation: 'generate', ai_recipe: { instruction: 'Scenery' }, max_runs: 1 })
    vi.spyOn(wb, 'runJob').mockResolvedValue({ anlas_spent: 0 })
    await wb.worker.tick('2026-10-01T00:00:00Z')
    expect(calls).toHaveBeenCalledOnce()
    const run = wb.store.listScheduleRuns(String(schedule.id))[0]!
    expect(run.outcome).toBe('completed')
    expect(run.usage).toEqual([{ inputTokens: 123, outputTokens: 25 }])
    expect(run.planning_metrics).toMatchObject({ guide_topics: ['prompting'], provider_calls: 1, estimation: true })
    expect(wb.store.getSchedule(String(schedule.id)).enabled).toBe(false)
  })
})

describe('AI recipe identity boundaries', () => {
  it('keeps frozen library composition out of the persisted editable base', async () => {
    const wb = new Workbench(root())
    const artist = wb.store.saveEntry({ kind: 'artist', name: 'Test style', data: { prompt: 'watercolor' } })
    const person = wb.store.saveEntry({ kind: 'character', name: 'Test identity', data: { prompt: 'boy, teal hair' } })
    const schedule = await wb.saveSchedule({ name: 'bound', enabled: false, kind: 'once', at: '2026-10-01T00:00:00Z', operation: 'generate', execution_mode: 'ai',
      request: { ...request, prompt: 'no humans, manual watercolor accent' }, ai_recipe: { instruction: 'Compose.', library_refs: [artist.id, person.id] } })
    const saved = wb.store.getSchedule(String(schedule.id))
    expect((saved.request as any).prompt).toBe('no humans, manual watercolor accent')
    expect((saved.request as any).characters).toEqual([])
    expect(saved.ai_library_snapshot).toHaveLength(2)
    const reloaded = new Workbench(wb.root)
    await reloaded.saveSchedule({ ai_recipe: { instruction: 'Compose.', library_refs: [] } }, String(schedule.id))
    const removed = reloaded.store.getSchedule(String(schedule.id))
    expect((removed.request as any).prompt).toBe('no humans, manual watercolor accent')
    expect((removed.request as any).characters).toEqual([])
    expect(removed.ai_library_snapshot).toEqual([])
  })
})

describe('public AI channel state', () => {
  it('does not stringify frozen job credentials into conversation history', () => {
    const wb = new Workbench(root())
    const draft = wb.store.getDraft()
    wb.store.saveDraft({ request: { ...request } }, Number(draft.revision))
    const jobs = wb.store.createJobs([{ operation: 'generate', request, context: { nai_secret: 'private-sealed-ref', proxy_url: 'private-proxy-url' } }], 0)
    const conv = wb.store.saveConversation({})
    wb.store.addMessage(String(conv.id), 'assistant', 'Previous job', { jobs: [{ id: jobs[0]!.id }] })
    const history = JSON.stringify(wb.conversations.context(String(conv.id)).history)
    expect(history).not.toContain('private-sealed-ref')
    expect(history).not.toContain('private-proxy-url')
  })
  it('distinguishes inherited defaults, explicit overrides and unavailable bridges', () => {
    const wb = new Workbench(root())
    expect(wb.settings.profiles()[0]).toMatchObject({ configuration_mode: 'inherit_default', status: 'bridge_unavailable', configured: false })
    wb.setDshLlm({ complete: async () => propose(), describe: async () => ({}), catalog: async () => ({}), vision: false })
    expect(wb.settings.profiles()[0]).toMatchObject({ configuration_mode: 'inherit_default', status: 'inherit_default', configured: true })
    wb.settings.save({ ai: { dsh_provider: 'chosen', dsh_model: 'model' } })
    expect(wb.settings.profiles()[0]).toMatchObject({ configuration_mode: 'override', status: 'override', configured: true })
    wb.setDshLlm(null)
    expect(wb.settings.profiles()[0]).toMatchObject({ configuration_mode: 'override', status: 'bridge_unavailable', configured: false })
  })
})

describe('DSH stream accounting', () => {
  it('retains exact provider token usage without estimating it', async () => {
    const usage = { inputTokens: 200, outputTokens: 50, cacheReadTokens: 30, reasoningTokens: 10 }
    const bridge = createDshLlmBridge({ async *stream() { yield { type: 'usage', usage }; yield { type: 'text-delta', text: 'OK' } } }, () => ({ provider: 'p', model: 'm' }))
    expect(await bridge.complete({ messages: [] })).toMatchObject({ content: 'OK', usage })
  })
})
