/** Isolated per-occurrence AI composition constraints. Ported from schedule_planner.py (pure parts). */
import { applyLibrary, entryPrompt } from './library.ts'
import { lockPath } from './scheduledAssistant.ts'

type Rec = Record<string, unknown>

function prefix(fixed: string, proposed: string): string {
  if (!fixed || proposed.includes(fixed)) return proposed
  // Keep a fixed fragment exactly once at the front of its own prompt.
  const rest = proposed.replace(fixed, '').replace(/^[ ,\n]+|[ ,\n]+$/gu, '')
  return fixed + (rest ? ', ' + rest : '')
}

/** Resolve selected identities before parameter locks acquire their meaning. */
export function creativeDraft(schedule: Rec): { draft: Rec; identities: Array<[string, string]>; fixed_prompt: string; fixed_negative: string; chosen: Rec[] } {
  const recipe = (schedule['ai_recipe'] ?? {}) as Rec
  const library = (schedule['ai_library_snapshot'] ?? []) as Rec[]
  const request = structuredClone(schedule['request']) as Rec
  const operation = schedule['operation'] as string
  if (!['generate', 'img2img', 'inpaint', 'enhance', 'reference_generate'].includes(operation))
    throw new Error('AI 创作计划需要支持提示词的生图操作')
  const locks = [...new Set(['operation', 'request.model', ...((recipe['locked_fields'] ?? []) as string[])])]
  let draft: Rec = { id: 'schedule', revision: 0, name: schedule['name'], operation, request, locked_fields: locks, library_refs: [] }
  const index = new Map(library.map((e) => [e['id'] as string, e]))
  let chosen: Array<Rec & { _prompt_set?: number }> = (((recipe['library_refs'] ?? []) as unknown[]) as string[]).map((id) => index.get(id)).filter(Boolean) as Rec[]
  if (Array.isArray(recipe['character_slots'])) {
    chosen = chosen.filter((e) => !['character', 'branch'].includes(e['kind'] as string))
    const slots = recipe['character_slots'] as Array<Rec>
    const people: Array<Rec & { _prompt_set?: number }> = []
    for (const slot of slots) {
      const entry = structuredClone(index.get(slot['entry_id'] as string)!)
      if (!entry) throw new Error('人物槽引用的资料不存在')
      if (!['character', 'branch'].includes(entry['kind'] as string)) throw new Error('人物槽只能选择角色或分支')
      entry['_prompt_set'] = (slot['prompt_set'] as number | undefined) ?? -1
      people.push(entry)
    }
    chosen = [...people, ...chosen]
  } else {
    // Migrate ambiguous old parent+branch selections to one identity.
    const parents = new Set(chosen.filter((e) => e['kind'] === 'branch').map((e) => e['parent_id']))
    chosen = chosen.filter((e) => e['kind'] !== 'character' || !parents.has(e['id']))
  }
  if (chosen.some((e) => ['character', 'branch'].includes(e['kind'] as string))) {
    const count = chosen.filter((e) => ['character', 'branch'].includes(e['kind'] as string)).length
    const previous = (request['characters'] ?? []) as Rec[]
    request['characters'] = Array.from({ length: count }, (_, i) =>
      Object.fromEntries(Object.entries(previous[i] ?? {}).filter(([k]) => !['prompt', 'negative_prompt'].includes(k))))
  }
  let fixedPrompt = (recipe['fixed_prompt'] ?? '') as string
  let fixedNegative = (recipe['fixed_negative_prompt'] ?? '') as string
  const identities: Array<[string, string]> = []
  for (const entry of chosen) {
    const { prompt, negative } = entryPrompt(entry, library, (entry['_prompt_set'] as number | undefined) ?? -1)
    if (['character', 'branch'].includes(entry['kind'] as string)) {
      draft = applyLibrary(draft, entry, library, { target_slot: identities.length, prompt_set: (entry['_prompt_set'] as number | undefined) ?? -1 })
      identities.push([prompt, negative])
    } else {
      fixedPrompt = [fixedPrompt, prompt].filter(Boolean).join(', ')
      fixedNegative = [fixedNegative, negative].filter(Boolean).join(', ')
    }
  }
  const request2 = draft['request'] as Rec
  request2['prompt'] = prefix(fixedPrompt, (request2['prompt'] ?? '') as string)
  request2['negative_prompt'] = prefix(fixedNegative, (request2['negative_prompt'] ?? '') as string)
  return { draft, identities, fixed_prompt: fixedPrompt, fixed_negative: fixedNegative, chosen }
}

/** Field differences between two JSON values (Python _differences shape). */
export function differences(left: unknown, right: unknown, prefix0 = ''): Array<{ field: string }> {
  const out: Array<{ field: string }> = []
  const walk = (a: unknown, b: unknown, p: string): void => {
    if (a instanceof Object && b instanceof Object && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const name = p ? `${p}.${key}` : key
        if (!(key in (a as Rec)) || !(key in (b as Rec))) out.push({ field: name })
        else walk((a as Rec)[key], (b as Rec)[key], name)
      }
      return
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const name = `${p}.${i}`
        if (i >= a.length || i >= b.length) out.push({ field: name })
        else walk(a[i], b[i], name)
      }
      return
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: p })
  }
  walk(left, right, prefix0)
  return out
}

export { prefix as fixedPrefix, lockPath }
