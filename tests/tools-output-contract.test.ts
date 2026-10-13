import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { Workbench } from '../src/workbench/app.ts'
import { registerTools } from '../src/tools.ts'
import { decodePng, encodePng } from '../src/core/png.ts'

const require = createRequire(import.meta.url)
const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const { default: SystemPrompt } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-system-prompt')).href)
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nai-output-contract-')); roots.push(root)
  const wb = new Workbench(root)
  wb.settings.save({ output_directory: join(root, 'outputs') })
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRegistry, {})
  registerTools(ctx, wb, { legacyTools: true })
  let sequence = 0
  const run = (name: string, args: Record<string, unknown> = {}) => ctx.tools.execute({
    callId: `output-${++sequence}` as never, name, arguments: args, signal: new AbortController().signal,
  })
  return { root, wb, run, async dispose() { wb.stop(); await ctx.fiber.dispose() } }
}

function png() {
  return encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255), { text: [
    { keyword: 'Source', text: 'NovelAI Diffusion V5 0ADF9AB7' },
    { keyword: 'Comment', text: JSON.stringify({ prompt: 'tree', seed: 42, nested: { nullable: null, values: [0, false, '', { '__proto__': null, label: 'retained' }] } }) },
  ] })
}

function success(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['run']>>): any {
  expect(result, JSON.stringify(result)).toMatchObject({ isError: false })
  expect(result.value).toEqual(JSON.parse(JSON.stringify(result.value)))
  return result.value
}

