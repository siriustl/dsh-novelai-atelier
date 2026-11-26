import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools } from '../src/tools.ts'
import { Workbench } from '../src/workbench/app.ts'
import { compileRequest, GenerationRequestSchema, validateRequest } from '../src/core/models.ts'

const directory = join(import.meta.dirname, '../assets/guides')
const guides = readdirSync(directory).filter((name) => name.endsWith('.md')).map((name) => ({ name, text: readFileSync(join(directory, name), 'utf8') }))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const registry = () => {
  const root = mkdtempSync(join(tmpdir(), 'nai-guide-contract-'))
  roots.push(root)
  const wb = new Workbench(root)
  const tools = new Map<string, any>()
  registerTools({ effect: (fn: () => void) => fn(), tools: { register: (tool: any) => tools.set(tool.name, tool) } } as never, wb)
  return tools
}

describe('packaged runtime guide contracts', () => {
  it('references only registered Agent tool names, never retired tool namespaces', () => {
    const tools = registry()
    const scheduleDescription = tools.get('nai_schedule_save').description
    expect(scheduleDescription).toContain('action:save')
    expect(scheduleDescription).toContain('action:delete')
    expect(scheduleDescription).not.toMatch(/per_image_anlas|(?<!max_)\btotal_anlas\b/)
    for (const { name, text } of guides) {
      expect(text, name).not.toMatch(/\bnovelai_[a-z][a-z0-9_]+/)
      for (const [tool] of text.matchAll(/\bnai_[a-z][a-z0-9_]+/g)) expect(tools.has(tool), `${name}: ${tool}`).toBe(true)
      const prose = text.replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g, '')
      expect(prose, name).not.toMatch(/\bMCP\b|\bstdio\b|\bSQLite\b|\bpython\b|7865|NOVELAI_WORKBENCH_URL/i)
      expect(text, name).not.toMatch(/(?:`|\]\()(?:research|outputs|references)\//)
    }
  })

  it('loads the same packaged text through the live guide tool route', async () => {
    const tools = registry()
    const signal = new AbortController().signal
    for (const { name, text } of guides) expect(await tools.get('nai_get_prompt_guide').execute({ topic: name.slice(0, -3) }, { signal })).toBe(text)
  })

  it('keeps neighboring Markdown topic links resolvable', () => {
    for (const { name, text } of guides) {
      for (const [, target] of text.matchAll(/\]\(([^\s)]+\.md)(?:#[^)]*)?\)/g)) {
        if (!/^https?:/i.test(target!)) expect(existsSync(join(directory, target!)), `${name}: ${target}`).toBe(true)
      }
    }
  })

  it('marks retained experiments as historical and validates all twelve authored examples offline', () => {
    for (const name of ['advanced.md', 'parameters.md', 'v5.md', 'examples.md', 'characters-artists.md', 'sources.md']) {
      const text = guides.find((guide) => guide.name === name)!.text
      expect(text.slice(0, 1500), name).toMatch(/historical|upstream|历史/i)
      expect(text, name).not.toMatch(/not new(?:ly)? tests of this DSH 0\.11|本次插件适配未新增在线生图测例/)
    }
    const examples = guides.find((guide) => guide.name === 'examples.md')!.text
    const requests = [...examples.matchAll(/```json\s*([\s\S]*?)```/g)]
    expect(requests).toHaveLength(12)
    const workbench = guides.find((guide) => guide.name === 'workbench.md')!.text
    for (const [, json] of workbench.matchAll(/```json\s*([\s\S]*?)```/g)) {
      const example = JSON.parse(json!)
      if (example.execution_mode === 'fixed') {
        expect(example.enabled).toBe(false)
        expect(() => GenerationRequestSchema.parse(example.request)).not.toThrow()
        expect(example.max_runs).toBeGreaterThan(0)
      }
    }
    for (const [, json] of requests) {
      const request = GenerationRequestSchema.parse(JSON.parse(json!))
      expect(() => { validateRequest(request); compileRequest(request) }).not.toThrow()
    }
  })
})
