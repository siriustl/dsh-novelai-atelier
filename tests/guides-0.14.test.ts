import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const directory = join(import.meta.dirname, '../assets/guides')
const readGuide = (name: string) => readFileSync(join(directory, name), 'utf8')
const guides = readdirSync(directory).filter((name) => name.endsWith('.md'))

describe('0.14 guide context and evidence contracts', () => {
  it('keeps the shared prompting core and overview within bounded context', () => {
    const core = readGuide('prompting.md')
    expect(core.length).toBeLessThanOrEqual(5000)
    expect(readGuide('overview.md').length).toBeLessThanOrEqual(2500)
    for (const phrase of ['scenery', 'objects', 'gender', 'Base and individual slots', 'source#hug', '1.2::detail::', 'Text:', 'negative space', 'locked fields/budgets']) {
      expect(core, phrase).toContain(phrase)
    }
    expect(core).toContain('full topics are read only when needed')
    expect(core).toContain('Validation is not visual proof')
    expect(core).toContain('not universal optima')
  })

  it('removes the gender-specific topic without removing applicable V5 vocabulary', () => {
    expect(existsSync(join(directory, 'male.md'))).toBe(false)
    for (const name of guides) {
      const text = readGuide(name)
      expect(text, name).not.toMatch(/male\.md|`male`|DSH 0\.11|not new[^\n]*adaptation|适配未新增/)
    }
    expect(readGuide('v5.md')).toContain('`attractive male`')
    expect(readGuide('examples.md')).toContain('attractive male')
  })

  it('resolves local topic links and includes the short core in AI context guidance', () => {
    for (const name of guides) {
      for (const [, target] of readGuide(name).matchAll(/\]\(([^\s)]+\.md)(?:#[^)]*)?\)/g)) {
        if (!/^https?:/i.test(target!)) expect(existsSync(join(directory, target!)), `${name}: ${target}`).toBe(true)
      }
    }
    expect(readGuide('overview.md')).toContain('prompting.md')
    const workbench = readGuide('workbench.md')
    expect(workbench).toContain('AI planning context')
    expect(workbench).toContain('prompting.md')
    expect(workbench).toContain('Do not attach the entire guide set')
    expect(workbench).toContain('locked fields')
  })

  it('records exact current sources, access limits, and nonofficial observations', () => {
    const sources = readGuide('sources.md')
    expect(sources).toContain('2026-10-02')
    for (const url of [
      'https://docs.novelai.net/en/image/models',
      'https://docs.novelai.net/en/image/multiplecharacters',
      'https://docs.novelai.net/en/image/strengthening-weakening',
      'https://docs.novelai.net/en/image/textrendering',
      'https://docs.novelai.net/en/image/qualitytags',
      'https://docs.novelai.net/en/image/undesiredcontent',
      'https://image.novelai.net/docs/doc.json',
      'https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d',
      '353ac9e714b9b75f545880c9c12b68c92abab89e',
    ]) expect(sources, url).toContain(url)
    expect(sources).toContain('community compatibility observations')
    expect(sources).toContain('not official mechanics')
    expect(sources).toContain('truncated at 50,000 characters')
    expect(sources).toContain('Historical image experiments were not rerun')
    expect(sources).toContain('tokens versus characters')
    expect(sources).toContain('human-initiated')
  })
})
