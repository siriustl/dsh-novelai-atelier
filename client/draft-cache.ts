/** Unacknowledged editor state survives closing/reopening the workbench pane. */
import type { Rec } from './api.ts'

const key = (id: string) => `dsh-novelai-atelier:pending-draft:${encodeURIComponent(id)}`
const legacyKey = (id: string) => `nai-atelier:pending-draft:${encodeURIComponent(id)}`

export function readPendingDraft(id: string): Rec | null {
  try {
    const text = sessionStorage.getItem(key(id)) ?? sessionStorage.getItem(legacyKey(id))
    if (!text) return null
    const value = JSON.parse(text) as Rec
    if (!Number.isSafeInteger(value['revision']) || value['revision'] < 0 || typeof value['operation'] !== 'string' || !value['request'] || typeof value['request'] !== 'object' || Array.isArray(value['request'])) return null
    return value
  } catch { return null }
}

export function cachePendingDraft(id: string, revision: number, operation: string, request: Rec): void {
  try { sessionStorage.setItem(key(id), JSON.stringify({ revision, operation, request })) } catch { /* Saving still works when browser storage is unavailable. */ }
}

export function clearPendingDraft(id: string): void {
  try { sessionStorage.removeItem(key(id)) } catch { /* Storage is optional. */ }
}
