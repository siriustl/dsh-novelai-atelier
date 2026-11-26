import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workbench } from '../src/workbench/app.ts'
import { prepareOperation, postprocessInpaint } from '../src/core/operations.ts'
import { encodePng, decodePng } from '../src/core/png.ts'
import { OperationExecutor } from '../src/core/service.ts'
import { recoverRequest } from '../src/core/recovery.ts'

const roots: string[] = []
const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'nai-backend-')); roots.push(root); return root }
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function solid(width: number, height: number, color: number[]): Uint8Array {
  const bytes = new Uint8Array(width * height * 4)
  for (let i = 0; i < bytes.length; i += 4) bytes.set(color, i)
  return bytes
}

async function focused() {
  const root = temporary()
  const sourcePixels = solid(64, 128, [20, 40, 60, 128])
  const maskPixels = solid(64, 128, [0, 0, 0, 255])
  for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) maskPixels.set([255, 255, 255, 255], (y * 64 + x) * 4)
  const source = encodePng(64, 128, sourcePixels)
  const mask = encodePng(64, 128, maskPixels)
  const imagePath = join(root, 'source.png'), maskPath = join(root, 'mask.png')
  writeFileSync(imagePath, source); writeFileSync(maskPath, mask)
  const prepared = await prepareOperation({ prompt: 'tree', image_path: imagePath, mask_path: maskPath, focus_box: [8, 8, 32, 40], focus_size: [64, 64] }, 'inpaint')
  return { source, mask, sourcePixels, prepared }
}

describe('focused inpaint compositing', () => {
  it('accepts the API tile and preserves every unmasked source RGBA pixel', async () => {
    const { source, mask, sourcePixels, prepared } = await focused()
    const generated = encodePng(64, 64, solid(64, 64, [200, 100, 50, 255]))
    const result = decodePng(postprocessInpaint(source, mask, generated, prepared))
    expect([result.width, result.height]).toEqual([64, 128])
    for (let y = 0; y < 128; y++) for (let x = 0; x < 64; x++) {
      const offset = (y * 64 + x) * 4
      const actual = Array.from(result.data.slice(offset, offset + 4))
      expect(actual).toEqual(x >= 12 && x < 20 && y >= 12 && y < 20 ? [200, 100, 50, 255] : Array.from(sourcePixels.slice(offset, offset + 4)))
    }
  })

  it('rejects source-canvas-sized output when the compiled tile is smaller', async () => {
    const { source, mask, prepared } = await focused()
    expect(() => postprocessInpaint(source, mask, encodePng(64, 128, solid(64, 128, [1, 2, 3, 255])), prepared)).toThrow(/API tile/)
  })
})

function workbench(): Workbench {
  const wb = new Workbench(temporary())
  const draft = wb.store.getDraft()
  wb.store.saveDraft({ request: { ...(draft.request as object), prompt: 'forest' } }, Number(draft.revision))
  return wb
}

describe('img2img request compilation and receipt recovery', () => {
  function image() {
    const root = temporary(), path = join(root, 'source.png')
    const pixels = encodePng(64, 64, solid(64, 64, [20, 40, 60, 255]))
    writeFileSync(path, pixels)
    return { root, path, pixels }
  }

  it('uses img2img strength 0.7 while enhance retains strength 0.2', async () => {
    const { path } = image()
    const input = { prompt: 'forest', image_path: path }
    const img2img = await prepareOperation(input, 'img2img')
    const enhance = await prepareOperation(input, 'enhance')
    expect((img2img.payload.parameters as any).strength).toBe(0.7)
    expect((enhance.payload.parameters as any).strength).toBe(0.2)
    expect(img2img.summary.request).not.toHaveProperty('mode')
    expect(img2img.summary.request).not.toHaveProperty('append_enhance_tags')
    expect(enhance.summary.request).toHaveProperty('mode', 'regular')
  })

  it('roundtrips a mocked successful img2img receipt without unsupported fields', async () => {
    const { root, path, pixels } = image()
    const credits = { active: true, tier: 3, expires_at: Date.now() / 1000 + 86400, anlas: { subscription: 100, purchased: 0, total: 100 }, perks: {}, v5_usage: { isNegative: false }, v5_usage_summary: null }
    const client: any = { credits: vi.fn().mockResolvedValue(credits), postOperation: vi.fn().mockResolvedValue(pixels) }
    const executor = new OperationExecutor({ token: () => '', baseUrl: () => 'https://image.novelai.net', proxy: () => null, outputDir: () => root, dataDir: () => root }, { run: async (fn) => fn() })
    const prepared = await prepareOperation({ prompt: 'forest', image_path: path, seed: 123 }, 'img2img')
    const result = await executor.execute(prepared, { client })
    const recovered = await recoverRequest(String(result.record_path))
    expect(recovered.ready_to_reuse).toBe(true)
    expect(recovered.exact_payload_match).toBe(true)
    expect(recovered.unsupported_fields).toEqual([])
    expect(recovered.unknown_fields).toEqual([])
    expect((recovered.request as any).strength).toBe(0.7)
    expect((recovered.request as any).max_anlas).toBe(0)
    expect(client.postOperation).toHaveBeenCalledOnce()
  })
})

describe('submission cancellation boundaries', () => {
  it('does not validate or persist new jobs for an already aborted call', async () => {
    const wb = workbench(); const validate = vi.spyOn(wb, 'validate')
    await expect(wb.submitJobs({ request: { prompt: 'forest' } }, 'abort-before', AbortSignal.abort())).rejects.toThrow()
    expect(validate).not.toHaveBeenCalled(); expect(wb.store.listJobs()).toHaveLength(0)
  })

  it('does not freeze settings or persist jobs when aborted during asynchronous validation', async () => {
    const wb = workbench(); const controller = new AbortController()
    const freeze = vi.spyOn(wb.settings, 'freeze')
    vi.spyOn(wb, 'validate').mockImplementation(async () => { controller.abort(); return { valid: true, resolved_request: { prompt: 'forest' } } })
    await expect(wb.submitJobs({ request: { prompt: 'forest' } }, 'abort-validation', controller.signal)).rejects.toThrow()
    expect(freeze).not.toHaveBeenCalled(); expect(wb.store.listJobs()).toHaveLength(0)
  })

  it('does not persist jobs when aborted during a comparison variant validation', async () => {
    const wb = workbench(); const controller = new AbortController()
    const validate = wb.validate.bind(wb)
    vi.spyOn(wb, 'validate').mockImplementation(async (operation, request) => {
      const result = await validate(operation, request)
      if (request.scale === 5) controller.abort()
      return result
    })
    await expect(wb.submitJobs({ request: { prompt: 'forest' }, variants: [{ scale: 5 }] }, 'abort-variant', controller.signal)).rejects.toThrow()
    expect(wb.store.listJobs()).toHaveLength(0)
  })

  it('returns previously persisted idempotent jobs even when a later caller is aborted', async () => {
    const wb = workbench(); const body = { request: { prompt: 'forest' } }
    const first = await wb.submitJobs(body, 'acknowledged')
    const second = await wb.submitJobs(body, 'acknowledged', AbortSignal.abort())
    expect(second).toEqual(first); expect(wb.store.listJobs()).toHaveLength(1)
  })
})