describe('public tools through the real SDK output contract', () => {
  it('returns a real saved executor result, null cost, receipt status, and recovered request', async () => {
    const f = await fixture()
    try {
      const client = { postOperation: vi.fn().mockResolvedValue(png()), credits: vi.fn(() => { throw new Error('No billing calls allowed') }) }
      vi.spyOn(f.wb.executor, 'makeClient').mockReturnValue(client as never)
      const executed = vi.spyOn(f.wb.executor, 'execute') // Call through the actual executor, receipt writer and PNG decoder.
      const result = await f.run('nai_generate_image', { prompt: 'tree', width: 64, height: 64, seed: 42 })
      expect(client.postOperation).toHaveBeenCalledTimes(1)
      const raw = await executed.mock.results[0]!.value
      expect(raw).toHaveProperty('response_path', undefined)
      expect(existsSync(raw.image_path)).toBe(true)
      const value = success(result)
      expect(value).toMatchObject({ status: 'generated', anlas_spent: null, artifact_paths: [raw.image_path] })
      expect(Object.hasOwn(value, 'response_path')).toBe(false)
      expect(result.meta).toMatchObject({ anlas_spent: null, image_paths: [raw.image_path] })
      expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('![NovelAI output]') })]))
      const receipt = JSON.parse(readFileSync(value.record_path, 'utf8'))
      expect(receipt).toMatchObject({ status: 'generated', anlas_spent: null })
      for (const [name, args] of [
        ['nai_image_info', { action: 'operation', record_path: value.record_path }],
        ['nai_get_operation', { record_path: value.record_path }],
      ] as const) {
        expect(success(await f.run(name, args))).toMatchObject({ status: 'generated', anlas_spent: null, artifacts: [{ exists: true }], retained_response: { exists: false } })
      }
      expect(success(await f.run('nai_image_info', { action: 'recover', source_path: value.record_path }))).toMatchObject({ source_kind: 'operation_receipt', ready_to_reuse: true, request: { seed: 42, prompt: 'tree' } })
      expect(success(await f.run('nai_workbench_status', { job_id: f.wb.jobs()[0]!.id }))).toMatchObject({ job: { result: { anlas_spent: null } } })
      expect(client.postOperation).toHaveBeenCalledTimes(1)
      expect(client.credits).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })

  it('returns upscale receipts whose optional seed was never present', async () => {
    const f = await fixture()
    try {
      const path = join(f.root, 'source.png'); writeFileSync(path, png())
      const client = { postOperation: vi.fn().mockResolvedValue(encodePng(128, 128, new Uint8Array(128 * 128 * 4).fill(255))) }
      vi.spyOn(f.wb.executor, 'makeClient').mockReturnValue(client as never)
      const value = success(await f.run('nai_edit_image', { operation: 'upscale', image_path: path }))
      expect(value).toMatchObject({ status: 'generated', anlas_spent: null })
      const status = success(await f.run('nai_image_info', { action: 'operation', record_path: value.record_path }))
      expect(status).toMatchObject({ status: 'generated', anlas_spent: null })
      expect(Object.hasOwn(status, 'seed')).toBe(false)
      expect(status.model).toBe('nai-diffusion-5-curated')
      expect(client.postOperation).toHaveBeenCalledTimes(1)
    } finally { await f.dispose() }
  })

  it('retains raw nested image metadata and omits optional PNG text fields recursively', async () => {
    const f = await fixture()
    try {
      const bytes = png(), path = join(f.root, 'metadata.png'); writeFileSync(path, bytes)
      for (const [name, args] of [['nai_image_info', { action: 'inspect', path }], ['nai_inspect_image', { path }]] as const) {
        const value = success(await f.run(name, args))
        expect(value.metadata.Comment.nested).toEqual({ nullable: null, values: [0, false, '', { label: 'retained' }] })
      }
      // PNG iTXt decoder owns undefined lang/translatedKeyword; nested values
      // also occur in preparation receipts. Keep the real decoder output intact.
      const text = decodePng(bytes).text
      expect(text[0]).toHaveProperty('lang', undefined)
      const raw = { metadata: { png_text: text, cost: null, optional: undefined } }
      vi.spyOn(f.wb, 'prepare').mockResolvedValue(raw)
      const value = success(await f.run('nai_prepare_image', {}))
      expect(value.metadata).toEqual({ png_text: text.map(({ keyword, text }) => ({ keyword, text })), cost: null })
      expect(Object.hasOwn(raw.metadata, 'optional')).toBe(true)
      expect(Object.hasOwn(text[0]!, 'lang')).toBe(true)
    } finally { await f.dispose() }
  })

  it('normalizes optional tag, draft, status and library fields at every registered boundary', async () => {
    const f = await fixture()
    try {
      vi.spyOn(f.wb.executor, 'suggestTags').mockResolvedValue([{ tag: 'tree', japanese: undefined, count: undefined }])
      expect(success(await f.run('nai_suggest_tags', { query: 'tree' }))).toEqual({ tags: [{ tag: 'tree' }] })
      const saved = success(await f.run('nai_library_save', { name: 'Tree', kind: 'preset', prompt: 'tree' }))
      const id = saved.entry?.id ?? saved.id
      const entry = f.wb.store.getEntry(id)
      vi.spyOn(f.wb.store, 'getEntry').mockReturnValue({ ...entry, optional: undefined, data: { ...(entry.data as object), nested: { missing: undefined, cost: null } } })
      expect(success(await f.run('nai_library_read', { id })).entry.data.nested).toEqual({ cost: null })
      success(await f.run('nai_library_read'))
      success(await f.run('nai_draft', { action: 'list' }))
      success(await f.run('nai_draft', { action: 'read' }))
      success(await f.run('nai_workbench_status'))
      success(await f.run('nai_get_prompt_guide'))
    } finally { await f.dispose() }
  })

  it('preserves null, shared data and literal prototype keys without mutating the source', async () => {
    const f = await fixture()
    try {
      const shared = Object.assign(Object.create(null), { absent: undefined, nullable: null, zero: 0, empty: '', flag: false })
      const raw = { first: shared, second: shared, nested: JSON.parse('{"__proto__":{"kept":true},"constructor":"data","prototype":null}') }
      vi.spyOn(f.wb, 'prepare').mockResolvedValue(raw)
      const value = success(await f.run('nai_prepare_image'))
      expect(value).toEqual({ first: { nullable: null, zero: 0, empty: '', flag: false }, second: { nullable: null, zero: 0, empty: '', flag: false }, nested: raw.nested })
      expect(Object.hasOwn(value.nested, '__proto__')).toBe(true)
      expect(Object.hasOwn(shared, 'absent')).toBe(true)
    } finally { await f.dispose() }
  })

  it.each([
    ['undefined array entry', () => [undefined]], ['sparse array', () => new Array(1)],
    ['NaN', () => NaN], ['infinity', () => Infinity], ['negative zero', () => -0],
    ['bigint', () => 1n], ['function', () => () => 1], ['symbol', () => Symbol('invalid')],
    ['date', () => new Date(0)], ['map', () => new Map()], ['set', () => new Set()],
    ['typed array', () => new Uint8Array([1])], ['custom instance', () => new (class { optional = undefined })()],
    ['cycle', () => { const v: any = {}; v.self = v; return v }],
    ['symbol key', () => ({ [Symbol('invalid')]: 1 })],
    ['hidden property', () => Object.defineProperty({}, 'hidden', { value: 1 })],
    ['accessor', () => Object.defineProperty({}, 'optional', { enumerable: true, get() { return undefined } })],
    ['array property', () => Object.assign([], { optional: undefined })],
    ['toJSON', () => ({ toJSON() { return {} } })],
  ])('rejects %s instead of silently converting it to JSON', async (_name, makeValue) => {
    const f = await fixture()
    try {
      vi.spyOn(f.wb, 'prepare').mockResolvedValue({ nested: { invalid: makeValue() } })
      expect(await f.run('nai_prepare_image')).toMatchObject({ isError: true })
    } finally { await f.dispose() }
  })
})
