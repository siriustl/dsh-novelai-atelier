import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, truncateSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workbench } from '../src/workbench/app.ts'
import { prepareOperation } from '../src/core/operations.ts'
import { OutputSubdirSchema } from '../src/core/outputDirectory.ts'
import { decodePng, encodePng } from '../src/core/png.ts'
import { registerTools } from '../src/tools.ts'

const workbenches: Workbench[] = []
const png = () => encodePng(64, 64, new Uint8Array(64 * 64 * 4).fill(255), {
  text: [{ keyword: 'Description', text: 'private prompt' }],
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nai-upgrade-output-'))
  const wb = new Workbench(root)
  workbenches.push(wb)
  wb.settings.save({ output_directory: join(root, 'outputs') })
  const tools = new Map<string, any>()
  registerTools({ effect: (fn: () => void) => fn(), tools: { register: (tool: any) => tools.set(tool.name, tool) } } as never, wb)
  const run = (name: string, args: Record<string, unknown>) => tools.get(name).execute(args, { signal: new AbortController().signal })
  return { wb, tools, run }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const wb of workbenches.splice(0)) { wb.stop(); rmSync(wb.root, { recursive: true, force: true }) }
})

describe('explicit output categories', () => {
  it.each(['..', '.', 'a/b', 'a\\b', 'name.', 'CON', 'con.txt', 'LPT1.png', 'nul', 'a\u0000b', '   '])('rejects unsafe category %j', async (value) => {
    expect(OutputSubdirSchema.safeParse(value).success).toBe(false)
    await expect(prepareOperation({ prompt: 'landscape', output_subdir: value }, 'generate')).rejects.toThrow()
  })
  it('preserves valid dots and saves the receipt and image below the configured output root', async () => {
    const { wb } = fixture()
    const postOperation = vi.fn().mockResolvedValue(png())
    vi.spyOn(wb.executor, 'makeClient').mockReturnValue({ postOperation } as never)
    const prepared = await prepareOperation({ prompt: 'landscape', width: 64, height: 64, output_subdir: '  portraits.v2  ' }, 'generate')
    const result = await wb.executor.execute(prepared)
    const directory = join(wb.root, 'outputs', 'portraits.v2')
    expect(dirname(String(result['image_path']))).toBe(directory)
    expect(dirname(String(result['record_path']))).toBe(directory)
    expect(JSON.parse(readFileSync(String(result['record_path']), 'utf8')).request.output_subdir).toBe('portraits.v2')
    expect(postOperation).toHaveBeenCalledOnce()
  })
  it('does not apply a retired global default to queued jobs', async () => {
    const { wb } = fixture()
    wb.store.saveSettings({ ...wb.settings.raw(), default_output_subdir: 'legacy-global' })
    expect(wb.settings.public()).not.toHaveProperty('default_output_subdir')
    expect(() => wb.settings.save({ default_output_subdir: 'hidden-default' })).toThrow()
    vi.spyOn(wb, 'client').mockReturnValue({} as never)
    const execute = vi.spyOn(wb.executor, 'execute').mockResolvedValue({ artifact_paths: [] })
    await wb.runJob({ id: 'queued', operation: 'generate', request: { prompt: 'landscape' }, context: { output_directory: wb.root } })
    expect(execute.mock.lastCall?.[0].output_subdir).toBeNull()
    await wb.runJob({ id: 'queued', operation: 'generate', request: { prompt: 'landscape', output_subdir: 'explicit' }, context: { output_directory: wb.root } })
    expect(execute.mock.lastCall?.[0].output_subdir).toBe('explicit')
  })
  it('exposes Medium and outpaint consistently without changing tag suggestions', async () => {
    const { tools, run } = fixture()
    for (const name of ['nai_generate_image', 'nai_edit_image']) {
      expect(tools.get(name).parameters.properties.v5_tier.enum).toEqual(['high', 'medium'])
      expect(tools.get(name).parameters.properties.output_subdir).toBeDefined()
    }
    expect(tools.get('nai_edit_image').parameters.properties.operation.enum).toContain('outpaint')
    const presets = await run('nai_get_presets', { operation: 'outpaint' })
    for (const key of ['left', 'right', 'top', 'bottom', 'seam_overlap', 'v5_tier', 'output_subdir'])
      expect(presets.request_parameters[key]).toBeDefined()
    expect(tools.get('nai_suggest_tags').parameters.properties.source.enum).toContain('official')
  })
})

describe('non-destructive metadata cleaning tool', () => {
  it('rejects an oversized file before PNG decoding or writing any output', async () => {
    const { wb, run } = fixture()
    const source = join(wb.root, 'oversized.png')
    writeFileSync(source, png())
    truncateSync(source, 49 * 1024 * 1024)
    await expect(run('nai_image_info', { action: 'clean', path: source })).rejects.toThrow('48 MiB')
  })
  it.each(['source.png', 'source.PNG', 'source.bin'])('never overwrites %s or an earlier cleaned copy', async (filename) => {
    const { wb, run } = fixture()
    const source = join(wb.root, filename), original = png()
    writeFileSync(source, original)
    const first = await run('nai_image_info', { action: 'clean', path: source, mode: 'all' })
    const second = await run('nai_image_info', { action: 'clean', path: source, mode: 'all' })
    expect(readFileSync(source)).toEqual(original)
    expect(first.cleaned_path).not.toBe(source)
    expect(second.cleaned_path).not.toBe(first.cleaned_path)
    expect(decodePng(readFileSync(first.cleaned_path)).text).toEqual([])
    expect(decodePng(readFileSync(second.cleaned_path)).text).toEqual([])
  })
})
