import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { decodePng, encodePng } from '../src/core/png.ts'
import { Raster } from '../src/core/raster.ts'
import { prepareImage, PrepareImageRequestSchema } from '../src/core/preparation.ts'
import { addScheduleLibraryReference, removeScheduleLibraryReference, SchedulesPanel } from '../client/panels/schedules.tsx'
import { setReact, type ReactLike } from '../client/ui.tsx'
import type { Rec } from '../client/api.ts'

const roots: string[] = []
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'nai-remaining-review-'))
  roots.push(directory)
  return directory
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4)
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, 8 + data.length)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length)
  return chunk
}
function rgbTransparencyPng(key: [number, number, number]): Buffer {
  const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255]), { rgb: true })
  const transparency = Buffer.alloc(6)
  key.forEach((value, index) => transparency.writeUInt16BE(value, index * 2))
  return Buffer.concat([png.subarray(0, 33), pngChunk('tRNS', transparency), png.subarray(33)])
}

describe('8-bit RGB PNG transparency keys', () => {
  it('matches low-byte transparent RGB keys and agrees with Sharp', async () => {
    const input = rgbTransparencyPng([255, 0, 0])
    const decoded = decodePng(input)
    expect([...decoded.data]).toEqual([255, 0, 0, 0, 0, 0, 0, 255])
    expect(Buffer.from(decoded.data)).toEqual(await sharp(input).ensureAlpha().raw().toBuffer())
    expect(decoded).toMatchObject({ hasAlphaChannel: false, transparencyMetadata: true, mode: 'RGB' })
  })

  it('keeps a zero RGB key transparent without making red transparent', () => {
    expect([...decodePng(rgbTransparencyPng([0, 0, 0])).data]).toEqual([255, 0, 0, 255, 0, 0, 0, 0])
  })

  it('does not reinterpret a 16-bit-only key as a matching 8-bit value', () => {
    expect([...decodePng(rgbTransparencyPng([0xff00, 0, 0])).data]).toEqual([255, 0, 0, 255, 0, 0, 0, 255])
  })

  it('preserves explicit RGBA alpha pixels', () => {
    const pixels = new Uint8Array([255, 0, 0, 128, 0, 0, 0, 254])
    expect(decodePng(encodePng(2, 1, pixels)).data).toEqual(pixels)
  })
})

describe('bounded cover preparation', () => {
  it.each([[1024, 64, 64, 4096], [64, 1024, 4096, 64]])('rejects an oversized intermediate before resize (%i x %i)', async (sourceWidth, sourceHeight, width, height) => {
    const directory = root(), imagePath = join(directory, 'source.png')
    const source = encodePng(sourceWidth, sourceHeight, new Uint8Array(sourceWidth * sourceHeight * 4))
    writeFileSync(imagePath, source)
    const resize = vi.spyOn(Raster.prototype, 'resize')
    await expect(prepareImage(PrepareImageRequestSchema.parse({ image_path: imagePath, mode: 'cover', width, height }), directory))
      .rejects.toThrow(/intermediate exceeds the 16 megapixel limit/u)
    expect(resize).not.toHaveBeenCalled()
    expect(readFileSync(imagePath)).toEqual(source)
    expect(readdirSync(directory)).toEqual(['source.png'])
  })

  it('keeps normal centered cover crops unchanged', async () => {
    const directory = root(), imagePath = join(directory, 'source.png')
    const pixels = new Uint8Array(128 * 64 * 4)
    for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
      const offset = (y * 128 + x) * 4
      pixels[offset] = x
      pixels[offset + 3] = 255
    }
    const source = encodePng(128, 64, pixels)
    writeFileSync(imagePath, source)
    const result = await prepareImage(PrepareImageRequestSchema.parse({ image_path: imagePath, mode: 'cover', width: 64, height: 64 }), directory)
    const output = decodePng(readFileSync(String(result.image_path)))
    expect([output.width, output.height]).toEqual([64, 64])
    expect([...output.data.subarray(0, 4)]).toEqual([32, 0, 0, 255])
    expect([...output.data.subarray(63 * 4, 64 * 4)]).toEqual([95, 0, 0, 255])
    expect(readFileSync(imagePath)).toEqual(source)
  })
})

