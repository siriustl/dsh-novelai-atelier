/** Official NovelAI Precise Reference image preprocessing (V5 97-bucket cover+crop & V4.5 black-padded canvas). */
import type { ImageInput } from './imageInputs.ts'

/** Official NovelAI V5 precise-reference resolution buckets (97 aspect buckets, ~1 MP, multiples of 64). */
export const V5_REFERENCE_BUCKETS: ReadonlyArray<readonly [number, number]> = [
  [256, 4096], [256, 4032], [256, 3968], [256, 3904], [256, 3840], [256, 3776], [256, 3712], [256, 3648],
  [256, 3584], [256, 3520], [256, 3456], [256, 3392], [256, 3328], [320, 3264], [320, 3200], [320, 3136],
  [320, 3072], [320, 3008], [320, 2944], [320, 2880], [320, 2816], [320, 2752], [384, 2688], [384, 2624],
  [384, 2560], [384, 2496], [384, 2432], [384, 2368], [448, 2304], [448, 2240], [448, 2176], [448, 2112],
  [512, 2048], [512, 1984], [512, 1920], [512, 1856], [576, 1792], [576, 1728], [576, 1664], [640, 1600],
  [640, 1536], [704, 1472], [704, 1408], [768, 1344], [768, 1280], [832, 1216], [896, 1152], [960, 1088],
  [1024, 1024], [1088, 960], [1152, 896], [1216, 832], [1280, 768], [1344, 768], [1408, 704], [1472, 704],
  [1536, 640], [1600, 640], [1664, 576], [1728, 576], [1792, 576], [1856, 512], [1920, 512], [1984, 512],
  [2048, 512], [2112, 448], [2176, 448], [2240, 448], [2304, 448], [2368, 384], [2432, 384], [2496, 384],
  [2560, 384], [2624, 384], [2688, 384], [2752, 320], [2816, 320], [2880, 320], [2944, 320], [3008, 320],
  [3072, 320], [3136, 320], [3200, 320], [3264, 320], [3328, 256], [3392, 256], [3456, 256], [3520, 256],
  [3584, 256], [3648, 256], [3712, 256], [3776, 256], [3840, 256], [3904, 256], [3968, 256], [4032, 256],
  [4096, 256],
]

/** Official NovelAI V4.5 precise-reference padded canvas sizes. */
export const V45_REFERENCE_CANVASES: ReadonlyArray<readonly [number, number]> = [
  [1024, 1536],
  [1472, 1472],
  [1536, 1024],
]

export interface V5BucketPlan {
  width: number
  height: number
  resizeWidth: number
  resizeHeight: number
  left: number
  top: number
  unchanged: boolean
}

/** Match NovelAI production `bucketCharacterReferences` log-aspect-ratio bucket selection and cover crop. */
export function pickV5ReferenceBucket(width: number, height: number): V5BucketPlan {
  const logRatio = Math.log(Math.max(width, 1) / Math.max(height, 1))
  let best = V5_REFERENCE_BUCKETS[0]!
  let bestDist = Math.abs(logRatio - Math.log(best[0] / best[1]))
  for (const bucket of V5_REFERENCE_BUCKETS) {
    const dist = Math.abs(logRatio - Math.log(bucket[0] / bucket[1]))
    if (dist < bestDist) {
      best = bucket
      bestDist = dist
    }
  }
  const [targetW, targetH] = best
  const scale = Math.max(targetW / width, targetH / height)
  const resizeWidth = Math.max(Math.floor(width * scale + 0.5), targetW)
  const resizeHeight = Math.max(Math.floor(height * scale + 0.5), targetH)
  return {
    width: targetW,
    height: targetH,
    resizeWidth,
    resizeHeight,
    left: Math.floor((resizeWidth - targetW) / 2),
    top: Math.floor((resizeHeight - targetH) / 2),
    unchanged: width === targetW && height === targetH,
  }
}

export interface V45CanvasPlan {
  width: number
  height: number
  resizeWidth: number
  resizeHeight: number
  offsetX: number
  offsetY: number
}

/** Match NovelAI production `resizeCharacterReferences` contain-fit + black-canvas padding. */
export function pickV45ReferenceCanvas(width: number, height: number): V45CanvasPlan {
  const ratio = width / height
  const [targetW, targetH] = V45_REFERENCE_CANVASES.reduce((best, candidate) =>
    Math.abs(ratio - candidate[0] / candidate[1]) < Math.abs(ratio - best[0] / best[1]) ? candidate : best)
  const factor = Math.min(targetW / width, targetH / height)
  const resizeWidth = Math.max(1, Math.round(width * factor))
  const resizeHeight = Math.max(1, Math.round(height * factor))
  return {
    width: targetW,
    height: targetH,
    resizeWidth,
    resizeHeight,
    offsetX: Math.floor((targetW - resizeWidth) / 2),
    offsetY: Math.floor((targetH - resizeHeight) / 2),
  }
}

export interface PreparedReferenceImage {
  base64: string
  prepared_width: number
  prepared_height: number
  preprocessing: 'v5_bucket_crop' | 'v45_black_pad'
}

/** Preprocess a validated reference image using sharp for fast Lanczos3 scaling and PNG encoding. */
export async function preparePreciseReferenceImage(source: ImageInput, v5: boolean): Promise<PreparedReferenceImage> {
  const { default: sharp } = await import('sharp')
  const { width, height, data } = source.image
  const raw = { width, height, channels: 4 as const }
  if (v5) {
    const plan = pickV5ReferenceBucket(width, height)
    let pipeline = sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw })
    if (!plan.unchanged) {
      pipeline = pipeline
        .resize(plan.resizeWidth, plan.resizeHeight, { fit: 'fill', kernel: 'lanczos3' })
        .extract({ left: plan.left, top: plan.top, width: plan.width, height: plan.height })
    }
    const png = await pipeline.png().toBuffer()
    return {
      base64: png.toString('base64'),
      prepared_width: plan.width,
      prepared_height: plan.height,
      preprocessing: 'v5_bucket_crop',
    }
  }

  const plan = pickV45ReferenceCanvas(width, height)
  const resized = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw })
    .resize(plan.resizeWidth, plan.resizeHeight, { fit: 'fill', kernel: 'lanczos3' })
    .flatten({ background: { r: 0, g: 0, b: 0 } })
    .extend({
      top: plan.offsetY,
      bottom: plan.height - plan.resizeHeight - plan.offsetY,
      left: plan.offsetX,
      right: plan.width - plan.resizeWidth - plan.offsetX,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .png()
    .toBuffer()
  return {
    base64: resized.toString('base64'),
    prepared_width: plan.width,
    prepared_height: plan.height,
    preprocessing: 'v45_black_pad',
  }
}
