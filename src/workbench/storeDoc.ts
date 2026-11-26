/** Workbench persisted document model (single JSON file, atomic writes). */
import { JsonDoc, timestamp } from './util.ts'

export interface DraftRow { id: string; revision: number; data: string }
export interface VersionRow { id: string; draft_id: string; revision: number; name: string; data: string; created_at: string }
export interface EntryRow { id: string; kind: string; parent_id: string | null; name: string; revision: number; data: string; created_at: string; updated_at: string }
export interface AssetRow { id: string; data: string; created_at: string }
export interface BatchRow { id: string; budget: number; spent: number; reserved: number; idempotency_key: string | null; fingerprint: string; schedule_id: string | null; created_at: string }
export interface JobRow {
  id: string; batch_id: string; schedule_id: string | null; status: string; snapshot: string
  result: string | null; error: string | null; ceiling: number; reserved: number; actual: number | null
  attempts: number; cancel_requested: number; favorite: number; archived: number
  created_at: string; updated_at: string; started_at: string | null; finished_at: string | null
}
export interface ScheduleRow { id: string; data: string; enabled: number; next_run: string | null; runs: number; spent: number; reserved: number; created_at: string; updated_at: string; revision: number }
export interface ScheduleRunRow { schedule_id: string; scheduled_for: string; batch_id: string | null; outcome: string; data: string }
export interface ConversationRow { id: string; title: string; data: string; revision: number; created_at: string; updated_at: string }
export interface MessageRow { id: string; conversation_id: string; role: string; content: string; data: string; created_at: string }
export interface AssistantRunRow { id: string; conversation_id: string; status: string; data: string; cancel_requested: number; idempotency_key: string | null; created_at: string; updated_at: string }
export interface WorkspaceProposalRow { id: string; data: string; status: string; result: string | null; created_at: string }

export interface StoreData {
  kv: Record<string, string>
  drafts: DraftRow[]
  draft_versions: VersionRow[]
  entries: EntryRow[]
  assets: AssetRow[]
  batches: BatchRow[]
  jobs: JobRow[]
  schedules: ScheduleRow[]
  schedule_runs: ScheduleRunRow[]
  conversations: ConversationRow[]
  messages: MessageRow[]
  assistant_runs: AssistantRunRow[]
  workspace_proposals: WorkspaceProposalRow[]
}

export function emptyStoreData(): StoreData {
  return {
    kv: {}, drafts: [], draft_versions: [], entries: [], assets: [],
    batches: [], jobs: [], schedules: [], schedule_runs: [],
    conversations: [], messages: [], assistant_runs: [], workspace_proposals: [],
  }
}

export const ENTRY_KINDS = new Set(['character', 'branch', 'artist', 'blend', 'preset'])
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
export const nowStamp = () => timestamp()

export function createStoreDoc(path: string): { doc: StoreData; persist: (value: StoreData) => void } {
  const file = new JsonDoc<StoreData>(path, emptyStoreData())
  const doc = file.load()
  return { doc, persist: (value) => file.save(value) }
}
