/** Shared Text: boundary parser for the compiler and browser-side prompt edits. */
const TEXT_BLOCK_RE = /(?:^|(?<=[\s,.[\]:{}\u3001\u3002]))text:(?!:)/i

export function splitPromptText(prompt: string): [string, string | null] {
  const match = TEXT_BLOCK_RE.exec(prompt)
  if (!match) return [prompt, null]
  return [prompt.slice(0, match.index).replace(/[ ,\n]+$/u, ''), prompt.slice(match.index + match[0].length).trim()]
}
