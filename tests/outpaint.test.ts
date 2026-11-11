import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync, unlinkSync } from 'node:fs'
import { prepareOperation, postprocessInpaint } from '../src/core/operations.ts'
import { Raster } from '../src/core/raster.ts'
import { encodePng, decodePng } from '../src/core/png.ts'

describe('Outpainting engine', () => {
  const tmpImg = join(tmpdir(), `test-outpaint-src-${Date.now()}.png`)
  const srcW = 256
  const srcH = 256

  beforeAll(() => {
    const srcData = new Uint8Array(srcW * srcH * 4)
    for (let i = 0; i < srcData.length; i += 4) {
      srcData[i] = 120 // R
      srcData[i + 1] = 150 // G
      srcData[i + 2] = 180 // B
      srcData[i + 3] = 255 // A
    }
    writeFileSync(tmpImg, encodePng(srcW, srcH, srcData))
  })

  afterAll(() => {
    try { unlinkSync(tmpImg) } catch {}
  })

  it('rejects when all expansion directions are zero', async () => {
    await expect(
      prepareOperation(
        {
          image_path: tmpImg,
          prompt: '1girl, scenery',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
        },
        'outpaint',
      ),
    ).rejects.toThrow('At least one of left, right, top, bottom must be greater than 0')
  })

  it('aligns dimensions to multiples of 64 and sets up seam overlap mask', async () => {
    const prepared = await prepareOperation(
      {
        image_path: tmpImg,
        prompt: '1girl, wide landscape',
        left: 50,
        right: 50,
        top: 100,
        bottom: 0,
        seam_overlap: 32,
        characters: [
          { prompt: '1girl, blue eyes', x: 0.5, y: 0.5 },
        ],
      },
      'outpaint',
    )

    expect(prepared.operation).toBe('outpaint')
    const params = prepared.payload['parameters'] as Record<string, unknown>
    expect(params['width']).toBe(384)
    expect(params['height']).toBe(384)
    expect(prepared.payload['action']).toBe('infill')
    expect(prepared.payload['model']).toContain('-inpainting')

    // Verify outpaint summary metadata
    const summary = prepared.summary as Record<string, any>
    expect(summary.outpaint).toBeDefined()
    expect(summary.outpaint.target_width).toBe(384)
    expect(summary.outpaint.target_height).toBe(384)
    expect(summary.outpaint.source_width).toBe(256)
    expect(summary.outpaint.source_height).toBe(256)

    // Character position re-mapping verification
    const req = summary.request as Record<string, any>
    expect(req.characters[0]).toMatchObject({ x: 0.5, y: 0.5 })
    const remappedChar = (params['v4_prompt'] as any).caption.char_captions[0].centers[0]
    expect(remappedChar.x).toBeCloseTo((128 + summary.outpaint.left) / 384, 3)
    expect(remappedChar.y).toBeCloseTo((128 + summary.outpaint.top) / 384, 3)
  })

  it('rejects explicit dimensions that disagree with the derived expansion canvas', async () => {
    await expect(prepareOperation({ image_path: tmpImg, prompt: 'scenery', left: 64, width: 256, height: 256 }, 'outpaint')).rejects.toThrow('Outpainting dimensions')
    await expect(prepareOperation({ image_path: tmpImg, prompt: 'scenery', left: 64, width: 320 }, 'outpaint')).rejects.toThrow('both width and height')
  })

  it.each(['left', 'right', 'top', 'bottom'] as const)('limits the seam to the expanded %s edge', async (direction) => {
    const prepared = await prepareOperation({ image_path: tmpImg, prompt: 'scenery', [direction]: 64, seam_overlap: 16 }, 'outpaint')
    const context = prepared.inpaint_context!
    const offset = prepared.summary.outpaint as Record<string, number>
    const left = offset.left!, top = offset.top!
    const maskAt = (x: number, y: number) => context.mask.data[(y * context.mask.width + x) * 4]
    const centerX = left + 128, centerY = top + 128
    expect(maskAt(centerX, centerY)).toBe(0)
    expect(maskAt(left, centerY)).toBe(direction === 'left' ? 255 : 0)
    expect(maskAt(left + srcW - 1, centerY)).toBe(direction === 'right' ? 255 : 0)
    expect(maskAt(centerX, top)).toBe(direction === 'top' ? 255 : 0)
    expect(maskAt(centerX, top + srcH - 1)).toBe(direction === 'bottom' ? 255 : 0)
  })

  it('preserves RGBA bytes outside the seam on a four-sided transparent source', async () => {
    const transparentPath = tmpImg + '.alpha.png'
    const source = Raster.blank(256, 256, [45, 67, 89, 128])
    try {
      writeFileSync(transparentPath, source.toPng())
      const prepared = await prepareOperation({ image_path: transparentPath, prompt: 'scenery', left: 16, right: 16, top: 16, bottom: 16, seam_overlap: 8 }, 'outpaint')
      const params = prepared.payload.parameters as Record<string, any>
      const uploaded = Raster.fromDecoded(decodePng(Buffer.from(params.image, 'base64')))
      const context = prepared.inpaint_context!
      const generated = Raster.blank(uploaded.width, uploaded.height, [0, 255, 0, 255])
      const result = decodePng(postprocessInpaint(context.source.toPng(), context.mask.toPng(), generated.toPng(), prepared))
      for (let i = 0; i < context.mask.data.length; i += 4) {
        if (context.mask.data[i] === 0) {
          expect(Array.from(uploaded.data.subarray(i, i + 4))).toEqual([45, 67, 89, 128])
          expect(Array.from(result.data.subarray(i, i + 4))).toEqual([45, 67, 89, 128])
        }
      }
    } finally { unlinkSync(transparentPath) }
  })

  it('composites and preserves unmasked source pixels after inpaint', async () => {
    const prepared = await prepareOperation(
      {
        image_path: tmpImg,
        prompt: '1girl, masterpiece',
        left: 64,
        right: 0,
        top: 0,
        bottom: 0,
        seam_overlap: 32,
      },
      'outpaint',
    )

    // Simulate API returned 320x256 image with neon green (0, 255, 0)
    const outW = 320
    const outH = 256
    const apiData = new Uint8Array(outW * outH * 4)
    for (let i = 0; i < apiData.length; i += 4) {
      apiData[i] = 0
      apiData[i + 1] = 255
      apiData[i + 2] = 0
      apiData[i + 3] = 255
    }
    const apiPng = encodePng(outW, outH, apiData)

    const compositedPng = postprocessInpaint(
      prepared.inpaint_context!.source.toPng(),
      prepared.inpaint_context!.mask.toPng(),
      apiPng,
      prepared,
    )

    const resultRaster = Raster.fromDecoded(
      await import('../src/core/png.ts').then((m) => m.decodePng(compositedPng)),
    )
    expect(resultRaster.width).toBe(outW)
    expect(resultRaster.height).toBe(outH)

    // In the strictly preserved region (e.g. at x = 64 + 32 + 20 = 116, y = 100),
    // pixels must remain the original source (120, 150, 180)
    const preservedOffset = (100 * outW + 116) * 4
    expect(resultRaster.data[preservedOffset]).toBe(120)
    expect(resultRaster.data[preservedOffset + 1]).toBe(150)
    expect(resultRaster.data[preservedOffset + 2]).toBe(180)

    // In the newly expanded region (e.g. at x = 10, y = 100),
    // pixels must be the generated green (0, 255, 0)
    const generatedOffset = (100 * outW + 10) * 4
    expect(resultRaster.data[generatedOffset]).toBe(0)
    expect(resultRaster.data[generatedOffset + 1]).toBe(255)
    expect(resultRaster.data[generatedOffset + 2]).toBe(0)
  })
})
