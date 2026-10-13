import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/workbench/store.ts'
import { prepareGeneration } from '../src/core/operations.ts'
import { GenerationRequestSchema, compileRequest } from '../src/core/models.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'nai-store-'))

describe('store', () => {
  it('draft revisions bump and conflict on stale revision', () => {
    const dir = tmp()
    try {
      const store = new Store(dir)
      const draft = store.getDraft()
      expect(draft['revision']).toBe(0)
      const saved = store.saveDraft({ request: { ...draft['request'] as object, prompt: 'hello' } }, 0)
      expect(saved['revision']).toBe(1)
      expect(() => store.saveDraft({ request: { prompt: 'x' } }, 0)).toThrow(/已被更新/)
      expect(store.listVersions('main')).toHaveLength(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('entries validate kinds, branches and blends', () => {
    const dir = tmp()
    try {
      const store = new Store(dir)
      const artist = store.saveEntry({ kind: 'artist', name: 'a1', data: { prompt: 'artist:aa' } })
      expect(artist['revision']).toBe(0)
      const character = store.saveEntry({ kind: 'character', name: 'char1', data: { prompt: '1girl' } })
      const branch = store.saveEntry({ kind: 'branch', name: 'b1', parent_id: character['id'], data: { prompt: 'smile' } })
      expect(branch['parent_id']).toBe(character['id'])
      expect(branch['parent_name']).toBe('char1')
      expect(store.listEntries('char1', 'branch').length).toBe(1)
      expect(() => store.deleteEntry(character['id'])).toThrow(/分支/)
      const blend = store.saveEntry({ kind: 'blend', name: 'mix', data: { artists: [{ id: artist['id'], weight: 0.8 }] } })
      expect(() => store.deleteEntry(artist['id'])).toThrow(/混合/)
      expect(store.listEntries('', 'character').length).toBe(1)
      void blend
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('job queue: idempotency, sequential claims and no legacy budget gating', () => {
    const dir = tmp()
    try {
      const store = new Store(dir)
      const snap = { operation: 'generate', request: { model: 'nai-diffusion-5-full', prompt: 'x', max_anlas: 5 } }
      const jobs = store.createJobs([structuredClone(snap), structuredClone(snap)], 0, 'key-1')
      expect(jobs).toHaveLength(2)
      expect(store.createJobs([structuredClone(snap), structuredClone(snap)], 0, 'key-1').map((job) => job.id)).toEqual(jobs.map((job) => job.id))
      expect(() => store.createJobs([{ ...snap, request: { ...snap.request, prompt: 'different' } }], 0, 'key-1')).toThrow(/同一幂等键/)
      const claimed = store.claimJob()!
      expect(claimed).toMatchObject({ id: jobs[0]!.id, status: 'running' })
      expect(store.claimJob()).toBeNull()
      const done = store.finishJob(String(claimed.id), { result: { anlas_spent: 20 } })
      expect(done).toMatchObject({ status: 'completed', actual_anlas: 20 })
      const second = store.claimJob()!
      expect(second).toMatchObject({ id: jobs[1]!.id, status: 'running' })
      expect(store.finishJob(String(second.id), { result: {} })).toMatchObject({ status: 'completed', actual_anlas: null })
      expect(store.getPaused()).toBe(false)
      expect(store.getBatch(String(done.batch_id))).toMatchObject({ spent: 20, reserved: 0 })
      const overLegacyCeiling = store.createJobs([{ ...snap, request: { ...snap.request, max_anlas: 9 } }], 0, 'key-2')
      expect(store.claimJob()).toMatchObject({ id: overLegacyCeiling[0]!.id, status: 'running' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('schedules: fixed tick creates jobs and computes next run', () => {
    const dir = tmp()
    try {
      const store = new Store(dir)
      const past = new Date(Date.now() - 3600_000).toISOString()
      const schedule = store.saveSchedule({
        name: 't1', kind: 'once', at: past, operation: 'generate',
        request: { model: 'nai-diffusion-5-full', prompt: 'p', max_anlas: 0 }, count: 2, max_total_anlas: 0, max_runs: 5,
        enabled: true, missed_policy: 'once', seed_mode: 'increment',
      })
      expect(schedule['next_run']).toBeTruthy()
      const created = store.tickSchedules()
      expect(created.length).toBe(2)
      expect(created[0]!['operation']).toBe('generate')
      const runs = store.listScheduleRuns(schedule['id'] as string)
      expect(runs.length).toBe(1)
      expect(runs[0]!['outcome']).toBe('queued')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('conversations: save, messages, fork', () => {
    const dir = tmp()
    try {
      const store = new Store(dir)
      const conv = store.saveConversation({ title: '测试会话' })
      store.addMessage(conv['id'] as string, 'user', '你好')
      store.addMessage(conv['id'] as string, 'assistant', '好的')
      const refetched = store.getConversation(conv['id'] as string)
      const forked = store.forkConversation(conv['id'] as string, (refetched['messages'] as Rec[])[0]!['id'] as string)
      expect((forked['messages'] as Rec[]).length).toBe(1)
      expect(forked['title']).toContain('分支')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('core', () => {
  it('compileRequest produces official payload shape', () => {
    const request = GenerationRequestSchema.parse({ prompt: '1girl, smile', width: 832, height: 1216, seed: 42 })
    const { payload, warnings } = compileRequest(request)
    expect(payload['model']).toBe('nai-diffusion-5-full')
    expect((payload['parameters'] as Rec)['seed']).toBe(42)
    expect(String((payload['parameters'] as Rec)['negative_prompt'])).toContain('nsfw')
    expect(warnings).toEqual([])
  })

  it('prepareGeneration compiles inpaint model suffix on inpaint kind only via prepareOperation', async () => {
    const prepared = prepareGeneration(GenerationRequestSchema.parse({ prompt: 'x' }))
    expect(prepared.endpoint).toBe('/ai/generate-image')
    expect(prepared.operation).toBe('generate')
  })

  it('queue priority: manual jobs prioritize over scheduled batch jobs', () => {
    const dir = tmp()
    try {
      const store = new Store(dir)
      const snap = { operation: 'generate', request: { model: 'nai-diffusion-5-full', prompt: 'x', max_anlas: 0 } }
      // 1. Create a scheduled batch job (scheduleId = 'sched-1')
      const scheduledJobs = store.createJobs([structuredClone(snap)], 0, null, { scheduleId: 'sched-1' })
      expect(scheduledJobs.length).toBe(1)

      // 2. Later, a manual job is submitted from workspace (scheduleId = null)
      const manualJobs = store.createJobs([structuredClone(snap)], 0, null)
      expect(manualJobs.length).toBe(1)

      // 3. Claiming should pick the manual job FIRST despite scheduled job created earlier!
      const claimed = store.claimJob()
      expect(claimed?.['id']).toBe(manualJobs[0]!['id'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('png roundtrip keeps text chunks and alpha', async () => {
    const { encodePng, decodePng, stealthMetadata } = await import('../src/core/png.ts')
    const w = 64, h = 64
    const rgba = new Uint8Array(w * h * 4).fill(255)
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 254 // near-opaque alpha
    const png = encodePng(w, h, rgba, { text: [{ keyword: 'Comment', text: JSON.stringify({ prompt: '测试' }) }] })
    const decoded = decodePng(png)
    expect(decoded.width).toBe(w)
    expect(decoded.text[0]?.keyword).toBe('Comment')
    expect(JSON.parse(decoded.text[0]!.text)).toEqual({ prompt: '测试' })
    expect(decoded.data[3]).toBe(254)
    expect(stealthMetadata(w, h, decoded.data)).toBeNull()
  })
})
