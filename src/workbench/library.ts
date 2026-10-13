/** Draft/library prompt composition helpers. Ported from workspace_actions.py. */
import { isV5 } from '../core/models.ts'

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
    request['prompt'] = [request['prompt'], prompt].filter(Boolean).join(', ')
    request['negative_prompt'] = [request['negative_prompt'], negative].filter(Boolean).join(', ')
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

