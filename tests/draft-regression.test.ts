import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/workbench/store.ts'
import { DraftSaveQueue } from '../client/draft-save.ts'
import { reconcileBootstrap } from '../client/shell.tsx'

const roots: string[] = []
const makeStore = () => { const root = mkdtempSync(join(tmpdir(), 'nai-draft-regression-')); roots.push(root); return { root, store: new Store(root) } }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('draft storage without automatic history', () => {
  it('edits and operation switches only update the same draft, preserving explicit versions', () => {
    const { root, store } = makeStore()
    store.saveVersion('main', 'A named checkpoint', 0)
    const checkpoint = store.listVersions('main')[0]
    for (let i = 0; i < 120; i++) store.saveDraft({ id: 'main', operation: i % 2 ? 'generate' : 'img2img', request: { prompt: `edit ${i}` } }, i)
    expect(store.listDrafts()).toHaveLength(1)
    expect(store.data.draft_versions).toHaveLength(1)
    expect(store.listVersions('main')[0]).toEqual(checkpoint)
    expect(new Store(root).getDraft()).toMatchObject({ id: 'main', revision: 120, request: { prompt: 'edit 119' } })
    const copy = store.createDraft({ name: 'Copy' }, false)
    expect(store.listVersions(String(copy.id))).toHaveLength(0)
    expect(store.data.draft_versions).toHaveLength(1)
  })

  it('hides old unnamed automatic snapshots without removing or rewriting them', () => {
    const { root, store } = makeStore()
    const data = store.data.drafts[0]!.data
    store.data.draft_versions.push({ id: 'automatic', draft_id: 'main', revision: 0, name: '', data, created_at: 'old' })
    store.saveVersion('main', '创建草稿', 0) // This could be a user name; never guess based on its text.
    const file = join(root, 'workbench.json')
    const before = readFileSync(file, 'utf8')
    const restarted = new Store(root)
    expect(restarted.listVersions('main').map((version) => version.name)).toEqual(['创建草稿'])
    expect(restarted.data.draft_versions).toHaveLength(2)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('does not write or increase revisions for unchanged saves or reactivating the same draft', () => {
    const { store } = makeStore()
    const save = vi.spyOn(store as any, 'save')
    const current = store.getDraft()
    const request = Object.fromEntries(Object.entries(current.request as object).reverse())
    expect(store.saveDraft({ ...current, request }, 0).revision).toBe(0)
    store.switchDraft('main')
    expect(save).not.toHaveBeenCalled()
    store.saveDraft({ name: 'changed' }, 0)
    expect(() => store.saveDraft({ name: 'changed' }, 0)).toThrow('草稿已被更新')
  })

  it('can delete the last default draft and keeps a clean replacement across restart', () => {
    const { root, store } = makeStore()
    store.saveDraft({ request: { prompt: 'discard me' } }, 0)
    store.saveVersion('main', 'Retain named version', 1)
    expect(() => store.deleteDraft('main', 0)).toThrow('草稿已修改')
    const next = store.deleteDraft('main', 1)
    expect(next.id).not.toBe('main')
    expect(next.revision).toBe(0)
    expect((next.request as any).prompt).toBe('')
    expect(store.listDrafts()).toHaveLength(1)
    expect(() => store.getDraft('main')).toThrow()
    expect(store.listVersions('main')).toHaveLength(1)
    expect(new Store(root).getDraft()).toEqual(next)
    expect(store.data.draft_versions).toHaveLength(1)
  })

  it('deletes an inactive default draft without changing the active draft', () => {
    const { store } = makeStore()
    const current = store.createDraft({ name: 'Active' })
    expect(store.deleteDraft('main', 0)).toEqual(current)
    expect(store.listDrafts()).toEqual([current])
  })

  it('restores a named version with the current revision, replacing extra request fields', () => {
    const { root, store } = makeStore()
    store.saveVersion('main', 'Clean', 0)
    store.saveDraft({ operation: 'inpaint', request: { prompt: 'later', mask_path: 'remove-me' }, library_refs: [{ id: 'ref' }] }, 0)
    const version = store.listVersions('main')[0]!
    const restored = store.saveDraft({ ...(version.data as any), id: 'main' }, 1)
    expect(restored).toMatchObject({ revision: 2, operation: 'generate', library_refs: [] })
    expect(restored.request).not.toHaveProperty('mask_path')
    expect(new Store(root).getDraft()).toEqual(restored)
    expect(store.listVersions('main')).toHaveLength(1)
  })

  it('rolls back in-memory revision when persistence fails so a retry uses the original revision', () => {
    const { store } = makeStore()
    const save = vi.spyOn(store as any, 'save').mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => store.saveDraft({ name: 'retry me' }, 0)).toThrow('disk full')
    expect(store.getDraft().revision).toBe(0)
    save.mockRestore()
    expect(store.saveDraft({ name: 'retry me' }, 0).revision).toBe(1)
  })
})

describe('bounded editor autosaves', () => {
  it('combines a hundred edits into one request and flush skips the delay', async () => {
    vi.useFakeTimers()
    const send = vi.fn(async () => ({ revision: 1 }))
    const queue = new DraftSaveQueue(0, send, 250)
    const promises = Array.from({ length: 100 }, (_, i) => queue.enqueue({ operation: i % 2 ? 'generate' : 'img2img', request: { prompt: String(i) } }))
    expect(queue.status).toBe('saving')
    expect(send).not.toHaveBeenCalled()
    await queue.flush()
    await Promise.all(promises)
    expect(send).toHaveBeenCalledExactlyOnceWith({ operation: 'generate', request: { prompt: '99' } }, 0)
    expect(queue.status).toBe('saved')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('saves ordinary typing after the bounded delay without a flush', async () => {
    vi.useFakeTimers()
    const send = vi.fn(async () => ({ revision: 4 }))
    const queue = new DraftSaveQueue(3, send, 250)
    const pending = queue.enqueue({ request: { prompt: 'typed' } })
    await vi.advanceTimersByTimeAsync(249)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(send).toHaveBeenCalledOnce()
  })

  it('notifies recovery-cache listeners for newer edits during an in-flight save', async () => {
    let release!: (saved: Record<string, unknown>) => void
    const send = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { release = resolve })).mockResolvedValueOnce({ revision: 2 })
    const queue = new DraftSaveQueue(0, send)
    let latest = 'a'
    const cache: string[] = []
    queue.subscribe(() => cache.push(latest))
    const first = queue.enqueue({ request: { prompt: latest } })
    latest = 'ab'
    void queue.enqueue({ request: { prompt: latest } })
    expect(cache.at(-1)).toBe('ab')
    release({ revision: 1 })
    await first
    expect(send).toHaveBeenLastCalledWith({ request: { prompt: 'ab' } }, 1)
  })

  it('accepts a same-revision acknowledgement only when it confirms all sent content', async () => {
    const queue = new DraftSaveQueue(4, async (patch) => ({ ...patch, revision: 4 }))
    await queue.enqueue({ operation: 'generate', request: { prompt: 'unchanged' } })
    expect(queue.status).toBe('saved')
    const broken = new DraftSaveQueue(4, async () => ({ revision: 4, request: { prompt: 'wrong' } }))
    await expect(broken.enqueue({ request: { prompt: 'wanted' } })).rejects.toThrow('未确认')
    expect(broken.status).toBe('failed')
  })
})

describe('polling state identity', () => {
  it('retains the state object when polling returns unchanged content', () => {
    const current = { draft: { id: 'main', revision: 4, request: { prompt: 'latest' } }, jobs: [], paused: false }
    expect(reconcileBootstrap(current, structuredClone(current))).toBe(current)
    expect(reconcileBootstrap(current, { ...current, draft: { id: 'main', revision: 3 } })).toBe(current)
    const next = { ...current, jobs: [{ id: 'new', status: 'running' }] }
    expect(reconcileBootstrap(current, next)).toBe(next)
    const switched = { ...current, draft: { id: 'other', revision: 0 } }
    expect(reconcileBootstrap(current, switched)).toBe(switched)
  })
})