const artist = { id: 'artist', kind: 'artist', name: 'Artist', data: { prompt: 'artist:one', negative_prompt: 'artist:negative' } }
const character = { id: 'character', kind: 'character', name: 'Character', data: { prompt: 'red hair', negative_prompt: 'blue hair' } }
function plan(mode: string): Rec {
  return {
    name: 'reference plan', execution_mode: mode, kind: 'daily', timezone: 'Asia/Shanghai', time: '09:00',
    request: { prompt: 'user prompt', negative_prompt: 'user negative', characters: [{ prompt: 'user character' }] },
    ai_recipe: { instruction: 'draw', library_refs: [], fixed_prompt: 'artist:one', fixed_negative_prompt: 'artist:negative' },
  }
}
function nodes(value: any): Rec[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object') return []
  return [value, ...nodes(value.props?.children)]
}
function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join('')
  return value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')
}
function renderHarness(initial: any[] = []) {
  let cursor = 0
  const slots = initial.slice()
  const runtime = {
    createElement(type: any, props: Rec | null, ...children: unknown[]) {
      return { $$typeof: Symbol.for('react.element'), type, props: { ...props, children } }
    },
    useState(value: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof value === 'function' ? value() : value
      return [slots[index], (next: any) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(value: any) { const index = cursor++; return slots[index] ??= { current: value } },
    useMemo(fn: () => unknown) { cursor++; return fn() },
    useCallback(fn: any) { cursor++; return fn },
    useEffect() { cursor++ },
  } as ReactLike
  return {
    slots,
    render(component: (props: any) => Rec, props: any) { setReact(runtime); cursor = 0; return component(props) },
  }
}

describe('schedule reference ownership', () => {
  it.each([artist, character])('keeps AI $kind bindings out of baseline and handwritten fixed text', (entry) => {
    const original = plan('ai'), before = structuredClone(original)
    const added = addScheduleLibraryReference(original, entry)
    expect(added.ai_recipe.library_refs).toEqual([entry.id])
    expect(added.request).toEqual(original.request)
    expect(added.ai_recipe.fixed_prompt).toBe(original.ai_recipe.fixed_prompt)
    expect(added.ai_recipe.fixed_negative_prompt).toBe(original.ai_recipe.fixed_negative_prompt)
    expect(original).toEqual(before)
    const reopened = JSON.parse(JSON.stringify(added))
    expect(removeScheduleLibraryReference(reopened, entry.id)).toEqual(original)
  })

  it('does not duplicate an already-selected fixed snapshot', () => {
    const added = addScheduleLibraryReference(plan('fixed'), character)
    expect(added.request.characters).toHaveLength(2)
    expect(addScheduleLibraryReference(added, character)).toBe(added)
  })

  it.each([artist, character])('removes only fixed $kind provenance and preserves applied snapshot contents', (entry) => {
    const added = addScheduleLibraryReference(plan('fixed'), entry)
    const removed = removeScheduleLibraryReference(added, entry.id)
    expect(removed.ai_recipe.library_refs).toEqual([])
    expect(removed.request).toEqual(added.request)
    expect(removed.ai_recipe.fixed_prompt).toBe('artist:one')
    expect(removed.ai_recipe.fixed_negative_prompt).toBe('artist:negative')
    expect(added.ai_recipe.library_refs).toEqual([entry.id])
  })

  it.each([
    ['ai', '移除绑定', '手写固定片段保持不变'],
    ['fixed', '移除来源标签', '已应用的固定提示词和角色保持不变'],
  ])('labels the %s removal action according to its semantics', (mode, label, hint) => {
    const current = addScheduleLibraryReference(plan(mode), artist)
    const panel = renderHarness([[], current])
    const panelTree = panel.render(SchedulesPanel, { state: { paused: false } })
    const editor = nodes(panelTree).find((node) => typeof node.type === 'function' && node.type.name === 'PlanEditor')!
    expect(editor).toBeDefined()
    const harness = renderHarness()
    const tree = harness.render(editor.type, editor.props)
    const remove = nodes(tree).find((node) => node.type === 'button' && text(node) === label)!
    expect(remove).toBeDefined()
    expect(remove.props.title).toContain(hint)
    remove.props.onClick()
    expect(harness.slots[0].ai_recipe.library_refs).toEqual([])
    expect(harness.slots[0].request).toEqual(current.request)
  })
})
