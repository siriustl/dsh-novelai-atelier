/** Draft/library prompt composition helpers. Ported from workspace_actions.py. */
import { splitPromptText } from '../core/promptText.ts'

const isV5 = (model: string): boolean => model.startsWith('nai-diffusion-5-')

/** Append scene tags before a rendered Text: block. */
export function appendScenePrompt(current: string, addition: string): string {
  const [scene, text] = splitPromptText(current)
  const [addedScene, addedText] = splitPromptText(addition)
  if (text !== null && addedText !== null) throw new Error('当前草稿和预设均包含 Text:，请先保留一个文字块')
  const combined = [scene, addedScene].filter(Boolean).join(', ')
  const rendered = text ?? addedText
  return rendered === null ? combined : `${combined}${combined ? '\n' : ''}Text: ${rendered}`
}

/** Preset character slots survive inspiration → library → workspace round trips. */
export function appendPresetCharacters(request: Record<string, unknown>, data: Record<string, unknown>): void {
  if (data['characters'] === undefined) return
  if (!Array.isArray(data['characters'])) throw new Error('预设角色需要对象列表')
  const incoming = data['characters'] as Array<Record<string, unknown>>
  const existing = (request['characters'] ?? []) as Array<Record<string, unknown>>
  const limit = isV5(String(request['model'] ?? 'nai-diffusion-5-full')) ? 22 : 6
  if (existing.length + incoming.length > limit) throw new Error(`已达到模型角色数量上限 ${limit}`)
  for (const character of incoming) {
    if (!character || typeof character !== 'object' || typeof character['prompt'] !== 'string' || !character['prompt'].trim())
      throw new Error('预设角色需要有效提示词')
  }
  if (incoming.length) request['characters'] = [...existing, ...structuredClone(incoming)]
}


export function defaultDraft(): Record<string, unknown> {
  return {
    name: '未命名作品', operation: 'generate',
    request: {
      model: 'nai-diffusion-5-full', prompt: '', negative_prompt: '',
      width: 832, height: 1216, quality_preset: 'standard', negative_preset: 'heavy',
      max_anlas: 0,
    },
    locked_fields: [], library_refs: [],
  }
}

type Entry = Record<string, unknown>

export function entryPrompt(entry: Entry, entries: Entry[], promptSet = -1): { prompt: string; negative: string } {
  const data = (entry['data'] ?? {}) as Record<string, unknown>
  const sets = (data['prompt_sets'] ?? []) as Array<Record<string, unknown>>
  if (!Number.isInteger(promptSet) || promptSet < -1 || promptSet >= sets.length) throw new Error('提示词组序号无效')
  const selected = promptSet >= 0 ? sets[promptSet]! : data
  let prompt = (selected['prompt'] ?? '') as string
  let negative = (selected['negative_prompt'] ?? '') as string
  const index = new Map(entries.map((e) => [e['id'] as string, e]))
  if (entry['kind'] === 'branch' && !data['replace_identity']) {
    const parent = (index.get(entry['parent_id'] as string)?.['data'] ?? {}) as Record<string, unknown>
    prompt = [parent['prompt'], prompt].filter(Boolean).join(', ')
    negative = [parent['negative_prompt'], negative].filter(Boolean).join(', ')
  }
  if (entry['kind'] === 'blend') {
    const pieces: string[] = []
    for (const artist of (data['artists'] ?? []) as Array<Record<string, unknown>>) {
      const tag = ((index.get(artist['id'] as string)?.['data'] ?? {}) as Record<string, unknown>)['prompt'] as string ?? ''
      const value = artist['weight'] ?? 1
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('画师权重需要有限数值')
      const weight = value
      if (tag) pieces.push(weight === 1 ? tag : `${weight}::${tag}::`)
    }
    prompt = pieces.join(', ')
  }
  return { prompt, negative }
}

/** Gallery tag filter: a character matches its first main-prompt tag, an artist its whole main prompt. */
export function entryFilterTag(entry: Entry): string {
  const data = (entry['data'] ?? {}) as Record<string, unknown>
  const prompt = typeof data['prompt'] === 'string' ? data['prompt'] : ''
  return entry['kind'] === 'character' ? (prompt.split(',')[0] ?? '').trim() : prompt.trim()
}

export function applyLibrary(draft: Record<string, unknown>, entry: Entry, entries: Entry[], opts: { prompt_set?: number; target_slot?: number | null } = {}): Record<string, unknown> {
  const result = structuredClone(draft)
  const promptSet = opts.prompt_set ?? -1
  const { prompt, negative } = entryPrompt(entry, entries, promptSet)
  const request = result['request'] as Record<string, unknown>
  let slot: number | null = null
  if (entry['kind'] === 'character' || entry['kind'] === 'branch') {
    const characters = (request['characters'] ?? []) as Array<Record<string, unknown>>
    if (opts.target_slot != null && (!Number.isInteger(opts.target_slot) || opts.target_slot < -1 || opts.target_slot > characters.length))
      throw new Error('角色槽序号无效')
    slot = opts.target_slot == null || opts.target_slot === -1 ? characters.length : opts.target_slot
    const limit = isV5(String(request['model'] ?? 'nai-diffusion-5-full')) ? 22 : 6
    if (slot >= limit) throw new Error('已达到模型角色数量上限')
    if (slot === characters.length) characters.push({})
    const target = characters[slot]!
    target['prompt'] = prompt
    target['negative_prompt'] = negative
    request['characters'] = characters
  } else {
    request['prompt'] = appendScenePrompt(String(request['prompt'] ?? ''), prompt)
    request['negative_prompt'] = [request['negative_prompt'], negative].filter(Boolean).join(', ')
    if (entry['kind'] === 'preset' && promptSet === -1) appendPresetCharacters(request, (entry['data'] ?? {}) as Entry)
  }
  const refs = ((result['library_refs'] ?? []) as Array<Record<string, unknown>>).filter((r) => slot === null || r['slot'] !== slot)
  const sets = ((entry['data'] as Record<string, unknown>)?.['prompt_sets'] ?? []) as Array<Record<string, unknown>>
  refs.push({
    id: entry['id'], revision: entry['revision'], name: entry['name'],
    prompt_set: promptSet,
    prompt_set_name: promptSet >= 0 ? (sets[promptSet]?.['name'] ?? '') : '默认词组',
    parent_id: (entry['parent_id'] as string) || entry['id'],
    ...(slot !== null ? { slot } : {}),
  })
  result['library_refs'] = refs
  return result
}

