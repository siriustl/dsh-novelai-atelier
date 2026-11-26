import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareImage, PrepareImageRequestSchema } from '../src/core/preparation.ts'
import { decodePng, encodePng } from '../src/core/png.ts'

const roots: string[] = []
function source() {
  const root = mkdtempSync(join(tmpdir(), 'nai-preparation-color-'))
  roots.push(root)
  const path = join(root, 'source.png')
  writeFileSync(path, encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255)))
  return { root, path }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('preparation padding color validation', () => {
  it.each(['rgb(256,0,0)', 'rgba(0,0,0,2)', 'rgba(0,0,0,0.5.5)'])('rejects %s instead of wrapping bytes or erasing alpha', async (background) => {
    const { root, path } = source()
    await expect(prepareImage(PrepareImageRequestSchema.parse({ image_path: path, width: 128, height: 128, mode: 'pad', background }), root))
      .rejects.toThrow(/background.*color/u)
    expect(readdirSync(root)).toEqual(['source.png'])
  })

  it.each([
    ['rgb(255,128,0)', [255, 128, 0, 255]],
    ['rgba(12,34,56,0.5)', [12, 34, 56, 128]],
    ['rgba(12,34,56,0)', [12, 34, 56, 0]],
  ] as const)('retains valid padding color %s', async (background, expected) => {
    const { root, path } = source()
    const result = await prepareImage(PrepareImageRequestSchema.parse({ image_path: path, width: 128, height: 128, mode: 'pad', background }), root)
    const output = decodePng(readFileSync(String(result.image_path)))
    expect([...output.data.subarray(0, 4)]).toEqual(expected)
    const sourceCorner = (32 * 128 + 32) * 4
    expect([...output.data.subarray(sourceCorner, sourceCorner + 4)]).toEqual([255, 255, 255, 255])
  })
})
