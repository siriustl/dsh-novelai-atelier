/** Operation execution: durable receipts, artifacts, and explicit submission outcomes. */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync, unlinkSync, readFileSync } from 'node:fs'
import { resolve as resolvePath, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { boundedUnzip } from './archive.ts'
import { NovelAIError, NovelAINotSubmitted, NovelAIClient, type NormalizedCredits } from './client.ts'
import { inspectImage } from './metadata.ts'
import { decodePng } from './png.ts'
import { postprocessInpaint, type PreparedOperation } from './operations.ts'
import { Raster } from './raster.ts'
import { decodeRaster } from './imageInputs.ts'

export const MAX_OUTPUT_PIXELS = 32 * 1024 * 1024

export interface ServiceConfig {
  token: () => string
  baseUrl: () => string
  proxy: () => string | null
  outputDir: () => string
  dataDir: () => string
  retryDelaySeconds?: () => number
  retryMaxAttempts?: () => number
}

export function defaultOutputDir(): string {
  return process.env['NOVELAI_OUTPUT_DIR'] || join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', 'Pictures', 'NovelAI')
}

/** Replace a receipt only after complete UTF-8 JSON is safely written. */
export function writeRecord(path: string, record: unknown): void {
  // JSON.stringify escapes lone surrogates, so ordinary Unicode stays readable and
  // malformed metadata survives as escapes.
  const content = Buffer.from(JSON.stringify(record, null, 2) + '\n', 'utf8')
  const tmp = join(dirname(path), `${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, content)
    const deadline = performance.now() + 200
    let waitSignal: Int32Array | undefined
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code
        const remaining = deadline - performance.now()
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 4 || remaining <= 0) throw error
        // Retry only this atomic commit, never the POST or a non-atomic overwrite.
        Atomics.wait(waitSignal ??= new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10 * 2 ** attempt, remaining))
        if (performance.now() >= deadline) throw error
      }
    }
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
}

interface UnpackedImage { bytes: Uint8Array; extension: string; width: number; height: number }

async function identifyImage(bytes: Uint8Array): Promise<{ extension: string; width: number; height: number }> {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const png = decodePng(bytes)
    return { extension: '.png', width: png.width, height: png.height }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const r = await decodeRaster(bytes, MAX_OUTPUT_PIXELS)
    return { extension: '.jpg', width: r.width, height: r.height }
  }
  if (bytes.length > 12 && Buffer.from(bytes.subarray(0, 4)).toString('latin1') === 'RIFF') {
    const r = await decodeRaster(bytes, MAX_OUTPUT_PIXELS)
    return { extension: '.webp', width: r.width, height: r.height }
  }
  throw new Error('unsupported format')
}

async function unpackImages(data: Uint8Array, expectedOutputs: number): Promise<UnpackedImage[]> {
  // ZIP multi-output (NovelAI returns a zip when several images share one job).
  const isZip = data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 3 || data[2] === 5 || data[2] === 7)
  let candidates: Uint8Array[]
  if (isZip) {
    let entries: Array<{ name: string; data: Uint8Array }>
    try {
      const unzipped = boundedUnzip(data, { bytes: 128 * 1024 * 1024, fileBytes: 48 * 1024 * 1024, files: 64, accept: (name) => /\.(png|webp|jpe?g)$/iu.test(name) })
      entries = Object.entries(unzipped)
        .filter(([name]) => !name.endsWith('/') && /\.(png|webp|jpe?g)$/iu.test(name))
        .map(([name, bytes]) => ({ name, data: bytes }))
    } catch {
      throw new NovelAIError('Generated image archive failed validation; original response retained')
    }
    if (entries.length !== expectedOutputs)
      throw new NovelAIError(`Expected ${expectedOutputs} image outputs; archive contains ${entries.length}`)
    const total = entries.reduce((a, e) => a + e.data.length, 0)
    if (entries.some((e) => e.data.length > 48 * 1024 * 1024) || total > 128 * 1024 * 1024)
      throw new NovelAIError('Image archive exceeds the size limit')
    // Archive filenames never become filesystem paths.
    candidates = entries.map((e) => e.data)
  } else if (expectedOutputs === 1) {
    candidates = [data]
  } else {
    throw new NovelAIError('Expected a multi-image archive')
  }
  const results: UnpackedImage[] = []
  for (const original of candidates) {
    try {
      const info = await identifyImage(original)
      if (info.width * info.height > MAX_OUTPUT_PIXELS)
        throw new NovelAIError('Generated image exceeds permitted format or pixel limits')
      results.push({ bytes: original, ...info })
    } catch (error) {
      if (error instanceof NovelAIError) throw error
      throw new NovelAIError('Generated image failed validation; original response retained')
    }
  }
  return results
}

/** Keep reproducible parameters and binary hashes instead of inline images. */
export function redactBinaryPayload(value: unknown, key = ''): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactBinaryPayload(v, k)]))
  }
  if (Array.isArray(value)) return value.map((v) => redactBinaryPayload(v, key))
  if (typeof value === 'string' && ['image', 'mask', 'reference_image', 'reference_image_multiple', 'reference_vibe_multiple', 'director_reference_images', 'encoding', 'encoded', 'data'].includes(key)) {
    return { inline_binary_omitted: true, base64_characters: value.length, sha256_base64: createHash('sha256').update(value, 'latin1').digest('base64') }
  }
  return value
}

export class OperationExecutor {
  private activeRuns = 0
  get activeExecutions(): number { return this.activeRuns }
  private lock: { run<T>(fn: () => Promise<T>): Promise<T> }
  constructor(private config: ServiceConfig, lock: { run<T>(fn: () => Promise<T>): Promise<T> }) {
    this.lock = lock
  }

  makeClient(signal?: AbortSignal): NovelAIClient {
    return new NovelAIClient({
      token: this.config.token(), baseUrl: this.config.baseUrl(), proxy: this.config.proxy(), signal,
      retryDelaySeconds: this.config.retryDelaySeconds?.(), retryMaxAttempts: this.config.retryMaxAttempts?.(),
    })
  }

  /** Run one prepared operation end-to-end and persist a recovery receipt. */
  async execute(operation: PreparedOperation, options: { client?: NovelAIClient; outputDir?: string; beforeSubmit?: () => void; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const warnings = [...operation.warnings]
    let submissionStarted = false
    this.activeRuns++
    try {
      return await this.lock.run(async () => {
        const client = options.client ?? this.makeClient(options.signal)
        options.signal?.throwIfAborted()
        options.beforeSubmit?.()
        options.signal?.throwIfAborted()
        const directory = resolvePath(options.outputDir ? expandDir(options.outputDir) : expandDir(this.config.outputDir()))
        mkdirSync(directory, { recursive: true })
        const stamp = new Date().toISOString().replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).*$/u, '$1$2$3T$4$5$6Z')
        const id = `${stamp}-${randomUUID().replaceAll('-', '').slice(0, 10)}`
        const recordPath = join(directory, `${id}.json`)
        const record: Record<string, unknown> = {
          id, operation: operation.operation, status: 'prepared',
          ...operation.summary, api_payload: redactBinaryPayload(operation.payload),
          endpoint: operation.endpoint, max_anlas: operation.max_anlas, warnings,
        }
        const save = () => writeRecord(recordPath, record)
        save()
        const paths: string[] = []
        record['artifact_paths'] = paths
        const dimensions: Array<{ width: number; height: number }> = []
        let postAttempted = false
        let responseReceived = false
        let confirmedNotSubmitted = false
        let operationError: NovelAIError | undefined
        const snapshot = (): Record<string, unknown> => ({
          id, operation: operation.operation, status: record['status'],
          artifact_paths: [...paths], record_path: recordPath, response_path: record['response_path'],
          max_anlas: operation.max_anlas,
          anlas_delta: null, anlas_spent: confirmedNotSubmitted ? 0 : null,
          submission_outcome_unknown: record['submission_outcome_unknown'] === true,
          not_submitted: confirmedNotSubmitted, warnings, dimensions,
          ...(operation.output_kind === 'vibe' ? { vibe_path: paths[0] } : { image_path: paths[0], image_paths: [...paths] }),
        })
        try {
          record['status'] = 'submitted'
          save()
          postAttempted = true
          submissionStarted = true
          const response = await client.postOperation(operation.endpoint, operation.payload, options.signal, options.beforeSubmit)
          responseReceived = true
          record['status'] = 'response_received'
          const responsePath = join(directory, `${id}.response`)
          try {
            writeFileSync(responsePath, response)
            record['response_path'] = responsePath
          } catch {
            warnings.push('Could not retain the original response; decoded image saving will still be attempted')
          }
          record['response_bytes'] = response.length
          record['response_sha256'] = createHash('sha256').update(response).digest('hex')
          try { save() } catch { warnings.push('Could not save the response receipt update; image saving will still be attempted') }
          if (operation.output_kind === 'vibe') {
            if (!response.length) throw new NovelAIError('NovelAI returned an empty Vibe encoding')
            const path = join(directory, `${id}.vibe`)
            writeFileSync(path, response)
            paths.push(path)
            record['vibe_sha256'] = createHash('sha256').update(response).digest('hex')
          } else {
            const outputs = await unpackImages(response, operation.expected_outputs)
            for (const [i, output] of outputs.entries()) {
              const expected = operation.expected_dimensions?.[i]
              if (expected && (output.width !== expected.width || output.height !== expected.height))
                throw new NovelAIError('Generated image dimensions differ from the expected dimensions; original response saved')
            }
            for (const [i, output] of outputs.entries()) {
              let imageBytes = output.bytes
              let extension = output.extension
              let size = { width: output.width, height: output.height }
              if (operation.operation === 'inpaint') {
                const rawPath = join(directory, `${id}.raw${extension}`)
                writeFileSync(rawPath, imageBytes)
                record['raw_api_image_path'] = rawPath
                imageBytes = postprocessInpaint(operation.inpaint_context!.source.toPng(), operation.inpaint_context!.mask.toPng(), imageBytes, operation)
                extension = '.png'
                const composited = decodePng(imageBytes)
                size = { width: composited.width, height: composited.height }
                record['composited_inpaint'] = true
              }
              const suffix = i === 0 ? '' : `_${String(i + 1).padStart(2, '0')}`
              const path = join(directory, `${id}${suffix}${extension}`)
              writeFileSync(path, imageBytes)
              paths.push(path)
              dimensions.push(size)
            }
            record['image_path'] = paths[0]
            record['image_paths'] = paths
            try {
              record['image_metadata'] = inspectImage(paths[0]!)
            } catch {
              record['metadata_inspection_error'] = 'InspectionError'
              warnings.push('Image saved successfully; optional metadata inspection failed')
            }
          }
          record['status'] = 'generated'
          // Commit artifact paths before removing the original response: a
          // process interruption must leave either it or a recovery receipt.
          let artifactReceiptSaved = false
          try { save(); artifactReceiptSaved = true } catch {
            warnings.push('Image saved successfully; receipt update failed and the original response was retained')
          }
          if (artifactReceiptSaved && record['response_path']) {
            try {
              unlinkSync(responsePath)
              delete record['response_path']
            } catch {
              warnings.push('Image saved successfully; original response retained because cleanup failed')
            }
          }
        } catch (error) {
          const status = error instanceof NovelAIError ? error.status_code : undefined
          const rejected = status !== undefined && status >= 400 && status < 500 && status !== 408
          confirmedNotSubmitted = !postAttempted || error instanceof NovelAINotSubmitted ||
            (error instanceof NovelAIError && error.notSubmitted === true) || (!responseReceived && rejected)
          record['status'] = confirmedNotSubmitted ? 'prepared' : 'failed'
          if (confirmedNotSubmitted) record['not_submitted'] = true
          const errMsg = error instanceof Error ? error.message : String(error)
          record['error'] = errMsg
          if (error instanceof NovelAIError && error.server_message) record['server_message_untrusted'] = error.server_message
          const unresolvedPost = !confirmedNotSubmitted && postAttempted && !responseReceived
          if (unresolvedPost) {
            record['submission_outcome_unknown'] = true
            warnings.push('Generation outcome is unknown; this request will not be automatically retried.')
          }
          try { save() } catch { warnings.push('Could not update the operation receipt; retained outputs are still available') }
          operationError = confirmedNotSubmitted
            ? error instanceof NovelAINotSubmitted ? error : new NovelAINotSubmitted(error)
            : error instanceof NovelAIError ? error : new NovelAIError(`Operation could not be completed locally (${errMsg}); review saved outputs before submitting again`)
          operationError.receiptPath = recordPath
          operationError.submission_outcome_unknown = unresolvedPost
          operationError.message += ` Receipt: ${recordPath}.`
          throw operationError
        } finally {
          record['anlas_delta'] = null
          record['anlas_spent'] = confirmedNotSubmitted ? 0 : null
          try { save() } catch { warnings.push('Could not save the final receipt update; saved outputs remain available') }
          if (operationError) operationError.partialResult = snapshot()
        }
        const result = snapshot()
        if (operation.output_kind === 'vibe') result['vibe_path'] = paths[0]
        else {
          result['image_path'] = paths[0]
          result['image_paths'] = paths
          result['dimensions'] = dimensions
        }
        if (operation.generation_request) {
          result['model'] = operation.payload['model']
          result['seed'] = (operation.payload['parameters'] as Record<string, unknown>)['seed']
        }
        if (dimensions.length) {
          result['width'] = dimensions[0]!.width
          result['height'] = dimensions[0]!.height
        }
        return result
      })
    } catch (error) {
      if (!submissionStarted && !(error instanceof NovelAINotSubmitted)) throw new NovelAINotSubmitted(error)
      throw error
    } finally { this.activeRuns-- }
  }

  credits(signal?: AbortSignal): Promise<NormalizedCredits> {
    return this.makeClient(signal).credits(signal)
  }

  suggestTags(prompt: string, model: string, language: 'en' | 'jp', signal?: AbortSignal) {
    return this.makeClient(signal).suggestTags(prompt, model, language, signal)
  }
}

function expandDir(path: string): string {
  return resolvePath(path.replace(/^~(?=\/|\\|$)/u, process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.'))
}

export function readReceipt(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}
